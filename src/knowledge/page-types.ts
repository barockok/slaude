/** Memory page types (spec §8.2), exact strings. Dependency-free so the tool
 *  contracts can import it; src/knowledge/memory-pages.ts re-exports it. */
export type PageType =
  | "profile"
  | "person-note"
  | "commitment"
  | "investigation"
  | "correction"
  | "outcome"
  | "lessons"
  | "heartbeat"
  | "team-fact"
  | "proactive-rule"
  | "heartbeat-journal";

export const PAGE_TYPES: readonly PageType[] = [
  "profile", "person-note", "commitment", "investigation", "correction", "outcome", "lessons", "heartbeat", "team-fact",
  "proactive-rule", "heartbeat-journal",
];
