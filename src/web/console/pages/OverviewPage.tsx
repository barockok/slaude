import type { OverviewResponse } from "../../../gateway/panel/api-types";
import { Link, navigate } from "../../lib/router";
import { Card, EmptyState, IconChevronRight, PageHeader, Skeleton } from "../../ui";
import { AuditTable } from "../components/AuditTable";
import { ErrorState } from "../components/ErrorState";
import { useApi } from "../hooks/useApi";
import { auditLinkFor } from "../lib/format";

interface Stat {
  key: keyof OverviewResponse["counts"];
  label: string;
  hint: string;
  to: string;
}

const STATS: Stat[] = [
  { key: "agents", label: "Agents", hint: "On this deployment", to: "/agents" },
  { key: "liveSessions", label: "Live sessions", hint: "With a turn in flight", to: "/sessions" },
  { key: "pendingApprovals", label: "Pending approvals", hint: "Waiting on a decision", to: "/audit" },
  { key: "auditEvents24h", label: "Audit events in 24\u00a0h", hint: "Decisions and changes", to: "/audit" },
];

export function OverviewPage() {
  const { data, loading, error, reload } = useApi<OverviewResponse>("/api/overview");

  return (
    <>
      <PageHeader title="Overview" description="Agents, live sessions, pending approvals and recent activity at a glance." />

      {error && !data ? (
        <Card>
          <ErrorState what="Overview" error={error} onRetry={reload} />
        </Card>
      ) : (
        <>
          <div className="sl-stats">
            {STATS.map((s) => (
              <Link key={s.key} to={s.to} className="sl-stat">
                <span className="sl-stat__label">
                  {s.label}
                  <IconChevronRight size={14} className="sl-stat__chevron" />
                </span>
                {data ? (
                  <span className="sl-stat__value">{data.counts[s.key].toLocaleString()}</span>
                ) : (
                  <Skeleton width="3rem" height="2rem" />
                )}
                <span className="sl-stat__hint">{s.hint}</span>
              </Link>
            ))}
          </div>

          <section className="sl-section">
            <div className="sl-section__head">
              <h2 className="sl-section__title">Recent activity</h2>
              <Link to="/audit" className="sl-link">
                View all
              </Link>
            </div>
            <AuditTable
              label="Recent activity"
              rows={data?.recentAudit ?? []}
              loading={loading && !data}
              skeletonRows={6}
              showAgent
              onRowClick={(e) => navigate(auditLinkFor(e))}
              empty={
                <EmptyState
                  title="No activity yet"
                  description="Permission decisions, approvals and console changes show up here as they happen."
                />
              }
            />
          </section>
        </>
      )}
    </>
  );
}
