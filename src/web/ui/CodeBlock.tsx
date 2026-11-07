import { useEffect, useState } from "react";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { IconCheck, IconCopy } from "./icons";

export interface CodeBlockProps {
  code: string;
  /** Short label shown in the header, e.g. "json". */
  language?: string;
  className?: string;
}

/** Monospace block with a copy button. Copy failures are silent; the text stays selectable. */
export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      /* clipboard blocked; the text is still selectable */
    }
  };

  return (
    <div className={cx("sl-code", className)}>
      <div className="sl-code__head">
        <span className="sl-code__lang">{language ?? ""}</span>
        <IconButton label={copied ? "Copied" : "Copy"} size="sm" onClick={copy}>
          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
        </IconButton>
      </div>
      <pre className="sl-code__pre" tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
