import { useEffect, useState } from "react";
import type { ApprovalOutcome, ApproveProposalResponse, ProposalItem, ProposalSide } from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { Badge, Button, Dialog, EmptyState, Field, FilterChip, Input, PageHeader, Table, useToast, type Column, type FilterOption } from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { api } from "../../client";
import { ErrorState } from "../../components/ErrorState";
import { usePagedList } from "../../hooks/usePagedList";
import { useRole } from "../../hooks/useRole";

const STATE_OPTIONS: FilterOption<string>[] = [
  { value: "open", label: "Open" },
  { value: "dismissed", label: "Dismissed" },
  { value: "merged", label: "Merged" },
  { value: "all", label: "All" },
];

export const PROPOSALS_NOTE =
  "Pairs of records the system would not merge by itself. Approving merges them as an operator, after you confirm the grants it would activate. A record that holds a verified binding is never merged here: unlink or delete the losing account first, then approve.";

const REASON_LABEL = { conflict: "Conflict", "two-emails": "Two emails" } as const;

const side = (s: ProposalSide) => (
  <span className="sl-stack">
    <span className="sl-truncate">{s.exists ? s.preferred ?? <span className="sl-faint">No bindings</span> : <span className="sl-faint">Record gone</span>}</span>
    {s.exists && <span className="sl-caption">{s.bindings.verified} verified, {s.bindings.observed} observed, {s.bindings.declared} declared</span>}
  </span>
);

export function ProposalsPage() {
  const role = useRole();
  const [state, setState] = useState("open");
  const [review, setReview] = useState<ProposalItem | null>(null);
  const [dismiss, setDismiss] = useState<ProposalItem | null>(null);
  const list = usePagedList<ProposalItem>(`/api/merge-proposals?limit=50${state === "all" ? "" : `&state=${state}`}`);
  const columns: Column<ProposalItem>[] = [
    { key: "when", header: "Proposed", width: "8.5rem", skeleton: 0.6, render: (p) => <TimeAgo at={p.createdAt} /> },
    { key: "reason", header: "Reason", width: "7rem", skeleton: 0.5, render: (p) => REASON_LABEL[p.reason] },
    { key: "a", header: "Record", skeleton: 0.7, render: (p) => side(p.a) },
    { key: "b", header: "Other record", skeleton: 0.7, render: (p) => side(p.b) },
    { key: "state", header: "State", width: "16rem", skeleton: 0.5, render: (p) => (
      <span className="sl-stack">
        <span>{p.stale ? <Badge tone="warning" title={p.staleReason ?? undefined}>Stale</Badge> : <Badge tone={p.state === "open" ? "accent" : "neutral"}>{p.state}</Badge>}</span>
        {p.hint && <span className="sl-caption">{p.hint}</span>}
      </span>
    ) },
    { key: "act", header: "", width: "11rem", skeleton: 0.4, render: (p) => (
      p.state === "open" && role === "superadmin" ? (
        <span className="sl-nowrap">
          <Button size="sm" disabled={p.stale} onClick={() => setReview(p)}>Review</Button>{" "}
          <Button size="sm" variant="ghost" onClick={() => setDismiss(p)}>Dismiss</Button>
        </span>
      ) : null
    ) },
  ];
  return (
    <>
      <PageHeader title="Proposals" description={PROPOSALS_NOTE} />
      <div className="sl-filter-row sl-filter-row--wrap">
        <FilterChip label="State" value={state} options={STATE_OPTIONS} onChange={setState} />
      </div>
      {list.error && list.items.length === 0 ? (
        <ErrorState what="Proposals" error={list.error} onRetry={list.reload} />
      ) : (
        <div className="sl-section sl-section--flush">
          <Table
            label="Merge proposals"
            columns={columns}
            rows={list.items}
            rowKey={(p) => p.id}
            loading={list.loading}
            skeletonRows={6}
            empty={<EmptyState title="No proposals" description="A proposal appears when a merge was refused: a conflict between records, or two different emails on one person." />}
          />
          {list.hasMore && !list.loading && (
            <div className="sl-more">
              <Button onClick={list.loadMore} loading={list.more}>Load more</Button>
            </div>
          )}
        </div>
      )}
      <ReviewDialog p={review} onClose={() => setReview(null)} onDone={() => { setReview(null); list.reload(); }} />
      <DismissDialog p={dismiss} onClose={() => setDismiss(null)} onDone={() => { setDismiss(null); list.reload(); }} />
    </>
  );
}

/** The word an operator types to confirm; the grants it lists are echoed back to the server, which refuses a changed list. */
export const CONFIRM_WORD = "merge";

function ReviewDialog({ p, onClose, onDone }: { p: ProposalItem | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [preview, setPreview] = useState<ApprovalOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const id = p?.id ?? null;
  useEffect(() => {
    setPreview(null);
    setError(null);
    setTyped("");
    if (!id) return;
    let live = true;
    api.post<ApproveProposalResponse>(`/api/merge-proposals/${encodeURIComponent(id)}/approve`, {}).then(
      (r) => live && (r.status === "confirm" ? setPreview(r.outcome) : setError("Unexpected answer.")),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => { live = false; };
  }, [id]);
  const approve = async () => {
    if (!id || !preview) return;
    setBusy(true);
    try {
      await api.post<ApproveProposalResponse>(`/api/merge-proposals/${encodeURIComponent(id)}/approve`, { confirm: preview });
      toast({ tone: "success", title: "Records merged", description: "It is in Merges, where it can be undone for seven days." });
      onDone();
    } catch (e) {
      // A changed list comes back as 409 with the current one: show it and ask again.
      const body = e instanceof ApiError ? (e.body as { outcome?: ApprovalOutcome } | null) : null;
      if (body?.outcome) setPreview(body.outcome);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const ready = !!preview && typed.trim().toLowerCase() === CONFIRM_WORD && !busy;
  return (
    <Dialog
      open={p !== null}
      onClose={() => (busy ? undefined : onClose())}
      size="md"
      title="Merge these records?"
      description="The two records become one. A binding state is never raised by this merge. Recorded in the audit trail."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={approve}>Approve merge</Button>
        </>
      }
    >
      <div className="sl-stack-lg">
        {error && <p className="sl-form__error" role="alert">{error}</p>}
        {!preview && !error && <p className="sl-caption">Checking what the merge would activate.</p>}
        {preview && (
          <div className="sl-stack" aria-label="What this merge would do">
            <p>Keeps <strong>{preview.survivor}</strong> and merges away <strong>{preview.loser}</strong>.</p>
            <p>Moves {preview.bindings} bindings and {preview.grants} stored grants.</p>
            {preview.activates.length === 0 ? (
              <p>No grant becomes active.</p>
            ) : (
              <>
                <p>These grants become active for the person:</p>
                <ul className="sl-stack">{preview.activates.map((l) => <li key={l} className="sl-mono sl-break">{l}</li>)}</ul>
              </>
            )}
            {preview.inactivePrivileged.length > 0 && (
              <p className="sl-caption">Privileged grants that stay inactive until the Slack binding is verified: {preview.inactivePrivileged.join(", ")}.</p>
            )}
          </div>
        )}
        <Field label={`Type "${CONFIRM_WORD}" to confirm`} hint="You confirm the direction, the counts and the grants listed above.">
          {(f) => <Input id={f.id} aria-describedby={f.describedBy} value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function DismissDialog({ p, onClose, onDone }: { p: ProposalItem | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [p?.id]);
  const dismiss = async () => {
    if (!p) return;
    setBusy(true);
    try {
      await api.post(`/api/merge-proposals/${encodeURIComponent(p.id)}/dismiss`, {});
      toast({ tone: "success", title: "Proposal dismissed", description: "The same pair is not proposed again for this reason." });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={p !== null}
      onClose={() => (busy ? undefined : onClose())}
      size="sm"
      title="Dismiss this proposal?"
      description="The records stay separate. The same pair is not proposed again for this reason."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={dismiss}>Dismiss</Button>
        </>
      }
    >
      {error && <p className="sl-form__error" role="alert">{error}</p>}
    </Dialog>
  );
}
