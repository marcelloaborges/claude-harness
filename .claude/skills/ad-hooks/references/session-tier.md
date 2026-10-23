# Session-lifecycle hooks (Claude Code)

Loaded on demand from `ad-hooks/SKILL.md`. Each subsection is one hook of the tier.

## Contents

- Handoff-nudge `Stop` hook
- Workflow-checkpoint `UserPromptSubmit` hook
- Artifact-validator `PostToolUse` gate
- Handoff-chip `PostToolUse` reminder
- Shadow receipt gate on `PreToolUse`
- Command guard on `PreToolUse`
- Resolving the script path


Steps 0–6 scaffold *git* hooks (they fire on commit / push). Claude Code also exposes *session-lifecycle* hooks in `.claude/settings.json` that fire on agent events. This tier scaffolds those; it has six members.

## Handoff-nudge `Stop` hook

Nudges the user to run `/ad-handoff` before a long session's context is compacted or lost. Key facts (verified against the official hooks docs):

* It hangs off the **`Stop`** event (fires when Claude finishes a turn), **not `PreCompact`** — `PreCompact` can only allow or block compaction, it cannot inject a message.
* It emits **`{"systemMessage": …}` on exit 0 with no `decision` field**, so the session stops normally and the nudge **cannot loop**. It never uses `decision: "block"` or `hookSpecificOutput.additionalContext` (both continue the turn — loop-prone and disruptive).
* It is **size-gated** (silent below a transcript-size threshold, read from `transcript_path` via `statSync`) and fires **at most once per session** (a temp-dir flag keyed on `session_id`), plus a defensive `stop_hook_active` early-exit — so it never nags every turn.

Scaffold it in two parts:

1. **The script** ships with this skill at `scripts/handoff-nudge.mjs` (Node, zero-dependency).
2. **The wiring** — merge (never clobber) a `Stop` block into `.claude/settings.json` (see *Resolving the script path* below for `<ad-hooks-dir>`):

   ```json
   {
     "hooks": {
       "Stop": [
         {
           "matcher": "*",
           "hooks": [
             { "type": "command", "command": "node \"<ad-hooks-dir>/scripts/handoff-nudge.mjs\"" }
           ]
         }
       ]
     }
   }
   ```

   Preserve any existing `.claude/settings.json` / `.claude/settings.local.json` content (e.g. a `permissions` block) — merge the `Stop` array in, do not overwrite the file.

Tunable via environment: `AD_HANDOFF_NUDGE_THRESHOLD_BYTES` (default `750000` — chosen from measured transcript sizes; lower it to nudge earlier) and `AD_HANDOFF_NUDGE_STATE_DIR` (flag-file directory; default the OS temp dir).

## Workflow-checkpoint `UserPromptSubmit` hook

Puts the pipeline in front of the model on every prompt. Skills and `AGENTS.md` are advisory; this hook is the deterministic delivery that replaces the owner repeating "follow the workflow" by hand. Key facts (verified against the official hooks docs):

* It hangs off **`UserPromptSubmit`**, one of the events whose plain-text stdout on exit 0 is added as context the model can act on. The event has no matcher and fires on every prompt.
* The checkpoint's text is **fixed** (imperative): skip when trivial; open with a three-line summary and a checklist roadmap without reciting the rules; `/ad-grill-me` for unknowns; `/ad-ground` before code; `/ad-tdd` to implement and `/ad-diagnose` for hard bugs; `/ad-review` after each slice; `/ad-commit` to land; `/ad-handoff` at the end for a chip or a fresh-session prompt. Edit `CHECKPOINT` in the script to change it.
* It **always exits 0** and never emits a JSON decision, so it cannot block or erase a prompt. Empty or malformed stdin is silent. `AD_WORKFLOW_CHECKPOINT=0` silences it.

Scaffold it in two parts:

1. **The script** ships with this skill at `scripts/workflow-checkpoint.mjs` (Node, zero-dependency).
2. **The wiring** — merge a `UserPromptSubmit` block into `.claude/settings.json`, beside any existing `Stop` block:

   ```json
   {
     "hooks": {
       "UserPromptSubmit": [
         {
           "hooks": [
             { "type": "command", "command": "node \"<ad-hooks-dir>/scripts/workflow-checkpoint.mjs\"" }
           ]
         }
       ]
     }
   }
   ```

## Artifact-validator `PostToolUse` gate

Runs the ground-record validator after a skill writes a governed record, and shows a failure to the model inside the same turn. `ad-ground` tells the agent to run `validate-record.mjs` as a step; this gate is the deterministic delivery of that step. Key facts:

* It hangs off **`PostToolUse`** matched on **`Edit|Write`**. `PostToolUse` cannot block: a failure is shown by **exit 2 with the message on stderr** ("shows stderr to the model; the tool already ran"), a pass is a silent exit 0.
* It **routes by the file's first heading** under `doc/research/`: `GROUND-NNNN` to `ad-ground/scripts/validate-record.mjs`. Any other heading, any other path, an event without a path, and malformed stdin are silent.
* It distinguishes **four terminal states**: `validator-failed` and `runtime-unavailable` (the validator could not run) reach the model with a reproduction command; `validator-passed` and unowned events do not. A gate that cannot run never reports a pass.
* Every governed firing appends one JSON line to `<tmpdir>/agentic-artifact-gate/<session_id>.jsonl`, **outside the working tree**; `AD_ARTIFACT_GATE_EVIDENCE_DIR` redirects it. `AD_ARTIFACT_GATE=0` silences the gate. `AD_ARTIFACT_GATE_SKILLS_ROOT` points at the skills root when `ad-ground` is not installed beside `ad-hooks`.
* It is **feedback, not enforcement**: no decision object, no `PreToolUse` deny, no `Stop` continuation.

Scaffold it in two parts:

1. **The script** ships with this skill at `scripts/artifact-gate.mjs` (Node, zero-dependency).
2. **The wiring**, merged beside the existing blocks in `.claude/settings.json`:

   ```json
   {
     "hooks": {
       "PostToolUse": [
         {
           "matcher": "Edit|Write",
           "hooks": [
             { "type": "command", "command": "node \"<ad-hooks-dir>/scripts/artifact-gate.mjs\"" }
           ]
         }
       ]
     }
   }
   ```

Claude Code Desktop shares this wiring with the CLI but inherits only `PATH` and a fixed set of variables from the shell profile, so set `AD_ARTIFACT_GATE*` variables where Desktop sessions can see them, not only in `.zshrc`.

## Handoff-chip `PostToolUse` reminder

Reminds the model to offer the one-click resume chip when a handoff file is written, whether or not `/ad-handoff` ran. Key facts:

* It hangs off **`PostToolUse`** matched on **`Edit|Write`**, in the same entry as the artifact gate. It fires only when a written path is a Markdown file directly under an `agentic-handoffs` directory; paths are recovered with the artifact gate's own parser.
* It prints **`hookSpecificOutput.additionalContext` on exit 0**, the field that places text in the model's context for this event (plain stdout is ignored there). The text names the path, asks for the chip where the host has a chip tool, and for the path plus a fresh-session prompt where it does not.
* It is a **reminder, not a gate**: no validator, no evidence file, no exit 2, no decision object. Everything else is silent. `AD_HANDOFF_CHIP=0` silences it.

Scaffold it in two parts:

1. **The script** ships with this skill at `scripts/handoff-chip.mjs` (Node, zero-dependency; it imports `artifact-gate.mjs` from the same directory).
2. **The wiring** — add a command to the `Edit|Write` `PostToolUse` entry (create the entry when the artifact gate is not wired): `{ "type": "command", "command": "node \"<ad-hooks-dir>/scripts/handoff-chip.mjs\"" }` in `.claude/settings.json`.

## Shadow receipt gate on `PreToolUse`

Records, before a landing action, whether the workflow step it depends on left a fresh receipt for the exact state, so the owner's "did the local gate run for this?" has a logged answer. Shadow mode is the only mode: it never denies and nobody sees it during the session.

* **The receipt.** After the repository's CI-mirror command passes, `scripts/gate-run.mjs record --command "<command>" --exit 0` appends a receipt to `.agentic/receipts/gate-run.jsonl`, keyed to the git tree of the working copy (computed through an empty temporary index, so the real index is untouched and the tree equals the next commit's). Wire it where the command already runs: an npm `postverify` script, or the step after the pre-push runner. Add `.agentic/receipts/` to `.gitignore`.
* **The check.** `scripts/sequence-gate.mjs` hangs off **`PreToolUse`** matched on **`Bash`**. Before `git push` and `gh pr create` it looks for a passing gate-run receipt; before `gh pr create`, `gh pr ready` and `gh pr merge`, for a review receipt (an `ad-review` verdicts file's `Target-SHA:` line). A receipt is fresh when its tree, or its commit's tree, equals `HEAD^{tree}` or differs from it only in receipt-neutral paths (`receiptNeutral` globs in `.agentic/gates.json`, default `doc/tasks/**`), so a reworded or amended commit keeps its review. A review receipt with a second line `Base-SHA: <sha>` is a delta review and counts only when that base is an ancestor of its target and an earlier review receipt covers it.
* **Per repository.** In `.agentic/gates.json`, `"checks": { "review": false }` turns a check off. Where a review bot or harness does the review, `"checks": { "review": { "command": ["<program>", "<arg>"], "timeoutSeconds": 10 } }` replaces the review receipt: the command, an argument list run without a shell (a pipeline belongs in a script it names), runs with `AGENTIC_HEAD_SHA` set and exits 0 when that evidence exists for the commit. `timeoutSeconds` must be above 0 and at most 20; a timeout or an invalid setting logs `runtime-unavailable`, not `would-block`.
* **Matching and cost.** A chained command (`git push && gh pr create`) runs each check once, logged against the first action that needs it. Each check reads only the newest 20 receipt files, since `.agentic/reviews/` is never pruned, so a covering receipt older than 20 others reads as missing. `gh pr ready <n>` and `gh pr merge <n>` are compared with the local `HEAD`, which is the pull request's head only when its branch is checked out.
* **GitHub CLI wrappers.** `"githubCommands": ["gh", "<wrapper>"]` in `.agentic/gates.json` makes the gate see pull request commands run through a wrapper; plain names only.
* **Evidence only.** It appends one line per check of an action, state `clear`, `would-block` or `runtime-unavailable`, to `<tmpdir>/agentic-sequence-gate/<session_id>.jsonl` (`AD_SEQUENCE_GATE_EVIDENCE_DIR` redirects it). It always exits 0 and prints nothing. `AD_SEQUENCE_GATE=0` silences it. Enforcing any check is a later decision, once the shadow log shows it would not block good work.

Scaffold it in three parts: the receipt hook beside the CI-mirror command, the `.gitignore` line, and the wiring `{ "matcher": "Bash", "hooks": [ { "type": "command", "command": "node \"<ad-hooks-dir>/scripts/sequence-gate.mjs\"" } ] }` under `PreToolUse` in `.claude/settings.json`.

## Command guard on `PreToolUse`

`scripts/command-guard.mjs` denies a closed list of destructive shell patterns before they run: killing processes by name in command position (`pkill`, `killall`, `taskkill /IM`, `Stop-Process -Name` or `-ProcessName`, `spps`, `Get-Process ... | Stop-Process`, a kill fed by `pgrep`), and a `git commit` joined by `;` or a newline to an earlier check (tests, lint, type check, build, verify) in the same command line, staging steps in between included. Quoted strings and heredoc bodies are removed before matching, so text that only mentions a pattern passes. A denial prints one `hookSpecificOutput` deny decision whose reason names the fix (kill the PID you started; chain with `&&`). It fails open and `AD_COMMAND_GUARD=0` turns it off. Wire it as a `PreToolUse` entry matched on `Bash|PowerShell` in `.claude/settings.json`; it is a guardrail, not a sandbox (a command built at run time is not seen).

## Resolving the script path

Every hook in this tier runs from `.claude/settings.json`, read at session start; the command needs a path that exists wherever the harness was installed. Do not hard-code `${CLAUDE_PROJECT_DIR}/.claude/skills/...` when the skills live at user scope (`~/.claude/skills/ad-hooks`), where that path does not exist. Resolve `<ad-hooks-dir>` from the base directory stated at the top of this skill load and write it as an absolute path (or `${CLAUDE_PROJECT_DIR}/.claude/skills/ad-hooks` only when the skill actually loaded from the project). Scaffold a session-lifecycle hook only when the user asked for that hook: show the exact merged JSON and the target file, and write only after the user approves. Hook edits take effect in the next session.
