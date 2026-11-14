/**
 * The access decision sites (slice C). Every place that decides admit, role,
 * approvers or "same person" through the shadow seam names itself with one of
 * these ids, so that a metric label, a mismatch log line and the pre-flip site
 * count (`slaude_access_decision_total{site}`) all speak the same names, and a
 * typo is a type error.
 *
 * `group` is the plan task that wired the site (13 to 18). Task 18 adds the
 * guard test and `scripts/verify-access-sites.sh` that read this list; a site
 * is listed here once its call site is wired through `wired.ts`.
 */
export const SITES = [
  // Task 13: gateway admission, roles and 1on1 locks (src/gateway/core/gateway.ts).
  { id: "gateway.admit", group: 13, kind: "admit", where: "preTurnDropReason: admission over the persona's grants" },
  { id: "gateway.heartbeat_status.role", group: 13, kind: "role", where: "/heartbeat status: manager role" },
  { id: "gateway.heartbeat_status.manager_same", group: 13, kind: "same", where: "/heartbeat status: the speaker is the heartbeat recipient" },
  { id: "gateway.heartbeat_now.role", group: 13, kind: "role", where: "/heartbeat now: manager role" },
  { id: "gateway.heartbeat_now.manager_same", group: 13, kind: "same", where: "/heartbeat now: the speaker is the heartbeat recipient" },
  { id: "gateway.agent_connect.lock_owner", group: 13, kind: "same", where: "agent connect_mcp tool: speaker owns the 1on1 lock" },
  { id: "gateway.agent_connect.role", group: 13, kind: "role", where: "agent connect_mcp tool: global scope needs the manager role" },
  { id: "gateway.connect_card.lock_owner", group: 13, kind: "same", where: "connect card click: clicker owns the 1on1 lock" },
  { id: "gateway.connect_card.role", group: 13, kind: "role", where: "connect card click: global scope needs the manager role" },
  { id: "gateway.one_on_one_gate.role", group: 13, kind: "role", where: "1on1 speaker gate: manager role" },
  { id: "gateway.one_on_one_gate.lock_owner", group: 13, kind: "same", where: "1on1 speaker gate: speaker owns the lock" },
  { id: "gateway.one_on_one_relock.lock_owner", group: 13, kind: "same", where: "/1on1 lock: speaker owns the lock" },
  { id: "gateway.one_on_one_relock.role", group: 13, kind: "role", where: "/1on1 lock: manager role" },
  { id: "gateway.mcp_slash.lock_owner", group: 13, kind: "same", where: "/mcp in a 1on1 thread: speaker owns the lock" },
  { id: "gateway.mcp_slash.role", group: 13, kind: "role", where: "/mcp outside a lock: global scope needs the manager role" },
  { id: "gateway.cron.role", group: 13, kind: "role", where: "/cron commands: manager or approver role" },
  { id: "gateway.proposal_managers", group: 13, kind: "approvers", where: "proposal card clicks: the persona's managers" },
  { id: "gateway.brain_managers", group: 13, kind: "approvers", where: "brain tools: the persona's managers" },
  // Task 14: approval and permission cards.
  { id: "permission.initiator_same", group: 14, kind: "same", where: "permission card click: the clicker started the turn" },
  { id: "permission.lock_owner_same", group: 14, kind: "same", where: "permission card click: the clicker owns the thread's 1on1 lock" },
  { id: "permission.role", group: 14, kind: "role", where: "permission card click: approver or manager role of the persona" },
  { id: "approval.resolve_approvers", group: 14, kind: "approvers", where: "approval card: who may approve for a named persona" },
  { id: "approval.resolve_denied", group: 14, kind: "denied", where: "approval card: default chain members removed by a deny grant" },
  { id: "approval.click_allowlist", group: 14, kind: "check", where: "approval click: the clicker is on the card's allowlist (live waiter)" },
  { id: "approval.click_allowlist_poll", group: 14, kind: "check", where: "approval click: the clicker is on the card's allowlist (node poll or foreign row)" },
  { id: "approval.click_denied", group: 14, kind: "denied", where: "approval click: a deny grant refuses the clicker" },
  // Task 15: soul-field readers.
  { id: "model_auth.can_change", group: 15, kind: "check", where: "/model: manager, backup, approver or DM-allowed user named in the soul" },
  { id: "ingest_auth.can_trigger", group: 15, kind: "check", where: "/ingest: manager, backup or approver named in the soul" },
  { id: "soul_override.self_lockout", group: 15, kind: "same", where: "soul override: refuse to block the manager" },
  { id: "soul_override.slash_manager_same", group: 15, kind: "same", where: "/soul: the speaker is the soul's primary manager" },
  { id: "soul_override.slash_role", group: 15, kind: "role", where: "/soul: manager role on the default persona" },
  { id: "soul_override.tool_manager_same", group: 15, kind: "same", where: "soul_override tool: the turn's initiator is the soul's primary manager" },
  { id: "mcp_tools.manager_or_approver", group: 15, kind: "role", where: "slack and slash tools: manager or approver role (isManagerOrApprover)" },
] as const;

export type SiteId = (typeof SITES)[number]["id"];
export type SiteKind = (typeof SITES)[number]["kind"];

/** Site ids wired by a plan task. */
export const sitesOfGroup = (group: number): SiteId[] => SITES.filter((s) => s.group === group).map((s) => s.id);
