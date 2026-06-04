/** Pure Tab-completion for the REPL: given the current line and the known command names,
 *  return the candidates that share the typed prefix. Only completes the command head — once
 *  an argument is being typed (a space appears) there's nothing to complete. cli.ts adapts
 *  this to readline's `[hits, line]` completer contract. */
export function completeLine(line: string, candidates: string[]): string[] {
  if (!line.startsWith("/") || line.includes(" ")) return [];
  return candidates.filter((c) => c.startsWith(line));
}
