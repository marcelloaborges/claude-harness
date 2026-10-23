#!/usr/bin/env node
/**
 * Deterministic core of /ad-experiment. Run from the repository root:
 *
 *   node <skill-dir>/scripts/experiment.mjs prepare    <exp-dir> [--fresh]
 *   node <skill-dir>/scripts/experiment.mjs judge-prep <exp-dir> --metric <name> [--run <id>] [--batch <n>]
 *   node <skill-dir>/scripts/experiment.mjs score      <exp-dir> [--run <id>]
 *
 * prepare     Fingerprints the frozen inputs (test set, metric definitions,
 *             judge rubrics) and returns the run to write records into: the
 *             latest run when nothing changed, a new `runs/rN/` otherwise.
 * judge-prep  Builds blinded, shuffled batches for one judge metric: the judge
 *             sees opaque ids, never scenario names.
 * score       Computes every metric per scenario, applies the current
 *             thresholds, flags cases worth a look, merges the agent's
 *             considerations, and writes results.md and results.csv.
 *
 * Thresholds are not part of the fingerprint, so changing them only needs a
 * re-score. Every command prints one JSON object; failures print
 * `{ "error": ... }` and exit 1. Zero dependencies, Node 22+.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const METRIC_TYPES = ['accuracy', 'f1', 'latency', 'cost', 'errors', 'custom', 'judge'];
const DEFAULT_STAT = {
  accuracy: 'value',
  f1: 'value',
  latency: 'p95',
  cost: 'mean',
  errors: 'count',
  custom: 'mean',
  judge: 'mean',
};
const OPS = {
  '>=': (a, b) => a >= b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '<': (a, b) => a < b,
  '==': (a, b) => a === b,
};
const DEFAULT_FLAGS = { judgeSpread: 1, latencyFactor: 3 };
const PREVIEW = 160;

class UsageError extends Error {}

// ---------------------------------------------------------------- utilities

function fail(message) {
  throw new UsageError(message);
}

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`${label} unreadable at ${path}: ${error.code ?? error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON (${path}): ${error.message}`);
  }
}

function readJsonl(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`${label} unreadable at ${path}: ${error.code ?? error.message}`);
  }
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line)
    .map(({ line, number }) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return fail(`${label} line ${number} is not valid JSON (${path}): ${error.message}`);
      }
    });
}

/** JSON with sorted keys, so equal values always serialize the same way. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function normalized(value) {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ').toLowerCase();
  return canonical(value);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function seededRandom(seedText) {
  let state = parseInt(sha256(seedText).slice(0, 8), 16) || 1;
  return () => {
    // mulberry32
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function std(values) {
  if (values.length < 2) return values.length ? 0 : null;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

/** Nearest-rank percentile. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function numericStats(values) {
  return {
    n: values.length,
    mean: round(mean(values)),
    std: round(std(values)),
    min: values.length ? round(Math.min(...values)) : null,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    max: values.length ? round(Math.max(...values)) : null,
  };
}

function preview(value) {
  const text = typeof value === 'string' ? value : canonical(value);
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW - 1)}…` : flat;
}

function parseArgs(argv) {
  const [command, dir, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'fresh') options.fresh = true;
    else {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`--${key} needs a value`);
      options[key] = value;
      i += 1;
    }
  }
  return { command, dir, options };
}

// ---------------------------------------------------------------- experiment

/** Load and validate experiment.json plus the test set it names. */
export function loadExperiment(expDir) {
  const root = resolve(expDir);
  const config = readJson(join(root, 'experiment.json'), 'experiment.json');
  if (!Array.isArray(config.scenarios) || config.scenarios.length < 1) {
    fail('experiment.json needs a non-empty "scenarios" array');
  }
  const scenarioIds = config.scenarios.map((s) => s?.id);
  if (scenarioIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id))) {
    fail('every scenario needs an "id" made of letters, digits, "_" or "-"');
  }
  if (new Set(scenarioIds).size !== scenarioIds.length) fail('scenario ids must be unique');
  if (!Array.isArray(config.metrics) || config.metrics.length < 1) {
    fail('experiment.json needs a non-empty "metrics" array');
  }
  const names = new Set();
  for (const metric of config.metrics) {
    if (!metric || typeof metric.name !== 'string' || !metric.name) fail('every metric needs a "name"');
    if (names.has(metric.name)) fail(`metric names must be unique: ${metric.name}`);
    names.add(metric.name);
    if (!METRIC_TYPES.includes(metric.type)) {
      fail(`metric ${metric.name}: "type" must be one of ${METRIC_TYPES.join(', ')}`);
    }
    if (metric.type === 'judge') {
      if (typeof metric.rubric !== 'string') fail(`judge metric ${metric.name} needs a "rubric" path`);
      const scale = metric.scale;
      if (!Array.isArray(scale) || scale.length !== 2 || !(scale[0] < scale[1])) {
        fail(`judge metric ${metric.name} needs "scale": [min, max]`);
      }
      if (!existsSync(join(root, metric.rubric))) fail(`rubric not found: ${metric.rubric}`);
    }
  }
  const testsetPath = config.testset ?? 'testset/cases.jsonl';
  const cases = readJsonl(join(root, testsetPath), 'test set');
  if (!cases.length) fail('the test set is empty');
  const caseIds = new Set();
  for (const item of cases) {
    if (typeof item?.id !== 'string' || !item.id) fail('every test case needs a string "id"');
    if (caseIds.has(item.id)) fail(`duplicate test case id: ${item.id}`);
    caseIds.add(item.id);
  }
  for (const threshold of config.thresholds ?? []) validateThreshold(threshold, config.metrics);
  return {
    root,
    config,
    cases,
    testsetPath,
    flags: { ...DEFAULT_FLAGS, ...(config.flags ?? {}) },
  };
}

function validateThreshold(threshold, metrics) {
  const metric = metrics.find((m) => m.name === threshold?.metric);
  if (!metric) fail(`threshold names an unknown metric: ${threshold?.metric}`);
  if (!OPS[threshold.op]) fail(`threshold on ${metric.name}: "op" must be one of ${Object.keys(OPS).join(' ')}`);
  if (typeof threshold.value !== 'number') fail(`threshold on ${metric.name}: "value" must be a number`);
  if (threshold.level === 'case' && metric.type === 'f1') {
    fail(`threshold on ${metric.name}: f1 has no per-case value; use accuracy for case-level checks`);
  }
}

/** Hash of everything that makes scores comparable across scenarios. */
export function fingerprint(experiment) {
  const { root, config, testsetPath } = experiment;
  const parts = {
    testset: sha256(readFileSync(join(root, testsetPath), 'utf8')),
    metrics: sha256(canonical(config.metrics)),
    rubrics: Object.fromEntries(
      config.metrics
        .filter((m) => m.type === 'judge')
        .map((m) => [m.name, sha256(readFileSync(join(root, m.rubric), 'utf8'))])
    ),
  };
  return { ...parts, id: sha256(canonical(parts)).slice(0, 12) };
}

function listRuns(root) {
  const dir = join(root, 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^r\d+$/.test(name))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function resolveRun(root, requested) {
  const runs = listRuns(root);
  if (requested) {
    if (!runs.includes(requested)) fail(`run not found: ${requested}`);
    return requested;
  }
  if (!runs.length) fail('no run yet: call "prepare" first');
  return runs[runs.length - 1];
}

// ---------------------------------------------------------------- prepare

export function prepare(expDir, { fresh = false } = {}) {
  const experiment = loadExperiment(expDir);
  const current = fingerprint(experiment);
  const runs = listRuns(experiment.root);
  const latest = runs[runs.length - 1];
  if (latest && !fresh) {
    const previous = readJson(join(experiment.root, 'runs', latest, 'fingerprint.json'), 'fingerprint');
    if (previous.id === current.id) {
      return { run: latest, reused: true, fingerprint: current.id, cases: experiment.cases.length };
    }
  }
  const run = `r${latest ? Number(latest.slice(1)) + 1 : 1}`;
  const runDir = join(experiment.root, 'runs', run);
  mkdirSync(join(runDir, 'records'), { recursive: true });
  writeFileSync(join(runDir, 'fingerprint.json'), `${JSON.stringify(current, null, 2)}\n`);
  let changed = [];
  if (latest) {
    const previous = readJson(join(experiment.root, 'runs', latest, 'fingerprint.json'), 'fingerprint');
    changed = ['testset', 'metrics'].filter((k) => previous[k] !== current[k]);
    if (canonical(previous.rubrics) !== canonical(current.rubrics)) changed.push('rubrics');
  }
  return {
    run,
    reused: false,
    previous: latest ?? null,
    changed,
    fingerprint: current.id,
    cases: experiment.cases.length,
    recordsDir: join('runs', run, 'records'),
  };
}

// ---------------------------------------------------------------- records

function loadRecords(experiment, run) {
  const dir = join(experiment.root, 'runs', run, 'records');
  const known = new Set(experiment.config.scenarios.map((s) => s.id));
  const caseIds = new Set(experiment.cases.map((c) => c.id));
  const records = new Map(); // `${case}\u0000${scenario}` -> record
  const problems = [];
  if (!existsSync(dir)) return { records, problems };
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const record of readJsonl(join(dir, file), `records ${file}`)) {
      const label = `${file}: case ${record?.case}`;
      if (!known.has(record?.scenario)) {
        problems.push(`${label}: unknown scenario ${record?.scenario}`);
        continue;
      }
      if (!caseIds.has(record?.case)) {
        problems.push(`${label}: case is not in the test set`);
        continue;
      }
      const key = `${record.case}\u0000${record.scenario}`;
      if (records.has(key)) problems.push(`${label}: duplicate record for scenario ${record.scenario}; the last one wins`);
      records.set(key, record);
    }
  }
  return { records, problems };
}

// ---------------------------------------------------------------- judge-prep

export function judgePrep(expDir, { metric: metricName, run: requested, batch = '25' } = {}) {
  const experiment = loadExperiment(expDir);
  const metric = experiment.config.metrics.find((m) => m.name === metricName);
  if (!metric) fail(`unknown metric: ${metricName}`);
  if (metric.type !== 'judge') fail(`metric ${metricName} is not a judge metric`);
  const run = resolveRun(experiment.root, requested);
  assertFresh(experiment, run);
  const size = Number(batch);
  if (!Number.isInteger(size) || size < 1) fail('--batch must be a positive integer');
  const { records } = loadRecords(experiment, run);
  const sees = metric.judgeSees ?? ['input', 'output', 'expected'];
  const byCase = new Map(experiment.cases.map((c) => [c.id, c]));
  const entries = [...records.values()].filter((r) => !r.error);
  if (!entries.length) fail('no successful records to judge in this run');
  const random = seededRandom(`${run}:${metric.name}`);
  const order = entries.map((r) => ({ r, k: random() })).sort((a, b) => a.k - b.k);
  const key = {};
  const items = order.map(({ r }, index) => {
    const id = `j${String(index + 1).padStart(4, '0')}`;
    key[id] = { case: r.case, scenario: r.scenario };
    const item = { id };
    const testCase = byCase.get(r.case);
    if (sees.includes('input')) item.input = testCase.input;
    if (sees.includes('expected') && testCase.expected !== undefined) item.expected = testCase.expected;
    if (sees.includes('output')) item.output = r.output;
    return item;
  });
  const judgeDir = join(experiment.root, 'runs', run, 'judge', metric.name);
  mkdirSync(judgeDir, { recursive: true });
  writeFileSync(join(judgeDir, 'key.json'), `${JSON.stringify(key, null, 2)}\n`);
  const batches = [];
  for (let start = 0; start < items.length; start += size) {
    const name = `batch-${String(batches.length + 1).padStart(2, '0')}.json`;
    writeFileSync(join(judgeDir, name), `${JSON.stringify(items.slice(start, start + size), null, 2)}\n`);
    batches.push(name);
  }
  const passes = metric.passes ?? 3;
  return {
    run,
    metric: metric.name,
    items: items.length,
    passes,
    scale: metric.scale,
    rubric: metric.rubric,
    judgeDir: join('runs', run, 'judge', metric.name),
    batches,
    writeTo: `pass-<1..${passes}>/<batch file name>`,
  };
}

function assertFresh(experiment, run) {
  const saved = readJson(join(experiment.root, 'runs', run, 'fingerprint.json'), 'fingerprint');
  const current = fingerprint(experiment);
  if (saved.id !== current.id) {
    fail(
      `run ${run} was made with a different test set, metric set or rubric (fingerprint ${saved.id}, now ${current.id}); ` +
        'call "prepare" to start a new run'
    );
  }
}

/** Judge scores per `${case}\u0000${scenario}`: an array with one score per pass. */
function loadJudgeScores(experiment, run, metric, problems) {
  const scores = new Map();
  const judgeDir = join(experiment.root, 'runs', run, 'judge', metric.name);
  if (!existsSync(join(judgeDir, 'key.json'))) return scores;
  const key = readJson(join(judgeDir, 'key.json'), `judge key for ${metric.name}`);
  const [low, high] = metric.scale;
  const passDirs = readdirSync(judgeDir).filter((d) => /^pass-\d+$/.test(d));
  for (const passDir of passDirs) {
    for (const file of readdirSync(join(judgeDir, passDir)).filter((f) => f.endsWith('.json'))) {
      const entries = readJson(join(judgeDir, passDir, file), `judge ${metric.name} ${passDir}/${file}`);
      if (!Array.isArray(entries)) {
        problems.push(`judge ${metric.name} ${passDir}/${file}: not an array`);
        continue;
      }
      for (const entry of entries) {
        const target = key[entry?.id];
        if (!target) {
          problems.push(`judge ${metric.name} ${passDir}/${file}: unknown item id ${entry?.id}`);
          continue;
        }
        if (typeof entry.score !== 'number' || entry.score < low || entry.score > high) {
          problems.push(`judge ${metric.name} ${passDir}/${file}: item ${entry.id} score out of scale`);
          continue;
        }
        const k = `${target.case}\u0000${target.scenario}`;
        if (!scores.has(k)) scores.set(k, []);
        scores.get(k).push({ score: entry.score, reason: entry.reason ?? '' });
      }
    }
  }
  return scores;
}

// ---------------------------------------------------------------- scoring

function f1Stats(pairs, positive) {
  // pairs: [{ expected, output }] as normalized label strings
  const labels = positive !== undefined && positive !== null
    ? [String(positive)]
    : [...new Set(pairs.flatMap((p) => [p.expected, p.output]))].sort();
  const per = labels.map((label) => {
    const tp = pairs.filter((p) => p.output === label && p.expected === label).length;
    const fp = pairs.filter((p) => p.output === label && p.expected !== label).length;
    const fn = pairs.filter((p) => p.output !== label && p.expected === label).length;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { precision, recall, f1 };
  });
  return {
    value: round(mean(per.map((p) => p.f1))),
    precision: round(mean(per.map((p) => p.precision))),
    recall: round(mean(per.map((p) => p.recall))),
    averaging: labels.length === 1 && positive !== undefined && positive !== null ? `binary (${positive})` : 'macro',
    n: pairs.length,
  };
}

function label(value, match) {
  if (match === 'normalized') return normalized(value);
  return typeof value === 'string' ? value.trim() : canonical(value);
}

/** Per-case value of a metric for one record, or null when it has none. */
function caseValue(metric, record, testCase, judge) {
  if (!record) return null;
  switch (metric.type) {
    case 'accuracy':
      if (record.error || testCase.expected === undefined) return record.error ? 0 : null;
      return isCorrect(metric, record, testCase) ? 1 : 0;
    case 'latency':
      return typeof record.latency_ms === 'number' ? record.latency_ms : null;
    case 'cost':
      return typeof record.cost === 'number' ? record.cost : null;
    case 'errors':
      return record.error ? 1 : 0;
    case 'custom': {
      const v = record.metrics?.[metric.name];
      return typeof v === 'number' ? v : null;
    }
    case 'judge':
      return judge?.length ? mean(judge.map((j) => j.score)) : null;
    default:
      return null;
  }
}

function isCorrect(metric, record, testCase) {
  return metric.match === 'normalized'
    ? normalized(record.output) === normalized(testCase.expected)
    : canonical(record.output) === canonical(testCase.expected);
}

function aggregate(metric, rows) {
  // rows: [{ record, testCase, judge }] for one scenario
  const present = rows.filter((r) => r.record);
  switch (metric.type) {
    case 'accuracy': {
      const values = present.map((r) => caseValue(metric, r.record, r.testCase)).filter((v) => v !== null);
      return { value: round(mean(values)), correct: values.filter((v) => v === 1).length, n: values.length };
    }
    case 'f1': {
      const pairs = present
        .filter((r) => !r.record.error && r.testCase.expected !== undefined)
        .map((r) => ({ expected: label(r.testCase.expected, metric.match), output: label(r.record.output, metric.match) }));
      const positive = metric.positive === undefined || metric.positive === null ? metric.positive : label(metric.positive, metric.match);
      return f1Stats(pairs, positive);
    }
    case 'errors': {
      const count = present.filter((r) => r.record.error).length;
      return { count, rate: round(present.length ? count / present.length : null), n: present.length };
    }
    case 'cost': {
      const values = present.map((r) => caseValue(metric, r.record)).filter((v) => v !== null);
      return { ...numericStats(values), total: round(values.reduce((a, b) => a + b, 0)) };
    }
    case 'judge': {
      const means = [];
      const spreads = [];
      for (const r of present) {
        if (!r.judge?.length) continue;
        const scores = r.judge.map((j) => j.score);
        means.push(mean(scores));
        spreads.push(Math.max(...scores) - Math.min(...scores));
      }
      return { ...numericStats(means), spreadMean: round(mean(spreads)), spreadMax: spreads.length ? round(Math.max(...spreads)) : null };
    }
    default: {
      const values = present.map((r) => caseValue(metric, r.record, r.testCase, r.judge)).filter((v) => v !== null);
      return numericStats(values);
    }
  }
}

export function score(expDir, { run: requested } = {}) {
  const experiment = loadExperiment(expDir);
  const { config, cases, flags } = experiment;
  const run = resolveRun(experiment.root, requested);
  assertFresh(experiment, run);
  const { records, problems } = loadRecords(experiment, run);
  const scenarios = config.scenarios.map((s) => s.id);
  const metrics = config.metrics;
  const thresholds = config.thresholds ?? [];
  const judgeMetrics = metrics.filter((m) => m.type === 'judge');
  const judgeScores = new Map(judgeMetrics.map((m) => [m.name, loadJudgeScores(experiment, run, m, problems)]));
  const notesPath = join(experiment.root, 'runs', run, 'considerations.json');
  const notes = existsSync(notesPath) ? readJson(notesPath, 'considerations.json') : {};

  const rowsFor = (scenario) =>
    cases.map((testCase) => {
      const k = `${testCase.id}\u0000${scenario}`;
      return {
        testCase,
        record: records.get(k),
        judgeBy: Object.fromEntries(judgeMetrics.map((m) => [m.name, judgeScores.get(m.name).get(k)])),
      };
    });

  // Summary per scenario and metric.
  const summary = {};
  const latencyMedian = {};
  for (const scenario of scenarios) {
    const rows = rowsFor(scenario);
    summary[scenario] = {
      records: rows.filter((r) => r.record).length,
      missing: rows.filter((r) => !r.record).length,
    };
    for (const metric of metrics) {
      summary[scenario][metric.name] = aggregate(
        metric,
        rows.map((r) => ({ ...r, judge: r.judgeBy[metric.name] }))
      );
      if (metric.type === 'judge') {
        const judged = rows.filter((r) => r.record && !r.record.error).length;
        const withScores = rows.filter((r) => r.judgeBy[metric.name]?.length).length;
        if (judged && withScores < judged) {
          problems.push(`judge ${metric.name}: scenario ${scenario} has ${withScores} of ${judged} records scored`);
        }
      }
    }
    const latencies = rows.map((r) => r.record?.latency_ms).filter((v) => typeof v === 'number');
    latencyMedian[scenario] = percentile(latencies, 50);
  }

  // Thresholds: aggregate checks per scenario, case-level checks per case.
  const thresholdResults = thresholds.map((t) => {
    const metric = metrics.find((m) => m.name === t.metric);
    const applies = t.scenarios ?? scenarios;
    const result = { ...t, level: t.level ?? 'aggregate', byScenario: {} };
    for (const scenario of applies) {
      if (result.level === 'case') {
        const rows = rowsFor(scenario);
        const values = rows
          .map((r) => caseValue(metric, r.record, r.testCase, r.judgeBy[metric.name]))
          .filter((v) => v !== null);
        const passing = values.filter((v) => OPS[t.op](v, t.value)).length;
        result.byScenario[scenario] = { passing, total: values.length, rate: round(values.length ? passing / values.length : null) };
      } else {
        const stat = t.stat ?? DEFAULT_STAT[metric.type];
        const actual = summary[scenario][metric.name]?.[stat];
        result.stat = stat;
        result.byScenario[scenario] = {
          actual: actual ?? null,
          pass: typeof actual === 'number' ? OPS[t.op](actual, t.value) : null,
        };
      }
    }
    return result;
  });

  // Per-case rows and flags.
  const caseRows = [];
  const flagged = [];
  for (const testCase of cases) {
    const perScenario = {};
    const caseFlags = new Set();
    const outputs = new Set();
    for (const scenario of scenarios) {
      const k = `${testCase.id}\u0000${scenario}`;
      const record = records.get(k);
      const entry = { flags: [], metrics: {}, judgeSpread: {} };
      if (!record) {
        entry.flags.push('missing');
      } else {
        entry.output = record.output;
        entry.error = record.error ?? null;
        entry.latency_ms = record.latency_ms ?? null;
        entry.cost = record.cost ?? null;
        if (record.error) entry.flags.push('error');
        else outputs.add(canonical(record.output));
        for (const metric of metrics) {
          const judge = judgeScores.get(metric.name)?.get(k);
          const value = caseValue(metric, record, testCase, judge);
          if (metric.type !== 'f1' && metric.type !== 'errors') entry.metrics[metric.name] = round(value);
          if (metric.type === 'accuracy' && value === 0 && !record.error) entry.flags.push('incorrect');
          if (metric.type === 'judge' && judge?.length) {
            const scores = judge.map((j) => j.score);
            const spread = Math.max(...scores) - Math.min(...scores);
            entry.judgeSpread[metric.name] = spread;
            if (spread >= flags.judgeSpread) entry.flags.push(`judge-spread:${metric.name}`);
          }
        }
        const median = latencyMedian[scenario];
        if (typeof record.latency_ms === 'number' && median && record.latency_ms > flags.latencyFactor * median) {
          entry.flags.push('slow');
        }
        for (const t of thresholdResults.filter((x) => x.level === 'case')) {
          if (!(t.scenarios ?? scenarios).includes(scenario)) continue;
          const metric = metrics.find((m) => m.name === t.metric);
          const value = caseValue(metric, record, testCase, judgeScores.get(metric.name)?.get(k));
          if (value !== null && !OPS[t.op](value, t.value)) entry.flags.push(`below:${t.metric}`);
        }
      }
      entry.note = notes[`${testCase.id}/${scenario}`] ?? null;
      entry.flags.forEach((f) => caseFlags.add(f));
      perScenario[scenario] = entry;
    }
    if (outputs.size > 1) caseFlags.add('disagree');
    const row = { case: testCase.id, tags: testCase.tags ?? [], flags: [...caseFlags], note: notes[testCase.id] ?? null, scenarios: perScenario };
    caseRows.push(row);
    if (row.flags.length) flagged.push(row);
  }

  // Per-tag breakdown for accuracy and judge metrics.
  const tags = [...new Set(cases.flatMap((c) => c.tags ?? []))].sort();
  const byTag = {};
  for (const tag of tags) {
    byTag[tag] = {};
    for (const scenario of scenarios) {
      const rows = rowsFor(scenario).filter((r) => (r.testCase.tags ?? []).includes(tag));
      byTag[tag][scenario] = { n: rows.length };
      for (const metric of metrics.filter((m) => m.type === 'accuracy' || m.type === 'judge' || m.type === 'custom')) {
        const values = rows
          .map((r) => caseValue(metric, r.record, r.testCase, r.judgeBy[metric.name]))
          .filter((v) => v !== null);
        byTag[tag][scenario][metric.name] = round(mean(values));
      }
    }
  }

  const fp = readJson(join(experiment.root, 'runs', run, 'fingerprint.json'), 'fingerprint');
  const report = { run, fingerprint: fp.id, cases: cases.length, scenarios, summary, thresholds: thresholdResults, byTag, flagged, problems };
  writeFileSync(join(experiment.root, 'results.md'), renderMarkdown(experiment, report, caseRows));
  writeFileSync(join(experiment.root, 'results.csv'), renderCsv(experiment, caseRows));
  return {
    run,
    fingerprint: fp.id,
    cases: cases.length,
    scenarios,
    summary,
    thresholds: thresholdResults,
    flaggedCount: flagged.length,
    flagged: flagged.slice(0, 40).map((r) => ({
      case: r.case,
      flags: r.flags,
      tags: r.tags,
      byScenario: Object.fromEntries(Object.entries(r.scenarios).map(([s, e]) => [s, e.flags])),
    })),
    unnotedFlagged: flagged.filter((r) => !r.note).length,
    problems,
    files: ['results.md', 'results.csv'],
  };
}

// ---------------------------------------------------------------- rendering

function cell(value) {
  if (value === null || value === undefined) return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function metricSummaryText(metric, stats) {
  if (!stats) return '—';
  switch (metric.type) {
    case 'accuracy':
      return `${stats.value ?? '—'} (${stats.correct}/${stats.n})`;
    case 'f1':
      return `${stats.value ?? '—'} (P ${stats.precision ?? '—'}, R ${stats.recall ?? '—'}, ${stats.averaging})`;
    case 'errors':
      return `${stats.count} (${stats.rate ?? '—'})`;
    case 'latency':
      return `p50 ${stats.p50 ?? '—'} · p95 ${stats.p95 ?? '—'} · max ${stats.max ?? '—'}`;
    case 'cost':
      return `mean ${stats.mean ?? '—'} · total ${stats.total ?? '—'}`;
    case 'judge':
      return `${stats.mean ?? '—'} ± ${stats.std ?? '—'} (spread max ${stats.spreadMax ?? '—'}, n ${stats.n})`;
    default:
      return `${stats.mean ?? '—'} ± ${stats.std ?? '—'} (n ${stats.n})`;
  }
}

function renderMarkdown(experiment, report, caseRows) {
  const { config } = experiment;
  const { scenarios, summary } = report;
  const lines = [];
  lines.push(`# Results — ${config.title ?? 'experiment'}`, '');
  if (config.question) lines.push(`**Question:** ${config.question}`, '');
  lines.push(
    `**Run:** ${report.run} · **Fingerprint:** ${report.fingerprint} · **Cases:** ${report.cases} · **Flagged:** ${report.flagged.length}`,
    '',
    'Generated by `ad-experiment/scripts/experiment.mjs score`. No winner is declared: thresholds are set in the iteration session and the approach is chosen by the owner.',
    ''
  );
  lines.push('## Scenarios', '');
  for (const s of config.scenarios) lines.push(`- **${s.id}** — ${s.name ?? ''}${s.id === config.baseline ? ' (baseline)' : ''}`);
  lines.push('', '## Summary', '');
  lines.push(`| Metric | ${scenarios.map((s) => `${s}`).join(' | ')} |`);
  lines.push(`| --- | ${scenarios.map(() => '---').join(' | ')} |`);
  lines.push(`| records (missing) | ${scenarios.map((s) => `${summary[s].records} (${summary[s].missing})`).join(' | ')} |`);
  for (const metric of config.metrics) {
    lines.push(`| ${cell(metric.name)} | ${scenarios.map((s) => cell(metricSummaryText(metric, summary[s][metric.name]))).join(' | ')} |`);
  }
  lines.push('');
  if (report.thresholds.length) {
    lines.push('## Thresholds (current draft)', '');
    lines.push(`| Threshold | ${scenarios.join(' | ')} |`);
    lines.push(`| --- | ${scenarios.map(() => '---').join(' | ')} |`);
    for (const t of report.thresholds) {
      const title = t.level === 'case' ? `${t.metric} per case ${t.op} ${t.value}` : `${t.metric} ${t.stat} ${t.op} ${t.value}`;
      const cells = scenarios.map((s) => {
        const r = t.byScenario[s];
        if (!r) return 'n/a';
        if (t.level === 'case') return `${r.passing}/${r.total} pass (${r.rate ?? '—'})`;
        return r.pass === null ? 'no value' : `${r.pass ? 'pass' : 'fail'} (${r.actual})`;
      });
      lines.push(`| ${cell(title)} | ${cells.map(cell).join(' | ')} |`);
    }
    lines.push('');
  } else {
    lines.push('## Thresholds', '', 'None set yet. They are defined during the iteration session.', '');
  }
  const tagNames = Object.keys(report.byTag);
  if (tagNames.length) {
    const tagMetrics = config.metrics.filter((m) => ['accuracy', 'judge', 'custom'].includes(m.type));
    if (tagMetrics.length) {
      lines.push('## By tag', '');
      lines.push(`| Tag | Metric | ${scenarios.join(' | ')} |`);
      lines.push(`| --- | --- | ${scenarios.map(() => '---').join(' | ')} |`);
      for (const tag of tagNames) {
        for (const metric of tagMetrics) {
          lines.push(`| ${cell(tag)} (n ${report.byTag[tag][scenarios[0]].n}) | ${cell(metric.name)} | ${scenarios.map((s) => cell(report.byTag[tag][s][metric.name])).join(' | ')} |`);
        }
      }
      lines.push('');
    }
  }
  lines.push('## Flagged cases', '');
  if (!report.flagged.length) lines.push('None.', '');
  for (const row of caseRows.filter((r) => r.flags.length)) {
    const testCase = experiment.cases.find((c) => c.id === row.case);
    lines.push(`### ${row.case}${row.tags.length ? ` — ${row.tags.join(', ')}` : ''}`, '');
    lines.push(`- **Flags:** ${row.flags.join(', ')}`);
    lines.push(`- **Input:** ${cell(preview(testCase.input))}`);
    if (testCase.expected !== undefined) lines.push(`- **Expected:** ${cell(preview(testCase.expected))}`);
    for (const scenario of scenarios) {
      const e = row.scenarios[scenario];
      const detail = e.flags.includes('missing')
        ? 'no record'
        : e.error
          ? `error: ${cell(preview(e.error))}`
          : `${cell(preview(e.output))}${Object.keys(e.metrics).length ? ` · ${Object.entries(e.metrics).map(([k, v]) => `${k} ${v ?? '—'}`).join(', ')}` : ''}`;
      lines.push(`- **${scenario}:** ${detail}${e.flags.length ? ` [${e.flags.join(', ')}]` : ''}${e.note ? ` — ${cell(e.note)}` : ''}`);
    }
    lines.push(`- **Considerations:** ${row.note ? cell(row.note) : '_not written yet_'}`, '');
  }
  if (report.problems.length) {
    lines.push('## Problems', '');
    for (const p of report.problems) lines.push(`- ${cell(p)}`);
    lines.push('');
  }
  lines.push('Full case × scenario list: `results.csv`.', '');
  return lines.join('\n');
}

function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : canonical(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function renderCsv(experiment, caseRows) {
  const { config } = experiment;
  const valueMetrics = config.metrics.filter((m) => m.type !== 'f1' && m.type !== 'errors');
  const judgeMetrics = config.metrics.filter((m) => m.type === 'judge');
  const header = [
    'case', 'scenario', 'tags', 'input', 'expected', 'output', 'error', 'latency_ms', 'cost',
    ...valueMetrics.map((m) => m.name),
    ...judgeMetrics.map((m) => `${m.name}_spread`),
    'flags', 'case_flags', 'scenario_note', 'case_note',
  ];
  const lines = [header.join(',')];
  for (const row of caseRows) {
    const testCase = experiment.cases.find((c) => c.id === row.case);
    for (const scenario of config.scenarios.map((s) => s.id)) {
      const e = row.scenarios[scenario];
      lines.push(
        [
          row.case, scenario, row.tags.join(';'), testCase.input, testCase.expected, e.output, e.error, e.latency_ms, e.cost,
          ...valueMetrics.map((m) => e.metrics[m.name]),
          ...judgeMetrics.map((m) => e.judgeSpread[m.name]),
          e.flags.join(';'), row.flags.join(';'), e.note, row.note,
        ].map(csvField).join(',')
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- main

function main(argv) {
  const { command, dir, options } = parseArgs(argv);
  if (!command || !dir) {
    fail('usage: experiment.mjs <prepare|judge-prep|score> <experiment-dir> [options]');
  }
  if (!existsSync(join(resolve(dir), 'experiment.json'))) fail(`no experiment.json in ${dir}`);
  if (command === 'prepare') return prepare(dir, options);
  if (command === 'judge-prep') {
    if (!options.metric) fail('judge-prep needs --metric <name>');
    return judgePrep(dir, options);
  }
  if (command === 'score') return score(dir, options);
  return fail(`unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
    if (!(error instanceof UsageError)) process.stderr.write(`${error.stack}\n`);
  }
}
