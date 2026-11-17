/** The longest file name sent to Slack. */
export const MAX_FILENAME_LENGTH = 255;

/**
 * A file name a node declared, reduced to something safe to show in Slack:
 * the base name only (either separator), control characters and Unicode line
 * and bidi controls removed, surrounding space trimmed, capped in length with
 * the extension kept. Falls back to "file" when nothing is left.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.toWellFormed().split(/[\\/]/).pop() ?? "";
  // C0 and C1 controls, line and paragraph separators, bidi overrides and isolates, zero-width marks.
  let name = base.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/g, "").trim();
  if (name === "" || name === "." || name === "..") return "file";
  const points = [...name];
  if (points.length > MAX_FILENAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 20 ? [...name.slice(dot)] : [];
    name = [...points.slice(0, MAX_FILENAME_LENGTH - ext.length), ...ext].join("");
  }
  return name;
}
