# Claude harness

A Claude Code plugin (`ad`) for disciplined software engineering: understand the ask, ground it, build it test-first, review it, land it, and hand off between sessions.

Derived from [agentic-development](https://github.com/alexandremendoncaalvaro/agentic-development) by Alexandre Alvaro (MIT, see [LICENSE](LICENSE)). It keeps only the Claude Code skills for engineering work. The npm installer, the Codex support, and the writing, research, spike and release skills were removed.

## Install

This repository is both the plugin and a one-plugin marketplace (`ad-harness`).

```
/plugin marketplace add marcelloaborges/claude-harness
/plugin install ad@ad-harness
```

Or from a shell: `claude plugin marketplace add marcelloaborges/claude-harness`, then `claude plugin install ad@ad-harness`. Then run `/ad:next` in any project.

To try a local checkout without installing it: `claude --plugin-dir <path-to-this-repo>` (run `/reload-plugins` after edits). Check the package with `claude plugin validate <path-to-this-repo>`.

Requires Node.js on `PATH` (the hooks and skill scripts are zero-dependency `.mjs` files).

## Layout

```
.claude-plugin/
  plugin.json          plugin manifest (name: ad)
  marketplace.json     marketplace manifest (name: ad-harness)
skills/                the 23 skills, invoked as /ad:<skill>
agents/                ad:fresh-context-reviewer (/ad:review), ad:experiment-judge (/ad:experiment)
hooks/hooks.json       session hooks (scripts in skills/hooks/scripts)
.agentic/gates.json    example per-repository settings for the receipt gate
```

Skills reference their scripts through `${CLAUDE_PLUGIN_ROOT}`, which Claude Code fills in with the plugin's install directory when a skill loads.

## Skills

| Stage | Skills |
| --- | --- |
| Orient | `/ad:next` (what to do next), `/ad:project-state` (used by the others) |
| Posture | `/ad:philosophy` (loads automatically on non-trivial work) |
| Sharpen the ask | `/ad:grill-me`, `/ad:domain` (glossary) |
| Plan | `/ad:spec`, `/ad:task`, `/ad:adr` |
| Ground | `/ad:ground` (research before coding), `/ad:experiment` (measure competing approaches on a test set) |
| Build | `/ad:tdd`, `/ad:diagnose` (hard bugs), `/ad:deepen` (refactor for depth) |
| Review | `/ad:review` (two-axis, fresh context) |
| Land | `/ad:commit`, `/ad:pr`, `/ad:merge` |
| Project docs | `/ad:bootstrap` (AGENTS.md / CLAUDE.md), `/ad:architecture`, `/ad:guidelines`, `/ad:drift` |
| Gates and sessions | `/ad:hooks`, `/ad:handoff` |

Typical routes:

- New feature: `/ad:grill-me` → `/ad:spec` → `/ad:task` → `/ad:ground` → `/ad:tdd` → `/ad:review`
- Bug: `/ad:diagnose` → regression test → `/ad:review`
- Ship: `/ad:commit` → `/ad:pr` → `/ad:merge`
- Compare approaches: `/ad:experiment` (scenarios, test set, metrics → per-case results → threshold iteration → your choice) → `/ad:task` to adopt it

## Hooks

The hooks are active in every session where the plugin is enabled. Don't also copy them into `.claude/settings.json`, or each one runs twice.

| Event | Script | What it does |
| --- | --- | --- |
| `UserPromptSubmit` | `workflow-checkpoint.mjs` | Adds the workflow steps to every prompt. Edit `CHECKPOINT` to change them. |
| `Stop` | `handoff-nudge.mjs` | Suggests `/ad:handoff` once per long session |
| `PostToolUse` (Edit/Write) | `artifact-gate.mjs` | Validates `GROUND-` records under `doc/research/` |
| `PostToolUse` (Edit/Write) | `handoff-chip.mjs` | Reminds Claude to offer a resume chip after writing a handoff |
| `PreToolUse` (Bash/PowerShell) | `command-guard.mjs` | Blocks killing processes by name and `check; git commit` chains |
| `PreToolUse` (Bash) | `sequence-gate.mjs` | Logs only: records whether a push or PR had a passing gate run and review |

Each hook has an off switch, an environment variable such as `AD_WORKFLOW_CHECKPOINT=0`. Plugins can't ship settings, so set these in the `env` block of your own `.claude/settings.json` or `.claude/settings.local.json`. See [skills/hooks/references/session-tier.md](skills/hooks/references/session-tier.md).

The receipt gate also reads per-repository settings from `.agentic/gates.json` in the project being worked on. To record gate runs, `/ad:hooks` copies `gate-run.mjs` into the project as `.agentic/gate-run.mjs`.

## Upgrading from the `.claude/` layout

If a project has the old copy under `.claude/skills/ad-*`, `.claude/agents/` and the hook block in `.claude/settings.json`, delete them after installing the plugin. Otherwise every skill appears twice and every hook runs twice. Skill names changed from `/ad-<name>` to `/ad:<name>`.
