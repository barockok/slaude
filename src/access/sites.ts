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
  { id: "approval.resolve_default_managers", group: 20, kind: "approvers", where: "approval card: the default persona's managers, when a named persona has no approver or manager" },
  { id: "approval.default_managers", group: 20, kind: "approvers", where: "approval card: an agent.yaml default persona's managers, by Slack id, email or user (internal source only)" },
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
  // Task 16: knowledge and memory scope.
  { id: "brain_gate.lock_owner", group: 16, kind: "same", where: "brain write gate: in a 1on1 only the lock owner's own slice is writable" },
  { id: "brain_gate.turn_sender_same", group: 16, kind: "same", where: "turn brain scope: the sole sender of the turn is the speaker" },
  { id: "brain_gate.manager_approver", group: 16, kind: "same", where: "kb-admin approval: the approver is one of the persona's managers" },
  { id: "kb_tools.lock_owner", group: 16, kind: "same", where: "kb_memoize: in a 1on1 the speaker is the lock owner" },
  { id: "kb_tools.memory_about", group: 16, kind: "same", where: "memory_about: the asked person is the turn's own sender" },
  { id: "kb_scope.lock_owner", group: 16, kind: "same", where: "brain scope: the speaker owns the thread's 1on1 lock" },
  { id: "memory_scope.lock_owner", group: 16, kind: "same", where: "memory scope: the speaker owns the thread's 1on1 lock" },
  { id: "memory_scope.run_as_speaker", group: 16, kind: "same", where: "memory scope: the carried identity is the speaker" },
  { id: "memory_scope.run_as_lock", group: 16, kind: "same", where: "memory scope: the carried identity is the lock owner" },
  { id: "memory_scope.claim_live_same", group: 16, kind: "same", where: "claimed lock owner equals the live lock owner" },
  { id: "memory_scope.live_speaker_same", group: 16, kind: "same", where: "live lock owner is the speaker (the claim is used otherwise)" },
  { id: "proposal.person_decider", group: 16, kind: "same", where: "proposal card click: the clicker is the person the proposal is for" },
  { id: "proposal.manager_decider", group: 16, kind: "same", where: "proposal card click: the clicker is one of the persona's managers" },
  { id: "proposal.apply_is_manager", group: 16, kind: "same", where: "proposal apply: the approver is a manager (shared memory writes)" },
  { id: "gateway.brain_gate.role", group: 16, kind: "role", where: "brain gate input: the speaker's manager role" },
  // Task 17: 1on1, remote, env, oauth home.
  { id: "remote.active_lock_owner", group: 17, kind: "same", where: "remote target: a user-machine environment needs a lock owned by its owner" },
  { id: "remote.offer_connect_lock_owner", group: 17, kind: "same", where: "/remote status: offer the connect form to the lock owner only" },
  { id: "remote.own_current", group: 17, kind: "same", where: "/remote on: the thread's current environment is the speaker's own" },
  { id: "remote.thread_identity_run_as", group: 17, kind: "same", where: "thread identity: the remote target's owner is the identity the turn runs as" },
  { id: "env.own_environment", group: 17, kind: "same", where: "/env use: an environment belongs to the speaker" },
  { id: "env.use_lock_owner", group: 17, kind: "same", where: "/env use: the speaker owns the thread's 1on1 lock" },
  { id: "env.inherit_lock_by_env", group: 17, kind: "same", where: "/env use: the existing binding is the speaker's own (lock inheritance)" },
  { id: "env.turn_off_owner", group: 17, kind: "same", where: "/env off: the speaker owns the environment" },
  { id: "env.release_lock_owner", group: 17, kind: "same", where: "/env off: the lock still belongs to the environment's owner" },
  { id: "env.remove_lock_owner", group: 17, kind: "same", where: "/env remove: the lock still belongs to the environment's owner" },
  { id: "gateway.remote_ctx.role", group: 17, kind: "role", where: "/remote and /env context: the speaker's manager role" },
  // Task 18: background and display.
  { id: "scheduler.persona_manager", group: 18, kind: "list", where: "heartbeat and wake recipient: the persona's manager from its soul (no workspace on the call)" },
  { id: "digest.recipient", group: 18, kind: "list", where: "weekly digest recipient: the default persona's manager, else the backup (no workspace on the call)" },
  { id: "gateway.background_managers", group: 18, kind: "list", where: "proposal and digest managers: the default soul's manager and backup (no workspace on the call)" },
  { id: "gateway.connect_notify_target", group: 18, kind: "role", where: "bridge connect card for the agent's shared identity: the soul's manager holds the manager role" },
  { id: "rule_tool.approvers", group: 18, kind: "approvers", where: "proactive rule: who may approve it (managers, and a channel's approvers)" },
  { id: "rule_tool.can_approve", group: 18, kind: "same", where: "proactive rule: a person (the speaker or a card clicker) is one of the rule's approvers" },
  { id: "rule_tool.own_turn", group: 18, kind: "same", where: "proactive rule: the turn's sole sender is the speaker" },
  { id: "gateway.bash.role", group: 18, kind: "role", where: "/bash: manager role" },
  // Task 18, found by the full-src guard (not in the plan's map).
  { id: "proposal.restore_manager", group: 18, kind: "same", where: "retired skill restore click: the clicker is one of the persona's managers" },
  { id: "gateway.one_on_one_agent_lock.prev_target_same", group: 18, kind: "same", where: "agent 1on1 lock: the thread's remote target belongs to the new lock owner" },
  { id: "gateway.one_on_one_slash.prev_target_same", group: 18, kind: "same", where: "/1on1 on: the thread's remote target belongs to the new lock owner" },
  { id: "gateway.connect_card.clicker_same", group: 18, kind: "same", where: "connect card click: the clicker is the person the card was posted for" },
  { id: "bridge.card_scope_lock_same", group: 18, kind: "same", where: "bridge connect card: the carried identity still holds the thread's lock" },
  { id: "remote.offer_clicker_same", group: 18, kind: "same", where: "remote connect form: the clicker is the person the offer was issued to" },
  { id: "remote.env_api_owner_same", group: 18, kind: "same", where: "environment endpoint: the turn's carried identity owns a personal environment" },
  { id: "restraint.manager_recipient", group: 18, kind: "same", where: "proactive post to the manager: the recipient is the persona's manager (no workspace on the call)" },
  { id: "kb_tools.profile_subject", group: 18, kind: "same", where: "kb_memoize profile: a named subject is the turn's sender" },
  { id: "kb_tools.memory_about_subject", group: 18, kind: "same", where: "memory_about listing: a page's subject is the turn's sender" },
  { id: "pass_tools.profile_subject", group: 18, kind: "same", where: "background pass profile write: a named subject is the pass's person (no workspace on the call)" },
  { id: "permission.stamp_expect_same", group: 18, kind: "same", where: "turn stamp: the token's initiator is the turn's sole sender (no workspace on the call)" },
] as const;

export type SiteId = (typeof SITES)[number]["id"];
export type SiteKind = (typeof SITES)[number]["kind"];

/** Site ids wired by a plan task. */
export const sitesOfGroup = (group: number): SiteId[] => SITES.filter((s) => s.group === group).map((s) => s.id);
