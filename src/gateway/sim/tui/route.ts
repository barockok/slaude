// src/gateway/sim/tui/route.ts
// Pure classification of a submitted REPL line into a view action. Keeps the React
// component free of branching logic and makes the routing unit-testable.
export type SubmitAction =
  | { kind: "noop" }
  | { kind: "help" }
  | { kind: "picker"; which: "layer" | "as" }
  | { kind: "send"; text: string };

export function routeSubmit(raw: string): SubmitAction {
  const t = raw.trim();
  if (!t) return { kind: "noop" };
  if (t === "/help") return { kind: "help" };
  if (t === "/layer") return { kind: "picker", which: "layer" };
  if (t === "/as") return { kind: "picker", which: "as" };
  return { kind: "send", text: raw };
}
