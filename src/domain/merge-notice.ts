/**
 * The Slack notice a merge sends (slice C, task 27). The engine calls
 * `queueMergeNotice` once, after the merge commits. Task 27 fills this in;
 * until then it does nothing and the ledger row stays `pending`.
 */
export function queueMergeNotice(_mergeId: string): void {
  /* filled by task 27 */
}
