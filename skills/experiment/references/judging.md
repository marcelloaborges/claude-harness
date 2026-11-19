# Judging non-deterministic metrics

Loaded on demand from `experiment/SKILL.md` for every `judge` metric.

## Write the rubric

`rubrics/<metric>.md` defines one quality on the metric's scale. It is frozen with the test set: editing it starts a new run.

```markdown
# Faithfulness

Does the output state only what the input supports?

- **5** — Every claim is supported by the input. Example: ...
- **4** — Supported, with one harmless omission or rewording. Example: ...
- **3** — One unsupported detail that does not change the meaning. Example: ...
- **2** — An unsupported claim that changes the meaning. Example: ...
- **1** — Mostly unsupported or contradicts the input. Example: ...

Ignore: style, length, formatting.
Use `expected` only as a reference answer, not as the only acceptable wording.
```

Rules for a usable rubric:

- One quality per rubric. Two qualities make two metrics.
- Every scale point is defined, with an example.
- Say what to ignore, so the judge does not score style when the metric is about facts.
- Say how to use `expected` when the judge sees it. Set `judgeSees` in `experiment.json` to hide it (or the input) when it would bias the score.

## Prepare blinded batches

```bash
node "<skill-dir>/scripts/experiment.mjs" judge-prep experiments/NNNN-<slug> --metric <name>
```

`<skill-dir>` is this skill's base directory: the same `experiment.mjs` path SKILL.md runs for `prepare` and `score`.

It shuffles every successful record of the run with a seed derived from the run and metric, replaces the (case, scenario) pair with an opaque id (`j0001`, ...), and writes `runs/<run>/judge/<metric>/batch-NN.json`. `key.json` maps ids back to cases and scenarios; never pass it to the judge.

## Run the passes

For each pass `p` in `1..passes` and each batch file, delegate to the `ad:experiment-judge` subagent with a prompt that names exactly:

- the rubric path and the scale,
- the batch file path,
- the output path `runs/<run>/judge/<metric>/pass-<p>/<batch file name>`.

Example prompt:

```
Score the items in experiments/0003-invoice-extraction/runs/r1/judge/faithfulness/batch-02.json
against the rubric experiments/0003-invoice-extraction/rubrics/faithfulness.md on the scale 1-5.
Write your scores to experiments/0003-invoice-extraction/runs/r1/judge/faithfulness/pass-2/batch-02.json.
```

Each call is independent: never give a pass the scores of another pass. Independent calls may run in parallel. Do not add hints about which scenario an item came from, and do not score items yourself.

Each pass file is a JSON array: `[{"id": "j0001", "score": 4, "reason": "one short sentence"}]`. `score` reports items without scores, ids not in the key and scores outside the scale under `problems`. Re-run the missing batch rather than filling in scores.

## Read the spread

`score` reports each case's mean across passes and its spread (max − min). A large spread usually means the rubric is ambiguous for that kind of case. Read the judge reasons on the flagged items and say so in the considerations, for example: "The rubric does not say how to score partial answers; the passes split 2/4/4."

## When the test set is large

Subagent judging costs one call per batch per pass. With thousands of records, say so at plan approval, and offer either a sample (stratified by tag, fixed before the run) or a judge called from the runner through an API the project already uses, scoring the same rubric blind and writing the same pass files.
