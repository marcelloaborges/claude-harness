# Claude harness

A Claude Code skill set for disciplined software engineering: understand the ask, ground it, build it test-first, review it, land it, and hand off between sessions.

Derived from [agentic-development](https://github.com/alexandremendoncaalvaro/agentic-development) by Alexandre Alvaro (MIT, see [LICENSE](LICENSE)). It keeps only the Claude Code skills for engineering work. The npm installer, the Codex support, and the writing, research, spike and release skills were removed.

## Layout

```
.claude/
  settings.json        session hooks (wired to .claude/skills/ad-hooks/scripts)
  agents/              fresh-context-reviewer (/ad-review), experiment-judge (/ad-experiment)
  skills/              the 23 ad-* skills
.agentic/gates.json    settings for the receipt gate hook
```

## Use it in a project

Copy `.claude/` (and `.agentic/` if you want the receipt gate settings) into the project root, then start Claude Code there and run `/ad-next`.

The hooks in `settings.json` use `${CLAUDE_PROJECT_DIR}/.claude/skills/...`, so they only work when the skills live inside the project. If you install the skills at user level (`~/.claude/skills/`) instead, change those paths to absolute ones.

## Skills

| Stage | Skills |
| --- | --- |
| Orient | `/ad-next` (what to do next), `/ad-project-state` (used by the others) |
| Posture | `/ad-philosophy` (loads automatically on non-trivial work) |
| Sharpen the ask | `/ad-grill-me`, `/ad-domain` (glossary) |
| Plan | `/ad-spec`, `/ad-task`, `/ad-adr` |
| Ground | `/ad-ground` (research before coding), `/ad-experiment` (measure competing approaches on a test set) |
| Build | `/ad-tdd`, `/ad-diagnose` (hard bugs), `/ad-deepen` (refactor for depth) |
| Review | `/ad-review` (two-axis, fresh context) |
| Land | `/ad-commit`, `/ad-pr`, `/ad-merge` |
| Project docs | `/ad-bootstrap` (AGENTS.md / CLAUDE.md), `/ad-architecture`, `/ad-guidelines`, `/ad-drift` |
| Gates and sessions | `/ad-hooks`, `/ad-handoff` |

Typical routes:

- New feature: `/ad-grill-me` → `/ad-spec` → `/ad-task` → `/ad-ground` → `/ad-tdd` → `/ad-review`
- Bug: `/ad-diagnose` → regression test → `/ad-review`
- Ship: `/ad-commit` → `/ad-pr` → `/ad-merge`
- Compare approaches: `/ad-experiment` (scenarios, test set, metrics → per-case results → threshold iteration → your choice) → `/ad-task` to adopt it

## Hooks

| Event | Script | What it does |
| --- | --- | --- |
| `UserPromptSubmit` | `workflow-checkpoint.mjs` | Adds the workflow steps to every prompt. Edit `CHECKPOINT` to change them. |
| `Stop` | `handoff-nudge.mjs` | Suggests `/ad-handoff` once per long session |
| `PostToolUse` (Edit/Write) | `artifact-gate.mjs` | Validates `GROUND-` records under `doc/research/` |
| `PostToolUse` (Edit/Write) | `handoff-chip.mjs` | Reminds Claude to offer a resume chip after writing a handoff |
| `PreToolUse` (Bash/PowerShell) | `command-guard.mjs` | Blocks killing processes by name and `check; git commit` chains |
| `PreToolUse` (Bash) | `sequence-gate.mjs` | Logs only: records whether a push or PR had a passing gate run and review |

Each hook has an off switch (for example `AD_WORKFLOW_CHECKPOINT=0`). See `.claude/skills/ad-hooks/references/session-tier.md`.

