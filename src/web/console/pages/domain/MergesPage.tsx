import { useEffect, useState } from "react";
import type { MergeBindingView, MergeDetail, MergeListItem, MergeVetoItem, MergeVetoList, NoticeState, UndoPreviewResponse, UndoResponse } from "../../../../gateway/panel/api-types";
import { Badge, Button, Dialog, EmptyState, Field, FilterChip, Input, KeyValue, PageHeader, Table, useToast, type BadgeTone, type Column, type FilterOption } from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { api } from "../../client";
import { Drawer } from "../../components/Drawer";
import { ErrorState } from "../../components/ErrorState";
import { useApi } from "../../hooks/useApi";
import { usePagedList } from "../../hooks/usePagedList";
import { useRole } from "../../hooks/useRole";
import { absoluteTime } from "../../lib/format";
import { STATE_TONE } from "./DomainList";

const STATE_OPTIONS: FilterOption<string>[] = [
  { value: "all", label: "All" },
  { value: "applied", label: "Applied" },
  { value: "undone", label: "Undone" },
];

export const MERGES_NOTE =
  "Merges join two records of one person. A merge made on proof can be undone for seven days: undo moves records and grants back, it does not touch credentials or memory, and anything changed after the merge is left as it is.";

const NOTICE_TONE: Record<NoticeState, BadgeTone> = { pending: "neutral", sent: "success", failed: "danger", skipped: "neutral" };

const COLUMNS: Column<MergeListItem>[] = [
  { key: "when", header: "When", width: "8.5rem", skeleton: 0.6, render: (m) => <TimeAgo at={m.createdAt} /> },
  { key: "kind", header: "Kind", width: "6rem", skeleton: 0.5, render: (m) => (m.kind === "proof" ? "Proof" : "Console") },
  { key: "state", header: "State", width: "6.5rem", skeleton: 0.5, render: (m) => <Badge tone={m.state === "applied" ? "accent" : "neutral"}>{m.state}</Badge> },
  { key: "moved", header: "Moved", width: "10rem", skeleton: 0.6, render: (m) => `${m.counts.bindings} bindings, ${m.counts.grants} grants` },
  { key: "act", header: "Grants now active", width: "11rem", skeleton: 0.6, render: (m) => (
    <span className="sl-nowrap">
      {m.counts.activated}
      {m.counts.inactivePrivileged > 0 && <> <Badge tone="warning">{m.counts.inactivePrivileged} privileged waiting</Badge></>}
    </span>
  ) },
  { key: "notice", header: "Notice", width: "6.5rem", skeleton: 0.5, render: (m) => <Badge tone={NOTICE_TONE[m.noticeState]}>{m.noticeState}</Badge> },
  { key: "undo", header: "Undo until", width: "9rem", skeleton: 0.6, render: (m) => (m.state === "undone" ? <span className="sl-faint">Undone</span> : m.undoable ? <TimeAgo at={m.undoUntil} /> : <span className="sl-faint">Window passed</span>) },
];

export function MergesPage() {
  const role = useRole();
  const [state, setState] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = usePagedList<MergeListItem>(`/api/merges?limit=50${state ? `&state=${state}` : ""}`);
  return (
    <>
      <PageHeader title="Merges" description={MERGES_NOTE} />
      <div className="sl-filter-row sl-filter-row--wrap">
        <FilterChip label="State" value={state || "all"} options={STATE_OPTIONS} onChange={(v) => setState(v === "all" ? "" : v)} />
      </div>
      {list.error && list.items.length === 0 ? (
        <ErrorState what="Merges" error={list.error} onRetry={list.reload} />
      ) : (
        <div className="sl-section sl-section--flush">
          <Table
            label="Merges"
            columns={COLUMNS}
            rows={list.items}
            rowKey={(m) => m.id}
            loading={list.loading}
            skeletonRows={6}
            onRowClick={(m) => setOpen(m.id)}
            empty={<EmptyState title="No merges yet" description="A merge appears here when a proof (a portal link, a sign-in with a proven email) or an operator joins two records." />}
          />
          {list.hasMore && !list.loading && (
            <div className="sl-more">
              <Button onClick={list.loadMore} loading={list.more}>Load more</Button>
            </div>
          )}
        </div>
      )}
      {role === "superadmin" && <VetoCard />}
      <MergeDrawer id={open} onClose={() => setOpen(null)} onChanged={list.reload} />
    </>
  );
}

const NOW_LABEL: Record<MergeBindingView["now"], string> = { survivor: "With the survivor", elsewhere: "Moved elsewhere", removed: "Removed" };

function MergeDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const d = useApi<MergeDetail>(id ? `/api/merges/${encodeURIComponent(id)}` : null);
  const role = useRole();
  const [undoing, setUndoing] = useState(false);
  const m = id ? d.data : null;
  return (
    <>
      <Drawer open={!!id} onClose={onClose} title="Merge" description={id ?? undefined}>
        {d.error && !m && <ErrorState what="This merge" error={d.error} onRetry={d.reload} />}
        {m && (
          <div className="sl-stack-lg">
            <KeyValue
              className="sl-kv--compact"
              items={[
                { key: "kind", label: "Kind", value: m.kind === "proof" ? "Proof (automatic)" : "Console" },
                { key: "state", label: "State", value: m.state },
                { key: "actor", label: "By", value: m.actor },
                { key: "when", label: "Merged", value: absoluteTime(m.createdAt) },
                { key: "surv", label: "Survivor", value: <span className="sl-mono sl-break">{m.survivorId}</span> },
                { key: "lose", label: "Merged away", value: <span className="sl-mono sl-break">{m.loserId} ({m.loserKind})</span> },
                { key: "until", label: "Undo until", value: m.state === "undone" ? `Undone ${m.undoneAt ? absoluteTime(m.undoneAt) : ""} by ${m.undoneBy ?? "unknown"}` : absoluteTime(m.undoUntil) },
                { key: "notice", label: "Notice", value: (
                  <span className="sl-stack">
                    <span><Badge tone={NOTICE_TONE[m.notice.state]}>{m.notice.state}</Badge></span>
                    {m.notice.detail && <span className="sl-caption">{m.notice.detail}</span>}
                    {m.notice.state === "failed" && <span className="sl-caption">The merge stands. The notice is not retried: tell the person yourself.</span>}
                  </span>
                ) },
              ]}
            />
            <h3 className="sl-subhead">Moved</h3>
            <Table<MergeBindingView>
              label="Bindings"
              rows={m.bindings}
              rowKey={(b) => b.id}
              columns={[
                { key: "svc", header: "Service", width: "6rem", render: (b) => `${b.service} ${b.kind}` },
                { key: "val", header: "Value", render: (b) => <span className="sl-mono sl-break">{b.value || "removed"}</span> },
                { key: "state", header: "State", width: "6rem", render: (b) => (b.state ? <Badge tone={STATE_TONE[b.state]}>{b.state}</Badge> : null) },
                { key: "now", header: "Now", width: "9rem", render: (b) => NOW_LABEL[b.now] },
              ]}
              empty={<EmptyState title="No bindings moved" />}
            />
            {m.grants.length > 0 && (
              <ul className="sl-stack">
                {m.grants.map((g) => (
                  <li key={g.id}>Stored grant on <strong>{g.persona}</strong> <span className="sl-caption">({NOW_LABEL[g.now].toLowerCase()})</span></li>
                ))}
              </ul>
            )}
            <h3 className="sl-subhead">Grants that became active</h3>
            {m.activated.length === 0 ? <p className="sl-caption">None.</p> : (
              <ul className="sl-stack">
                {m.activated.map((a) => (
                  <li key={`${a.persona}-${a.role}-${a.entry}`}>{a.persona}: {a.role} {a.privileged && <Badge tone="warning">privileged</Badge>} <span className="sl-caption sl-mono">{a.entry}</span></li>
                ))}
              </ul>
            )}
            {m.inactivePrivileged.length > 0 && (
              <>
                <h3 className="sl-subhead">Privileged grants still waiting</h3>
                <ul className="sl-stack">
                  {m.inactivePrivileged.map((a) => (
                    <li key={`${a.persona}-${a.role}-${a.entry}`}>{a.persona}: {a.role} <span className="sl-caption">needs a verified Slack binding</span></li>
                  ))}
                </ul>
              </>
            )}
            <h3 className="sl-subhead">What undo does not do</h3>
            <ul className="sl-stack">{m.limits.map((l) => <li key={l} className="sl-caption">{l}</li>)}</ul>
            {role === "superadmin" && (
              <div>
                <Button variant="danger" disabled={!m.undoable} onClick={() => setUndoing(true)}>Undo this merge</Button>
                {!m.undoable && <p className="sl-caption">{m.state === "undone" ? "Already undone." : "The undo window has passed."}</p>}
              </div>
            )}
          </div>
        )}
      </Drawer>
      {id && <UndoDialog id={undoing ? id : null} onClose={() => setUndoing(false)} onDone={() => { setUndoing(false); d.reload(); onChanged(); }} />}
    </>
  );
}

function UndoDialog({ id, onClose, onDone }: { id: string | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [preview, setPreview] = useState<UndoPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPreview(null);
    setError(null);
    setReason("");
    if (!id) return;
    let live = true;
    api.post<UndoPreviewResponse>(`/api/merges/${encodeURIComponent(id)}/undo-preview`).then(
      (p) => live && setPreview(p),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => { live = false; };
  }, [id]);
  const confirm = async () => {
    if (!id) return;
    setBusy(true);
    try {
      const r = await api.post<UndoResponse>(`/api/merges/${encodeURIComponent(id)}/undo`, { reason: reason.trim() });
      toast({ tone: "success", title: "Merge undone", description: r.skipped.length ? `${r.skipped.length} item(s) were left as they are.` : "The records are separate again." });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const ready = reason.trim().length >= 3 && !!preview && !busy;
  return (
    <Dialog
      open={id !== null}
      onClose={() => (busy ? undefined : onClose())}
      size="md"
      title="Undo this merge?"
      description="Records and grants go back where the merge took them from. Anything changed since is left as it is. Recorded in the audit trail."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!ready} onClick={confirm}>Undo merge</Button>
        </>
      }
    >
      <div className="sl-stack-lg">
        {error && <p className="sl-form__error" role="alert">{error}</p>}
        {!preview && !error && <p className="sl-caption">Checking what would change.</p>}
        {preview && (
          <div className="sl-stack" aria-label="Undo preview">
            <p>Will move back: {preview.moved.bindings.length} bindings, {preview.moved.grants.length} grants, {preview.moved.aliases.length} aliases{preview.moved.restored.length ? `, ${preview.moved.restored.length} binding state(s) restored` : ""}.</p>
            {preview.moved.unlinked && <p>The link between the Slack account and the sign-in account will be removed, and that pair cannot link again until you lift the veto.</p>}
            {preview.skipped.length > 0 && (
              <>
                <p>Left as they are ({preview.skipped.length}):</p>
                <ul className="sl-stack">{preview.skipped.map((s) => <li key={`${s.kind}-${s.id}`} className="sl-caption">{s.kind}: {s.reason}</li>)}</ul>
              </>
            )}
          </div>
        )}
        <Field label="Reason" hint="Required. Recorded with the undo.">
          {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** Vetoes an undo left. Lifting one lets the pair link or merge again, so it asks for a reason. */
function VetoCard() {
  const v = useApi<MergeVetoList>("/api/merge-vetoes");
  const toast = useToast();
  const [lifting, setLifting] = useState<MergeVetoItem | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setReason(""); setError(null); }, [lifting?.id]);
  const items = v.data?.items ?? [];
  if (v.error || items.length === 0) return null;
  const lift = async () => {
    if (!lifting) return;
    setBusy(true);
    try {
      await api.post(`/api/merge-vetoes/${encodeURIComponent(lifting.id)}/lift`, { reason: reason.trim() });
      toast({ tone: "success", title: "Veto lifted", description: "That pair can link or merge again." });
      setLifting(null);
      v.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sl-section">
      <h3 className="sl-subhead">Vetoes</h3>
      <p className="sl-caption">An undo forbids the pair it undid from linking or merging again until you lift the veto here. A veto names nothing a person could be recognised by.</p>
      <Table<MergeVetoItem>
        label="Vetoes"
        rows={items}
        rowKey={(x) => x.id}
        columns={[
          { key: "when", header: "Made", width: "8.5rem", render: (x) => <TimeAgo at={x.createdAt} /> },
          { key: "by", header: "By", render: (x) => x.createdBy },
          { key: "merge", header: "From merge", render: (x) => <span className="sl-mono sl-break">{x.mergeId ?? "none"}</span> },
          { key: "act", header: "", width: "7rem", render: (x) => <Button size="sm" onClick={() => setLifting(x)}>Lift</Button> },
        ]}
      />
      <Dialog
        open={lifting !== null}
        onClose={() => (busy ? undefined : setLifting(null))}
        size="sm"
        title="Lift this veto?"
        description="The pair can link or merge again. Recorded in the audit trail."
        footer={
          <>
            <Button onClick={() => setLifting(null)} disabled={busy}>Cancel</Button>
            <Button variant="danger" loading={busy} disabled={reason.trim().length < 3 || busy} onClick={lift}>Lift veto</Button>
          </>
        }
      >
        {error && <p className="sl-form__error" role="alert">{error}</p>}
        <Field label="Reason" hint="Required. Recorded with the lift.">
          {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </Dialog>
    </div>
  );
}
