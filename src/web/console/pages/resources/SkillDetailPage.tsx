import { useState, type ReactNode } from "react";
import type { SkillActionResponse, SkillDetailResponse, SkillVersionDetailResponse, SkillVersionsResponse } from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { Link, navigate } from "../../../lib/router";
import { Badge, Button, Card, Dialog, EmptyState, Field, IconArrowLeft, Input, KeyValue, Markdown, PageHeader, Skeleton, useToast } from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { api } from "../../client";
import { ErrorState } from "../../components/ErrorState";
import { useApi } from "../../hooks/useApi";
import { useRole } from "../../hooks/useRole";
import { SourceBadge, StatusBadge, skillPath } from "./skillParts";

const none = <span className="sl-faint">None</span>;
const mono = (s: string) => <span className="sl-mono sl-break">{s}</span>;

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function provenance(d: SkillDetailResponse): Array<{ key: string; label: ReactNode; value: ReactNode }> {
  const o = d.origin;
  const rows: Array<{ key: string; label: ReactNode; value: ReactNode }> = [
    { key: "source", label: "Source", value: <SourceBadge source={d.source} /> },
    { key: "invocation", label: "Invoked as", value: mono(d.invocation) },
    {
      key: "root",
      label: "Lives in",
      value: {
        base: "The shared skills root",
        agent: `${o.authoredBy ?? "An agent"}'s own skills`,
        "built-in": "slaude's built-in plugin",
        plugin: "A Claude Code plugin",
      }[o.root],
    },
  ];
  if (d.currentVersion !== null) rows.push({ key: "currentVersion", label: d.status === "retired" ? "Version when retired" : "Tracked version", value: <span className="sl-mono">v{d.currentVersion}</span> });
  if (o.repo) rows.push({ key: "repo", label: "Repository", value: mono(o.repo) });
  if (o.ref) rows.push({ key: "ref", label: "Requested ref", value: mono(o.ref) });
  if (o.commit) rows.push({ key: "commit", label: "Pinned commit", value: <span className="sl-mono" title={o.commit}>{o.commit.slice(0, 12)}</span> });
  if (o.path) rows.push({ key: "path", label: "Path in repo", value: mono(o.path) });
  if (o.plugin) rows.push({ key: "plugin", label: "Plugin", value: mono(o.plugin) });
  if (o.marketplace) rows.push({ key: "marketplace", label: "Marketplace", value: mono(o.marketplace) });
  if (o.version) rows.push({ key: "version", label: "Version", value: mono(o.version) });
  if (o.bundled) rows.push({ key: "bundled", label: "Shipped", value: "With the slaude release, seeded at boot" });
  if (o.local) rows.push({ key: "local", label: "Lock", value: "In no lock: placed by an operator or the personas repo" });
  if (o.authoredBy) rows.push({ key: "author", label: "Written by", value: o.authoredBy });
  if (o.authoredAt) rows.push({ key: "authored", label: "Last written", value: <TimeAgo at={Date.parse(o.authoredAt)} /> });
  if (o.retiredAt) rows.push({ key: "retired", label: "Retired", value: <TimeAgo at={o.retiredAt} /> });
  if (d.shadowedFor?.length) rows.push({ key: "shadowed", label: "Shadowed for", value: d.shadowedFor.join(", ") });
  return rows;
}

function VersionText({ id, version }: { id: string; version: number }) {
  const { data, error, reload } = useApi<SkillVersionDetailResponse>(`/api/skills/${encodeURIComponent(id)}/versions/${version}`);
  if (error && !data) return <ErrorState what="Version" error={error} onRetry={reload} />;
  if (!data) return <Skeleton height="10rem" radius="var(--sl-radius-panel)" />;
  return (
    <div className="sl-stack">
      {data.skillMdTruncated && <span className="sl-caption">Only the first 256 KB of this version was kept.</span>}
      {data.skillMd.trim() ? <Markdown source={data.skillMd} copyLabel={`Copy version ${data.version}`} /> : <EmptyState title="This version has no SKILL.md text" />}
    </div>
  );
}

const ORIGIN_LABEL = { bundled: "Bundled", installed: "Installed", agent: "Written by the agent" } as const;

function VersionsCard({ id, retired, agentOwned }: { id: string; retired: boolean; agentOwned: boolean }) {
  const role = useRole();
  const textLocked = agentOwned && role !== "superadmin";
  const { data, error, reload } = useApi<SkillVersionsResponse>(`/api/skills/${encodeURIComponent(id)}/versions`);
  const [picked, setPicked] = useState<number | null>(null);
  if (error && !data) {
    return (
      <Card title="Versions">
        <ErrorState what="Versions" error={error} onRetry={reload} />
      </Card>
    );
  }
  if (!data) return <Skeleton height="6rem" radius="var(--sl-radius-panel)" />;
  const lockedNote = textLocked ? " Only a superadmin can read an agent's version text." : "";
  const history = retired ? "Read-only history of this copy, up to when it was retired." : "Read-only history of this skill's files.";
  const description = data.versions.length
    ? data.truncated
      ? `${history} Only the newest are listed.${lockedNote}`
      : `${history}${lockedNote}`
    : "No version has been recorded for this skill.";
  return (
    <Card title="Versions" description={description} flush={data.versions.length > 0}>
      {data.versions.length > 0 && (
        <div className="sl-scroll-x" tabIndex={0}>
          <table className="sl-simple-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Hash</th>
                <th>Captured</th>
                <th>Origin</th>
                <th aria-label="SKILL.md" />
              </tr>
            </thead>
            <tbody>
              {data.versions.map((v) => (
                <tr key={v.version}>
                  <td className="sl-mono">v{v.version}</td>
                  <td className="sl-mono" title={v.hash}>{v.hash.slice(0, 12)}</td>
                  <td><TimeAgo at={v.capturedAt} /></td>
                  <td>{ORIGIN_LABEL[v.origin]}</td>
                  <td className="is-end">
                    <Button size="sm" variant="ghost" disabled={textLocked} aria-pressed={picked === v.version} onClick={() => setPicked(picked === v.version ? null : v.version)}>
                      {picked === v.version ? "Hide" : "View SKILL.md"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {picked !== null && (
        <div className="sl-card__section">
          <VersionText key={picked} id={id} version={picked} />
        </div>
      )}
    </Card>
  );
}

function Body({ d, reload }: { d: SkillDetailResponse; reload: () => void }) {
  const role = useRole();
  const toast = useToast();
  const [confirm, setConfirm] = useState<"retire" | "restore" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const superadmin = role === "superadmin";

  const act = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = await api.post<SkillActionResponse>(`/api/skills/${encodeURIComponent(d.id)}/${confirm}`, confirm === "retire" ? { reason } : {});
      toast({ tone: "success", title: confirm === "retire" ? "Skill retired" : "Skill restored", description: `${d.name} ${confirm === "retire" ? "is retired and can be restored." : "is back."}` });
      setConfirm(null);
      setReason("");
      if (r.id !== d.id) navigate(skillPath(r.id), { replace: true });
      else reload();
    } catch (e) {
      toast({ tone: "danger", title: `Could not ${confirm} the skill`, description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sl-memory-page">
      <div className="sl-memory-page__main">
        <Card title="SKILL.md" description={d.rawTruncated ? "Only the first 256 KB is shown." : undefined}>
          {d.rawUnreadable ? (
            <EmptyState title="SKILL.md was not read" description={`${d.rawUnreadable}. The console reads only a regular file inside the skill's directory.`} />
          ) : d.raw.trim() ? (
            <Markdown source={d.raw} copyLabel="Copy SKILL.md" />
          ) : (
            <EmptyState title="This skill has no SKILL.md text" />
          )}
        </Card>
        <VersionsCard id={d.id} retired={d.status === "retired"} agentOwned={d.origin.root === "agent"} />
        <Card title="Usage" description={d.usageHistory.length ? "Per agent, as counted when the agent loaded it." : "No agent has used it yet."} flush={d.usageHistory.length > 0}>
          {d.usageHistory.length > 0 && (
            <div className="sl-scroll-x" tabIndex={0}>
            <table className="sl-simple-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Counted as</th>
                  <th className="is-end">Uses</th>
                  <th>Last used</th>
                  <th>Tracked since</th>
                </tr>
              </thead>
              <tbody>
                {d.usageHistory.map((u) => (
                  <tr key={`${u.agent}-${u.key}`}>
                    <td>{u.agent}</td>
                    <td className="sl-mono">{u.key}</td>
                    <td className="is-end">{u.uses.toLocaleString()}</td>
                    <td>{u.lastUsedAt ? <TimeAgo at={u.lastUsedAt} /> : none}</td>
                    <td>
                      <TimeAgo at={u.firstSeenAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </Card>
        {d.proposals.length > 0 && (
          <Card title="Proposals and retirements" flush>
            <div className="sl-scroll-x" tabIndex={0}>
            <table className="sl-simple-table">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>When</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {d.proposals.map((p) => (
                  <tr key={p.id}>
                    <td>{p.kind === "skill-retired" ? "Retired" : "Removal proposed"}</td>
                    <td>{p.agent}</td>
                    <td>
                      <Badge>{p.kind === "skill-retired" && p.status === "rejected" ? "restored" : p.status}</Badge>
                    </td>
                    <td>
                      <TimeAgo at={p.decidedAt ?? p.createdAt} />
                    </td>
                    <td className="sl-break">{p.reason ?? none}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </Card>
        )}
      </div>
      <aside className="sl-memory-page__aside">
        <Card title="Provenance">
          <KeyValue className="sl-kv--compact" items={provenance(d)} />
        </Card>
        <Card title="Agents" description={d.status === "retired" ? "A retired copy reaches no agent." : undefined}>
          {d.agents.length > 0 && (
            <ul className="sl-chips">
              {d.agents.map((a) => (
                <li key={a} className="sl-tag">
                  <Link to={`/agents/${encodeURIComponent(a)}`}>{a}</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Files" description={d.filesTruncated ? "The list is cut at its limit." : undefined}>
          {d.files.length ? (
            <ul className="sl-file-list">
              {d.files.map((f) => (
                <li key={f.path}>
                  <span className="sl-mono sl-break">{f.path}</span>
                  <span className="sl-caption">{size(f.size)}</span>
                </li>
              ))}
            </ul>
          ) : (
            none
          )}
        </Card>
        {(d.actions.retire || d.actions.restore) && (
          <Card title="Actions" description={superadmin ? undefined : "Only a superadmin can retire or restore a skill."}>
            {d.actions.retire && (
              <Button variant="danger" disabled={!superadmin} onClick={() => setConfirm("retire")}>
                Retire skill
              </Button>
            )}
            {d.actions.restore && (
              <Button variant="primary" disabled={!superadmin} onClick={() => setConfirm("restore")}>
                Restore skill
              </Button>
            )}
          </Card>
        )}
      </aside>
      <Dialog
        open={confirm !== null}
        onClose={() => (busy ? undefined : setConfirm(null))}
        size="sm"
        title={confirm === "retire" ? "Retire this skill?" : "Restore this skill?"}
        description={
          confirm === "retire"
            ? "The agent stops seeing it. The copy is kept, and you or the manager can restore it. Recorded in the audit trail."
            : "The agent sees it again from its next turn. Recorded in the audit trail."
        }
        footer={
          <>
            <Button onClick={() => setConfirm(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant={confirm === "retire" ? "danger" : "primary"} loading={busy} onClick={act}>
              {confirm === "retire" ? "Retire" : "Restore"}
            </Button>
          </>
        }
      >
        {confirm === "retire" && (
          <Field label="Reason" hint="Optional. Shown with the retirement.">
            {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        )}
      </Dialog>
    </div>
  );
}

export function SkillDetailPage({ id }: { id: string }) {
  const { data, error, reload } = useApi<SkillDetailResponse>(`/api/skills/${encodeURIComponent(id)}`);
  const back = (
    <Link to="/skills" className="sl-back">
      <IconArrowLeft size={14} />
      Skills
    </Link>
  );
  const missing = error instanceof ApiError && error.status === 404;
  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="sl-title-row">
            <span className="sl-break">{data?.name ?? (missing ? "No such skill" : id.split(":").pop())}</span>
            {data && <StatusBadge status={data.status} />}
          </span>
        }
        description={data?.description || undefined}
      />
      {error && !data ? (
        <Card>
          {missing ? (
            <EmptyState title="No such skill" description="It may have been retired, restored or removed since." action={<Link className="sl-link" to="/skills">Back to skills</Link>} />
          ) : (
            <ErrorState what="Skill" error={error} onRetry={reload} />
          )}
        </Card>
      ) : !data ? (
        <div className="sl-memory-page" aria-busy="true" aria-label="Loading skill">
          <div className="sl-memory-page__main">
            <Skeleton height="24rem" radius="var(--sl-radius-panel)" />
          </div>
          <div className="sl-memory-page__aside">
            <Skeleton height="14rem" radius="var(--sl-radius-panel)" />
          </div>
        </div>
      ) : (
        <Body d={data} reload={reload} />
      )}
    </>
  );
}
