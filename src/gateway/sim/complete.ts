/** Pure Tab-completion for the REPL: given the current line and the known command names,
 *  return the candidates that share the typed prefix. Only completes the command head — once
 *  an argument is being typed (a space appears) there's nothing to complete. cli.ts adapts
 *  this to readline's `[hits, line]` completer contract. */
export function completeLine(line: string, candidates: string[]): string[] {
  if (!line.startsWith("/") || line.includes(" ")) return [];
  return candidates.filter((c) => c.startsWith(line));
}

/** Complete the FIRST argument of a command (e.g. `/layer al` → `/layer allowed`) from a
 *  per-command candidate map. Returns full-line completions; empty once a 2nd arg begins. */
export function completeArg(line: string, args: Record<string, string[]>): string[] {
  const sp = line.indexOf(" ");
  if (sp < 0) return [];
  const head = line.slice(0, sp);
  const rest = line.slice(sp + 1);
  if (rest.includes(" ")) return [];
  const cands = args[head];
  if (!cands) return [];
  return cands.filter((c) => c.startsWith(rest)).map((c) => `${head} ${c}`);
}
