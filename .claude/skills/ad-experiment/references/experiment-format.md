# Experiment format

Loaded on demand from `ad-experiment/SKILL.md`. Paths are relative to the experiment folder `experiments/NNNN-<slug>/`.

## Contents

- Folder layout
- `experiment.json`
- Test set: `testset/cases.jsonl`
- Records: `runs/<run>/records/<scenario>.jsonl`
- Metrics: how each type is computed
- Thresholds
- Flags
- Considerations: `runs/<run>/considerations.json`
- Script commands

## Folder layout

```
experiments/NNNN-<slug>/
  plan.md                     narrative: question, scenarios, threshold log, decision
  experiment.json             machine config read by experiment.mjs
  testset/cases.jsonl         frozen test set
  rubrics/<metric>.md         one rubric per judge metric (frozen)
  scenarios/<id>/             scenarios built for the experiment (if any)
  run.<ext>                   the runner, in the project's language
  results.md                  rendered by `score`
  results.csv                 rendered by `score`: every case × scenario
  runs/                       gitignored
    r1/
      fingerprint.json        hashes of test set, metrics, rubrics
      records/<scenario>.jsonl
      judge/<metric>/key.json, batch-NN.json, pass-N/batch-NN.json
      considerations.json
```

## `experiment.json`

```json
{
  "title": "Invoice field extraction",
  "question": "How do the regex parser and the LLM extractor perform on real invoices?",
  "baseline": "A",
  "scenarios": [
    { "id": "A", "name": "regex parser (current)", "source": "src/invoices/parse.ts" },
    { "id": "B", "name": "LLM extractor, prompt v1", "source": "scenarios/B/" }
  ],
  "testset": "testset/cases.jsonl",
  "metrics": [
    { "name": "accuracy", "type": "accuracy", "match": "normalized" },
    { "name": "f1", "type": "f1", "positive": "approved", "match": "exact" },
    { "name": "latency", "type": "latency" },
    { "name": "cost", "type": "cost" },
    { "name": "errors", "type": "errors" },
    { "name": "field_overlap", "type": "custom" },
    {
      "name": "faithfulness",
      "type": "judge",
      "scale": [1, 5],
      "rubric": "rubrics/faithfulness.md",
      "passes": 3,
      "judgeSees": ["input", "output", "expected"]
    }
  ],
  "thresholds": [],
  "flags": { "judgeSpread": 1, "latencyFactor": 3 }
}
```

- `scenarios[].id`: letters, digits, `_`, `-`. It names the records file.
- `testset` defaults to `testset/cases.jsonl`.
- `metrics` and the rubric files are part of the fingerprint; `thresholds`, `flags`, `title`, `question` and scenario descriptions are not.
- `flags.judgeSpread`: flag a case when its judge passes differ by at least this much (default 1). `flags.latencyFactor`: flag a case slower than this multiple of the scenario's median latency (default 3).

## Test set: `testset/cases.jsonl`

One JSON object per line:

```json
{"id": "inv-001", "input": {"text": "..."}, "expected": {"total": "120.00"}, "tags": ["scanned", "edge"]}
```

- `id` (required, unique), `input` (any JSON), `expected` (any JSON; omit when there is no objective answer), `tags` (optional strings; results are broken down by tag).

## Records: `runs/<run>/records/<scenario>.jsonl`

One line per case, written by the runner:

```json
{"case": "inv-001", "scenario": "B", "output": {"total": "120.00"}, "latency_ms": 812.4, "cost": 0.0021, "error": null, "metrics": {"field_overlap": 0.92}}
```

- `case`, `scenario` (required), `output` (any JSON), `latency_ms` (number), `cost` (number), `error` (string or null), `metrics` (numbers for `custom` metrics).
- Re-running one scenario replaces its file. A duplicate (case, scenario) pair is reported under `problems`; the last line wins.
- A case with no record for a scenario is flagged `missing`.

## Metrics: how each type is computed

| Type | Per case | Per scenario |
| --- | --- | --- |
| `accuracy` | 1 when `output` equals `expected` (`exact`: canonical JSON; `normalized`: strings trimmed, spaces collapsed, lowercased), else 0. An errored record counts as 0. Cases without `expected` are skipped. | mean, with correct / n |
| `f1` | none | macro precision, recall and F1 over all labels; binary for the `positive` label when set. Errored records are excluded (they are counted by `errors`). |
| `latency` | `latency_ms` | n, mean, std, min, p50, p95, max (nearest-rank percentiles) |
| `cost` | `cost` | the same stats plus `total` |
| `errors` | 1 when `error` is set | count and rate |
| `custom` | `metrics.<name>` | n, mean, std, min, p50, p95, max |
| `judge` | mean of the passes; spread = max − min | mean, std and the rest of the stats over case means, plus mean and max spread |

## Thresholds

```json
"thresholds": [
  { "metric": "accuracy", "op": ">=", "value": 0.9 },
  { "metric": "latency", "stat": "p95", "op": "<=", "value": 200 },
  { "metric": "cost", "stat": "total", "op": "<=", "value": 5 },
  { "metric": "faithfulness", "level": "case", "op": ">=", "value": 4 },
  { "metric": "accuracy", "op": ">=", "value": 0.95, "scenarios": ["B", "C"] }
]
```

- `op`: `>=`, `>`, `<=`, `<`, `==`.
- Aggregate thresholds (default) compare one statistic per scenario. Default statistic: `value` for `accuracy` and `f1`, `p95` for `latency`, `mean` for `cost`, `custom` and `judge`, `count` for `errors`. Any statistic in the summary can be named with `stat` (for example `rate` for `errors`, `recall` for `f1`).
- Case thresholds (`"level": "case"`) are checked on every case. The results show how many cases pass per scenario, and failing cases are flagged `below:<metric>`. `f1` has no per-case value.
- `scenarios` limits a threshold to some scenarios.

## Flags

| Flag | Meaning |
| --- | --- |
| `missing` | no record for this scenario |
| `error` | the record has an `error` |
| `incorrect` | an `accuracy` metric scored 0 |
| `disagree` | scenarios produced different outputs (errored records excluded) |
| `judge-spread:<metric>` | judge passes differ by at least `flags.judgeSpread` |
| `slow` | latency above `flags.latencyFactor` × the scenario median |
| `below:<metric>` | a case threshold fails |

## Considerations: `runs/<run>/considerations.json`

```json
{
  "inv-014": "Both miss the total on scanned invoices: the OCR text splits the amount across two lines.",
  "inv-014/B": "B invents a currency symbol not in the input."
}
```

Keys are a case id, or `<case>/<scenario>` for a note about one scenario. `score` renders them into `results.md` and `results.csv`, and reports `unnotedFlagged` until every flagged case has a note.

## Script commands

Run from the repository root; each prints one JSON object, and failures print `{"error": ...}` with exit code 1.

| Command | Does |
| --- | --- |
| `experiment.mjs prepare <dir> [--fresh]` | Validates the config and test set, fingerprints the frozen inputs, returns the run to write into (reuses the latest run when nothing changed; `--fresh` forces a new one). |
| `experiment.mjs judge-prep <dir> --metric <name> [--run <id>] [--batch <n>]` | Writes blinded, shuffled batches of at most `n` items (default 25) and the id key for one judge metric. |
| `experiment.mjs score <dir> [--run <id>]` | Refuses a run whose fingerprint no longer matches; computes metrics, thresholds and flags; writes `results.md` and `results.csv`. |
