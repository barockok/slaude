/** @jsxImportSource @opentui/react */
import { forText } from "./ansi";

export interface HelpProps {
  lines: string[];
}

/** The /help bottom-sheet: a bordered, focused scrollbox of help lines. Focused so ↑/↓ scroll
 *  the list; Esc-to-close is handled by the parent's useKeyboard. */
export function Help({ lines }: HelpProps) {
  return (
    <box border title="help — Esc to close" flexDirection="column">
      <scrollbox focused>
        {lines.map((l, i) => (
          <text key={i}>{forText(l)}</text>
        ))}
      </scrollbox>
    </box>
  );
}
