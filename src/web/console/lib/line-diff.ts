/**
 * A line diff (longest common subsequence) for showing a console override
 * against its source text. GUARDRAIL.md is at most 64 KB, so the quadratic
 * table stays small; past a bound the diff falls back to "everything
 * changed" rather than freezing the page.
 */

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

const MAX_CELLS = 4_000_000;

export function lineDiff(from: string, to: string): DiffLine[] {
  const a = from.split(/\r?\n/);
  const b = to.split(/\r?\n/);
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i++]! });
    } else {
      out.push({ kind: "add", text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}
