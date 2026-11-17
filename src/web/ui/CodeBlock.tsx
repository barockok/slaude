import { cx } from "./cx";
import { CopyButton } from "./CopyButton";

export interface CodeBlockProps {
  code: string;
  /** Short label shown in the header, e.g. "json". */
  language?: string;
  className?: string;
}

/** Monospace block with a copy button that says "Copied" or "Copy failed"; the text stays selectable. */
export function CodeBlock({ code, language, className }: CodeBlockProps) {
  return (
    <div className={cx("sl-code", className)}>
      <div className="sl-code__head">
        <span className="sl-code__lang">{language ?? ""}</span>
        <CopyButton text={code} label="Copy" />
      </div>
      <pre className="sl-code__pre" tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
