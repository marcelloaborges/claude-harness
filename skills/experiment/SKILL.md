---
name: experiment
description: 'Compare scenarios A..N on a frozen test set with deterministic metrics and blind rubric judges; return per-case results for threshold iteration. Use on "experiment", "compare approaches".'
summary: Comparative experiment — competing scenarios run on one frozen test set, scored by script-computed metrics and a blind, repeated rubric judge. Returns a summary plus flagged cases with considerations, then iterates on thresholds with the owner until the owner chooses the approach. Never declares a winner.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent
---

# /ad:experiment

Runs a comparative experiment: competing scenarios (A = baseline, B..N = alternatives) are run on the same frozen test set and scored with the same metrics, so their results are directly comparable. The skill measures and explains; it **never declares a winner**. The owner reads the per-case results, sets the thresholds in an iteration session, and chooses the approach.

Each experiment lives in `experiments/NNNN-<slug>/`. A bundled script, `scripts/experiment.mjs`, owns everything deterministic: fingerprinting the frozen inputs, blinding judge batches, computing metrics, applying thresholds, flagging cases, and writing `results.md` and `results.csv`. The agent owns the judgment: framing, building scenarios, writing the runner, orchestrating the judge, and writing the considerations.

## Not for

- Choosing between approaches that docs, references or in-repo patterns already settle → `/ad:ground`.
- A bug or regression → `/ad:diagnose`.
- A fuzzy goal with no clear scenarios or metrics yet → `/ad:grill-me` first.
- Implementing the chosen approach in production code → `/ad:task` and `/ad:tdd` after the experiment closes.

## Non-negotiables

- **Production code is untouched.** Scenarios reuse existing code or config, or are built inside the experiment folder. Adopting a scenario is separate work after the experiment.
- **Frozen inputs.** The test set, the metric definitions and the judge rubrics are fingerprinted when a run starts. A scenario is never scored on a different or edited set; changing any of them starts a new run of every scenario.
- **Deterministic metrics come from the script**, never from reading outputs by eye.
- **The judge is blind.** It sees opaque item ids, never scenario names, and runs the number of passes the metric declares (default 3) so the spread is visible.
- **No winner.** Report what each scenario did and where it broke. Thresholds and the final choice belong to the owner.
- **Errors are results.** A crash, timeout or invalid output is recorded on the case, never retried until it passes or silently dropped.

## Step 1 — Frame and create the folder

1. State the experiment question in one sentence (what is being compared, and for what use).
2. Get the number: `node "${CLAUDE_PLUGIN_ROOT}/skills/experiment/scripts/next-number.mjs" experiments` from the repository root. Use JSON `next` as NNNN. Stop if `unreadable` is non-empty; stop for a decision if `exhausted` is true. Slug: kebab-case, at most 6 words.
3. Create `experiments/NNNN-<slug>/` with `plan.md` from [references/plan-template.md](references/plan-template.md) and an `experiment.json` following [references/experiment-format.md](references/experiment-format.md).
4. If `experiments/*/runs/` is not in `.gitignore`, propose adding it (raw outputs are re-creatable and can be large).

## Step 2 — Request the scenarios

Ask the user for scenarios A, B, ..., N. For each, capture in `plan.md` and `experiment.json`:

- **id and name** — `A` is the baseline (usually the current behavior) unless the user says otherwise.
- **What it is** — the model, prompt, algorithm, library or configuration that differs.
- **Source** — an existing path, command or config that already runs it, or "to build".
- **How it is invoked** — the call the runner will make per case.

Build every "to build" scenario under `scenarios/<id>/`. Keep all scenarios behind the same interface (same input shape, same output shape) so the runner treats them alike. Read the code a scenario reuses; do not guess its signature.

## Step 3 — Settle the test set

- **The user has a dataset:** convert or copy it into `testset/cases.jsonl` (one JSON object per line: `id`, `input`, `expected` when known, optional `tags`). Copying freezes it; record the source path in `plan.md`.
- **No dataset:** draft one. Cover typical inputs and edge cases (empty, malformed, very large, ambiguous, adversarial for the domain), tag each case (`easy`, `edge`, `negation`, ...), and give expected outputs where they are objective. Show it and get the user's approval before any run.

Never add, remove or edit cases after a run has started without accepting that it starts a new run.

## Step 4 — Request the metrics

Ask which metrics evaluate the scenarios. Map each to a metric type in `experiment.json` (full schema in [references/experiment-format.md](references/experiment-format.md)):

| User asks for | Type | Notes |
| --- | --- | --- |
| Exact or normalized correctness | `accuracy` | `match`: `exact` (default) or `normalized` (trim, collapse spaces, lowercase) |
| Precision, recall, F1 for labels | `f1` | macro by default; `positive` for binary; same `match` option |
| Speed | `latency` | from `latency_ms`; summary shows p50, p95, max |
| Spend | `cost` | from `cost` per record |
| Failures | `errors` | count and rate of records with `error` |
| Any other number the runner can compute (BLEU, IoU, memory) | `custom` | runner writes `metrics.<name>` per record |
| A non-deterministic rule ("faithful", "helpful", "on-brand") | `judge` | needs `scale` and a rubric file; see Step 6 |

For each `judge` metric, write `rubrics/<name>.md` following [references/judging.md](references/judging.md): what the score means at every point of the scale, with a short example per point. Get the user's approval of each rubric; it is frozen with the test set.

Thresholds start empty unless the user already has some. They are set in Step 8.

## Step 5 — Approve the plan

Before running anything, show the plan in one screen: question, scenarios, test set (size, tags, source), metrics, rubrics, and the estimated volume: `cases × scenarios` runs plus `cases × scenarios × passes` judge scores per judge metric. Name any scenario that calls a paid API. Run only after the user approves.

## Step 6 — Run

1. `node "${CLAUDE_PLUGIN_ROOT}/skills/experiment/scripts/experiment.mjs" prepare experiments/NNNN-<slug>` → returns the `run` to write into (`r1`, ...). It reuses the latest run when nothing frozen changed.
2. Write the runner in the project's own language at `experiments/NNNN-<slug>/run.<ext>`. For each scenario it reads `testset/cases.jsonl`, calls the scenario per case, and writes `runs/<run>/records/<scenario>.jsonl`, one line per case: `case`, `scenario`, `output`, `latency_ms`, optional `cost`, `error` (message or null) and `metrics` for custom metrics. Catch per-case failures into `error`; never stop the whole scenario on one bad case. The record format is in [references/experiment-format.md](references/experiment-format.md).
3. Run each scenario. Report progress per scenario, not per case.
4. For each judge metric, follow [references/judging.md](references/judging.md): `judge-prep` builds blinded batches; delegate each batch and pass to the `ad:experiment-judge` subagent (independent passes may run in parallel); it writes `pass-<n>/<batch>.json`.

## Step 7 — Score and present

1. `node "${CLAUDE_PLUGIN_ROOT}/skills/experiment/scripts/experiment.mjs" score experiments/NNNN-<slug>` → writes `results.md` and `results.csv`, and prints a JSON summary with the flagged cases.
2. Fix anything under `problems` before presenting (missing records, judge items without scores, unknown ids).
3. Read every flagged case: its input, expected value and each scenario's output. Write the considerations to `runs/<run>/considerations.json` (`"<case>"` for the case, `"<case>/<scenario>"` for one scenario): what happened and the likely reason, for example "A ignores negation; B handles it", "judge passes split because the rubric does not cover partial answers", "B times out on inputs over 2 KB". State what the evidence shows; mark a guess as a guess.
4. Score again so the considerations are rendered into the results files.
5. Present in chat:
   - one line with the run, the number of cases and the number of flagged cases;
   - the summary table (scenario × metric);
   - the flagged cases worth a look, each with its considerations (group repeated patterns instead of listing near-identical cases);
   - patterns across cases: where each scenario is strong and where it breaks, by tag when tags exist;
   - the paths to `results.md` and `results.csv`.

   Do not rank the scenarios or recommend one. If the user asks for an opinion, give it as an opinion, separate from the results.

## Step 8 — Iterate on thresholds

Work with the user until the thresholds are settled. For each change:

| Change | Action |
| --- | --- |
| Add or adjust a threshold | Edit `thresholds` in `experiment.json`, append the change and its reason to the threshold log in `plan.md`, re-run `score`. No new run. |
| Change or add a scenario | Re-run only that scenario into the current run (its records file is replaced), re-judge its records, re-run `score`. |
| Change the test set, a metric definition or a rubric | Call `prepare` (it starts a new run), then re-run every scenario and judge. Old runs stay for reference. |

Thresholds are aggregate (`accuracy >= 0.9`, `latency p95 <= 200`) or per case (`faithfulness >= 4` on every case); see [references/experiment-format.md](references/experiment-format.md). After each re-score, show only what changed: which scenarios now pass or fail which threshold, and which cases moved.

## Step 9 — Close

When the user chooses the approach:

1. Fill the `Decision` section of `plan.md`: the chosen scenario, the final thresholds, the run id and fingerprint the choice rests on, and the owner's reasons in their words.
2. Offer `/ad:adr` only when the choice is hard to reverse, surprising without context, and the result of a real trade-off.
3. Adoption into production code is a separate piece of work: offer `/ad:task` with the chosen scenario, its thresholds as acceptance criteria, and a link to the experiment.
4. Commit the experiment folder through `/ad:commit` (`runs/` stays ignored).

## Output contract

- `experiments/NNNN-<slug>/` with `plan.md`, `experiment.json`, `testset/`, `rubrics/` (when judged), `scenarios/` (when built), the runner, `results.md` and `results.csv`; `runs/` holds raw records, judge passes and considerations and is gitignored.
- Every reported number comes from `experiment.mjs score` on a run whose fingerprint matches the current frozen inputs.
- The chat report gives the summary, the flagged cases with considerations, and patterns; it never declares a winner.
- The threshold log in `plan.md` records every threshold change with its reason; the `Decision` section records the owner's choice.
- No production code changes.

## Next

- After the choice: `/ad:task` to adopt the chosen scenario, with the thresholds as acceptance criteria; `/ad:tdd` to implement it.
- A hard-to-reverse choice: `/ad:adr`.
- A scenario failing for reasons that look like a bug: `/ad:diagnose`.
