/**
 * The undo window and what undo does not do (slice C). No imports: the console
 * dev stub shows the same text, so this file must stay free of server code.
 */

/** D1: how long a merge can be undone. */
export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const days = Math.round(UNDO_WINDOW_MS / 86_400_000);

/** Stated in the console beside every merge and in the release note. */
export const UNDO_LIMITS: readonly string[] = [
  "Undo moves records and grants back. Credentials and memory slices were never moved, so undo does not touch them.",
  "Items changed after the merge (a binding unlinked, a grant revoked or edited) are not reverted: they are left as they are and listed as skipped.",
  `Past the window (${days} days) undo is refused.`,
  "A merge that a later merge chained onto must be undone later-first.",
  "A deleted account is not restored.",
];
export const PROOF_UNDO_LIMIT =
  "Undoing a proof merge also removes the link between the Slack account and the sign-in account, and forbids that pair from linking again until an operator lifts the veto.";
