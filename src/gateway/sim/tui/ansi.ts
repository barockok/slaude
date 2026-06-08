// src/gateway/sim/tui/ansi.ts
import { stripAnsiSequences } from "@opentui/core";

// Adapt a render.ts line for an OpenTUI <text>: <text> renders raw ANSI as literal characters
// (spike verdict, API-NOTES.md), so strip the escape codes. Color is dropped in MVP; a future
// enhancement can convert ANSI → StyledText (core: StyledText/fg/bold) to restore it.
export function forText(line: string): string {
  return stripAnsiSequences(line);
}
