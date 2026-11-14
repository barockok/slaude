/** Dev fixtures for the Merges and Proposals pages (same masking as the server). */
import type { MergeDetail, MergeListItem, ProposalItem, UndoListsView } from "../../../gateway/panel/api-types";
import { UNDO_LIMITS } from "../../../domain/merge-limits";

const DAY = 86_400_000;

export interface MergeFixtures {
  vetoes: Array<{ id: string; createdBy: string; createdAt: number; mergeId: string | null }>;
  merges: MergeDetail[];
  proposals: ProposalItem[];
  /** What the undo preview and the proposal confirmation answer, by id. */
  undo: Record<string, UndoListsView>;
  activates: Record<string, string[]>;
}

export function mergeFixtures(now: number): MergeFixtures {
  const base = (id: string, over: Partial<MergeDetail>): MergeDetail => ({
    id,
    createdAt: now - DAY,
    kind: "proof",
    state: "applied",
    actor: "system",
    survivorId: "00000000-0000-4000-8000-000000000001",
    loserId: "00000000-0000-4000-8000-0000000000aa",
    undoUntil: now + 6 * DAY,
    undoable: true,
    noticeState: "sent",
    counts: { bindings: 2, grants: 1, activated: 2, inactivePrivileged: 0 },
    undoneAt: null,
    undoneBy: null,
    loserKind: "person",
    proof: { slackBindingId: "b-slack", oidcBindingId: "b-oidc" },
    bindings: [
      { id: "b-slack", service: "slack", kind: "user", workspace: "T0EXAMPLE", value: "U0***LE", state: "verified", now: "survivor" },
      { id: "b-mail", service: "email", kind: "address", workspace: "", value: "j***@example.com", state: "verified", now: "survivor" },
    ],
    grants: [{ id: "g-1", persona: "scout", now: "survivor" }],
    raised: [{ bindingId: "b-slack", fromState: "observed", verifiedAt: now - DAY }],
    aliases: { added: 1, repointed: 0 },
    activated: [
      { persona: "scout", role: "member", source: "console", entry: "grant:g-1", privileged: false },
      { persona: "scout", role: "manager", source: "soul", entry: "soul:email", privileged: true },
    ],
    inactivePrivileged: [],
    notice: { state: "sent", detail: "person sent; managers sent 1, failed 0" },
    limits: [...UNDO_LIMITS],
    ...over,
  });
  const merges: MergeDetail[] = [
    base("m-proof", {}),
    base("m-console", {
      kind: "console", actor: "l***@example.com", createdAt: now - 2 * DAY, noticeState: "failed", loserId: "00000000-0000-4000-8000-0000000000bb",
      counts: { bindings: 1, grants: 0, activated: 0, inactivePrivileged: 1 },
      bindings: [{ id: "b-x", service: "slack", kind: "user", workspace: "T0EXAMPLE", value: "U1***LE", state: "observed", now: "survivor" }],
      grants: [], raised: [], activated: [], inactivePrivileged: [{ persona: "scout", role: "manager", entry: "grant:g-2" }],
      notice: { state: "failed", detail: "person failed; errors: person:channel_not_found" },
    }),
    base("m-old", { state: "undone", undoable: false, undoneAt: now - DAY / 2, undoneBy: "l***@example.com", createdAt: now - 5 * DAY, loserId: "00000000-0000-4000-8000-0000000000cc" }),
    base("m-late", { undoable: false, undoUntil: now - DAY, createdAt: now - 9 * DAY, loserId: "00000000-0000-4000-8000-0000000000dd" }),
  ];
  const side = (id: string, preferred: string | null, v: number, o: number): ProposalItem["a"] => ({
    id, exists: true, kind: "person", preferred, bindings: { declared: 0, observed: o, verified: v },
  });
  const proposals: ProposalItem[] = [
    {
      id: "p-conflict", createdAt: now - DAY, reason: "conflict", state: "open",
      a: side("00000000-0000-4000-8000-000000000001", "j***@example.com", 2, 0), b: side("00000000-0000-4000-8000-0000000000ee", "slack user U2***LE", 0, 1),
      stale: false, staleReason: null, hint: "One record holds a verified binding (a sign-in). If it is an account that signed in with an address it did not prove, it may be squatting the address: demote or delete that account (the existing account flows), then approve. Otherwise dismiss.", resolvedBy: null, resolvedAt: null,
    },
    {
      id: "p-stale", createdAt: now - 3 * DAY, reason: "two-emails", state: "open",
      a: side("00000000-0000-4000-8000-000000000002", "k***@example.com", 1, 0), b: { id: "00000000-0000-4000-8000-0000000000ff", exists: false, kind: null, preferred: null, bindings: { declared: 0, observed: 0, verified: 0 } },
      stale: true, staleReason: "a record of this proposal no longer exists", hint: null, resolvedBy: null, resolvedAt: null,
    },
    {
      id: "p-done", createdAt: now - 6 * DAY, reason: "conflict", state: "dismissed",
      a: side("00000000-0000-4000-8000-000000000003", "m***@example.com", 1, 0), b: side("00000000-0000-4000-8000-0000000000a1", "slack user U3***LE", 0, 1),
      stale: false, staleReason: null, hint: null, resolvedBy: "l***@example.com", resolvedAt: now - 5 * DAY,
    },
  ];
  const undo: Record<string, UndoListsView> = {
    "m-proof": { moved: { bindings: ["b-slack", "b-mail"], grants: ["g-1"], aliases: ["00000000-0000-4000-8000-0000000000aa"], restored: ["b-slack"], unlinked: true }, skipped: [] },
    "m-console": { moved: { bindings: [], grants: [], aliases: [], restored: [], unlinked: false }, skipped: [{ kind: "binding", id: "b-x", reason: "the binding belongs to another record now" }] },
  };
  const vetoes = [{ id: "v-1", createdBy: "l***@example.com", createdAt: now - DAY / 2, mergeId: "m-old" }];
  return { vetoes, merges, proposals, undo, activates: { "p-conflict": ["scout:member:grant:g-1"] } };
}

export const listItemOf = (m: MergeDetail): MergeListItem => ({
  id: m.id, createdAt: m.createdAt, kind: m.kind, state: m.state, actor: m.actor, survivorId: m.survivorId, loserId: m.loserId,
  undoUntil: m.undoUntil, undoable: m.undoable, noticeState: m.noticeState, counts: m.counts,
});
