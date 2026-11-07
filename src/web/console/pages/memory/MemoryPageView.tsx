import type { ReactNode } from "react";
import type { MemoryPageResponse } from "../../../../gateway/panel/api-types";
import { Link, useSearch } from "../../../lib/router";
import { Badge, Card, EmptyState, IconArrowLeft, KeyValue, Markdown, PageHeader, Skeleton } from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { useApi } from "../../hooks/useApi";
import { MemoryError, PrivateBadge, isPrivateStoreId, pagePath, storePath } from "./memoryParts";

/** A frontmatter value as text: strings as they are, everything else as compact JSON. */
function fmValue(v: unknown): ReactNode {
  if (v == null) return <span className="sl-faint">None</span>;
  if (typeof v === "string") return <span className="sl-break">{v}</span>;
  if (typeof v === "number" || typeof v === "boolean") return <span className="sl-mono">{String(v)}</span>;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return <span className="sl-break">{v.join(", ")}</span>;
  return <span className="sl-mono sl-break">{JSON.stringify(v)}</span>;
}

function Body({ page }: { page: MemoryPageResponse }) {
  const fm = Object.entries(page.frontmatter ?? {});
  return (
    <div className="sl-memory-page">
      <div className="sl-memory-page__main">
        <Card title="Content">
          {page.content.trim() ? (
            <Markdown source={page.content} />
          ) : (
            <EmptyState title="This page has no content" description="It may hold only links or frontmatter." />
          )}
        </Card>
        {page.timeline.trim() && (
          <Card title="Timeline">
            <Markdown source={page.timeline} />
          </Card>
        )}
      </div>
      <aside className="sl-memory-page__aside">
        <Card title="About">
          <KeyValue
            className="sl-kv--compact"
            items={[
              { key: "type", label: "Type", value: page.type ? <Badge>{page.type}</Badge> : <span className="sl-faint">None</span> },
              { key: "slug", label: "Slug", value: <span className="sl-mono sl-break">{page.slug}</span> },
              {
                key: "tags",
                label: "Tags",
                value: page.tags.length ? (
                  <ul className="sl-chips">
                    {page.tags.map((t) => (
                      <li key={t} className="sl-tag">
                        {t}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="sl-faint">None</span>
                ),
              },
              { key: "updated", label: "Updated", value: page.updatedAt ? <TimeAgo at={page.updatedAt} /> : <span className="sl-faint">Unknown</span> },
              { key: "created", label: "Created", value: page.createdAt ? <TimeAgo at={page.createdAt} /> : <span className="sl-faint">Unknown</span> },
            ]}
          />
        </Card>
        <Card title="Links" description={page.links.length ? undefined : "This page links to nothing."}>
          {page.links.length > 0 && (
            <ul className="sl-links">
              {page.links.map((l, i) => (
                <li key={`${l.to}-${l.type}-${i}`} className="sl-links__item">
                  <span className="sl-inline">
                    <Link className="sl-link sl-mono sl-break" to={pagePath(page.store, l.to)}>
                      {l.to}
                    </Link>
                    {l.type && <Badge>{l.type.replace(/_/g, " ")}</Badge>}
                  </span>
                  {l.context && <span className="sl-caption">{l.context}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {fm.length > 0 && (
          <Card title="Frontmatter">
            <KeyValue className="sl-kv--compact" items={fm.map(([k, v]) => ({ key: k, label: <span className="sl-mono">{k}</span>, value: fmValue(v) }))} />
          </Card>
        )}
      </aside>
    </div>
  );
}

export function MemoryPageView({ storeId }: { storeId: string }) {
  const slug = new URLSearchParams(useSearch()).get("slug") ?? "";
  const { data, error, reload } = useApi<MemoryPageResponse>(
    slug ? `/api/memory/pages?store=${encodeURIComponent(storeId)}&slug=${encodeURIComponent(slug)}` : null,
  );
  const priv = isPrivateStoreId(storeId);

  const back = (
    <Link to={storePath(storeId)} className="sl-back">
      <IconArrowLeft size={14} />
      <span className="sl-mono">{storeId}</span>
    </Link>
  );

  if (!slug) {
    return (
      <>
        <PageHeader back={back} title="No page chosen" />
        <Card>
          <EmptyState title="No page chosen" description="Open a page from the store's list." />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="sl-title-row">
            <span className="sl-break">{data?.title || slug}</span>
            {priv && <PrivateBadge />}
          </span>
        }
        description={priv ? "Opening this page was recorded in the audit trail." : undefined}
      />
      {error && !data ? (
        <MemoryError what="Memory page" error={error} onRetry={reload} />
      ) : !data ? (
        <div className="sl-memory-page" aria-busy="true" aria-label="Loading page">
          <div className="sl-memory-page__main">
            <Skeleton height="24rem" radius="var(--sl-radius-panel)" />
          </div>
          <div className="sl-memory-page__aside">
            <Skeleton height="14rem" radius="var(--sl-radius-panel)" />
          </div>
        </div>
      ) : (
        <Body page={data} />
      )}
    </>
  );
}
