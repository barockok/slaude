/** Shell-style Ctrl-C at the prompt: a non-empty line is cleared; an empty line warns once,
 *  then a second consecutive Ctrl-C exits. `pending` is whether a prior warn is still armed.
 *  (Mid-turn Ctrl-C is handled separately — there it aborts the running turn.) */
export function sigintAction(pending: boolean, lineLength: number): { action: "clear" | "warn" | "exit"; pending: boolean } {
  if (lineLength > 0) return { action: "clear", pending: false };
  if (!pending) return { action: "warn", pending: true };
  return { action: "exit", pending: false };
}
