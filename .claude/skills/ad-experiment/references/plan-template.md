# Plan template

Copy into `experiments/NNNN-<slug>/plan.md` and fill every `<placeholder>`. Remove a section only when it does not apply; keep `Threshold log` and `Decision` even when empty.

````markdown
# Experiment NNNN — <title>

**Status:** planning | running | iterating | closed
**Created:** <YYYY-MM-DD>

## Question

<One sentence: what is compared, and for what use.>

## Scenarios

| Id | Name | What differs | Source | Invocation |
| --- | --- | --- | --- | --- |
| A | <name> (baseline) | <model / prompt / algorithm / config> | <existing path, or scenarios/A/> | <how the runner calls it> |
| B | <name> | <...> | <...> | <...> |

## Test set

- **Source:** <user dataset path, or "drafted for this experiment, approved <date>">
- **Size:** <n> cases; tags: <tag (count), ...>
- **Expected outputs:** <all / some / none — and why>

## Metrics

| Metric | Type | Definition |
| --- | --- | --- |
| <accuracy> | accuracy | <exact / normalized match against expected> |
| <faithfulness> | judge (1–5, 3 passes) | rubric: `rubrics/faithfulness.md` |

## Runs

| Run | Fingerprint | Why it started |
| --- | --- | --- |
| r1 | <id> | first run |

## Threshold log

Append-only. One entry per change.

- <YYYY-MM-DD> — <threshold added / changed / removed> — <the owner's reason>

## Decision

- **Chosen scenario:** <id and name, or "none yet">
- **Final thresholds:** <list>
- **Evidence:** run <id>, fingerprint <id>, `results.md`
- **Owner's reasons:** <in the owner's words>
- **Follow-up:** <task / ADR links>
````
