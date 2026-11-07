/**
 * Markdown shown rendered, with a toolbar to switch to the raw text and to
 * copy it. Rendering goes through the AST of ./md-parse and plain React
 * elements: no dangerouslySetInnerHTML, no raw HTML, links only to http(s)
 * and mailto.
 *
 * The Rendered or Raw choice is the viewer's, remembered in localStorage (when
 * the browser allows it) and shared by every markdown view on the page.
 */
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";
import { cx } from "./cx";
import { KeyValue } from "./Display";
import { IconButton } from "./Button";
import { IconCheck, IconCopy } from "./icons";
import { parseMarkdown, type Block, type Inline, type MdDoc } from "./md-parse";

export type MarkdownView = "rendered" | "raw";

const VIEW_KEY = "slaude.markdown.view";
const listeners = new Set<() => void>();
let memoryView: MarkdownView | null = null;

function readView(): MarkdownView {
  if (memoryView) return memoryView;
  try {
    return localStorage.getItem(VIEW_KEY) === "raw" ? "raw" : "rendered";
  } catch {
    return "rendered";
  }
}

export function setMarkdownView(v: MarkdownView): void {
  memoryView = v;
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The viewer's Rendered or Raw choice, shared by every markdown view. */
export function useMarkdownView(): [MarkdownView, (v: MarkdownView) => void] {
  const v = useSyncExternalStore(subscribe, readView, () => "rendered" as const);
  return [v, setMarkdownView];
}

/** Sources past this size show raw: the parser is not built for megabytes. */
const MAX_RENDER = 300_000;

// --- rendering -----------------------------------------------------------------

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return <Fragment key={i}>{n.v}</Fragment>;
      case "br":
        return <br key={i} />;
      case "code":
        return (
          <code key={i} className="sl-md__code">
            {n.v}
          </code>
        );
      case "strong":
        return <strong key={i}>{renderInline(n.c)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.c)}</em>;
      case "del":
        return <del key={i}>{renderInline(n.c)}</del>;
      case "link":
        return (
          <a key={i} className="sl-link sl-break" href={n.href} title={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.c)}
          </a>
        );
    }
  });
}

/**
 * Markdown headings sit under the page's own: `#` renders as an h3 and the
 * rest step down from there, so a document never adds a second page title.
 */
const HEADING_TAG = { 1: "h3", 2: "h4", 3: "h5", 4: "h6", 5: "h6", 6: "h6" } as const;

function renderBlocks(blocks: Block[], tight = false): ReactNode {
  return blocks.map((b, i) => {
    switch (b.t) {
      case "heading": {
        const Tag = HEADING_TAG[b.level];
        return (
          <Tag key={i} className={cx("sl-md__h", `sl-md__h${b.level}`)}>
            {renderInline(b.c)}
          </Tag>
        );
      }
      case "paragraph":
        return tight ? (
          <span key={i} className="sl-md__tight">
            {renderInline(b.c)}
          </span>
        ) : (
          <p key={i} className="sl-md__p">
            {renderInline(b.c)}
          </p>
        );
      case "code":
        return <CodeBlock key={i} className="sl-md__pre" code={b.v} language={b.lang || undefined} />;
      case "hr":
        return <hr key={i} className="sl-md__hr" />;
      case "blockquote":
        return (
          <blockquote key={i} className="sl-md__quote">
            {renderBlocks(b.blocks)}
          </blockquote>
        );
      case "list": {
        const items = b.items.map((it, k) => (
          <li key={k} className={cx("sl-md__li", it.checked !== null && "sl-md__task")}>
            {it.checked !== null && (
              <input type="checkbox" className="sl-md__check" checked={it.checked} disabled aria-label={it.checked ? "Done" : "Not done"} />
            )}
            {renderBlocks(it.blocks, b.tight)}
          </li>
        ));
        return b.ordered ? (
          <ol key={i} className="sl-md__list" start={b.start !== 1 ? b.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={i} className="sl-md__list">
            {items}
          </ul>
        );
      }
      case "table":
        return (
          <div key={i} className="sl-md__table-wrap" tabIndex={0}>
            <table className="sl-md__table">
              <thead>
                <tr>
                  {b.head.map((c, k) => (
                    <th key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>
                      {renderInline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, k) => (
                      <td key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>
                        {renderInline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** The rendered document only, no toolbar. */
export function MarkdownBody({ doc, className }: { doc: MdDoc; className?: string }) {
  return (
    <div className={cx("sl-md", className)}>
      {doc.frontmatter && doc.frontmatter.entries.length > 0 && (
        <KeyValue
          className="sl-kv--compact sl-md__frontmatter"
          items={doc.frontmatter.entries.map((e, k) => ({
            key: `${e.key}-${k}`,
            label: <span className="sl-mono">{e.key}</span>,
            value: <span className="sl-break sl-md__fm-value">{e.value}</span>,
          }))}
        />
      )}
      {renderBlocks(doc.blocks)}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard blocked; switch to Raw to select the text */
    }
  };
  return (
    <IconButton label={copied ? "Copied" : label} size="sm" onClick={copy}>
      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
    </IconButton>
  );
}

export interface MarkdownProps {
  source: string;
  className?: string;
  /**
   * `full` (default): a toolbar above the text. `compact`: a small toolbar in
   * the corner, shown on hover and focus (chat messages). `none`: no toolbar.
   */
  toolbar?: "full" | "compact" | "none";
  /** What the copy button copies, for its label: "Copy markdown" by default. */
  copyLabel?: string;
  /** Extra controls placed at the start of a full toolbar. */
  title?: ReactNode;
}

/** Markdown with a Rendered or Raw toggle and a copy button. */
export function Markdown({ source, className, toolbar = "full", copyLabel = "Copy markdown", title }: MarkdownProps) {
  const [view, setView] = useMarkdownView();
  const tooBig = source.length > MAX_RENDER;
  const showRaw = view === "raw" || tooBig;
  const doc = useMemo(() => (showRaw ? null : parseMarkdown(source)), [source, showRaw]);

  const toggle = (
    <div className="sl-md-seg" role="group" aria-label="Markdown view">
      {(["rendered", "raw"] as const).map((v) => (
        <button
          key={v}
          type="button"
          className={cx("sl-md-seg__btn", (showRaw ? "raw" : "rendered") === v && "is-active")}
          aria-pressed={(showRaw ? "raw" : "rendered") === v}
          disabled={tooBig && v === "rendered"}
          onClick={() => setView(v)}
        >
          {v === "rendered" ? "Rendered" : "Raw"}
        </button>
      ))}
    </div>
  );

  const body = showRaw ? <pre className="sl-prose-pre sl-md-raw">{source}</pre> : <MarkdownBody doc={doc!} />;

  return (
    <div className={cx("sl-markdown", toolbar === "compact" && "sl-markdown--compact", className)}>
      {toolbar !== "none" && (
        <div className="sl-md-toolbar">
          {title && <div className="sl-md-toolbar__title">{title}</div>}
          {toggle}
          <CopyButton text={source} label={copyLabel} />
        </div>
      )}
      {body}
    </div>
  );
}
