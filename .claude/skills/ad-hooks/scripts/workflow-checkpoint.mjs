#!/usr/bin/env node
/**
 * Session-lifecycle workflow-checkpoint hook for ad-hooks. Wired as a Claude
 * Code `UserPromptSubmit` hook: plain-text stdout on exit 0 is added to the
 * model's context before it processes the prompt
 * (https://code.claude.com/docs/en/hooks). The event has no matcher and fires
 * on every prompt, so the checkpoint never inspects the prompt; its text is
 * fixed.
 *
 * Skills and CLAUDE.md are advisory; this hook is the deterministic delivery of
 * the pipeline (sharpen, ground, TDD, review per slice, commit, handoff) at the
 * moment it matters. The wording is imperative on purpose: polite reminders
 * tend to be ignored, while an imperative instruction naming the skill is
 * followed.
 *
 * Contract: exit 0 always. Never exit 2 (that blocks and erases the prompt);
 * never emit a JSON decision object. Empty, malformed, or non-object stdin is
 * silent. `AD_WORKFLOW_CHECKPOINT=0` silences the hook entirely.
 *
 * Zero dependencies, Node-only.
 *
 * Manual smoke-test (stdin must be piped, or `readFileSync(0)` waits on a TTY):
 *   echo '{"hook_event_name":"UserPromptSubmit","prompt":"x"}' | node workflow-checkpoint.mjs
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CHECKPOINT = [
  'Workflow checkpoint. Trivial request (typo, one-liner, a question)? Skip this.',
  'Otherwise, in order:',
  '1. Open with a 3-line summary of what this task will do and a checklist roadmap (done / remaining). Confirm the rules were read; do not recite them.',
  '2. Unknowns or a fuzzy ask: /ad-grill-me.',
  '3. Before code: /ad-ground and its evidence record.',
  '4. Implement with /ad-tdd; a hard bug goes through /ad-diagnose.',
  '5. Review only what is not yet covered: /ad-review on each slice, then on the delta after a fix.',
  '6. Land with /ad-commit; /ad-pr and /ad-merge ask the owner once before the outward step.',
  '7. Ending, or context running low: /ad-handoff for a resume chip, or a fresh-session prompt where chips are unavailable.',
].join('\n');

/**
 * Kill switch: `AD_WORKFLOW_CHECKPOINT=0` (or `false`/`off`) silences the hook.
 * Any other value, including unset, keeps it on.
 */
export function isEnabled(env) {
  const raw = String(env.AD_WORKFLOW_CHECKPOINT ?? '')
    .trim()
    .toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

/**
 * Read all of stdin (fd 0) synchronously. Returns '' on any failure — a hook
 * that cannot read its input must degrade to silent, never break the session.
 */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * True only for a parseable JSON object on stdin. Anything else (empty input,
 * malformed JSON, `null`, arrays, scalars) is not a hook event and yields
 * silence rather than a crash or a stray message.
 */
export function isHookEvent(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  try {
    const event = JSON.parse(text);
    return event !== null && typeof event === 'object' && !Array.isArray(event);
  } catch {
    return false;
  }
}

function main() {
  if (!isEnabled(process.env)) return;
  if (!isHookEvent(readStdin())) return;
  process.stdout.write(`${CHECKPOINT}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
