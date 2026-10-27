import type { AgentManager, AgentEvent } from "../../agent/manager";
import { env } from "../../config/env";
import { m as metric } from "../../metrics";
import {
  discoverSkills,
  matchSkillInvocation,
  buildSkillInvocation,
} from "../../skills/loader";
import { ReactionTracker } from "../slack/reactions";
import { Presence } from "../slack/presence";
import { Status } from "../slack/status";
import { PermissionGate } from "../slack/permission-gate";
import { ApprovalGate } from "../slack/approval-gate";
import { IgnoreGate } from "../slack/ignore-gate";
import { parseSlashCommand, helpText, humanModeName, MODE_LABELS } from "../slack/commands";
import { soulData, soulDataBase, effectiveSoulForChannel } from "../../soul/extract";
import { indexWritten, runAsOf } from "../../proactive/commitment-index";
import type { CommitmentRow } from "../../db/commitments";
import { onProactiveReaction, onProactiveReply, type FeedbackDeps } from "../../proactive/feedback";
import { proactiveReplyBlock } from "../../proactive/reply-context";
import type { PromiseTransport } from "../../proactive/promises";
import type { ProactiveTransport } from "../../proactive/dispatch";
import { proactiveFor } from "../../soul/proactive";
import { ledgerTurnRun, type TurnPass } from "../../background/skill-check";
import { mutateOverride, FIELD_ALIASES } from "../../soul/overrides";
import * as SoulOverrides from "../../db/soul-overrides";
import { quietForVoice, voiceTurns } from "../../voice/turn-flags";
import { VoiceCalls } from "../../voice/call";
import { voiceBundleFromEnv, voiceConfigFromEnv, type VoiceConfig } from "../../voice/config";
import { drainVoiceCalls, endCallsOnSessionExit, makeMonoVoiceHost, voiceServersFor } from "../../voice/hosts";

/** Mono shutdown: how long live voice calls get to say goodbye and end. */
const VOICE_SHUTDOWN_GRACE_MS = 5_000;
import { monoPersonaSoul } from "../../voice/mono-soul";
import { createSlackMcp, SLACK_MCP_NAME, createRuntimeMcp, RUNTIME_MCP_NAME, createConnectMcp, CONNECT_MCP_NAME, type SlackContext, parseDuration } from "../slack/mcp-tools";
import { makeSlackSurfaceFactory } from "../slack/surface";
import { createSurfaceMcp, SURFACE_MCP_NAME } from "./surface-mcp";
import { humanizeToolStatus, redactSecrets } from "./status-text";
import * as Remote from "../../db/remote";
import * as Envs from "../../db/environments";
import { handleEnvCommand, addEnvironment, useEnvironment, defaultEnvDeps } from "./env-command";
import type { RemoteTarget } from "../../remote/types";

/** A thread's remote target that runs on a person's own machine (the manager
 *  filter applies); a sandbox does not. */
const personalRemote = (t: RemoteTarget | null): boolean => !!t && t.env?.trust !== "provisioned";
import {
  ENV_ADD_ACTION,
  ENV_ADD_VIEW,
  ENV_KIND_ACTION,
  ENV_USE_ACTION,
  decodeEnvOffer,
  envAddModal,
  envPickerBlocks,
  readEnvAddValues,
} from "./env-form";
import { getKind } from "../../remote/kinds";
import {
  handleRemoteCommand,
  endRemoteForThread,
  remoteStatusOn,
  decodeRemoteOffer,
  readRemoteConnectValues,
  remoteConnectModal,
  remoteOfferBlocks,
  REMOTE_CONNECT_VIEW,
  REMOTE_OPEN_ACTION,
  type RemoteCommandCtx,
} from "./remote-command";
import { activeRemoteTarget } from "../../remote/active";
import { sweepIdleSandboxes } from "../../remote/env-runtime";
import { makeMonoRemoteFactory, monoRemoteResolver } from "../../remote/mono";
import type { Surface, SurfaceFactory, SessionBinding } from "./surface";
import { createSkillsMcp, SKILLS_MCP_NAME } from "../../skills/mcp-tools";
import { createSessionMcp, SESSION_MCP_NAME } from "../../agent/session-mcp";
import { createKbMcp, KB_MCP_NAME, type BrainToolDeps } from "../../knowledge/mcp-tools";
import { createV1Api } from "../api";
import type { PendingSource } from "../api/pending-source";
import type { JobClaims } from "../api/auth";
import { memoryScopeForClaims } from "../api/memory";
import { defaultGateBus } from "../../queue/gate-bus";
import { makeQueueDispatch, type QueueDispatch } from "./dispatch";
import { createOnceGuard, failureText } from "./failure-codes";
import { getRedis, getSubRedis } from "../../queue/redis";
import { makeKeys } from "../../queue/keys";
import type { SessionRow } from "../../db/schema";
import { makeRegistry, type Registry } from "../../queue/registry";
import { makePubSub, type PubSub } from "../../queue/pubsub";
import { makePanelLock, type PanelLock } from "../../queue/panel-lock";
import { createPanelApi } from "../panel/api";
import { createPortalApi } from "../portal/api";
import { createDeployApi } from "../deploy/api";
import { createBrainImportApi } from "../brain-import/api";
import { persistConnect, persistDisconnect } from "../../agent/mcp-oauth/persist";
import { importOnDiskCredentials } from "./credential-import";
import { mintLinkToken } from "../portal/link-token";
import { nudgeOnboarding } from "../portal/onboarding-nudge";
import { accountForSlackUser } from "../../db/accounts";
import { makeDeferQueue } from "../panel/defer-queue";
import { suppressibleSurface } from "../panel/suppress";
import type { DispatchMeta } from "./dispatch";
import { brainCall, brainCallIfOpen, brainEnabled, brainReady, ensureSources } from "../../knowledge/brain";
import { buildTurnMemoryContext } from "../../memory/turn-context";
import { brainMode } from "../../knowledge/brain-config";
import { syncKbWikis } from "../../knowledge/brain-sync";
import { scheduleNightlyMaintenance } from "../../knowledge/brain-cycle";
import { trackBrainWork, whileClosing } from "../../knowledge/brain-work";
import { agentSourceId, channelTrustFor, resolveBrainScope, type ChannelTrust } from "../../knowledge/scope";
import { gather } from "../../knowledge/gather";
import { gateRunnerFromEnv, type GateRunner } from "../gate/runner";
import { buildGateInput, type GateContextDeps } from "../gate/context";
import type { GateAction, Trust } from "../gate/types";
import { providerSecretResolver } from "../api/tenants";
import { parseRef } from "../../secrets";
import { agentIdSync, resolveAgentId } from "../../knowledge/agent-identity";
import { memory as processMemory } from "../../memory";
import { makeScopedMemory } from "../../memory/scoped";
import { backgroundAgentId, ledgerSkillCheckBudget, warnUnpricedModels } from "../../background/skill-check";
import { recordSkillUse } from "../../skills/usage";
import { scrubChildEnv, withoutKeys } from "../../agent/child-env";
import { providerSelectingNames } from "../../agent/provider-env";
import { memoryScopeFor, withClaimLock } from "../../memory/scope";
import { getPersonaRegistry, labelsInUse, livePersona, managedPersonaProvider, onPersonaRegistryInstalled } from "../../persona/registry";
import { makeLabelMonitor } from "../../queue/label-status";
import { isInteractiveOrigin, turnBrainScope, type GateInput } from "../../knowledge/gated-dispatch";
import { personaKbs, personaKbSourceIds } from "../../knowledge/persona-kb";
import { resolveUserName } from "../slack/users";
import { downloadAttachments, type SlackFile } from "../slack/attachments";
import * as Sessions from "../../db/sessions";
import * as SeenEvents from "../../db/seen-events";
import * as PendingGates from "../../db/pending-gates";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { bridgeExternalMcp, connectableServers, loadExternalMcp, privateOverrides, sessionExternalMcp } from "./external-mcp";
import { connectText, createMcpBridge, reauthText, type McpBridge } from "./mcp-bridge";
import { createSourceReader, oauthOnlyWatches, unservedWatches } from "../../proactive/source-reader";
import { parseRunAs } from "../../agent/credential-owner";
import * as SlackOauthFlows from "../../db/slack-oauth-flows";
import { randomBytes } from "node:crypto";
import { ensureInitiatorConfigDir, agentConfigDir } from "../../agent/oauth-home";
import { scopeConfigDir, personaKey } from "../../agent/mcp-oauth/scope-home";
import { writeEntry, removeEntry, type OAuthServerConfig, type OAuthTokens } from "../../agent/mcp-oauth/store";
import { discover } from "../../agent/mcp-oauth/discovery";
import { beginConnect, exchangeAuthCode, prepareConnect } from "../../agent/mcp-oauth/client";
import { beginConnectShared } from "../../agent/mcp-oauth/shared-client";
import { parseOAuthCallback } from "../../agent/mcp-oauth/callback";
import { canTriggerIngest } from "../slack/ingest-auth";
import { canChangeModel } from "../slack/model-auth";
import { listModelsFor, verifyModelChoice } from "../../agent/models";
import * as kbIngest from "../../knowledge/ingest";
import * as Ignores from "../../db/ignores";
import * as CronJobs from "../../db/cron-jobs";
import * as OneOnOne from "../../db/one-on-one";
import * as MentionOnly from "../../db/mention-only";
import { CronScheduler } from "../slack/cron-scheduler";
import { startCronLeader } from "./cron-leader";
import { defaultSchedulerDeps, leaderElect, startBackgroundScheduler, type SchedulerSlack } from "../../background/scheduler";
import { cardPoster, registerProposalActions } from "../../background/proposal-cards";
import { digestRecipientOf } from "../../background/digest";
import type { LeaderHandle } from "../../queue/locks";
import { getNextRun } from "../slack/cron-parser";
import { clientForApp, type AppRef, type Transport } from "./transport";

export interface SessionMcpCtx { slack: SlackContext; surface: Surface }
export interface GatewayHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Node-facing REST /v1 handler (spec §3). Returns null for non-/v1 paths so
   *  the caller (health server) can fall through. Mounted only when
   *  SLAUDE_ROLE is mono/gateway — see src/server.ts. */
  fetchV1(req: Request): Promise<Response | null>;
  /** Operator control-panel handler (design §Session control panel). Returns
   *  null for non-/panel paths so the caller (health server) can fall through.
   *  Mounted only when SLAUDE_PANEL is enabled and the role is mono/gateway —
   *  see src/server.ts. */
  fetchPanel(req: Request): Promise<Response | null>;
  /** `/portal/*` — end-user onboarding. Null when SLAUDE_PORTAL is off. */
  fetchPortal(req: Request): Promise<Response | null>;
  /** `/deploy/*` — the config pipeline's door (own token, not the node token).
   *  Optional so test doubles needn't implement it. */
  fetchDeploy?(req: Request): Promise<Response | null>;
  /** `/brain-import/*` — persona memory migration (own token). Optional so
   *  test doubles needn't implement it. */
  fetchBrainImport?(req: Request): Promise<Response | null>;
  /** TEST/SIM SEAM ONLY. The pending-gate source behind /v1/pending. */
  __pendingSource(): PendingSource;
  /** TEST/SIM SEAM ONLY. Live per-session MCP contexts built by the resolver.
   *  Undefined until the session's resolver has run. Production never calls this. */
  __sessionCtx(sessionId: string): SessionMcpCtx | undefined;
  /** TEST/SIM SEAM ONLY. Re-run the per-session MCP resolver and return the
   *  mounted server map (incl. /1on1 private-service credential overlays).
   *  Requires the session's route to exist (feed a message first). Production
   *  never calls this. */
  __resolveMcp(sessionId: string): Promise<Record<string, McpServerConfig> | undefined>;
  /** Test seam: how this gateway delivers promise checks (phase E). */
  __promises?: PromiseTransport;
  /** Test seam: how this gateway dispatches heartbeat ask/act turns. */
  __proactive?: ProactiveTransport;
  /** TEST SEAM: the mono process's voice call registry. */
  __voiceCalls?: VoiceCalls;
  /** TEST/SIM SEAM ONLY. Drive the natural-language connect path (what the
   *  mcp__slaude_connect__connect_mcp tool calls) for a live session. */
  __agentConnect(sessionId: string, server: string): Promise<string>;
  /** TEST/SIM SEAM ONLY. Drive the agent-facing 1on1 toggle
   *  (mcp__slaude_surface__set_one_on_one) for a live session. */
  __agentOneOnOne(sessionId: string, action: "lock" | "open" | "off", scope?: string): Promise<string>;
  /** TEST/SIM SEAM ONLY. Drive the agent-facing mention-only toggle
   *  (mcp__slaude_surface__set_mention_only) for a live session. */
  __agentMentionOnly(sessionId: string, active: boolean): Promise<string>;
  /** TEST SEAM ONLY. The brain gate input a mono session's tools see now
   *  (its route's context); undefined with no route. */
  __brainGate?(sessionId: string): Promise<GateInput | undefined>;
  /** TEST SEAM ONLY. The brain gate input a node turn's /v1 tools see for
   *  these (verified) job-token claims. */
  __brainGateForClaims?(claims: JobClaims): Promise<GateInput>;
  /** TEST SEAM ONLY. The panel's chat enqueue (what POST /panel chat calls
   *  after its own auth), without the panel's OIDC. */
  __panelChat?(session: SessionRow, text: string, operatorId: string): Promise<void>;
}

const REACT_RECEIVED = "eyes";
const REACT_WORKING = "gear";
const REACT_DONE = "white_check_mark";
const REACT_ERROR = "x";
/** A mention the decision gate doubts is addressed to the agent: recorded, not run. */
const REACT_DOUBT = "thinking_face";

/** The brain's channel trust in the envelope's terms (trusted / allowed / restricted). */
const GATE_TRUST: Record<ChannelTrust, Trust> = { trusted: "trusted", public: "allowed", unknown: "restricted" };

/**
 * The channel-mode rule, driven by SOUL.md: in a trusted or allowed channel
 * anyone may address the agent; in a DM or an unlisted channel only the
 * manager or backup (plus, in a DM, the DM allowlist). Whitelisted DM users
 * get chat only: admin commands still gate on manager/backup/approver.
 * Shared by handleMessage and the decision gate's skip check.
 */
function channelModeAdmits(soul: ReturnType<typeof soulData>, channelId: string, channelType: string, userId: string): boolean {
  const isDM = channelType === "im";
  const publicZone = !isDM && (soul.trustedChannels.includes(channelId) || soul.allowedChannels.includes(channelId));
  if (publicZone) return true;
  const managerId = soul.manager.userId;
  const backupId = soul.backupManager.userId;
  const dmAllowed = isDM && soul.dmAllowedUsers.includes(userId);
  return Boolean((managerId && userId === managerId) || (backupId && userId === backupId) || dmAllowed);
}

/** An early drop: the slackDropsTotal reason label and the line handleMessage
 *  logs (null for a silent drop: no line, no metric). */
type PreTurnDrop = { reason: string; log: string | null };

/** Pages of thread history the decision gate reads at most. */
const GATE_REPLY_PAGES = 5;
/** conversations.replies page size for the gate (Slack's recommended maximum),
 *  independent of how many messages the gate keeps. */
const GATE_REPLY_PAGE_SIZE = 200;

/**
 * The decision gate's thread context: the last `limit` messages of the thread
 * up to and including `latest` (conversations.replies pages oldest-first from
 * the thread start, so the tail is kept across pages; pages are large so the
 * page bound reaches the event in all but very long threads). Throws on a failed call;
 * buildGateInput reads that as no context.
 */
async function threadTail(client: any, channel: string, threadTs: string, latest: string, limit: number) {
  let tail: Array<{ user?: string; bot_id?: string; text?: string; ts: string }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < GATE_REPLY_PAGES; page++) {
    const r = await client.conversations.replies({
      channel, ts: threadTs, latest, inclusive: true, limit: GATE_REPLY_PAGE_SIZE, ...(cursor ? { cursor } : {}),
    });
    if (!r?.ok) throw new Error("conversations.replies failed");
    const upToEvent = (r.messages ?? []).filter((m: { ts: string }) => Number(m.ts) <= Number(latest));
    tail = [...tail, ...upToEvent].slice(-limit);
    cursor = r.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return tail;
}

const STATUS_THINKING = { text: "thinking", emoji: ":thought_balloon:" };

type SessionRoute = {
  ctx: SlackContext;
  /** The interaction Surface for this session. Built once; reads ctx live (getters). */
  surface: Surface;
  /** Whether the agent has emitted user-visible output this turn (surface reply/edit/upload). */
  spoke: boolean;
  /** The agent ended this turn deliberately without replying (`mcp__slaude_surface__pass`).
   *  Satisfies the stop guard like `spoke`, but posts nothing. Reset per turn. */
  passed?: boolean;
  /** The reaction the pass added (`react`), if any. A passed turn ends without ✅,
   *  and the received 👀 is kept only when it is this same emoji. Reset per turn. */
  passReact?: string;
  /** Whether the thread was engaged before this turn's mention engaged it.
   *  `false` means the mention engaged it; a turn that then only passes puts it
   *  back (a passing mention is not an invitation). Undefined when the turn did
   *  not come from a mention. Set per turn. */
  engagedBefore?: boolean;
  /** Slack message ref for the live todo tracker posted by the TodoWrite interceptor.
   *  Cleared at the start of each new user turn so each request gets a fresh block. */
  todoRef?: string;
  /** Last todos array written via TodoWrite — used to stamp the message "all done"
   *  when the turn ends with every item completed. Cleared alongside todoRef. */
  todosSnapshot?: Array<{ content: string; status: string }>;
  /** Slack message ref for the structured TaskCreate/TaskUpdate tracker.
   *  Keyed separately from todoRef so both systems can coexist. */
  tasksRef?: string;
  /** Ordered task map from TaskCreate/TaskUpdate, keyed by task ID. */
  tasksMap?: Map<string, { subject: string; status: string; completedAt?: string }>;
  /** Subject of the in-flight TaskCreate awaiting its toolResult (to capture the assigned ID). */
  pendingTaskCreate?: string;
  /** This turn is a disengaged message recorded into the transcript but suppressed
   *  by the UserPromptSubmit hook (no model run). Skip all Slack-visible feedback. */
  suppress?: boolean;
  /** When true, this session was started by a silent cron job — the stop guard
   *  must not force a reply (the job ran without intending to post to Slack). */
  silent?: boolean;
  /** Set when a manual /compact is in flight; cleared in the done handler after
   *  posting the ✅ confirmation reply. */
  wasCompacting?: boolean;
};

export interface GatewayOptions {
  /** Override how a Surface is built per session. Defaults to a SlackSurface over the
   *  transport client — the extension seam for future surfaces. */
  surfaceFactory?: SurfaceFactory;
  /** Override the OAuth connect runner so a sim can stub the network/browser flow.
   *  Defaults to the real discover → beginConnect → exchange round-trip. */
  oauthConnect?: (args: {
    sessionId: string;
    serverName: string;
    serverConfig: import("../../agent/mcp-oauth/store").OAuthServerConfig;
    postAuthorizeUrl: (url: string) => Promise<void>;
  }) => Promise<import("../../agent/mcp-oauth/store").OAuthTokens>;
  /** Override the paste-back prepare step so a sim can stub discovery/registration.
   *  Defaults to the real discover → prepareConnect round-trip. Used only in
   *  paste-back mode (SLAUDE_OAUTH_REDIRECT_URL set). */
  oauthPrepare?: (args: {
    serverName: string;
    serverConfig: import("../../agent/mcp-oauth/store").OAuthServerConfig;
    redirectUri: string;
  }) => Promise<{
    authorizeUrl: string;
    state: string;
    /** The exchange's inputs as values. Parked in the flow row, because the
     *  paste can arrive on a replica that never held the closure. */
    parts: import("../../agent/mcp-oauth/client").ExchangeParts;
  }>;
  /** Override how a parked flow redeems its code. Defaults to the real token
   *  endpoint round-trip. Injectable so a sim need not stand one up. */
  oauthExchange?: (
    parts: import("../../agent/mcp-oauth/client").ExchangeParts,
    code: string,
  ) => Promise<import("../../agent/mcp-oauth/store").OAuthTokens>;
  /** Disable `/mcp connect` when the boot-time store-format canary fails. Defaults to enabled. */
  mcpConnectEnabled?: boolean;
  /** Test seam: inject the outbound (post-as-user) client directly, bypassing the
   *  SLACK_POST_AS_USER / SLACK_USER_TOKEN env path. When set, the gateway behaves as
   *  if posting-as-user is enabled (self-user echo guard active). */
  outClient?: any;
  /** Turn dispatch override. Default: SLAUDE_ROLE=gateway builds the queue
   *  dispatcher (enqueue to BullMQ, spec §2); any other role runs the agent
   *  in-process as today. Tests inject one with stub infra; explicit null
   *  forces the in-process path regardless of role. */
  queueDispatch?: QueueDispatch | null;
  /** Import on-disk MCP credentials into the store at boot (gateway role only).
   *  Default true; tests that construct a gateway turn it off. */
  importCredentials?: boolean;
  /** Control-panel infra override (design §Session control panel). Default:
   *  built from the queue dispatcher's Redis (gateway role) or the process
   *  Redis singletons (mono) when SLAUDE_PANEL is enabled and the role is not
   *  node. Tests inject one over their key prefix; explicit null forces the
   *  panel off regardless of env. */
  panel?: PanelInfra | null;
  /** Decision gate (phase B). Default: the runner gateRunnerFromEnv resolves
   *  to at boot (SLAUDE_DECISION_CONFIG), treated as off until it does. */
  gateRunner?: GateRunner;
  /** Start the background learning scheduler (nightly review, lessons upkeep;
   *  phase D): leader-elected in the gateway role, directly in mono, never on a
   *  node, and only with the brain enabled. Default false, so no test starts it
   *  by building a gateway; server.ts turns it on. */
  backgroundLearning?: boolean;
}

/** Redis-backed primitives the control panel needs — injected together so a
 *  test drives them over one connection + key prefix. */
export interface PanelInfra {
  registry: Registry;
  pubsub: PubSub;
  panelLock: PanelLock;
}

/** Render a TaskCreate/TaskUpdate tasks map as a compact markdown task list. */
function formatTaskList(tasks: Map<string, { subject: string; status: string; completedAt?: string }>): string {
  const lines = [...tasks.values()].map((t) => {
    if (t.status === "completed") return `✓ ${t.subject}${t.completedAt ? ` _(${t.completedAt})_` : ""}`;
    if (t.status === "in_progress") return `➠ **${t.subject}**`;
    return `○ ${t.subject}`;
  });
  return `**Tasks**\n${lines.join("\n")}`;
}

/** Render a TodoWrite todos array as a compact markdown task list for the Slack surface. */
function formatTodoList(todos: Array<{ content: string; status: string }>): string {
  const lines = todos.map((t) => {
    if (t.status === "completed") return `✓ ${t.content}`;
    if (t.status === "in_progress") return `➠ **${t.content}**`;
    return `○ ${t.content}`;
  });
  return `**Tasks**\n${lines.join("\n")}`;
}

/** A live SessionBinding view over the mutated-in-place SlackContext, so the Surface always
 *  reads the current turn's conversation/inbound/user (the gateway mutates ctx across turns). */
export function bindingFor(ctx: SlackContext): SessionBinding {
  return {
    get conversationId() { return ctx.channel; },
    // Channel-target crons must post at channel root, not threaded under the
    // originating thread. The surface binding is the single seam every post
    // tool (reply/upload/getHistory) reads, so drop the thread ref here when
    // the context is channel-targeted. postTarget is only set for crons; normal
    // inbound sessions leave it unset and keep their thread.
    get threadRef() { return ctx.postTarget === "channel" ? undefined : ctx.threadTs; },
    get inboundRef() { return ctx.inboundTs; },
    get userId() { return ctx.userId; },
    get teamId() { return ctx.teamId; },
    requestApproval: (r) => ctx.requestApproval!(r),
    reloadSession: (prompt?) => ctx.reloadSession?.(prompt) ?? false,
  };
}

/** Dispatch meta for an operator-panel turn: the session row is the only
 *  source, including the Slack app its thread arrives through (D1.2). */
export function panelDispatchMeta(session: SessionRow, operatorId: string, eventTs: string): DispatchMeta {
  const personaId = session.persona_id && session.persona_id !== "default" ? session.persona_id : undefined;
  return {
    teamId: session.slack_team_id ?? "",
    channelId: session.slack_channel_id ?? "",
    threadTs: session.slack_thread_ts ?? "",
    eventTs,
    userId: operatorId,
    personaId,
    ...(session.slack_app_id ? { apiAppId: session.slack_app_id } : {}),
    origin: "panel",
  };
}

/** A cron run's dispatch: it runs as the job's creator, under its app, and is
 *  never interactive (origin "cron"), so it can never write a profile. */
export function cronDispatchMeta(job: CronJobs.CronJob, threadTs: string, eventTs: string): DispatchMeta {
  return {
    teamId: job.slackTeamId!,
    channelId: job.slackChannelId!,
    threadTs,
    eventTs,
    userId: job.createdBy,
    personaId: job.personaId !== "default" ? job.personaId : undefined,
    ...(job.slackAppId ? { apiAppId: job.slackAppId } : {}),
    origin: "cron",
    // A job created inside a /1on1 runs as its lock owner wherever it lands.
    ...(job.oauthUser ? { oauthUser: job.oauthUser } : {}),
  };
}

export function createGateway(agent: AgentManager, t: Transport, opts: GatewayOptions = {}): GatewayHandle {

  // Horizontal-scale dispatch (spec §2): in the gateway role turns are
  // enqueued to the node pool instead of running in-process; the events
  // stream follower inside the dispatcher re-emits AgentEvents locally so
  // the Slack UX pipeline below stays identical. mono keeps today's path.
  const queueDispatch: QueueDispatch | null =
    opts.queueDispatch !== undefined
      ? opts.queueDispatch
      : env.role() === "gateway"
        ? makeQueueDispatch(agent)
        : null;
  if (queueDispatch) console.log("[slaude] gateway role: turns dispatch to the node queue");

  // Nodes seed MCP credentials only from the gateway's store, so credentials
  // still on disk from before the store existed are imported once. Insert-only
  // and idempotent, so every replica can run it at boot without coordinating.
  // Never awaited: a slow volume must not hold up Slack ingress. On failure
  // only the error's class and code are logged: a filesystem error's message
  // carries a path, and a person's path carries their Slack user id.
  if (env.role() === "gateway" && opts.importCredentials !== false) {
    void importOnDiskCredentials().catch((e) => {
      const code = (e as { code?: unknown })?.code;
      console.error(
        `[credential-import] failed: ${e instanceof Error ? e.name : typeof e}${typeof code === "string" ? ` code=${code}` : ""}`,
      );
    });
  }

  // ── Session control panel (design §Session control panel) ────────────────
  // Redis-backed active-surface lock + event tail + warm registry. Reuses the
  // queue dispatcher's pubsub/registry when present (same connection + prefix),
  // else builds them off the process Redis singletons. Built only for
  // mono/gateway roles with SLAUDE_PANEL on; a test injects opts.panel.
  const panelInfra: PanelInfra | null =
    opts.panel !== undefined
      ? opts.panel
      : env.panel.enabled() && env.role() !== "node"
        ? (() => {
            const redis = getRedis();
            const keys = queueDispatch?.pubsub.keys ?? makeKeys();
            return {
              registry: queueDispatch?.registry ?? makeRegistry({ redis, keys }),
              pubsub: queueDispatch?.pubsub ?? makePubSub({ redis, sub: getSubRedis(), keys }),
              panelLock: makePanelLock({ redis, keys }),
            } satisfies PanelInfra;
          })()
        : null;
  if (panelInfra) console.log("[slaude] control panel enabled (/panel)");

  // Cross-replica active-surface state. The Redis lock (`panel:<id>`) is the
  // sole source of truth about WHO holds a session — per-process maps only
  // cache it or hold this replica's own deferred inbound. A session can be
  // locked on replica A while Slack traffic and the node's /v1 posts land on
  // replica B, so every "is it held?" check ultimately consults Redis.
  const panelHeldLocal = new Map<string, number>(); // sessionId -> local expiresAt (fast path on the owning replica)
  const panelOwnerCache = new Map<string, { owner: string | null; at: number }>();
  const panelDefer = makeDeferQueue(); // THIS replica's deferred inbound only
  const OWNER_CACHE_MS = 1_000;

  const panelMarkHeld = (sessionId: string, ttlMs: number) => {
    panelHeldLocal.set(sessionId, Date.now() + ttlMs);
    // Prime the owner cache optimistically so suppression is immediate on the
    // replica that just took/refreshed the lock.
    panelOwnerCache.set(sessionId, { owner: "self", at: Date.now() });
    // Broadcast the acquisition so OTHER replicas invalidate any stale
    // "unlocked" cache for this session — otherwise a negative lookup cached
    // (e.g. during an earlier turn) could mask a lock taken here for up to the
    // cache window, letting inbound through / outbound double-post.
    void panelInfra?.pubsub.publishPanelHold(sessionId).catch(() => {});
  };

  // Authoritative (async) held check: local fast-path OR Redis owner present,
  // cached ~1s so it is not a per-event GET. Used by the inbound gate and by
  // the outbound surface suppression (both already async).
  const panelHeldAsync = async (sessionId: string): Promise<boolean> => {
    const exp = panelHeldLocal.get(sessionId);
    if (exp !== undefined && Date.now() <= exp) return true;
    if (!panelInfra) return false;
    const cached = panelOwnerCache.get(sessionId);
    if (cached && Date.now() - cached.at < OWNER_CACHE_MS) return cached.owner !== null;
    try {
      const owner = await panelInfra.panelLock.owner(sessionId);
      panelOwnerCache.set(sessionId, { owner, at: Date.now() });
      return owner !== null;
    } catch {
      // Redis hiccup: fall back to the last cached value, else not-held.
      return cached ? cached.owner !== null : false;
    }
  };

  // Synchronous best-effort held check for the (sync) agent event handler:
  // local fast-path OR a fresh cache hit; a stale/missing cache kicks an async
  // refresh and returns the last known value. The authoritative reply-echo
  // suppression is the async surface path above; this only gates
  // reactions/status, which tolerate a sub-second lag.
  const panelHeldSync = (sessionId: string): boolean => {
    const exp = panelHeldLocal.get(sessionId);
    if (exp !== undefined && Date.now() <= exp) return true;
    if (!panelInfra) return false;
    const cached = panelOwnerCache.get(sessionId);
    if (cached && Date.now() - cached.at < OWNER_CACHE_MS) return cached.owner !== null;
    void panelHeldAsync(sessionId); // refresh for next time
    return cached ? cached.owner !== null : false;
  };

  // Drain THIS replica's deferred inbound for a session and clear local held.
  async function drainPanelDefer(sessionId: string): Promise<void> {
    panelHeldLocal.delete(sessionId);
    panelOwnerCache.delete(sessionId);
    const thunks = panelDefer.drain(sessionId);
    for (const run of thunks) {
      try {
        await run();
      } catch (e) {
        console.error(`[panel] deferred replay failed session=${sessionId}:`, e);
      }
    }
  }

  // Resume broadcast: a lock released (explicit / TTL / not-force). Clear the
  // Redis notice guard + drain locally, then PUBLISH so EVERY replica drains
  // its own queue — a Slack message deferred on a non-owning replica is
  // replayed, never orphaned.
  async function broadcastPanelResume(sessionId: string): Promise<void> {
    if (!panelInfra) return;
    await panelInfra.panelLock.clearNotice(sessionId).catch(() => {});
    await drainPanelDefer(sessionId);
    await panelInfra.pubsub.publishPanelResume(sessionId).catch(() => {});
  }

  // Subscribe once: another replica released a lock → drain our own queue;
  // another replica acquired/transferred a lock → invalidate our owner cache so
  // the next held-check reads the fresh Redis lock.
  let panelResumeUnsub: (() => Promise<void>) | null = null;
  let panelHoldUnsub: (() => Promise<void>) | null = null;
  if (panelInfra) {
    panelInfra.pubsub
      .onPanelResume((sessionId) => void drainPanelDefer(sessionId))
      .then((unsub) => {
        panelResumeUnsub = unsub;
      })
      .catch((e) => console.error("[panel] resume subscribe failed:", e));
    panelInfra.pubsub
      .onPanelHold((sessionId) => panelOwnerCache.delete(sessionId))
      .then((unsub) => {
        panelHoldUnsub = unsub;
      })
      .catch((e) => console.error("[panel] hold subscribe failed:", e));
  }

  // Sweeper: drain-driven off the deferred queue, not a local held map — so a
  // TTL-expiry (or a release we missed the broadcast for) still resumes on
  // whichever replica is holding the deferred messages. For each session with
  // pending inbound, if Redis says the lock is gone, broadcast a resume.
  const panelSweeper = panelInfra
    ? setInterval(() => {
        void (async () => {
          for (const sessionId of panelDefer.heldSessions()) {
            try {
              if ((await panelInfra.panelLock.owner(sessionId)) === null) {
                await broadcastPanelResume(sessionId);
              }
            } catch {
              /* transient — retry next tick */
            }
          }
          // Expire stale local held marks so panelHeldSync stops lying.
          for (const [sessionId, exp] of [...panelHeldLocal]) {
            if (Date.now() > exp) panelHeldLocal.delete(sessionId);
          }
        })();
      }, 1_000)
    : null;
  panelSweeper?.unref?.();

  // Wrap a session's Surface so its user-visible writes are suppressed while
  // the panel lock is held (design §Active-surface lock, outbound gate). No-op
  // passthrough when the panel is off, so non-panel deploys are byte-identical.
  const wrapSurface = (surface: Surface, sessionId: string): Surface =>
    quietForVoice(panelInfra ? suppressibleSurface(surface, sessionId, panelHeldAsync) : surface, sessionId);

  // Outbound content client. When SLACK_USER_TOKEN (xoxp) is set, agent replies,
  // edits, reactions and uploads go out AS the real Slack user account rather than
  // the app bot. Interactivity-bound paths (gates) keep using the bot client
  // of the session's app (botClientFor below). No user token → outbound posts
  // go out as that bot (defaultOutClient), preserving current behavior.
  // This is the DEFAULT identity (persona_id='default') — named personas with
  // their own `userToken` get their own client, resolved per-session below.
  const userToken = env.slack.userToken();
  const postsAsUser = Boolean(opts.outClient) || (env.slack.postAsUser() && Boolean(userToken));
  const outClient: any = opts.outClient
    ? opts.outClient
    : postsAsUser
    ? new (require("@slack/web-api").WebClient)(userToken)
    : (t.client as any);
  if (postsAsUser) console.log("[slack-out] posting as user (xoxp) — bot token reserved for gates/events");
  else if (env.slack.postAsUser()) console.warn("[slack-out] SLACK_POST_AS_USER=true but SLACK_USER_TOKEN unset — posting as bot");

  // Bot client of the app a session, event, cron job or gate belongs to (D1.2).
  // A multi-app (HTTP) transport resolves it per call from (api_app_id,
  // team_id) and refuses an identity that names no single registered app; a
  // single-app transport has only its one client, so nothing changes there.
  // Interactivity-bound paths (gates, status, the error post) always use it.
  const botClientFor = (app?: AppRef): any => clientForApp(t, app);
  const appOf = (c: { apiAppId?: string; teamId?: string }): AppRef => ({ apiAppId: c.apiAppId, teamId: c.teamId });
  // The default outbound identity: the user token when posting as a user,
  // else the bot of the session's app.
  const defaultOutClient = (app?: AppRef): any => (postsAsUser ? outClient : botClientFor(app));

  // Per-persona xoxp posting: a named persona with its own `userToken` gets its
  // own WebClient + surfaceFactory instead of the default outClient above, so its
  // replies/edits/uploads show as that persona's own Slack account. Default
  // persona (or a named persona with no token) → falls through to outClient,
  // byte-identical to before this feature existed. `opts.surfaceFactory` (test/
  // sim override) always wins regardless of persona — sim never needs a real
  // per-persona Slack client, and per-persona resolution would otherwise try to
  // hit the real Slack API with whatever token a test happens to configure.
  // On a managed registry a named persona that is not live is refused
  // (livePersona throws), never served the default client: posting a retired
  // persona's thread as the default identity is exactly what must not happen.
  const outClientForPersona = (personaId?: string, app?: AppRef): any => {
    if (!personaId || personaId === "default") return defaultOutClient(app);
    return livePersona(personaId)?.outClient ?? defaultOutClient(app);
  };
  // Surfaces resolve their client on every call, so a sync that rotates,
  // removes or re-points a persona's userToken reaches surfaces built before
  // it, including the one the in-process surface MCP of a warm session holds
  // (bound at boot). A retired persona's resolver throws on a managed registry
  // (outClientForPersona), so nothing posts.
  const surfaceFactoryFor = (personaId?: string, app?: AppRef): SurfaceFactory => {
    if (opts.surfaceFactory) return opts.surfaceFactory;
    const named = personaId && personaId !== "default" ? personaId : undefined;
    return makeSlackSurfaceFactory(() => outClientForPersona(named, app));
  };
  // A session's surface follows its context: the persona's current client, as
  // the app the context currently names.
  const surfaceForCtx = (ctx: SlackContext): Surface =>
    opts.surfaceFactory
      ? opts.surfaceFactory(bindingFor(ctx))
      : makeSlackSurfaceFactory(() => outClientForPersona(ctx.personaId, appOf(ctx)))(bindingFor(ctx));

  // Resolve per-session client: persona xoxp when available, bot token as fallback.
  // routes Map is populated lazily (after this line), but the resolver is called
  // only at reaction time — no init-order issue.
  const reactions = new ReactionTracker(
    (sessionId: string) => routes.get(sessionId)?.ctx.client ?? botClientFor(),
  );
  const presence = new Presence(t.client as any);
  // Status is an assistant-thread call: the bot of the session's app.
  const status = new Status((sessionId: string) => {
    const route = routes.get(sessionId);
    return botClientFor(route ? appOf(route.ctx) : undefined);
  });
  const permissions = new PermissionGate(t);
  const approvals = new ApprovalGate(t, env.slack.approvers(), {
    timeoutSeconds: () => soulData().approvalTimeoutSeconds || 300,
  });
  // Background-learning messages (phase D): the weekly digest to the manager
  // and a person's proposals to their DM. Both carry buttons, so they go out
  // as the bot of the app (interactivity-bound, like the gates); chat:write
  // with im:write lets a bot post to a user id, which opens its DM.
  const backgroundManagers = (): string[] => {
    const soul = soulData();
    return [soul.manager.userId, soul.backupManager.userId].filter((u): u is string => !!u);
  };
  /** The persona's servers as the MCP bridge serves them (bridgeExternalMcp:
   *  the managed persona's config; files only with the operator's opt-in). */
  const bridgeServers = (claims: JobClaims) =>
    bridgeExternalMcp(claims.persona && claims.persona !== "default" ? claims.persona : undefined);
  /** Boot warning: a watched server a session mounts but the bridge does not
   *  serve (a file-configured server without the opt-in) is never read. */
  const warnUnservedWatches = (): void => {
    const personas = ["default", ...getPersonaRegistry().list().map((p) => p.name)];
    for (const p of new Set(personas)) {
      try {
        const watch = proactiveFor(p).watch;
        if (!watch.length) continue;
        const named = p === "default" ? undefined : p;
        for (const name of unservedWatches(watch, sessionExternalMcp(named, loadExternalMcp()), bridgeExternalMcp(named))) {
          console.warn(
            `[proactive] persona=${p} watch "${name}": the MCP bridge does not serve it, so the heartbeat cannot read it; a file-configured server needs SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG=1`,
          );
        }
        // Mono: /mcp global connect writes the agent's OAuth grant into the
        // CLI's own store, which the bridge neither reads nor may refresh (the
        // CLI rotates it), so a server with no config headers is not readable.
        if (env.role() === "mono") {
          for (const name of oauthOnlyWatches(watch, bridgeExternalMcp(named))) {
            console.warn(
              `[proactive] persona=${p} watch "${name}": it has no config headers, so the heartbeat would need the agent's OAuth connection, which on mono lives in the agent CLI's own store and is not used; the source is skipped when it asks for auth`,
            );
          }
        }
      } catch (e) {
        console.warn(`[proactive] persona=${p}: could not check watched sources: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  const backgroundSlack: SchedulerSlack = {
    // As the bot of the app the message names; on a multi-app transport a
    // post that does not name both app id and team is refused (cardPoster).
    post: cardPoster(t),
    // Mono keeps the agent's OAuth grants in the CLI's own store (persistTokens).
    ...(env.role() === "mono" ? { agentOAuthInCli: true } : {}),
    managers: backgroundManagers,
    digestRecipient: () => digestRecipientOf(soulData()),
  };
  registerProposalActions(t, { managers: backgroundManagers, call: brainCall, now: () => new Date(), ready: brainReady });
  const ignoreGate = new IgnoreGate();
  // Boot sweep: auto-expire pending gates whose deadline passed while no
  // process was alive (a restart killed their auto-deny timers). Rows with no
  // deadline stay; a later click on one settles it as cancelled.
  void PendingGates.sweepExpired()
    .then((rows) => {
      for (const r of rows) console.log(`[gates] expired orphaned ${r.kind} gate ${r.id} (session ${r.sessionId})`);
    })
    .catch((e) => console.error("[gates] boot sweep failed:", e));
  // Clean up expired ignores + abandoned paste-back OAuth flows every 5 minutes.
  // Each parked flow holds the registered client secret and the PKCE verifier
  // (encrypted), so an abandoned one must not linger until the initiator happens
  // to message again.
  setInterval(() => {
    import("../../db/ignores").then((m) => m.cleanupExpired());
    // Overdue gates (live auto-deny timers normally win; this catches strays)
    // + settled gate rows past the 24h audit horizon + stale dedup rows on
    // quiet deployments where the inbound-path purge never fires.
    void PendingGates.sweepExpired().catch(() => {});
    void PendingGates.purgeSettledOlderThan().catch(() => {});
    void SeenEvents.purgeOlderThan().catch(() => {});
    void SlackOauthFlows.sweepExpiredFlows().catch(() => {});
    // Idle sandboxes (provisioned environments) are torn down and restart on
    // the thread's next message. Safe on every replica: each teardown is claimed.
    // Mono reboots the warm session now; a split deploy reboots through the
    // fingerprint once the next dispatch provisions a new sandbox.
    if (env.remote.enabled()) {
      void sweepIdleSandboxes(undefined, (ch, ts) => {
        if (queueDispatch) return;
        for (const [sid, r] of routes) if (r.ctx.channel === ch && (r.ctx.threadTs ?? r.ctx.inboundTs) === ts) agent.reload(sid);
      }).catch((e) => console.error("[env] idle sweep failed:", e));
    }
  }, 5 * 60 * 1000);

  // Mono turn senders (phase C, invariant 2): the route's ctx is rewritten
  // by every delivered message, so a profile write reads who sent the inputs
  // the session's CLI is processing from the manager's own per-input queue
  // (AgentManager.turnSenders; the Slack and panel paths hand each message's
  // sender to sendMessage). Bound on every route ctx; declared before the
  // cron scheduler, whose routes bind it too (cron inputs carry no sender).
  const noteTurnSender = (sessionId: string, ctx: SlackContext): void => {
    ctx.turnSenders ??= () => (typeof agent.turnSenders === "function" ? agent.turnSenders(sessionId) : null);
  };

  const cronScheduler = new CronScheduler({
    agent,
    // Queue mode: a cron turn is a turn like any other — it runs on a node, not
    // in the gateway, which is sized and drained on the assumption that it holds
    // none. mono keeps running it in process (no send/isLive injected).
    ...(queueDispatch
      ? {
          send: async ({ session, envelope, job, threadTs }) => {
            await queueDispatch.dispatch(session, envelope, cronDispatchMeta(job, threadTs, String(Date.now() / 1000)));
          },
          // when_active=skip asks whether a turn is already running. Under the
          // split that happens on a node, so the gateway's own agent knows
          // nothing about it: the session lock is held for exactly the turn's
          // duration, so its presence is the cluster-wide answer.
          isLive: async (sessionId: string) =>
            (await getRedis().exists(makeKeys().sessionLock(sessionId))) > 0,
        }
      : {}),
    onExecute: (job, sessionId) => {
      // Register a route so cron sessions get Slack MCP tools + event handling.
      const jobPersonaId = job.personaId !== "default" ? job.personaId : undefined;
      // The app the job was created under: it posts as that app after a
      // restart or on another replica. Older jobs carry only the team.
      const jobApp: AppRef = { apiAppId: job.slackAppId ?? undefined, teamId: job.slackTeamId ?? undefined };
      const ctx: SlackContext = {
        client: outClientForPersona(jobPersonaId, jobApp),
        apiAppId: jobApp.apiAppId,
        resolveBotToken: () => t.botTokenFor?.(jobApp),
        channel: job.slackChannelId!,
        threadTs: job.slackThreadTs ?? job.channelId,
        inboundTs: String(Date.now()), // synthetic — no real inbound msg for cron
        userId: job.createdBy,
        teamId: job.slackTeamId ?? undefined,
        postTarget: job.target,
        personaId: jobPersonaId,
        origin: "cron",
      };
      ctx.requestApproval = (req) =>
        approvals.request({
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          sessionId,
          app: jobApp,
          ...req,
        });
      ctx.reloadSession = (prompt?) => agent.reload(sessionId, prompt);
      noteTurnSender(sessionId, ctx);
      routes.set(sessionId, { ctx, surface: wrapSurface(surfaceForCtx(ctx), sessionId), spoke: false, silent: true });
    },
  });
  /**
   * One background turn into a thread through the cron path (promise checks,
   * heartbeat ask/act): the thread's session, a route bound like a cron run's
   * (origin cron, silent), then the queue in the gateway role or this
   * process in mono, carrying the open ledger run its own usage closes. Whom
   * the turn runs as is the thread's own /1on1 lock, never a carried identity;
   * callers check that the lock is what they expect. `userId` is the ctx's
   * and the job's initiator; `engage` marks the thread engaged so a later
   * human reply continues it.
   */
  const dispatchThreadTurn = async (
    target: { teamId: string; channelId: string; threadTs: string; personaId: string | undefined; userId: string; engage?: boolean; appId?: string | null },
    envelope: string,
    run: { runId: string; agentId: string },
    pass: TurnPass,
  ): Promise<void> => {
    const { teamId, channelId, threadTs, userId } = target;
    const persona = target.personaId;
    const session = await agent.ensureSession({ team_id: teamId, channel_id: channelId, thread_ts: threadTs, persona_id: persona ?? "default" });
    if (target.engage) await Sessions.setEngaged(session.id, true);
    // A thread a heartbeat post just opened has no app of its own yet: the
    // post's app is stamped on it, so this turn (and a later reply's) speaks
    // as the app that posted, which a multi-app transport requires.
    if (!session.slack_app_id && target.appId) {
      await Sessions.setSlackApp(session.id, target.appId);
      session.slack_app_id = target.appId;
    }
    const app: AppRef = { apiAppId: session.slack_app_id ?? undefined, teamId };
    const ctx: SlackContext = {
      client: outClientForPersona(persona, app),
      apiAppId: app.apiAppId,
      resolveBotToken: () => t.botTokenFor?.(app),
      channel: channelId,
      threadTs,
      inboundTs: String(Date.now()),
      userId,
      teamId,
      postTarget: "thread",
      personaId: persona,
      origin: "cron",
    };
    ctx.requestApproval = (req) => approvals.request({ channel: ctx.channel, threadTs: ctx.threadTs, sessionId: session.id, app, ...req });
    ctx.reloadSession = (prompt?) => agent.reload(session.id, prompt);
    noteTurnSender(session.id, ctx);
    routes.set(session.id, { ctx, surface: wrapSurface(surfaceForCtx(ctx), session.id), spoke: false, silent: true });
    if (queueDispatch) {
      await queueDispatch.dispatch(session, envelope, {
        teamId,
        channelId,
        threadTs,
        eventTs: String(Date.now() / 1000),
        userId,
        personaId: persona,
        ...(app.apiAppId ? { apiAppId: app.apiAppId } : {}),
        origin: "cron",
        backgroundRunId: run.runId,
      });
    } else {
      await agent.sendMessage(session.id, envelope, { backgroundRun: ledgerTurnRun({ runId: run.runId, agentId: run.agentId, pass }) });
    }
  };
  // Promise checks (phase E): a due commitment's check turn goes into the
  // thread that made the promise, through the cron path (a route bound like a
  // cron run's, origin cron; the queue in the gateway role, this process in
  // mono), carrying its open `commitment` ledger run. It never runs as anyone
  // through a carried identity: the thread's own /1on1 lock decides, and a
  // check whose thread no longer has the scope it was promised in (a lock
  // taken or released since) is refused and retried, so a /1on1 promise is
  // only ever checked inside that /1on1.
  const promiseTeam = async (row: CommitmentRow): Promise<string | null> =>
    row.teamId ?? (await Sessions.teamForThread(row.channelId, row.threadTs));
  const promiseSession = async (row: CommitmentRow): Promise<SessionRow | null> => {
    const teamId = await promiseTeam(row);
    return teamId ? Sessions.findByThread({ team_id: teamId, channel_id: row.channelId, thread_ts: row.threadTs, persona_id: row.personaId || "default" }) : null;
  };
  /** Throws unless the thread still has the scope the promise was made in (its /1on1 lock owner, or no lock). */
  const promiseScopeHolds = async (row: CommitmentRow): Promise<void> => {
    const lockedUser = (await OneOnOne.find(row.channelId, row.threadTs))?.locked_user ?? null;
    if ((row.runAs ?? null) !== lockedUser) throw new Error("the thread's /1on1 lock changed since the promise; not speaking there");
  };
  backgroundSlack.promises = {
    isBusy: async (row) => {
      const session = await promiseSession(row);
      if (!session) return false;
      if (!queueDispatch) return agent.isTurnInFlight(session.id);
      // A turn running (its session lock) or a message waiting to be claimed.
      if ((await getRedis().exists(makeKeys().sessionLock(session.id))) > 0) return true;
      return queueDispatch.turns.hasPending(session.id);
    },
    dispatch: async (row, envelope, run) => {
      const teamId = await promiseTeam(row);
      if (!teamId) throw new Error("no Slack team is known for this thread");
      await promiseScopeHolds(row);
      const persona = row.personaId && row.personaId !== "default" ? row.personaId : undefined;
      await dispatchThreadTurn(
        { teamId, channelId: row.channelId, threadTs: row.threadTs, personaId: persona, userId: row.beneficiary },
        envelope,
        run,
        "commitment",
      );
    },
    post: async (row, text) => {
      // Even the fixed line names the promise's due: only where a check may speak.
      await promiseScopeHolds(row);
      const teamId = await promiseTeam(row);
      const persona = row.personaId && row.personaId !== "default" ? row.personaId : undefined;
      const session = await promiseSession(row);
      const app: AppRef = { apiAppId: session?.slack_app_id ?? undefined, teamId: teamId ?? undefined };
      await outClientForPersona(persona, app).chat.postMessage({ channel: row.channelId, thread_ts: row.threadTs, text });
    },
  };

  // Heartbeat ask/act (src/proactive/dispatch.ts): the item's turn goes into
  // the thread of the post the round just made, as the agent. The thread is
  // new, so no /1on1 lock is expected; one taken since would make the turn
  // run as that person, so it is refused. The initiator is the agent's own id
  // in a DM as in a channel: no person sent this turn, and the route's
  // userId is what manager-only tools and the brain gate's isManager read,
  // so a DM recipient (often the manager) must not lend the turn their
  // rights. A human reply rewrites the route with its real sender. Engaged,
  // so that reply continues the thread.
  backgroundSlack.proactive = {
    dispatch: async (post, envelope, run, personaId) => {
      if (!post.messageTs) throw new Error("the post has no message ts");
      if (!post.teamId) throw new Error("no Slack team is known for this post");
      if (await OneOnOne.find(post.channelId, post.messageTs)) throw new Error("the post's thread has a /1on1 lock; a heartbeat turn runs only as the agent");
      const persona = personaId && personaId !== "default" ? personaId : undefined;
      await dispatchThreadTurn(
        {
          teamId: post.teamId,
          channelId: post.channelId,
          threadTs: post.messageTs,
          personaId: persona,
          userId: post.agentId,
          engage: true,
          appId: post.appId,
        },
        envelope,
        run,
        "heartbeat-turn",
      );
    },
  };

  agent.setPermissionResolver(permissions.resolver);
  if (env.remote.enabled() && env.role() !== "gateway") {
    // Mono: the query runs in this process, so resolve the target from the DB
    // and open the helper here. In split deploys the node does this from claims.
    agent.setRemote(monoRemoteResolver, makeMonoRemoteFactory());
  }


  // Diag: dump bot identity + granted scopes once at startup, per registered
  // app (D1.4) — each line names the app and its bot user, never a token. A
  // single-app transport has one identity, logged as before.
  void (async () => {
    const apps = t.apps ? await t.apps() : [{ apiAppId: "", teamId: "", client: t.client }];
    for (const a of apps) {
      const who = a.apiAppId ? `app=${a.apiAppId} ` : "";
      try {
        const res = await a.client.auth.test();
        const scopesHeader = (res as any).response_metadata?.scopes ?? (res as any).headers?.["x-oauth-scopes"];
        console.log(
          `[slack-auth] ${who}team=${(res as any).team} user=${(res as any).user} bot_user=${(res as any).user_id} bot_id=${(res as any).bot_id} url=${(res as any).url}`,
        );
        console.log(`[slack-auth] ${who}scopes=${scopesHeader ?? "(unknown — check app OAuth page)"}`);
      } catch (e: any) {
        console.error(`[slack-auth] ${who}auth.test failed:`, e?.data?.error ?? e?.message);
      }
    }
  })().catch((e) => console.error("[slack-auth] app listing failed:", e?.message ?? e));

  // Per-session route + slack context. Mutated on each new inbound user message.
  const routes = new Map<string, SessionRoute>();
  const firstFailurePost = createOnceGuard();

  // On every registry install, bring warm routes in line with it:
  //  - a persona a MANAGED registry no longer lists: drop its routes, so events
  //    still arriving for that session (an in-flight turn the agent manager is
  //    aborting) post nothing, through neither its old client nor the default;
  //  - otherwise: re-point ctx.client at the persona's current client. Reactions
  //    and the Slack/runtime MCP servers read ctx.client per call, and surfaces
  //    resolve their client per call (surfaceFactoryFor), so a rotated token is
  //    used on the next post in an EXISTING thread, with no session restart.
  // WeakRef: a discarded gateway is not kept alive by the listener.
  const routesRef = new WeakRef(routes);
  const offRegistryInstalls = onPersonaRegistryInstalled((r) => {
    const live = routesRef.deref();
    if (!live) return offRegistryInstalls();
    for (const [sid, route] of live) {
      const pid = route.ctx.personaId;
      if (!pid || pid === "default") continue;
      const p = r.lookupByName(pid);
      if (!p) {
        if (!r.isManaged()) continue;
        console.log(`[slaude] dropping route session=${sid} — persona=${pid} no longer live`);
        live.delete(sid);
        continue;
      }
      route.ctx.client = p.outClient ?? defaultOutClient(appOf(route.ctx));
    }
  });

  const sessionCtx = new Map<string, SessionMcpCtx>();
  // Start the cron scheduler only after `routes` exists: start() synchronously runs any
  // due job through onExecute, which registers into `routes`. Starting earlier would hit
  // a temporal-dead-zone ReferenceError when a cron job is already due at boot.
  // Every gateway builds a scheduler, but only one may run it: the scheduler's
  // re-entry guard is in-process, and a due job is claimed nowhere, so N
  // replicas would fire every job N times. mono has no Redis to elect with and
  // is a single process anyway.
  let cronLeader: LeaderHandle | undefined;
  if (queueDispatch) {
    cronLeader = startCronLeader(cronScheduler, {
      redis: getRedis(),
      onError: (e) => console.error("[cron] leader loop:", e),
    });
    console.log("[slaude] cron scheduler contending for leadership");
  } else {
    cronScheduler.start();
  }

  // Background learning (phase D): one scheduler where the brain lives. Like
  // cron, the gateway role elects one replica to run it (each slot is also
  // claimed in the database, so a leader change mid-pass never re-runs one);
  // mono runs it directly. Ticks wait for an open brain and never boot it.
  let backgroundScheduler: { stop(graceMs?: number): Promise<void> } | undefined;
  // The heartbeat round reads the agent's own sources through a bridge of its
  // own: the same servers as the node bridge (bridgeServers), but no
  // onNeedsAuth, so a source that needs re-authorising posts no card; the
  // round reports it instead. Reads go out as the agent (backgroundClaims).
  let backgroundBridge: McpBridge | undefined;
  if (opts.backgroundLearning === true && env.role() !== "node" && brainEnabled()) {
    backgroundBridge = createMcpBridge({ servers: bridgeServers });
    backgroundSlack.sources = createSourceReader(backgroundBridge);
    warnUnservedWatches();
    backgroundScheduler = startBackgroundScheduler(defaultSchedulerDeps(backgroundSlack), queueDispatch ? { elect: leaderElect(getRedis()) } : {});
    console.log(`[slaude] background learning scheduler ${queueDispatch ? "contending for leadership" : "started"}`);
  }

  // MCP resolver — first-call-per-session wires the slack MCP server bound to
  // the session's SlackContext object. We mutate fields on the same context
  // object across turns so the SDK MCP server stays valid for the session.
  // External MCPs are configured via ~/.claude/mcp.json or .mcp.json in the
  // working dir — claude-code picks them up natively and merges them.
  const externalMcp = loadExternalMcp();
  const privateServiceSet = new Set(externalMcp.privateServices);
  if (Object.keys(externalMcp.servers).length) {
    console.log(`[mcp] loaded external servers: ${Object.keys(externalMcp.servers).join(", ")}`);
  }
  if (externalMcp.privateServices.length) {
    console.log(`[mcp] private (1on1-scoped) services: ${externalMcp.privateServices.join(", ")}`);
  }
  // Brain source bootstrap — sources MUST exist before any kb_memoize write runs.
  // KB wiki import runs after, in the background; failures are logged, not fatal.
  // In remote mode the separate brain-server process owns the engine, source
  // bootstrap and nightly maintenance; the gateway only proxies runtime calls.
  // Resolve this agent's stable identity (its `agent-<id>` slice anchor) once at
  // boot — SLAUDE_AGENT_ID wins, else auth.test on the posting token. Kicked off
  // for any brain mode so per-turn scoping and memory writes see the real id.
  // resolveAgentId catches auth.test failures internally and always resolves, so
  // a bare fire-and-forget is safe (no unhandled rejection).
  // Deliberately NOT per Slack app (D1.4): this id anchors ONE process-wide
  // brain slice (agent-<id>), read synchronously by every scope builder. Making
  // it per app would split one deployment's memory across slices by whichever
  // app a turn arrived through, which is a brain-scoping design change. With
  // several registered apps the auth.test fallback names the oldest one, so
  // such deployments should set SLAUDE_AGENT_ID, which wins without a call.
  if (brainEnabled()) void resolveAgentId(() => outClient.auth.test());
  // Both are owned by this gateway: stop() cancels the timer and waits for the
  // bootstrap, so no brain work outlives the handle (and closeBrain() waits
  // for the tracked bootstrap instead of disconnecting the engine under it).
  let brainBootstrap: Promise<void> | null = null;
  let cancelNightlyMaintenance: () => void = () => {};
  if (brainEnabled() && brainMode() === "local") {
    brainBootstrap = trackBrainWork(
      ensureSources()
        .then(() => syncKbWikis())
        .then((rs) => {
          for (const r of rs) {
            if (r.ok) console.log(`[brain] kb wiki indexed: ${r.label}`);
            else console.error(`[brain] kb sync failed for ${r.label}: ${r.error}`);
          }
        })
        .catch((e) => console.error("[brain] source bootstrap failed:", e)),
    );
    // Nightly maintenance (03:00 local default; SLAUDE_BRAIN_CYCLE="HH:MM"|"off").
    cancelNightlyMaintenance = scheduleNightlyMaintenance();
  }
  // Stop-hook enforcement: if a turn ends without any user-visible Slack tool
  // (reply / edit / upload) or an explicit pass, block the stop once with an
  // instruction to either reply (`mcp__slaude_surface__reply`) or pass
  // (`mcp__slaude_surface__pass`) before exiting.
  agent.setStopGuard((sessionId) => {
    if (voiceTurns.active(sessionId)) return null;
    const route = routes.get(sessionId);
    if (!route) return null;
    if (route.spoke) return null;
    if (route.passed) return null;
    if (route.silent) return null;
    return "You ended the turn without a reply or a pass. If the message needs an answer, call `mcp__slaude_surface__reply`; if it is not for you, call `mcp__slaude_surface__pass` with a reason. Then stop.";
  });

  // Brain gate input from the live SlackContext — read per tool call so the
  // current turn's author (not the session creator) drives KB scoping.
  type BrainGateCtx = Pick<SlackContext, "channel" | "threadTs" | "userId" | "teamId" | "personaId" | "origin" | "turnSenders">;
  // `lockedUser`: the thread's lock owner when the caller already read it.
  const brainGateFor = async (ctx: BrainGateCtx, known?: { lockedUser: string | null }): Promise<GateInput> => {
    const soul = soulData();
    const lockedUser = known ? known.lockedUser : ((await OneOnOne.find(ctx.channel, ctx.threadTs))?.locked_user ?? null);
    // Use the persona's Slack user ID as the agent brain-slice key when in
    // multi-persona mode; fall back to the process-level bot ID otherwise.
    const personaId = ctx.personaId && ctx.personaId !== "default" ? ctx.personaId : null;
    // Managed + not live: livePersona throws, so the gate refuses rather than
    // reading or writing the default agent's private brain slice.
    const personaAgentId = personaId
      ? (livePersona(personaId)?.slackUserId ?? agentIdSync())
      : agentIdSync();
    return {
      userId: ctx.userId ?? null,
      teamId: ctx.teamId || null,
      // Mono: the route's origin (set by the Slack, panel and cron paths);
      // nodes: the signed `origin` claim. Unknown reads as not interactive.
      interactive: isInteractiveOrigin(ctx.origin),
      ...(ctx.origin ? { origin: ctx.origin } : {}),
      ...(await (async () => {
        const senders = await ctx.turnSenders?.();
        return senders ? { turnSenders: senders } : {};
      })()),
      lockedUser,
      channelTrust: channelTrustFor(ctx.channel, soul),
      isManager: !!ctx.userId && (ctx.userId === soul.manager.userId || ctx.userId === soul.backupManager.userId),
      agentId: personaAgentId,
      threadKey: `${ctx.channel}:${ctx.threadTs}`,
    };
  };

  // Episodic memory for turns that run in THIS process (mono): scoped by the
  // turn's own context like the node routes (src/gateway/api/memory.ts), never
  // the process-wide slice. The route's ctx is the current speaker; runAs is
  // the same rule dispatch signs into a node's token (a cron job's carried
  // identity, else the thread's lock). No route: nothing read or written.
  agent.setMemoryProvider(
    makeScopedMemory({
      provider: () => processMemory,
      scopeFor: async (sessionId) => {
        const route = routes.get(sessionId);
        if (!route) return null;
        const { ctx } = route;
        const runAsUser = await agent.resolveEffectiveIdentity(sessionId, ctx.channel, ctx.threadTs);
        const gate = await brainGateFor(ctx);
        const scope = memoryScopeFor(gate, { channel: ctx.channel, runAsUser: runAsUser ?? null });
        // Only an interactive turn counts toward the quiet-moment pass's thread activity.
        return gate.interactive ? { ...scope, activityAgentId: gate.agentId } : scope;
      },
    }),
  );

  // One loud line at boot for a configured model the price table lacks (the
  // gateway prices every check and pass, its nodes' included).
  warnUnpricedModels();

  // The post-turn skill check's budget (spec §9.3), on the ledger for turns
  // that run in THIS process (mono). The run's scope is whom the session's
  // turns run as, by the same rule as memory above.
  agent.setBackgroundBudget(
    ledgerSkillCheckBudget({
      scopeFor: async (sessionId) => {
        const route = routes.get(sessionId);
        if (!route) return "agent";
        const runAsUser = await agent.resolveEffectiveIdentity(sessionId, route.ctx.channel, route.ctx.threadTs);
        return runAsUser ? `user:${runAsUser}` : "agent";
      },
    }),
  );

  // Skill usage for the weekly skill review (spec §9.1), for turns that run in
  // THIS process (mono): keyed by the session persona's agent id, best effort.
  agent.setSkillUsageRecorder(async (_sessionId, personaName, skill) =>
    recordSkillUse(await backgroundAgentId(personaName ?? "default"), skill),
  );

  // Brain tool deps for a context + surface — shared by the per-session MCP
  // resolver and the REST tool plane so both run identical scoping and gating.
  const brainDepsFor = (ctx: SlackContext, surface: Surface, sessionId: string | undefined = ctx.sessionId, claims?: JobClaims): BrainToolDeps | undefined => {
    const claimGate = async (): Promise<GateInput> => {
      const g = await brainGateFor(ctx);
      return claims ? withClaimLock(g, claims.lock?.user) : g;
    };
    return brainEnabled()
      ? {
          // kb-* sources: the live persona's kbSources ∩ installed, per call
          // (WS-C §4.1.3), so a sync applies on the next turn.
          // The speaker's profile only on that one sender's own turn (turnBrainScope).
          // On /v1 the lock is the more private of the live lock and the signed
          // claim (as the memory routes), so a lock released mid-turn cannot let
          // the rest of the turn write the /1on1 out to agent-<id>.
          scope: async () => turnBrainScope(await claimGate(), personaKbSourceIds(ctx.personaId)),
          gate: () => claimGate(),
          // kb_thread_history: the memory read scope. On /v1 the job token is
          // authoritative, derived as the memory routes do; mono uses the live
          // identity, as its route above does.
          thread: async () => {
            if (!sessionId) return { sessionId: undefined, read: null };
            if (claims) return { sessionId, read: memoryScopeForClaims(await brainGateFor(ctx), claims).read };
            const runAsUser = await agent.resolveEffectiveIdentity(sessionId, ctx.channel, ctx.threadTs);
            return { sessionId, read: memoryScopeFor(await brainGateFor(ctx), { channel: ctx.channel, runAsUser: runAsUser ?? null }).read };
          },
          managers: () => {
            const soul = soulData();
            return [soul.manager.userId, soul.backupManager.userId].filter((u): u is string => !!u);
          },
          requestApproval: (r) => surface.requestApproval(r),
          // A commitment written here is indexed for the promise scheduler (phase E).
          onWritten: async (pages, scope) =>
            indexWritten(pages, {
              agentId: (await claimGate()).agentId,
              personaId: ctx.personaId ?? "default",
              teamId: ctx.teamId || null,
              runAs: runAsOf(scope),
              allowedThreads: [`${ctx.channel}:${ctx.threadTs}`],
              writtenAt: new Date(),
            }),
        }
      : undefined;
  };

  // Per-turn memory context (phase C §8.4) for one inbound Slack message:
  // built for THAT message's sender, never from the live route ctx (which the
  // next delivered message rewrites), under the scope the KB tools get on that
  // sender's own turn. So it never holds another person's profile, and in
  // someone else's /1on1 it holds only the sender's own profile. Bounded in
  // time and size by buildTurnMemoryContext; any failure means no block.
  // Reads only a brain that is already open (brainReady, brainCallIfOpen):
  // the message hot path never boots the local engine or connects the remote
  // one. A brain not open yet (or closing) means no block, silently.
  const turnMemoryBlock = async (m: {
    channel: string; threadTs: string; userId: string; teamId: string; personaId?: string; lockedUser: string | null;
  }): Promise<string> => {
    if (!brainEnabled() || !brainReady()) return "";
    try {
      const sender = { userId: m.userId, teamId: m.teamId || null, origin: "slack" };
      const ctx: BrainGateCtx = {
        channel: m.channel, threadTs: m.threadTs, userId: m.userId, teamId: m.teamId, personaId: m.personaId,
        origin: "slack", turnSenders: () => [sender],
      };
      const g = await brainGateFor(ctx, { lockedUser: m.lockedUser });
      const inner = await buildTurnMemoryContext({
        call: brainCallIfOpen,
        scope: turnBrainScope(g, personaKbSourceIds(m.personaId)),
        agentSource: agentSourceId(g.agentId),
        speaker: m.userId,
        threadKey: `${m.channel}:${m.threadTs}`,
        channelId: m.channel,
      });
      return inner ? `<memory-context>\n${inner}\n</memory-context>\n\n` : "";
    } catch (e) {
      console.warn(`[memory-context] skipped: ${e instanceof Error ? e.name : typeof e}`);
      return "";
    }
  };

  // A reply under a proactive post (spec §5 Stitching): the post's
  // `<proactive-context>` for that reply's turn. Only threaded replies count,
  // so a top-level message (its own root) never gets one. Like the memory
  // block it reads only an already-open brain; any failure means no block.
  const turnProactiveBlock = async (m: { channel: string; threadTs: string; eventTs: string; personaId?: string }): Promise<string> => {
    if (m.threadTs === m.eventTs || !brainEnabled() || !brainReady()) return "";
    try {
      const block = await proactiveReplyBlock({ channel: m.channel, threadTs: m.threadTs, personaId: m.personaId });
      return block ? `${block}\n\n` : "";
    } catch (e) {
      console.warn(`[proactive-context] skipped: ${e instanceof Error ? e.name : typeof e}`);
      return "";
    }
  };

  // Voice calls (voice mode spec §3): mono only — a gateway never runs a
  // session; a node gets its config through the runtime bundle. Registered
  // only when voice is enabled AND configured.
  const voiceCalls = new VoiceCalls();
  const voiceHost = (() => {
    if (env.role() === "gateway") {
      // The gateway only ships voice config in runtime bundles; validate it
      // here so a bad or missing audio allowlist is reported at boot.
      if (env.voice.enabled()) {
        try {
          voiceBundleFromEnv();
        } catch (e) {
          console.warn(`[voice] disabled: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return null;
    }
    let cfg: VoiceConfig | null;
    try {
      cfg = voiceConfigFromEnv();
    } catch (e) {
      console.warn(`[voice] disabled: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    if (!cfg) return null;
    endCallsOnSessionExit(agent, voiceCalls);
    return makeMonoVoiceHost({
      agent,
      config: () => cfg,
      findThread: async (sid) => {
        const r = await Sessions.findById(sid);
        return r?.slack_channel_id && r.slack_thread_ts
          ? { channel: r.slack_channel_id, threadTs: r.slack_thread_ts, personaId: r.persona_id ?? null }
          : null;
      },
      remoteTarget: (c, t) => activeRemoteTarget(c, t),
      workingDir: async (sid) => {
        const r = await Sessions.findById(sid);
        if (!r) throw new Error(`unknown session ${sid}`);
        return r.working_dir;
      },
      soul: (t) => monoPersonaSoul(t.personaId, t.channel),
    });
  })();

  const mcpResolver = async (sessionId: string): Promise<Record<string, McpServerConfig> | undefined> => {
    const route = routes.get(sessionId);
    if (!route) return undefined;
    const sessionMcp = sessionExternalMcp(route.ctx.personaId, externalMcp);
    const servers: Record<string, McpServerConfig> = {
      [SURFACE_MCP_NAME]: createSurfaceMcp(route.surface, {
        initiator: () => route.ctx.userId,
        setOneOnOne: (action, scope) => agentOneOnOne(sessionId, route.ctx, action, scope),
        setMentionOnly: (active) => agentMentionOnly(route.ctx, active),
      }),
      [RUNTIME_MCP_NAME]: createRuntimeMcp(route.ctx),
      [CONNECT_MCP_NAME]: createConnectMcp({ connect: (server) => agentConnect(sessionId, route.ctx, server) }),
      [SLACK_MCP_NAME]: createSlackMcp(route.ctx, sessionId),
      [SKILLS_MCP_NAME]: createSkillsMcp(route.ctx.personaId),
      [SESSION_MCP_NAME]: createSessionMcp({
        getSnapshot: () => agent.getTokenSnapshot(sessionId),
      }),
      [KB_MCP_NAME]: createKbMcp(brainDepsFor(route.ctx, route.surface, sessionId), { kbs: () => personaKbs(route.ctx.personaId) }),
      // Per-persona MCP isolation. A filesystem tenant: named personas load
      // ~/.slaude/personas/<name>/mcp.json, the default the boot-time global.
      // A managed tenant: each persona's effective mcp, never the persona
      // directory (see sessionExternalMcp).
      ...sessionMcp.servers,
    };
    // 1on1 privacy: when this session's effective identity is locked (live /1on1
    // lock, or a cron job's captured initiator), whitelisted external services mount
    // with the agent's credentials stripped so they run as that identity (self-prompt
    // auth). Other sessions/threads keep the agent identity (source map untouched).
    const effectiveIdentity = await agent.resolveEffectiveIdentity(sessionId, route.ctx.channel, route.ctx.threadTs);
    Object.assign(servers, privateOverrides(sessionMcp.servers, new Set(sessionMcp.privateServices), !!effectiveIdentity));
    if (voiceHost) Object.assign(servers, await voiceServersFor(sessionId, voiceHost, voiceCalls));
    sessionCtx.set(sessionId, { slack: route.ctx, surface: route.surface });
    return servers;
  };
  agent.setMcpResolver(mcpResolver);

  // /mcp OAuth connect flow. The runner is injectable so a sim can stub the
  // network/browser round-trip; the default does real discover → begin → exchange.
  const runConnect = opts.oauthConnect ?? (async ({ sessionId, serverName, serverConfig, postAuthorizeUrl }) => {
    const meta = await discover(serverConfig.url);
    // Shared always-on loopback (one port, flows demuxed by signed state) vs the
    // default fresh ephemeral listener per connect.
    const handle = env.oauthSharedLoopback()
      ? await beginConnectShared({
          sessionId, stateSecret: env.oauthStateSecret(),
          serverName, serverConfig, meta, timeoutMs: 5 * 60_000,
        })
      : await beginConnect({
          serverName, serverConfig, meta,
          loopbackHost: env.oauthLoopbackHost(),
          loopbackPort: env.oauthLoopbackPorts()[0],
          timeoutMs: 5 * 60_000,
        });
    await postAuthorizeUrl(handle.authorizeUrl);
    const code = await handle.waitForCode();
    return handle.exchange(code);
  });

  // Paste-back prepare step (k8s / remote): register + build the authorize URL
  // against the operator's fixed redirect page, no loopback. Injectable for sims.
  const runExchange = opts.oauthExchange ?? ((parts, code) => exchangeAuthCode(parts, code));

  const runPrepare = opts.oauthPrepare ?? (async ({ serverName, serverConfig, redirectUri }) => {
    const meta = await discover(serverConfig.url);
    return prepareConnect({ serverName, serverConfig, meta, redirectUri });
  });

  // OAuth connect scope: "initiator" writes to the per-user config home (inside a
  // /1on1 lock); "global" writes to the agent's own config dir (manager-driven, no
  // lock — connects the agent's shared identity).
  type ConnectScope = "initiator" | "global";

  // Pending /mcp connect buttons live in pending_gates (kind 'mcp_connect'):
  // the token is the row id and the payload carries everything the click needs
  // to run the connect, so the card still works after a restart and a click is
  // settled exactly once via the guarded resolve.
  type McpGatePayload = { channelId: string; threadTs: string; userId: string; serverName: string; scope: ConnectScope; personaName?: string };

  // Connect cards expire so stale rows drain via sweepExpired instead of
  // accumulating. SLAUDE_MCP_CARD_TTL accepts '30m'/'12h'/'permanent' (max 24h,
  // parseDuration); unset or invalid → 24h.
  const mcpCardTtlMs = ((): number | null => {
    const raw = (process.env.SLAUDE_MCP_CARD_TTL ?? "").trim();
    if (!raw) return 24 * 60 * 60 * 1000;
    const d = parseDuration(raw);
    if (d.ok) return d.permanent ? null : d.minutes * 60 * 1000;
    console.warn(`[gates] invalid SLAUDE_MCP_CARD_TTL '${raw}' (${d.error}) — using 24h`);
    return 24 * 60 * 60 * 1000;
  })();

  /** One "Connect <server>" button: its pending_gates row, then the element.
   *  The `/mcp` status card and the MCP bridge's re-authorise card share it,
   *  so a click runs the same guarded connect either way. */
  async function connectButton(sessionId: string, payload: McpGatePayload): Promise<Record<string, unknown>> {
    const token = randomBytes(8).toString("hex");
    await PendingGates.create({
      id: token, kind: "mcp_connect", sessionId, payload,
      ...(mcpCardTtlMs !== null ? { expiresAt: Date.now() + mcpCardTtlMs } : {}),
    });
    return {
      type: "button",
      text: { type: "plain_text", text: `Connect ${payload.serverName}` },
      action_id: `slaude_mcp:connect:${token}`,
    };
  }

  // Paste-back: a started-but-not-completed OAuth flow, keyed by channel:thread:user
  // (one in-flight connect per initiator per thread). The initiator completes it by
  // pasting the callback URL/code into the locked thread.
  // A parked paste-back flow lives in the database, not in this process: the
  // pasted callback arrives on whichever replica took that Slack event, and one
  // that never ran the connect would otherwise know nothing about it.
  const pasteKey = (channelId: string, threadTs: string, userId: string) => `${channelId}:${threadTs}:${userId}`;

  // Only HTTP servers participate in the OAuth connect flow. Resolved per
  // persona (as a session mounts them) through the function the portal's
  // integrations list also uses, so the two surfaces offer the same servers.
  const httpExternalServers = (personaId?: string | null) => connectableServers(personaId, externalMcp);

  /** Tenant and workspace that own a session's credentials, resolved exactly as
   *  the queue dispatcher resolves them, so a connect and the turns that later
   *  read it agree on the owner. */
  async function credentialTarget(sessionId: string): Promise<{ tenant: string; teamId: string }> {
    const row = await Sessions.findById(sessionId);
    if (!row) throw new Error("session not found — send a message in this thread first, then connect");
    return {
      tenant: (row as { tenant_id?: string }).tenant_id ?? "default",
      teamId: row.slack_team_id ?? "",
    };
  }

  /** Persist freshly-exchanged tokens and reboot the session so the next turn
   *  uses them. Shared by loopback + paste.
   *
   *  gateway role: the credential store, never a file. Nodes seed from the store
   *  into pod-local directories; a file on the shared volume would be read by
   *  nothing and would reintroduce the hazard the store exists to remove.
   *  mono: the config directory on disk, as before — the agent runs in this
   *  process and reads that file, and a mono deployment need not have a master
   *  key for the store at all. */
  async function persistTokens(a: { sessionId: string; userId: string; serverName: string; serverConfig: OAuthServerConfig; scope: ConnectScope; personaName?: string }, tokens: OAuthTokens) {
    if (env.role() === "gateway") {
      const { tenant, teamId } = await credentialTarget(a.sessionId);
      const r = await persistConnect({
        scope: a.scope, tenant, persona: a.personaName ?? "default", teamId,
        slackUserId: a.userId, serverName: a.serverName, cfg: a.serverConfig, tokens,
      });
      if (!r.ok) {
        throw new Error("your Slack user isn't connected to an account yet — run `/link`, sign in, then connect again");
      }
      agent.noteSessionEvent(a.sessionId, `Connected MCP server \`${a.serverName}\`${a.scope === "global" ? " (agent's shared identity)" : ""}.`);
      agent.reload(a.sessionId);
      return;
    }
    // initiator: ensureInitiatorConfigDir seeds + creates the dir (the connect flow
    // may run before any locked session has booted). global: the agent config dir is
    // the live CLAUDE_CONFIG_DIR — already present, just write into it.
    const configDir = scopeConfigDir(a.scope, a.userId, a.personaName);
    writeEntry(configDir, a.serverName, a.serverConfig, tokens);
    agent.noteSessionEvent(a.sessionId, `Connected MCP server \`${a.serverName}\`${a.scope === "global" ? " (agent's shared identity)" : ""}.`);
    agent.reload(a.sessionId);
  }

  // Build a Surface for the connect channel/thread so the OAuth flow talks to
  // whatever platform the session is on (Slack, sim, …) instead of hard-coding the
  // Slack client. The connect flow may run outside a live turn (button click /
  // pre-session global connect), so we mint a binding from the ids in hand;
  // requestApproval/reloadSession aren't used by reply/edit.
  const connectSurface = (channelId: string, threadTs: string, userId: string, app?: AppRef): Surface =>
    surfaceFactoryFor(undefined, app)({
      conversationId: channelId,
      threadRef: threadTs,
      inboundRef: threadTs,
      userId,
      requestApproval: async () => { throw new Error("approval unavailable in the connect flow"); },
      reloadSession: () => false,
    });

  // Once the flow settles, edit the auth-URL message in place to strip the live
  // link (redact rather than delete — keeps the breadcrumb, kills the URL). The
  // URL is single-use/expired by now; this just avoids a stale clickable secret
  // lingering in the thread. Best-effort; needs the "edit" capability.
  const redactAuthMessage = async (surface: Surface, ref: string | undefined, serverName: string) => {
    if (!ref || !surface.capabilities.has("edit") || !surface.edit) return;
    try {
      await surface.edit({ ref, text: `:link: Authorize \`${serverName}\` — link removed (flow finished).` });
    } catch { /* best-effort: redaction failure must not mask the connect outcome */ }
  };

  async function connectServer(a: { sessionId: string; channelId: string; threadTs: string; userId: string; serverName: string; serverCfg: any; scope: ConnectScope; personaName?: string; app?: AppRef }) {
    const surface = connectSurface(a.channelId, a.threadTs, a.userId, a.app);
    const post = (text: string) => surface.reply({ text });
    const serverConfig: OAuthServerConfig = { type: "http", url: a.serverCfg.url, headers: a.serverCfg.headers };
    const redirectUrl = env.oauthRedirectUrl();

    // Paste-back mode (k8s / remote): the loopback isn't reachable, so register the
    // operator's fixed redirect page, post the authorize URL, and park a pending
    // flow the initiator completes by pasting the callback back into the thread.
    // The injectable `oauthConnect` stub forces loopback semantics, so paste mode
    // is gated on the redirect URL being set AND no loopback stub being supplied.
    if (redirectUrl && !opts.oauthConnect) {
      // The parked flow holds the registered client secret and the PKCE
      // verifier, so it is encrypted — which makes the master key a hard
      // requirement of this mode rather than of the gateway role alone. Said
      // plainly here, because the alternative is a connect that fails at the
      // paste with nothing to explain it.
      if (!process.env.SLAUDE_MASTER_KEY?.trim()) {
        await post(
          ":x: paste-back `/mcp connect` needs `SLAUDE_MASTER_KEY` set — the parked authorization is stored encrypted. Generate one with `openssl rand -base64 32`.",
        );
        return;
      }
      try {
        const prepared = await runPrepare({ serverName: a.serverName, serverConfig, redirectUri: redirectUrl });
        const { ref } = await post(
          `:link: Authorize \`${a.serverName}\`:\n${prepared.authorizeUrl}\n\n` +
            `After you approve, the page will show a code. *Paste the full redirect URL (or just the code) back here in this thread* to finish.`,
        );
        await SlackOauthFlows.putFlow(pasteKey(a.channelId, a.threadTs, a.userId), {
          state: prepared.state,
          parts: prepared.parts,
          serverName: a.serverName,
          cfg: serverConfig,
          sessionId: a.sessionId, channelId: a.channelId, threadTs: a.threadTs, userId: a.userId,
          scope: a.scope,
          personaName: a.personaName,
          authMsgRef: ref,
        });
      } catch (e) {
        await post(`:x: \`${a.serverName}\` connect failed: ${(e as Error).message}`);
      }
      return;
    }

    // Loopback mode (local / same-host container): block on the listener.
    let authMsgRef: string | undefined;
    try {
      const tokens = await runConnect({
        sessionId: a.sessionId, serverName: a.serverName, serverConfig,
        postAuthorizeUrl: async (url) => {
          const { ref } = await post(`:link: Authorize \`${a.serverName}\`: ${url}\n(opens a browser; the loopback captures the result)`);
          authMsgRef = ref;
        },
      });
      await persistTokens({ sessionId: a.sessionId, userId: a.userId, serverName: a.serverName, serverConfig, scope: a.scope, personaName: a.personaName }, tokens);
      await redactAuthMessage(surface, authMsgRef, a.serverName);
      await post(`:white_check_mark: \`${a.serverName}\` connected. Next message will use it.`);
    } catch (e) {
      await redactAuthMessage(surface, authMsgRef, a.serverName);
      await post(`:x: \`${a.serverName}\` connect failed: ${(e as Error).message}`);
    }
  }

  /**
   * Complete a parked paste-back flow once the initiator pastes the callback.
   *
   * The flow is read without consuming for the `state` check and only taken on
   * the path that actually exchanges. A mismatch therefore leaves the parked
   * flow alone, which is what makes the "paste the URL from the same authorize
   * step" advice true — before, the entry was already gone by this point and
   * retrying could not work.
   */
  async function completePaste(pend: SlackOauthFlows.SlackOauthFlow, code: string, state: string | undefined, app: AppRef): Promise<void> {
    const surface = connectSurface(pend.channelId, pend.threadTs, pend.userId, app);
    const post = (text: string) => surface.reply({ text });
    if (state && state !== pend.state) {
      await post(":x: OAuth `state` mismatch — paste the URL from the same authorize step, or rerun `/mcp connect`.");
      return;
    }
    // Whoever wins this delete owns the exchange; a concurrent paste finds
    // nothing and says nothing.
    const claimed = await SlackOauthFlows.takeFlow(pasteKey(pend.channelId, pend.threadTs, pend.userId));
    if (!claimed) return;
    try {
      const tokens = await runExchange(claimed.parts, code);
      await persistTokens({
        sessionId: claimed.sessionId, userId: claimed.userId, serverName: claimed.serverName,
        serverConfig: claimed.cfg as OAuthServerConfig, scope: claimed.scope, personaName: claimed.personaName,
      }, tokens);
      await redactAuthMessage(surface, claimed.authMsgRef, claimed.serverName);
      await post(`:white_check_mark: \`${claimed.serverName}\` connected. Next message will use it.`);
    } catch (e) {
      await redactAuthMessage(surface, claimed.authMsgRef, claimed.serverName);
      await post(`:x: \`${claimed.serverName}\` connect failed: ${(e as Error).message}`);
    }
  }

  // Natural-language front door: the agent calls mcp__slaude_connect__connect_mcp
  // (when a user asks to connect a service) → here. Same scope gate as `/mcp connect`,
  // then fire the SAME connectServer engine and return a status line — never the URL.
  // Fire-and-forget: connectServer posts the authorize link out-of-band, runs the
  // loopback, and redacts on settle, so the model turn isn't held while the user clicks.
  async function agentConnect(sessionId: string, ctx: SlackContext, serverName: string): Promise<string> {
    if (opts.mcpConnectEnabled === false) {
      return ":warning: MCP connect is temporarily disabled (store-format canary failed) — see server logs.";
    }
    // Empty if somehow absent — the scope checks below then reject (it can't equal a
    // lock owner or the manager), so connectServer is never reached without a real user.
    const userId = ctx.userId ?? "";
    const threadTs = ctx.threadTs ?? ctx.inboundTs ?? "";
    const lock = await OneOnOne.find(ctx.channel, threadTs);
    let scope: ConnectScope;
    if (lock) {
      if (lock.locked_user !== userId) {
        return `:lock: this 1on1 thread belongs to <@${lock.locked_user}> — only they can connect MCP servers here.`;
      }
      scope = "initiator";
    } else {
      const soul = soulData();
      if (userId !== soul.manager.userId && userId !== soul.backupManager.userId) {
        return ":lock: connecting the agent's shared identity is manager-only. Start a `/1on1` to connect your own MCP servers instead.";
      }
      scope = "global";
    }
    const httpServers = httpExternalServers(ctx.personaId);
    const cfg = httpServers[serverName];
    if (!cfg) {
      const names = Object.keys(httpServers);
      return `unknown MCP server \`${serverName}\`.` +
        (names.length ? ` Connectable: ${names.map((n) => `\`${n}\``).join(", ")}.` : " None are configured.");
    }
    const personaName = personaKey(ctx.personaId);
    void connectServer({ sessionId, channelId: ctx.channel, threadTs, userId, serverName, serverCfg: cfg, scope, personaName, app: appOf(ctx) })
      .catch(() => { /* connectServer posts its own failure out-of-band */ });
    return `Started authorizing \`${serverName}\` — I've posted the authorization link in this thread. Open it to approve; I'll confirm here once it's connected. You won't need to paste anything back.`;
  }

  // Agent-facing 1on1 toggle — driven by the set_one_on_one surface tool.
  // "lock" = lock/re-lock to current user; "open" = admit guests (with scope);
  // "off" = fully release. Session reloads on every state change so the
  // session-mode block and resolver pick up the new DB state.
  async function agentOneOnOne(sessionId: string, ctx: SlackContext, action: "lock" | "open" | "off", scope?: string): Promise<string> {
    const userId = ctx.userId ?? "";
    const threadTs = ctx.threadTs ?? ctx.inboundTs ?? "";
    if (action === "lock") {
      const prevTarget = await Remote.findTarget(ctx.channel, threadTs);
      if (prevTarget && prevTarget.user_id !== userId) await endRemoteForThread(ctx.channel, threadTs, { sessionId, userMachineOnly: true });
      await OneOnOne.lock({ channelId: ctx.channel, threadTs, lockedUser: userId, createdBy: userId });
      agent.reload(sessionId);
      return `Locked this thread to a 1on1 with <@${userId}> — only they and the manager are heard here now.`;
    }
    if (action === "open") {
      const existing = await OneOnOne.find(ctx.channel, threadTs);
      if (!existing) {
        await OneOnOne.lock({ channelId: ctx.channel, threadTs, lockedUser: userId, createdBy: userId });
      }
      await endRemoteForThread(ctx.channel, threadTs, { sessionId, userMachineOnly: true }); // open mode forbids remote
      await OneOnOne.setOpen(ctx.channel, threadTs, scope ?? "");
      agent.reload(sessionId);
      const scopeNote = scope ? ` Scope: ${scope}` : "";
      return `Opened this 1on1 to all participants.${scopeNote} Use set_one_on_one(action="lock") to restrict again.`;
    }
    if (!await OneOnOne.find(ctx.channel, threadTs)) return "No active 1on1 in this thread — nothing to release.";
    await endRemoteForThread(ctx.channel, threadTs, { sessionId, userMachineOnly: true });
    await OneOnOne.unlock(ctx.channel, threadTs);
    agent.reload(sessionId);
    return "Released 1on1 — the thread is open again.";
  }

  // Agent-facing mention-only toggle — same engine as /mention-only. No reboot: it's
  // a receive-time routing flag, not session-baked. No gating.
  async function agentMentionOnly(ctx: SlackContext, active: boolean): Promise<string> {
    const threadTs = ctx.threadTs ?? ctx.inboundTs ?? "";
    if (active) {
      await MentionOnly.set({ channelId: ctx.channel, threadTs, createdBy: ctx.userId ?? "" });
      return "Mention-only on — I'll reply in this thread only when @-mentioned.";
    }
    if (!await MentionOnly.find(ctx.channel, threadTs)) return "This thread isn't in mention-only mode — nothing to change.";
    await MentionOnly.clear(ctx.channel, threadTs);
    return "Mention-only off — I'll follow this thread normally again.";
  }

  /** The /remote handler's context for one thread and user: replies post as the
   *  thread's persona through `app`; private replies and the Connect button go
   *  ephemerally to `userId`. Shared by the typed command and the Connect modal. */
  function remoteCommandCtx(i: {
    teamId: string;
    channelId: string;
    threadTs: string;
    userId: string;
    sessionId: string;
    personaId?: string;
    app?: AppRef;
  }): RemoteCommandCtx {
    const { teamId, channelId, threadTs, userId, sessionId } = i;
    const surface = surfaceFactoryFor(i.personaId, i.app)({
      conversationId: channelId,
      threadRef: threadTs,
      inboundRef: threadTs,
      userId,
      teamId,
      requestApproval: async () => { throw new Error("approval is not part of /remote"); },
      reloadSession: () => false,
    });
    const canEphemeral = surface.capabilities.has("ephemeral") && !!surface.sayEphemeral;
    const reply = async (text: string) => {
      await outClientForPersona(i.personaId, i.app).chat.postMessage({ channel: channelId, thread_ts: threadTs, text, mrkdwn: true });
    };
    const soul = soulData();
    return {
      teamId, channelId, threadTs, userId, sessionId,
      isManager: userId === soul.manager.userId || userId === soul.backupManager.userId,
      reply,
      sayPrivately: async (text) => {
        if (canEphemeral) {
          await surface.sayEphemeral!({ text, userId });
          return;
        }
        await reply(":warning: `/remote` setup needs a surface that supports private replies.");
      },
      // The form needs ephemeral blocks to carry the button and modals to open.
      ...(canEphemeral && t.view
        ? {
            offerConnect: async () => {
              const offer = { sessionId, teamId, channelId, threadTs, userId, apiAppId: i.app?.apiAppId, issuedAt: Date.now() };
              await surface.sayEphemeral!({ text: "Connect your machine for /remote", userId, blocks: remoteOfferBlocks(offer) });
            },
            offerPicker: async (envs) => {
              const offer = { sessionId, teamId, channelId, threadTs, userId, apiAppId: i.app?.apiAppId, issuedAt: Date.now() };
              const current = (await Envs.findBinding(channelId, threadTs))?.env_id;
              await surface.sayEphemeral!({ text: "Your environments", userId, blocks: envPickerBlocks(offer, envs, current) });
            },
            offerAdd: async () => {
              const offer = { sessionId, teamId, channelId, threadTs, userId, apiAppId: i.app?.apiAppId, issuedAt: Date.now() };
              await surface.sayEphemeral!({ text: "Add an environment", userId, blocks: envPickerBlocks(offer, []).slice(-1) });
            },
          }
        : {}),
      reload: () => { agent.reload(sessionId); },
      reloadThread: async (ch, ts) => {
        const other = await Sessions.findAnyByThread({ team_id: teamId, channel_id: ch, thread_ts: ts }).catch(() => null);
        if (other) agent.reload(other.id);
      },
    };
  }

  // /env picker: Use buttons and the Add environment modal. The value (and the
  // modal's private_metadata) is bound to the user it was posted to and to a
  // max age; every check (enabled, lock owner, crons, key, preflight) runs in
  // the shared /env core, and results go to the thread.
  async function envCtxForOffer(offer: { sessionId: string; teamId: string; channelId: string; threadTs: string; userId: string; apiAppId?: string }, apiAppId?: string): Promise<RemoteCommandCtx | null> {
    const session = await Sessions.findById(offer.sessionId);
    if (!session || session.slack_channel_id !== offer.channelId || session.slack_thread_ts !== offer.threadTs) return null;
    const app: AppRef = { apiAppId: apiAppId ?? offer.apiAppId, teamId: offer.teamId };
    return remoteCommandCtx({ ...offer, personaId: session.persona_id ?? undefined, app });
  }

  t.action(new RegExp(`^${ENV_USE_ACTION}$`), async ({ ack, action, body, respond }) => {
    await ack();
    if (!env.remote.enabled()) return;
    const decoded = decodeEnvOffer((action as { value?: string }).value, (body as any).user?.id);
    if (!decoded.ok) {
      if (decoded.reason === "expired") {
        await respond({ response_type: "ephemeral", replace_original: true, text: "That button expired. Send `/env` again." }).catch(() => {});
      }
      return;
    }
    const { offer } = decoded;
    const ctx = await envCtxForOffer(offer, (body as any).api_app_id);
    const e = offer.envId ? await Envs.getEnv(offer.envId) : null;
    if (!ctx || !e) return;
    await useEnvironment(e, undefined, ctx, defaultEnvDeps);
  });

  t.action(new RegExp(`^${ENV_ADD_ACTION}$`), async ({ ack, action, body, respond }) => {
    await ack();
    if (!env.remote.enabled()) return;
    const decoded = decodeEnvOffer((action as { value?: string }).value, (body as any).user?.id);
    if (!decoded.ok) {
      if (decoded.reason === "expired") {
        await respond({ response_type: "ephemeral", replace_original: true, text: "That button expired. Send `/env` again." }).catch(() => {});
      }
      return;
    }
    const clickApp: AppRef = { apiAppId: (body as any).api_app_id, teamId: (body as any).team?.id ?? (body as any).user?.team_id };
    const client = botClientFor(clickApp);
    const triggerId = (body as any).trigger_id;
    if (!client.views || !triggerId) return;
    await client.views.open({ trigger_id: triggerId, view: envAddModal({ ...decoded.offer, issuedAt: Date.now() }) });
  });

  // Kind picked in the Add modal: redraw the modal with that kind's fields.
  t.action(new RegExp(`^${ENV_KIND_ACTION}$`), async ({ ack, action, body }) => {
    await ack();
    if (!env.remote.enabled()) return;
    const view = (body as any).view;
    const decoded = decodeEnvOffer(view?.private_metadata, (body as any).user?.id);
    if (!decoded.ok) return;
    const kindName = (action as { selected_option?: { value?: string } }).selected_option?.value;
    if (!kindName || !getKind(kindName)) return;
    const clickApp: AppRef = { apiAppId: (body as any).api_app_id, teamId: (body as any).team?.id ?? (body as any).user?.team_id };
    const client = botClientFor(clickApp);
    if (!client.views?.update) return;
    await client.views.update({ view_id: view.id, hash: view.hash, view: envAddModal({ ...decoded.offer, kindName }) }).catch(() => {});
  });

  t.view?.(ENV_ADD_VIEW, async ({ ack, view, body }) => {
    await ack();
    const decoded = decodeEnvOffer(view.private_metadata, (body as any).user?.id);
    if (!("offer" in decoded)) return;
    const ctx = await envCtxForOffer(decoded.offer, (body as any).api_app_id);
    if (!ctx) return;
    if (!decoded.ok) {
      await ctx.sayPrivately("That form expired. Send `/env add` again.").catch(() => {});
      return;
    }
    if (!env.remote.enabled()) return;
    const kind = getKind(decoded.offer.kindName ?? "");
    if (!kind) return;
    const v = readEnvAddValues(view, kind);
    await addEnvironment({ kindName: kind.kind, name: v.name, fields: v.fields, dir: v.dir, use: true }, ctx, defaultEnvDeps);
  });

  // /remote Connect button → the address/directory modal. Only the user the
  // button was posted to can open it (the value is bound to them), and only
  // within REMOTE_OFFER_TTL_MS.
  t.action(new RegExp(`^${REMOTE_OPEN_ACTION}$`), async ({ ack, action, body, respond }) => {
    await ack();
    if (!env.remote.enabled()) return;
    const decoded = decodeRemoteOffer((action as { value?: string }).value, (body as any).user?.id);
    if (!decoded.ok) {
      if (decoded.reason === "expired") {
        await respond({ response_type: "ephemeral", replace_original: true, text: "That Connect button expired. Send `/remote` again for a new one." }).catch(() => {});
      }
      return;
    }
    // The trigger belongs to the app the click arrived through: open the modal as it.
    const clickApp: AppRef = { apiAppId: (body as any).api_app_id, teamId: (body as any).team?.id ?? (body as any).user?.team_id };
    const client = botClientFor(clickApp);
    const triggerId = (body as any).trigger_id;
    if (!client.views || !triggerId) return;
    const existing = await Remote.findTarget(decoded.offer.channelId, decoded.offer.threadTs);
    const initialDir = existing?.user_id === decoded.offer.userId ? existing.dir : undefined;
    // Restamp: the modal's own clock starts when it opens.
    await client.views.open({ trigger_id: triggerId, view: remoteConnectModal({ ...decoded.offer, issuedAt: Date.now() }, initialDir) });
  });

  // Connect modal submitted: the same path as `/remote <addr> <dir>`, minus the
  // address in the thread. Every check (enabled, lock owner, foreign crons, key,
  // preflight) runs in handleRemoteCommand; results go to the thread.
  t.view?.(REMOTE_CONNECT_VIEW, async ({ ack, view, body }) => {
    await ack();
    const decoded = decodeRemoteOffer(view.private_metadata, (body as any).user?.id);
    if (!("offer" in decoded)) return; // invalid: not ours to answer
    const { offer } = decoded;
    const session = await Sessions.findById(offer.sessionId);
    if (!session || session.slack_channel_id !== offer.channelId || session.slack_thread_ts !== offer.threadTs) return;
    const app: AppRef = { apiAppId: (body as any).api_app_id ?? offer.apiAppId, teamId: offer.teamId };
    const ctx = remoteCommandCtx({ ...offer, personaId: session.persona_id ?? undefined, app });
    if (!decoded.ok) {
      await ctx.sayPrivately("That Connect form expired. Send `/remote` again for a new one.").catch(() => {});
      return;
    }
    const { addr, dir } = readRemoteConnectValues(view);
    await handleRemoteCommand({ kind: "remote", action: "on", addr, dir }, ctx);
  });

  t.action(/^slaude_mcp:connect:.+$/, async ({ ack, action, body }) => {
    await ack();
    const token = (action as { action_id: string }).action_id.replace(/^slaude_mcp:connect:/, "");
    const gate = await PendingGates.get(token);
    if (!gate || gate.kind !== "mcp_connect" || gate.status !== "pending") return;
    const ctx = gate.payload as unknown as McpGatePayload;
    // Slack shows the button to everyone in the thread. The clicker must be the user
    // who originally requested the card, and still authorized for the card's scope:
    //   initiator → they must still own the /1on1 lock (bystanders can't drive an
    //               initiator's OAuth grant; a dropped lock invalidates the card).
    //   global    → no lock, and they must still be the manager/backup.
    // Checks run BEFORE the guarded resolve so an unauthorized click never
    // consumes the card.
    const clicker = (body as any).user?.id;
    if (clicker !== ctx.userId) return;
    if (ctx.scope === "initiator") {
      const lock = await OneOnOne.find(ctx.channelId, ctx.threadTs);
      if (!lock || lock.locked_user !== ctx.userId) return;
    } else {
      if (await OneOnOne.find(ctx.channelId, ctx.threadTs)) return; // a lock appeared — global no longer applies
      const soul = soulData();
      if (ctx.userId !== soul.manager.userId && ctx.userId !== soul.backupManager.userId) return;
    }
    // Look the server up BEFORE consuming the card: a card minted by an older
    // version can name a server this persona does not mount, and approving it
    // only to drop it would swallow the click silently.
    // The click arrives through the app that posted the card: answer as it.
    const clickApp: AppRef = { apiAppId: (body as any).api_app_id, teamId: (body as any).team?.id ?? (body as any).user?.team_id };
    const cfg = httpExternalServers(ctx.personaName)[ctx.serverName];
    if (!cfg) {
      await connectSurface(ctx.channelId, ctx.threadTs, ctx.userId, clickApp)
        .reply({ text: `:warning: \`${ctx.serverName}\` is not available for this agent any more, so it can't be connected. Run \`/mcp\` for the current list.` })
        .catch(() => {});
      return;
    }
    // One click wins; a duplicate (or another replica) sees null and stops.
    if (!(await PendingGates.resolve(token, "approved", clicker))) return;
    await connectServer({ ...ctx, sessionId: gate.sessionId, serverCfg: cfg, personaName: ctx.personaName, app: clickApp });
  });

  agent.on("event", (e: AgentEvent) => {
    console.log(`[agent-evt] ${e.type} session=${e.sessionId}${"tool" in e ? ` tool=${e.tool}` : ""}${"error" in e ? ` err=${redactSecrets(String(e.error))}` : ""}`);
    const route = routes.get(e.sessionId);
    if (!route) return;

    // Active-surface lock (design §Active-surface lock, outbound gate): while an
    // operator drives this session from the panel, suppress the Slack-facing
    // reactions/status here (the authoritative reply-echo suppression is the
    // async surface path). Best-effort sync check — Redis-owner-backed so it
    // holds on a non-owning replica too, tolerating a sub-second cache lag.
    if (panelHeldSync(e.sessionId)) return;

    switch (e.type) {
      case "toolCall": {
        // Voice-origin turn: no status, no reaction, no task tracker, and a
        // (suppressed) reply must not count as the agent having spoken.
        if (voiceTurns.active(e.sessionId)) break;
        // The internal skill-evolution turn runs after the user's turn was
        // finalized (✅, status cleared): its tools must not bring back a
        // "thinking" status or a working reaction (#131).
        if (e.autoEvolve) break;
        // Any user-visible tool counts as "spoke" — reply, edit, upload all
        // surface content. (react alone doesn't satisfy: an emoji isn't a real
        // answer.) Matches the canonical surface namespace + the deprecated
        // slack namespace during the transition.
        const userVisible =
          e.tool === `mcp__${SURFACE_MCP_NAME}__reply` ||
          e.tool === `mcp__${SURFACE_MCP_NAME}__edit` ||
          e.tool === `mcp__${SURFACE_MCP_NAME}__upload` ||
          e.tool === `mcp__${SLACK_MCP_NAME}__reply` ||
          e.tool === `mcp__${SLACK_MCP_NAME}__edit` ||
          e.tool === `mcp__${SLACK_MCP_NAME}__upload`;
        if (e.tool === `mcp__${SURFACE_MCP_NAME}__pass`) {
          // Deliberate silence: satisfies the stop guard without counting as
          // having spoken, and without the working reaction.
          route.passed = true;
          const react = (e.input as any)?.react;
          if (typeof react === "string" && react) route.passReact = react.replace(/^:|:$/g, "");
        } else if (userVisible) {
          route.spoke = true;
          void reactions.set(e.sessionId, route.ctx.channel, route.ctx.inboundTs, REACT_WORKING);
        } else {
          // Live todo tracker: post or edit a task-list message in the thread whenever
          // the agent writes todos. Does not set `spoke` — the stop guard still requires
          // the agent to call reply() with its actual answer.
          if (e.tool === "TodoWrite") {
            const todos = (e.input as any)?.todos;
            if (Array.isArray(todos) && todos.length > 0) {
              route.todosSnapshot = todos;
              const text = formatTodoList(todos);
              void (async () => {
                try {
                  if (route.todoRef && route.surface.capabilities.has("edit") && route.surface.edit) {
                    await route.surface.edit({ ref: route.todoRef, text });
                  } else {
                    const { ref } = await route.surface.reply({ text });
                    route.todoRef = ref;
                  }
                } catch (err) {
                  console.error("[todo] failed to post/edit todo message:", err);
                }
              })();
            }
          }
          // Structured task system: TaskCreate captures the subject so the toolResult
          // handler can register the assigned ID. TaskUpdate re-renders immediately.
          if (e.tool === "TaskCreate") {
            const subject = (e.input as any)?.subject as string | undefined;
            if (subject) route.pendingTaskCreate = subject;
          }
          if (e.tool === "TaskUpdate") {
            const taskId = String((e.input as any)?.taskId ?? "");
            const newStatus = (e.input as any)?.status as string | undefined;
            if (taskId && newStatus && route.tasksMap?.has(taskId)) {
              const task = route.tasksMap.get(taskId)!;
              if (newStatus === "deleted") {
                route.tasksMap.delete(taskId);
              } else {
                task.status = newStatus;
                if (newStatus === "completed") {
                  const now = new Date();
                  task.completedAt = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
                }
              }
              if (route.tasksMap.size > 0) {
                const text = formatTaskList(route.tasksMap);
                void (async () => {
                  try {
                    if (route.tasksRef && route.surface.capabilities.has("edit") && route.surface.edit) {
                      await route.surface.edit({ ref: route.tasksRef, text });
                    } else {
                      const { ref } = await route.surface.reply({ text });
                      route.tasksRef = ref;
                    }
                  } catch (err) {
                    console.error("[tasks] failed to update task:", err);
                  }
                })();
              }
            }
          }
          // Animated humanized status next to the bot name.
          // remoteStatusOn never throws; the catch keeps the detached promise from ever rejecting.
          void (async () => status.set(
            e.sessionId,
            route.ctx.channel,
            route.ctx.threadTs,
            humanizeToolStatus(e.tool, e.input as any, { remote: await remoteStatusOn(e.sessionId, route.ctx.channel, route.ctx.threadTs) }),
          ))().catch(() => {});
        }
        break;
      }
      case "toolResult": {
        // Correlate with a pending TaskCreate: the result carries the assigned task ID.
        if (route.pendingTaskCreate) {
          const subject = route.pendingTaskCreate;
          route.pendingTaskCreate = undefined;
          const result = (e as any).result as any;
          const taskId: string | undefined = result?.task?.id;
          if (taskId && subject) {
            if (!route.tasksMap) route.tasksMap = new Map();
            route.tasksMap.set(taskId, { subject, status: "pending" });
            const text = formatTaskList(route.tasksMap);
            void (async () => {
              try {
                if (route.tasksRef && route.surface.capabilities.has("edit") && route.surface.edit) {
                  await route.surface.edit({ ref: route.tasksRef, text });
                } else {
                  const { ref } = await route.surface.reply({ text });
                  route.tasksRef = ref;
                }
              } catch (err) {
                console.error("[tasks] failed to post task:", err);
              }
            })();
          }
        }
        break;
      }
      case "done": {
        // engagedBefore belongs to the turn that is ending (the auto-evolve
        // check that follows a user turn is not one).
        const engagedBefore = route.engagedBefore;
        if (!e.autoEvolve) route.engagedBefore = undefined;
        void (async () => {
          // Voice-origin turn: the thread stays quiet (no ✅, no task-block
          // edits), but the per-turn state is still cleaned up.
          if (voiceTurns.active(e.sessionId)) {
            route.tasksRef = undefined;
            route.tasksMap = undefined;
            reactions.forget(e.sessionId);
            presence.exit(e.sessionId);
            await status.clear(e.sessionId);
            return;
          }
          // Suppressed (disengaged) turns set no 👀/status and must not stamp a
          // ✅ on the recorded-but-unprocessed message. Nothing to clean up.
          if (route.suppress) return;
          // Auto-evolve turns are internal — don't reset reactions/presence
          // (they were already finalized on the user-visible turn's done).
          if (e.autoEvolve) return;
          // Clear compact flag — ✅ reaction is already posted by REACT_DONE below.
          if (route.wasCompacting) route.wasCompacting = undefined;
          // Stamp the todo message "all done" when every task completed.
          if (route.todoRef && route.todosSnapshot?.length &&
              route.todosSnapshot.every((t) => t.status === "completed") &&
              route.surface.capabilities.has("edit") && route.surface.edit) {
            const doneText = `**Tasks**\n${route.todosSnapshot.map((t) => `✓ ${t.content}`).join("\n")}`;
            await route.surface.edit({ ref: route.todoRef, text: doneText }).catch(() => {});
          }
          // Stamp the structured task block "all done" when every task is completed/deleted.
          if (route.tasksRef && route.tasksMap?.size &&
              [...route.tasksMap.values()].every((t) => t.status === "completed" || t.status === "deleted") &&
              route.surface.capabilities.has("edit") && route.surface.edit) {
            const completedTasks = [...route.tasksMap.values()].filter((t) => t.status === "completed");
            const doneText = `**Tasks**\n${completedTasks.map((t) => `✓ ${t.subject}${t.completedAt ? ` _(${t.completedAt})_` : ""}`).join("\n")}`;
            await route.surface.edit({ ref: route.tasksRef, text: doneText }).catch(() => {});
          }
          route.tasksRef = undefined;
          route.tasksMap = undefined;
          // A mention that engaged the thread and ended in a pass (nothing
          // user-visible) gives the engagement back: the thread stays as it was.
          if (route.passed && !route.spoke && engagedBefore === false) {
            console.log(`[pass] disengage ch=${route.ctx.channel} ts=${route.ctx.threadTs}`);
            await persistEngaged(route.ctx.teamId, route.ctx.channel, route.ctx.threadTs, false, route.ctx.personaId ?? "default")
              .catch((err) => console.error(`[pass] disengage failed ch=${route.ctx.channel} ts=${route.ctx.threadTs}:`, err?.message ?? err));
          }
          // No fallback notice: setStopGuard above forces a reply via the SDK
          // Stop hook. If the agent still stops without spoke, manager logs
          // to stderr — surfacing a Slack message here would be redundant.
          if (route.passed && !route.spoke) {
            // A pass posts nothing: no ✅. The received 👀 goes too, unless the
            // pass reacted with that same emoji (Slack holds one per name).
            await reactions.clear(e.sessionId, route.passReact);
          } else {
            await reactions.set(e.sessionId, route.ctx.channel, route.ctx.inboundTs, REACT_DONE);
          }
          reactions.forget(e.sessionId);
          presence.exit(e.sessionId);
          await status.clear(e.sessionId);
        })();
        break;
      }
      case "error": {
        // The raw error (provider/CLI text, stack fragments) stays in the server
        // log; Slack only ever gets the fixed text for the failure code (D1.6).
        console.error(`[turn-error] session=${e.sessionId} code=${e.code ?? "UNKNOWN"} job=${e.jobId ?? "-"}: ${redactSecrets(String(e.error))}`);
        // Voice-origin turn: no failure text or ❌ in the thread (the call voices it).
        if (voiceTurns.active(e.sessionId)) break;
        void (async () => {
          // One message per failed turn. With a job id (queue mode) the key is the
          // job, so a client retry or a queue attempt that surfaces the same failure
          // posts once. Without one (mono/local) it is the session's current inbound
          // message, so the MCP-circuit error and the result error of one turn post
          // once. The guard is an in-process Set: it does NOT span replicas.
          if (firstFailurePost(e.jobId ? `${e.sessionId}:job:${e.jobId}` : `${e.sessionId}:ts:${route.ctx.inboundTs}`)) {
            try {
              await botClientFor(appOf(route.ctx)).chat.postMessage({
                channel: route.ctx.channel,
                thread_ts: route.ctx.threadTs,
                text: failureText(e.code),
                mrkdwn: true,
              });
            } catch {}
          }
          await reactions.set(e.sessionId, route.ctx.channel, route.ctx.inboundTs, REACT_ERROR);
          reactions.forget(e.sessionId);
          presence.exit(e.sessionId);
          await status.clear(e.sessionId);
        })();
        break;
      }
      case "compacting": {
        if (e.trigger === "manual") route.wasCompacting = true;
        void status.set(
          e.sessionId,
          route.ctx.channel,
          route.ctx.threadTs,
          e.trigger === "manual" ? "compacting context (manual)…" : "compacting context…",
        );
        break;
      }
    }
  });

  // Arrival order per session for the dispatch tail (route ctx update,
  // reactions, dispatch). The per-message reads before it (user name,
  // attachments, the memory context) take varying time, so without this two
  // quick messages in one thread could reach the session in the other order.
  // Each message takes a slot when it reaches those reads and waits for the
  // previous message's slot before its tail; a slot is always released when
  // its handleMessage ends, so one failure never blocks the next message.
  const dispatchOrder = new Map<string, Promise<void>>();
  const takeDispatchSlot = (sessionId: string): { ready: Promise<void>; release: () => void } => {
    const prev = dispatchOrder.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    dispatchOrder.set(sessionId, tail);
    void tail.then(() => {
      if (dispatchOrder.get(sessionId) === tail) dispatchOrder.delete(sessionId);
    });
    return { ready: prev, release };
  };

  async function handleMessage(args: any, dispatch?: { suppress?: boolean; personaId?: string; engagedBefore?: boolean }) {
    const slot = { release: () => {} };
    try {
      return await handleMessageInOrder(args, dispatch, slot);
    } finally {
      slot.release();
    }
  }

  async function handleMessageInOrder(
    args: any,
    dispatch: { suppress?: boolean; personaId?: string; engagedBefore?: boolean } | undefined,
    slot: { release: () => void },
  ) {
    const suppress = dispatch?.suppress === true;
    const { event, client, context } = args;
    const teamId: string | undefined = context.teamId ?? event.team;
    // The app this event arrived through (HTTP mode): everything this turn
    // posts goes out as it (D1.2).
    const app: AppRef = { apiAppId: context?.apiAppId, teamId };
    const channelId: string = event.channel;
    const userId: string | undefined = event.user;
    const eventTs: string = event.ts;
    const text: string = (event.text || "").trim();
    const channelType: string = event.channel_type ?? "";

    console.log(
      `[slack-rx] type=${event.type} subtype=${event.subtype ?? "-"} ch=${channelId} ts=${eventTs} thread=${event.thread_ts ?? "-"} user=${userId} txt=${JSON.stringify(text.slice(0, 80))}`,
    );

    // Early drops (missing ids, self echo, ignore gate, blocklist, channel
    // mode) come from preTurnDropReason, shared with the decision gate. The
    // dedup claim is handleMessage's own step, run between the self-echo and
    // the ignore checks exactly where it has always been. The id check is
    // repeated here only to narrow teamId/userId for the code below.
    if (!teamId || !userId) return;
    {
      const drop = await preTurnDropReason(args, {
        // Dedup — durable atomic claim in seen_events by (channel, ts), so a Slack
        // redelivery is dropped even across a restart or by a sibling replica.
        afterSelfEcho: async () => {
          const dedupKey = `${channelId}:${eventTs}`;
          if (!(await SeenEvents.tryInsert(dedupKey))) {
            return { reason: "dedup", log: `[slack-rx] drop ch=${channelId} ts=${eventTs} — dedup (already seen)` };
          }
          // Rows only matter for Slack's retry window; prune stale ones as we go.
          void SeenEvents.maybePurge();
          return null;
        },
      });
      if (drop) {
        if (drop.log !== null) {
          console.log(drop.log);
          metric.slackDropsTotal.inc({ reason: drop.reason });
        }
        return;
      }
    }

    const isDM = channelType === "im";
    const threadTs: string = event.thread_ts || (isDM ? eventTs : eventTs);

    // 1on1 lock: while active, only the locked user + manager/backup are heard in
    // this thread. After channel-mode (overrides "anyone can chat" in trusted/allowed
    // channels) and before slash parsing (a non-allowed user can't /1on1 off to hijack
    // someone else's lock). Approval buttons are unaffected — they go through
    // ApprovalGate's action handler, not this path.
    {
      const lock = await OneOnOne.find(channelId, threadTs);
      if (lock) {
        const soul = soulData();
        const isMgr = userId === soul.manager.userId || userId === soul.backupManager.userId;
        // In open mode (open_scope !== null) anyone may speak; only locked mode enforces the initiator gate.
        if (lock.open_scope === null && userId !== lock.locked_user && !isMgr) {
          console.log(`[slack-rx] drop ch=${channelId} user=${userId} thread=${threadTs} — 1on1 locked to ${lock.locked_user}`);
          metric.slackDropsTotal.inc({ reason: "one_on_one" });
          return;
        }
        // A personal environment runs tools on the owner's machine: only the owner
        // drives it. The manager is heard only to inspect or end it (/remote or
        // /env off|status, /1on1 off). A sandbox needs no such filter (spec §4).
        if (lock.open_scope === null && userId !== lock.locked_user && isMgr && env.remote.enabled() && personalRemote(await activeRemoteTarget(channelId, threadTs))) {
          // Strip exactly what the slash dispatcher strips (bot + persona mention).
          const mgrBot = (await client.auth.test()).user_id as string;
          const mgrPersona = dispatch?.personaId ? getPersonaRegistry().lookupByName(dispatch.personaId)?.slackUserId : undefined;
          const mgrText = text
            .replace(new RegExp(`<@${mgrBot}>`, "g"), "")
            .replace(mgrPersona ? new RegExp(`<@${mgrPersona}>`, "g") : /(?!x)/g, "")
            .trim();
          const hit = parseSlashCommand(mgrText);
          const allowed =
            (hit?.kind === "remote" && (hit.action === "off" || hit.action === "status")) ||
            (hit?.kind === "env" && (hit.action === "off" || hit.action === "status")) ||
            (hit?.kind === "one-on-one" && hit.action === "off");
          if (!allowed) {
            console.log(`[slack-rx] drop ch=${channelId} user=${userId} thread=${threadTs} — remote mode, 1on1 locked to ${lock.locked_user}`);
            metric.slackDropsTotal.inc({ reason: "one_on_one" });
            return;
          }
        }
      }
    }

    const botUserId = (await client.auth.test()).user_id as string;
    // Strip bot mention + persona mention (e.g. "@Noah /model" → "/model").
    const personaUserId = dispatch?.personaId
      ? getPersonaRegistry().lookupByName(dispatch.personaId)?.slackUserId
      : undefined;
    const stripped = text
      .replace(new RegExp(`<@${botUserId}>`, "g"), "")
      .replace(personaUserId ? new RegExp(`<@${personaUserId}>`, "g") : /(?!x)/g, "")
      .trim();
    const hasFiles = Array.isArray(event.files) && event.files.length > 0;
    if (!stripped && !hasFiles) return;

    const session = await agent.ensureSession({
      team_id: teamId,
      channel_id: channelId,
      thread_ts: threadTs,
      persona_id: dispatch?.personaId,
    });
    // Record the app the thread arrives through, so turns with no inbound
    // event (the operator panel) post as it on any replica (D1.2).
    if (app.apiAppId && session.slack_app_id !== app.apiAppId) {
      await Sessions.setSlackApp(session.id, app.apiAppId);
      session.slack_app_id = app.apiAppId;
    }

    // Paste-back OAuth completion: if this user has a parked /mcp connect in this
    // thread and the message carries the callback (URL or bare code), finish the flow
    // here and do NOT forward to the model. The binding is the pendingPaste key
    // (channel:thread:userId) on the signed inbound userId — a bystander's paste maps
    // to a different key and finds no entry. (Holds for both initiator and global
    // scope; global has no lock, so the key, not the lock, is what binds.)
    {
      const pend = await SlackOauthFlows.peekFlow(pasteKey(channelId, threadTs, userId));
      if (pend) {
        const parsed = parseOAuthCallback(stripped);
        if (parsed.code) {
          await completePaste(pend, parsed.code, parsed.state, app);
          return;
        }
      }
    }

    // Slash commands: /mode, /abort, /help. Handled locally; do not forward to model.
    const slash = parseSlashCommand(stripped);
    if (slash) {
      const slashClient = outClientForPersona(dispatch?.personaId, app);
      const reply = async (txt: string) => {
        await slashClient.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: txt,
          mrkdwn: true,
        });
      };
      if (slash.kind === "help") {
        await reply(helpText());
        return;
      }
      if (slash.kind === "mode-help") {
        const modes = Object.entries(MODE_LABELS)
          .map(([k, v]) => `• \`${humanModeName(k as any)}\` — ${v}`)
          .join("\n");
        await reply(`*usage:* \`/mode <ask|accept-edits|bypass|plan|dont-ask>\`\n${modes}`);
        return;
      }
      if (slash.kind === "mode") {
        await agent.setPermissionMode(session.id, slash.mode);
        agent.noteSessionEvent(session.id, `Permission mode changed to \`${humanModeName(slash.mode)}\`.`);
        await reply(`mode → \`${humanModeName(slash.mode)}\``);
        return;
      }
      if (slash.kind === "abort") {
        // Queue role: durable flag + publish reaches whichever node runs (or
        // will claim) the turn (spec §2). The local abort stays for mono and
        // for anything still live in this process.
        if (queueDispatch) {
          await queueDispatch.abort(session.id).catch((e) => console.error("[slaude] abort publish failed:", e));
        }
        agent.abort(session.id);
        await reply("aborted");
        return;
      }
      if (slash.kind === "ingest") {
        // DEPRECATED: the raw/ → wiki/ synthesis flow is superseded by brain
        // memoize (gbrain captures knowledge automatically). The command no longer
        // runs the job; it points to the replacement. Code kept for now (see
        // knowledge/ingest.ts @deprecated); slated for removal.
        await reply(
          ":warning: `/ingest` is *deprecated* — knowledge is captured automatically via brain memoize now, so the raw/→wiki synthesis no longer runs.",
        );
        return;
      }
      if (slash.kind === "remote") {
        await handleRemoteCommand(slash, remoteCommandCtx({ teamId, channelId, threadTs, userId, sessionId: session.id, personaId: dispatch?.personaId, app }));
        return;
      }
      if (slash.kind === "env") {
        await handleEnvCommand(slash, remoteCommandCtx({ teamId, channelId, threadTs, userId, sessionId: session.id, personaId: dispatch?.personaId, app }));
        return;
      }
      if (slash.kind === "one-on-one") {
        if (slash.action === "on") {
          const prevTarget = await Remote.findTarget(channelId, threadTs);
          if (prevTarget && prevTarget.user_id !== userId) await endRemoteForThread(channelId, threadTs, { sessionId: session.id, userMachineOnly: true });
          await OneOnOne.lock({ channelId, threadTs, lockedUser: userId, createdBy: userId });
          agent.reload(session.id);
          await reply(`:lock: *1on1 mode* — only <@${userId}> and the manager will be heard in this thread. \`/1on1 off\` to release. Ask me to open it to guests when needed.`);
          // Onboarding unlocks this person's own integrations; it never gates
          // the 1:1, which is already open above. So a failure here is logged
          // and dropped rather than turned into an error they cannot act on.
          try {
            const nudgeSurface = surfaceFactoryFor(dispatch?.personaId, app)({
              conversationId: channelId,
              threadRef: threadTs,
              inboundRef: threadTs,
              userId,
              teamId,
              requestApproval: async () => { throw new Error("approval is not part of onboarding"); },
              reloadSession: () => false,
            });
            await nudgeOnboarding(
              { teamId, slackUserId: userId },
              {
                sayEphemeral:
                  nudgeSurface.capabilities.has("ephemeral") && nudgeSurface.sayEphemeral
                    ? (text) => nudgeSurface.sayEphemeral!({ text, userId })
                    : undefined,
              },
            );
          } catch (e) {
            console.error("[portal] onboarding nudge failed:", e);
          }
          return;
        }
        if (slash.action === "lock") {
          const existing = await OneOnOne.find(channelId, threadTs);
          if (!existing) {
            await reply("No active 1on1 in this thread.");
            return;
          }
          if (existing.locked_user !== userId && !(() => { const s = soulData(); return userId === s.manager.userId || userId === s.backupManager.userId; })()) {
            await reply(`:lock: only the session owner (<@${existing.locked_user}>) can lock it.`);
            return;
          }
          if (existing.open_scope === null) {
            await reply("This 1on1 is already locked.");
            return;
          }
          await OneOnOne.setLocked(channelId, threadTs);
          agent.reload(session.id);
          await reply(`:lock: *1on1 re-locked* — only <@${existing.locked_user}> and the manager are heard again.`);
          return;
        }
        const existing = await OneOnOne.find(channelId, threadTs);
        if (!existing) {
          await reply("No active 1on1 in this thread.");
          return;
        }
        const r = await endRemoteForThread(channelId, threadTs, { sessionId: session.id, userMachineOnly: true });
        await OneOnOne.unlock(channelId, threadTs);
        agent.reload(session.id);
        await reply(":unlock: 1on1 released — the thread is open again." + (r.ended ? " Remote mode ended." : ""));
        return;
      }
      if (slash.kind === "mention-only") {
        if (slash.action === "on") {
          await MentionOnly.set({ channelId, threadTs, createdBy: userId });
          await reply(":speech_balloon: *mention-only* — I'll reply in this thread only when @-mentioned. `/mention-only off` to restore.");
          return;
        }
        if (!await MentionOnly.find(channelId, threadTs)) {
          await reply("This thread isn't in mention-only mode.");
          return;
        }
        await MentionOnly.clear(channelId, threadTs);
        await reply(":speech_balloon: mention-only off — I'll follow the thread normally again.");
        return;
      }
      if (slash.kind === "soul" || slash.kind === "soul-list" || slash.kind === "soul-clear") {
        // Manager-only — primary manager, NOT backup (owner: "only Manager").
        // Gate on the signed inbound Slack user id before any mutation.
        const soul = soulData();
        if (!soul.manager.userId || userId !== soul.manager.userId) {
          await reply(":lock: `/soul` is manager-only.");
          return;
        }
        if (slash.kind === "soul") {
          const res = await mutateOverride(
            { field: slash.field, action: slash.action, value: slash.value, by: userId },
            { managerId: soul.manager.userId },
          );
          if (res.ok) {
            agent.noteSessionEvent(session.id, `Soul ACL override: ${slash.action} \`${res.value}\` to \`${res.field}\` (shadows SOUL.md).`);
          }
          await reply(
            res.ok
              ? `:white_check_mark: soul override: \`${res.field}\` ${slash.action} \`${res.value}\` — effective immediately, all sessions.`
              : `:warning: ${res.reason}`,
          );
          return;
        }
        if (slash.kind === "soul-clear") {
          if (slash.field === "all") await SoulOverrides.clear();
          else await SoulOverrides.clear(FIELD_ALIASES[slash.field]);
          agent.noteSessionEvent(session.id, `Soul ACL overrides cleared (\`${slash.field}\`) — reverted to SOUL.md.`);
          await reply(`:leftwards_arrow_with_hook: soul overrides cleared (\`${slash.field}\`) — reverted to SOUL.md.`);
          return;
        }
        // soul-list: provenance — SOUL.md base vs runtime overlay.
        const base = soulDataBase();
        const rows = await SoulOverrides.list();
        const lines: string[] = ["*soul runtime overrides*"];
        for (const [alias, field] of Object.entries(FIELD_ALIASES)) {
          const adds = rows.filter((r) => r.field === field && r.action === "add");
          const removes = rows.filter((r) => r.field === field && r.action === "remove");
          const baseIds = base[field];
          if (!adds.length && !removes.length && !baseIds.length) continue;
          lines.push(
            `*${alias}* — soul: ${baseIds.length ? baseIds.map((v) => `\`${v}\``).join(" ") : "_none_"}` +
              (adds.length ? ` | +runtime: ${adds.map((r) => `\`${r.value}\``).join(" ")}` : "") +
              (removes.length ? ` | −masked: ${removes.map((r) => `\`${r.value}\``).join(" ")}` : ""),
          );
        }
        if (lines.length === 1) lines.push("_no overrides, no soul ACL entries_");
        await reply(lines.join("\n"));
        return;
      }
      if (slash.kind === "link") {
        // `teamId` here is the real workspace id (context.teamId ?? event.team,
        // narrowed above), and it is bound into the token: a wrong team id would
        // mint a link that binds in the wrong workspace.
        const linkSurface = surfaceFactoryFor(dispatch?.personaId, app)({
          conversationId: channelId,
          threadRef: threadTs,
          inboundRef: threadTs,
          userId,
          teamId,
          requestApproval: async () => { throw new Error("approval is not part of /link"); },
          reloadSession: () => false,
        });
        const sayPrivately = async (text: string) => {
          if (linkSurface.capabilities.has("ephemeral") && linkSurface.sayEphemeral) {
            await linkSurface.sayEphemeral({ text, userId });
            return;
          }
          // A surface that cannot keep it private must not leak it: say nothing
          // useful rather than posting an onboarding link into a channel.
          await reply(":warning: `/link` needs a surface that supports private replies.");
        };
        if (!env.portal.enabled()) {
          await sayPrivately(":information_source: the onboarding portal is not enabled on this deployment.");
          return;
        }
        const existing = await accountForSlackUser(teamId, userId);
        if (existing) {
          await sayPrivately(`:white_check_mark: already connected as \`${existing.email}\`.`);
          return;
        }
        const token = mintLinkToken({ teamId, slackUserId: userId });
        await sayPrivately(
          `:link: Connect your account: ${env.panel.publicUrl()}/portal/link?t=${token}\n` +
            `Only you can see this message. The link expires in 15 minutes.`,
        );
        return;
      }
      if (slash.kind === "mcp") {
        // Two scopes:
        //   inside a /1on1 lock → "initiator": the connect writes into THIS user's
        //     isolated config home, so it must be their own lock.
        //   no lock → "global": the connect writes into the agent's own config dir,
        //     wiring the agent's shared identity — manager/backup only.
        const lock = await OneOnOne.find(channelId, threadTs);
        let scope: ConnectScope;
        if (lock) {
          if (lock.locked_user !== userId) {
            await reply(`:lock: \`/mcp\` in a 1on1 thread is for the lock owner — only <@${lock.locked_user}> can connect here.`);
            return;
          }
          scope = "initiator";
        } else {
          const soul = soulData();
          if (userId !== soul.manager.userId && userId !== soul.backupManager.userId) {
            await reply(":lock: global `/mcp` connect is manager-only — it wires the agent's shared identity. Run `/1on1` first to connect your *own* MCP servers instead.");
            return;
          }
          scope = "global";
        }
        if (opts.mcpConnectEnabled === false) {
          await reply(":warning: `/mcp` connect is temporarily disabled (store-format canary failed) — see server logs.");
          return;
        }
        const httpServers = httpExternalServers(dispatch?.personaId);

        if (slash.action === "connect") {
          const name = slash.server;
          if (!name || !httpServers[name]) {
            await reply(`:warning: unknown HTTP MCP server \`${name ?? ""}\`. Run \`/mcp\` to list connectable servers.`);
            return;
          }
          await connectServer({ sessionId: session.id, channelId, threadTs, userId, serverName: name, serverCfg: httpServers[name], scope, personaName: personaKey(dispatch?.personaId), app });
          return;
        }

        if (slash.action === "disconnect") {
          const name = slash.server;
          if (!name || !httpServers[name]) {
            await reply(`:warning: unknown HTTP MCP server \`${name ?? ""}\`. Run \`/mcp\` to list servers.`);
            return;
          }
          // Same scope gate as connect already ran above: initiator removes from
          // their own config home, global (manager) removes the agent's shared
          // identity. Removing the stored grant means no token at next session
          // boot — the agent reconnects only if re-connected.
          // Reconstruct the SAME OAuthServerConfig shape connectServer wrote with
          // ({type:"http", url, headers}) — httpExternalServers drops `type`, so
          // passing its bare {url,headers} would compute a different oauthKey and
          // never match the stored grant.
          const cfg: OAuthServerConfig = { type: "http", url: httpServers[name]!.url, headers: httpServers[name]!.headers };
          let removed: boolean;
          if (env.role() === "gateway") {
            // The store is the authority on a gateway; see persistTokens.
            const { tenant, teamId: sessionTeam } = await credentialTarget(session.id);
            const r = await persistDisconnect({
              scope, tenant, persona: personaKey(dispatch?.personaId) ?? "default", teamId: sessionTeam,
              slackUserId: userId, serverName: name, cfg,
            });
            removed = r.ok && r.removed;
          } else {
            // Resolved only here: for a 1:1 it creates the config home, which a
            // gateway must not do on the shared volume.
            removed = removeEntry(scopeConfigDir(scope, userId, dispatch?.personaId), name, cfg);
          }
          if (removed) agent.noteSessionEvent(session.id, `Disconnected MCP server \`${name}\`${scope === "global" ? " (agent's shared identity)" : ""}.`);
          await reply(
            removed
              ? `:white_check_mark: Disconnected \`${name}\`${scope === "global" ? " (agent's shared identity)" : ""} — credential removed. Takes effect on the next session boot.`
              : `:information_source: \`${name}\` wasn't connected${scope === "global" ? " (agent's shared identity)" : " for you"} — nothing to disconnect.`,
          );
          return;
        }

        // action === "status": render the server status card.
        const statuses = await agent.mcpServerStatus(session.id);
        if (statuses === null) {
          await reply("Send a message in this thread first so the session boots, then `/mcp` can read MCP server status.");
          return;
        }
        const lines = statuses.map((s) => `• \`${s.name}\` — ${s.status}`).join("\n") || "(no MCP servers mounted)";
        const blocks: any[] = [
          { type: "section", text: { type: "mrkdwn", text: `*MCP servers*\n${lines}` } },
        ];
        const connectable = statuses.filter((s) => s.status !== "connected" && httpServers[s.name]);
        if (connectable.length) {
          const elements = [];
          for (const s of connectable) {
            elements.push(
              await connectButton(session.id, { channelId, threadTs, userId, serverName: s.name, scope, personaName: personaKey(dispatch?.personaId) }),
            );
          }
          blocks.push({ type: "actions", elements });
        }
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: "MCP servers", mrkdwn: true });
        return;
      }
      if (slash.kind === "ignore" || slash.kind === "unignore") {
        if (slash.kind === "ignore") {
          if (slash.target === "user") {
            const soul = soulData();
            const managerId = soul.manager.userId;
            const backupId = soul.backupManager.userId;
            const isManager = (managerId && userId === managerId) || (backupId && userId === backupId);
            const isApprover = soul.approvers.some((a) => a.userId === userId);
            if (!isManager && !isApprover) {
              await reply(":no_entry: only manager or approver can ignore users");
              return;
            }
            const duration = slash.duration;
            let expiresAt: number | undefined;
            if (duration) {
              const parsed = parseDuration(duration);
              if (!parsed.ok) {
                await reply(`:warning: ${parsed.error}`);
                return;
              }
              expiresAt = parsed.permanent ? undefined : Date.now() + parsed.minutes * 60 * 1000;
            }
            await Ignores.remove({ targetType: "user", userId: slash.userId });
            await Ignores.create({ targetType: "user", userId: slash.userId, createdBy: userId, expiresAt, reason: "manual" });
            const durText = duration ? `for ${duration}` : "permanently";
            await reply(`:mute: ignoring <@${slash.userId}> ${durText}`);
          } else {
            const duration = slash.duration;
            let expiresAt: number | undefined;
            if (duration) {
              const parsed = parseDuration(duration);
              if (!parsed.ok) {
                await reply(`:warning: ${parsed.error}`);
                return;
              }
              expiresAt = parsed.permanent ? undefined : Date.now() + parsed.minutes * 60 * 1000;
            }
            await Ignores.remove({ targetType: "thread", channelId, threadTs });
            await Ignores.create({ targetType: "thread", channelId, threadTs, createdBy: userId, expiresAt, reason: "manual" });
            const durText = duration ? `for ${duration}` : "permanently";
            await reply(`:mute: ignoring this thread ${durText}`);
          }
          return;
        }

        if (slash.kind === "unignore") {
          if (slash.target === "user") {
            const soul = soulData();
            const managerId = soul.manager.userId;
            const backupId = soul.backupManager.userId;
            const isManager = (managerId && userId === managerId) || (backupId && userId === backupId);
            const isApprover = soul.approvers.some((a) => a.userId === userId);
            if (!isManager && !isApprover) {
              await reply(":no_entry: only manager or approver can unignore users");
              return;
            }
            await Ignores.remove({ targetType: "user", userId: slash.userId });
            await reply(`:speaker: stopped ignoring <@${slash.userId}>`);
          } else {
            await Ignores.remove({ targetType: "thread", channelId, threadTs });
            await reply(":speaker: stopped ignoring this thread");
          }
          return;
        }
      }

      if (
        slash.kind === "cron-add" ||
        slash.kind === "cron-list" ||
        slash.kind === "cron-remove" ||
        slash.kind === "cron-edit" ||
        slash.kind === "cron-pause" ||
        slash.kind === "cron-resume"
      ) {
        const soul = soulData();
        const managerId = soul.manager.userId;
        const backupId = soul.backupManager.userId;
        const isManager = (managerId && userId === managerId) || (backupId && userId === backupId);
        const isApprover = soul.approvers.some((a) => a.userId === userId);
        const findJob = async (id: string) => {
          try {
            return await CronJobs.findByPrefix(id);
          } catch (e: any) {
            return e instanceof Error ? e.message : String(e);
          }
        };
        const renderJob = (j: CronJobs.CronJob) => {
          const flags = [
            j.target,
            j.whenActive === "skip" ? "passive" : null,
            j.paused ? "paused" : null,
          ].filter(Boolean).join(", ");
          return `• \`${j.id.slice(0, 8)}\` \`${j.cronExpr}\` [${flags}] → ${j.prompt}`;
        };

        if (slash.kind === "cron-list") {
          if (!isManager && !isApprover) {
            await reply(":no_entry: only manager or approver can list cron jobs");
            return;
          }
          const jobs = await CronJobs.listActive();
          if (!jobs.length) {
            await reply("No active cron jobs.");
            return;
          }
          const lines = jobs.map(renderJob);
          await reply("*Active cron jobs*\n" + lines.join("\n"));
          return;
        }

        if (slash.kind === "cron-remove") {
          if (!isManager && !isApprover) {
            await reply(":no_entry: only manager or approver can remove cron jobs");
            return;
          }
          const job = await findJob(slash.id);
          if (typeof job === "string") {
            await reply(`:warning: ${job}`);
            return;
          }
          if (!job) {
            await reply(`:warning: cron job \`${slash.id}\` not found`);
            return;
          }
          await CronJobs.deactivate(job.id);
          agent.noteSessionEvent(session.id, `Removed scheduled cron job \`${job.id.slice(0, 8)}\`.`);
          await reply(`:wastebasket: cron job \`${job.id.slice(0, 8)}\` removed`);
          return;
        }

        if (slash.kind === "cron-pause" || slash.kind === "cron-resume") {
          if (!isManager && !isApprover) {
            await reply(`:no_entry: only manager or approver can ${slash.kind.replace("cron-", "")} cron jobs`);
            return;
          }
          const job = await findJob(slash.id);
          if (typeof job === "string") {
            await reply(`:warning: ${job}`);
            return;
          }
          if (!job) {
            await reply(`:warning: cron job \`${slash.id}\` not found`);
            return;
          }
          if (slash.kind === "cron-pause") {
            await CronJobs.pause(job.id);
            await reply(`:pause_button: cron job \`${job.id.slice(0, 8)}\` paused`);
            return;
          }
          let nextRun: number;
          try {
            nextRun = getNextRun(job.cronExpr);
          } catch (e: any) {
            await reply(`:warning: invalid stored cron expression: ${e.message}`);
            return;
          }
          await CronJobs.resume(job.id, nextRun);
          await reply(`:arrow_forward: cron job \`${job.id.slice(0, 8)}\` resumed — next run: <t:${Math.floor(nextRun / 1000)}:R>`);
          return;
        }

        if (slash.kind === "cron-edit") {
          if (!isManager && !isApprover) {
            await reply(":no_entry: only manager or approver can edit cron jobs");
            return;
          }
          if (isApprover && !isManager) {
            const approval = await approvals.request({
              channel: channelId,
              threadTs: threadTs,
              summary: `Edit cron job ${slash.id}: "${slash.prompt}" at "${slash.cronExpr}"`,
              category: "cron",
              app,
              risks: "Changes unattended scheduled agent execution.",
            });
            if (!approval.approved) return void (await reply(":x: cron edit denied by manager"));
          }
          const job = await findJob(slash.id);
          if (typeof job === "string") {
            await reply(`:warning: ${job}`);
            return;
          }
          if (!job) {
            await reply(`:warning: cron job \`${slash.id}\` not found`);
            return;
          }
          let nextRun: number;
          try {
            nextRun = getNextRun(slash.cronExpr);
          } catch (e: any) {
            await reply(`:warning: invalid cron expression: ${e.message}`);
            return;
          }
          await CronJobs.update(job.id, {
            cronExpr: slash.cronExpr,
            prompt: slash.prompt,
            nextRunAt: nextRun,
            target: slash.target,
            whenActive: slash.whenActive,
          });
          const mode = slash.whenActive === "skip" ? ", passive (skips when active)" : "";
          const where = slash.target === "channel" ? "channel root" : "this thread";
          await reply(`:pencil2: cron job \`${job.id.slice(0, 8)}\` updated (posts to ${where}${mode}) — next run: <t:${Math.floor(nextRun / 1000)}:R>`);
          return;
        }

        if (slash.kind === "cron-add") {
          if (!isManager && !isApprover) {
            await reply(":no_entry: only manager or approver can add cron jobs");
            return;
          }

          let nextRun: number;
          try {
            nextRun = getNextRun(slash.cronExpr);
          } catch (e: any) {
            await reply(`:warning: invalid cron expression: ${e.message}`);
            return;
          }

          if (isApprover && !isManager) {
            // Approver-initiated: require manager approval
            const approval = await approvals.request({
              channel: channelId,
              threadTs: threadTs,
              summary: `Cron job: "${slash.prompt}" at "${slash.cronExpr}"`,
              category: "cron",
              app,
              risks: "Scheduled agent execution — runs unattended.",
            });
            if (!approval.approved) {
              await reply(":x: cron job denied by manager");
              return;
            }
          }

          // If this /cron-add ran inside a /1on1-locked thread, remember the lock
          // owner on the job. DM and channel-target runs key on a synthetic
          // `cron:<id>` thread that carries no lock, so the scheduler needs this to
          // boot the run under the initiator's OAuth config dir (initiator
          // isolation), not the agent's. NULL when created outside a 1on1.
          const cronLock = await OneOnOne.find(channelId, threadTs);
          const job = await CronJobs.create({
            slackTeamId: teamId,
            // The app this job was created through: its runs post as it.
            slackAppId: app.apiAppId,
            slackChannelId: channelId,
            slackThreadTs: slash.target === "channel" ? undefined : (isDM ? undefined : threadTs),
            channelId,
            threadTs: isDM ? undefined : threadTs,
            createdBy: userId,
            cronExpr: slash.cronExpr,
            prompt: slash.prompt,
            nextRunAt: nextRun,
            target: slash.target,
            whenActive: slash.whenActive,
            oauthUser: cronLock?.locked_user,
            // Persist the owning persona so the scheduled run fires as that persona.
            personaId: dispatch?.personaId,
          });
          const where = slash.target === "channel" ? "channel root" : "this thread";
          const mode = slash.whenActive === "skip" ? ", passive (skips when active)" : "";
          agent.noteSessionEvent(session.id, `Scheduled cron job \`${job.id.slice(0, 8)}\`: \`${slash.cronExpr}\` → "${slash.prompt}" (posts to ${where}).`);
          await reply(`:calendar: cron job created (\`${job.id.slice(0, 8)}\`, posts to ${where}${mode}) — next run: <t:${Math.floor(nextRun / 1000)}:R>`);
          return;
        }
      }

      if (slash.kind === "model") {
        const soul = effectiveSoulForChannel(channelId);
        if (!canChangeModel(userId, soul)) {
          await reply(":lock: `/model` — manager, approver, or DM-allowed users only.");
          return;
        }
        // A persona on its own provider (WS-A §5.5) is not checked against the
        // gateway's provider: its choice passes through unverified.
        const personaProvider = managedPersonaProvider(session.persona_id !== "default" ? session.persona_id : undefined);
        if (!slash.id) {
          // A managed tenant's session follows its persona's model until a
          // /model pins one; show what it resolves to, not the empty row.
          const current = agent.effectiveModelOf(session);
          try {
            const models = await listModelsFor(personaProvider);
            const lines = models.map((m) => `• \`${m.id}\``).join("\n") || "_none returned_";
            await reply(`*available models*\n${lines}\n\ncurrent: \`${current}\``);
          } catch {
            await reply(`can't fetch model list from provider. current: \`${current}\``);
          }
          return;
        }
        const verified = await verifyModelChoice(slash.id, personaProvider);
        await agent.setSessionModel(session.id, slash.id);
        agent.noteSessionEvent(session.id, `Model changed to \`${slash.id}\`.`);
        await reply(
          verified
            ? `model → \`${slash.id}\``
            : `model → \`${slash.id}\` :warning: couldn't verify against provider`,
        );
        return;
      }
      if (slash.kind === "compact") {
        const triggered = agent.triggerCommand(session.id, "/compact");
        if (!triggered) {
          // No live session — auto-boot and compact.
          const existing = routes.get(session.id);
          if (existing) {
            existing.ctx.channel = channelId;
            existing.ctx.threadTs = threadTs;
            existing.ctx.inboundTs = eventTs;
            existing.ctx.userId = userId;
            existing.ctx.teamId = teamId;
            existing.ctx.origin = "slack";
            if (app.apiAppId) existing.ctx.apiAppId = app.apiAppId;
            existing.spoke = false;
            existing.passed = false;
            existing.passReact = undefined;
            existing.engagedBefore = dispatch?.engagedBefore;
            existing.wasCompacting = true;
            noteTurnSender(session.id, existing.ctx);
          } else {
            const compactPersonaId = session.persona_id !== "default" ? session.persona_id : undefined;
            const ctx: SlackContext = {
              client: outClientForPersona(compactPersonaId, app),
              apiAppId: app.apiAppId,
              channel: channelId,
              threadTs,
              inboundTs: eventTs,
              userId,
              teamId,
              personaId: compactPersonaId,
              origin: "slack",
            };
            ctx.requestApproval = (req) =>
              approvals.request({ channel: ctx.channel, threadTs: ctx.threadTs, sessionId: session.id, app: appOf(ctx), ...req });
            ctx.reloadSession = (prompt?) => agent.reload(session.id, prompt);
            noteTurnSender(session.id, ctx);
            routes.set(session.id, {
              ctx,
              surface: wrapSurface(surfaceForCtx(ctx), session.id),
              spoke: false,
              engagedBefore: dispatch?.engagedBefore,
              wasCompacting: true,
            });
          }
          void reactions.set(session.id, channelId, eventTs, REACT_WORKING);
          void (queueDispatch
            ? queueDispatch.dispatch(session, "/compact", { teamId, channelId, threadTs, eventTs, userId, apiAppId: app.apiAppId, origin: "slack" })
            : agent.sendMessage(session.id, "/compact")
          ).catch((e: any) => console.error("[slaude] compact auto-boot error:", e?.message ?? e));
          return;
        }
        void reactions.set(session.id, channelId, eventTs, REACT_WORKING);
        return;
      }
      if (slash.kind === "bash") {
        const soul = soulData();
        const managerId = soul.manager.userId;
        const backupId = soul.backupManager.userId;
        const isManager = (managerId && userId === managerId) || (backupId && userId === backupId);
        if (!isManager) {
          await reply(":no_entry: `/bash` is manager-only");
          return;
        }
        // A gateway holds the master key, the job secret, the node key and the
        // database settings, and the output is posted to Slack: never run a
        // shell next to them. Agent turns run on nodes; so does a shell.
        if (env.role() === "gateway") {
          await reply(
            ":no_entry: `/bash` is not available on a gateway: it would run next to the gateway's secrets. " +
              "Run the command on a node (`kubectl exec` into a node pod) or in a `/remote` thread.",
          );
          return;
        }
        // Decode Slack's URL encoding: <https://url|label> → https://url
        const command = slash.command.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>?/g, "$1");
        try {
          // mono shares the gateway's environment: the same scrub as the agent
          // child, so no gateway-only variable can reach the posted output,
          // and every provider-selecting variable too (API key, auth token,
          // OAuth token, cloud credentials): the shell needs none of them.
          const proc = Bun.spawn(["bash", "-c", command], {
            env: withoutKeys(scrubChildEnv(process.env), providerSelectingNames(process.env)),
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          const out = [stdout, stderr].filter(Boolean).join("\n").trim();
          const truncated = out.length > 2800 ? out.slice(0, 2800) + "\n…(truncated)" : out;
          await reply(`\`$ ${command}\` (exit ${exitCode})\n\`\`\`\n${truncated || "(no output)"}\n\`\`\``);
        } catch (e: any) {
          await reply(`:x: failed to run: ${e?.message}`);
        }
        return;
      }
    }

    let userText = stripped;
    const skillHit = matchSkillInvocation(stripped, discoverSkills(session.persona_id));
    if (skillHit) {
      userText = buildSkillInvocation(skillHit.skill, skillHit.args, session.id);
      // A `/<slug>` invocation is a use too (it never reaches the Skill tool). Best effort, off the turn's path.
      void backgroundAgentId(session.persona_id ?? "default")
        .then((agentId) => recordSkillUse(agentId, skillHit.skill.slug))
        .catch((e) => console.error(`[skills] could not record a use of /${skillHit.skill.slug}: ${e instanceof Error ? e.message : String(e)}`));
    }

    // Resolve username and download any file attachments into the session dir.
    // The token is read only when there are files, and from the app the event
    // belongs to (HTTP mode puts it on the context). The environment is the
    // fallback in Socket Mode only: in HTTP mode it is absent by design (D1.1).
    const inboundFiles = (event.files ?? []) as SlackFile[];
    let attachToken: string | undefined;
    if (inboundFiles.length) {
      attachToken = context?.botToken ?? (env.slack.mode() === "socket" ? env.slack.botToken() : undefined);
      if (!attachToken) console.error(`[slack-attach] no bot token for the event's app — skipping ${inboundFiles.length} file(s)`);
    }
    // Take this message's place in the session's dispatch order before the
    // reads whose time varies (see takeDispatchSlot).
    const order = takeDispatchSlot(session.id);
    slot.release = order.release;
    const oneOnOneLock = await OneOnOne.find(channelId, threadTs);
    const [userName, files, memoryContext, proactiveContext] = await Promise.all([
      resolveUserName(client, userId),
      attachToken
        ? downloadAttachments({
            files: inboundFiles,
            botToken: attachToken,
            workingDir: session.working_dir,
            inboundTs: eventTs,
          })
        : Promise.resolve([]),
      // A suppressed message is recorded only; no turn runs, so no context.
      suppress
        ? ""
        : turnMemoryBlock({ channel: channelId, threadTs, userId, teamId, personaId: dispatch?.personaId, lockedUser: oneOnOneLock?.locked_user ?? null }),
      suppress ? "" : turnProactiveBlock({ channel: channelId, threadTs, eventTs, personaId: dispatch?.personaId }),
    ]);
    if (env.metricsPerUser()) {
      metric.userTurnsTotal.inc({ user_id: userId, user_name: userName });
    }

    const attachmentBlock = files.length
      ? "\n" +
        files
          .map(
            (f) =>
              `<attachment name="${escapeAttr(f.name)}" mimetype="${escapeAttr(f.mimetype)}" size="${f.size}" path="${escapeAttr(f.path)}" />`,
          )
          .join("\n") +
        "\n"
      : "";

    // Per-turn channel trust hint so the agent calibrates info exposure:
    //   trusted    — internal team channel, free to show MCP/skills/internals
    //   allowed    — public channel, answer but mind exposure
    //   restricted — DM or unlisted (manager-only by the gate above)
    const trust = (() => {
      const soul = soulData();
      if (channelType !== "im" && soul.trustedChannels.includes(channelId)) return "trusted";
      if (channelType !== "im" && soul.allowedChannels.includes(channelId)) return "allowed";
      return "restricted";
    })();

    // Wrap inbound in a channel envelope so the agent has slack context
    // and a clear directive to reply (or pass) via the MCP tools — not as plain text.
    const oneOnOneAttr = oneOnOneLock
      ? ` one_on_one="true" locked_user="<@${oneOnOneLock.locked_user}>"`
      : ` one_on_one="false" locked_user=""`;
    const envelope =
      `<channel source="slack" channel_id="${channelId}" thread_ts="${threadTs}" ` +
      `inbound_ts="${eventTs}" user_id="${userId}" user_name="${escapeAttr(userName)}" ` +
      `trust="${trust}"${oneOnOneAttr}>\n` +
      `${userText}${attachmentBlock}\n</channel>\n\n` +
      memoryContext +
      proactiveContext +
      (files.length
        ? `User attached ${files.length} file(s); paths above are local — Read them directly.\n`
        : "") +
      (suppress
        ? `You are currently disengaged from this thread, so this message is recorded ` +
          `for context only — do NOT reply to it. You will catch up on it when re-engaged.`
        : `Reply by calling \`mcp__${SURFACE_MCP_NAME}__reply\`, or call ` +
          `\`mcp__${SURFACE_MCP_NAME}__pass\` if the message is not for you or needs nothing from you. ` +
          `Plain assistant text is not delivered to Slack — only tool calls reach the user.`);

    // The previous message's tail first (arrival order).
    await order.ready;

    permissions.bindSession(session.id, channelId, threadTs, app);

    // First turn for this session → seed the SlackContext + route.
    // Subsequent turns → mutate the existing context so the bound MCP tools
    // keep targeting the right thread / inbound message.
    const existing = routes.get(session.id);
    if (existing) {
      existing.ctx.channel = channelId;
      existing.ctx.threadTs = threadTs;
      existing.ctx.inboundTs = eventTs;
      existing.ctx.userId = userId;
      existing.ctx.teamId = teamId;
      existing.ctx.origin = "slack";
      existing.ctx.botToken = context?.botToken;
      existing.ctx.apiAppId = app.apiAppId;
      existing.ctx.personaId = dispatch?.personaId;
      existing.ctx.client = outClientForPersona(dispatch?.personaId, appOf(existing.ctx));
      existing.ctx.reloadSession = (prompt?) => agent.reload(session.id, prompt);
      existing.spoke = false;
      existing.passed = false;
      existing.passReact = undefined;
      // A message merged into a running turn carries no mention result
      // (undefined) and must not erase the running mention's; the done
      // handler clears it at the end of every turn.
      if (dispatch?.engagedBefore !== undefined) existing.engagedBefore = dispatch.engagedBefore;
      existing.todoRef = undefined;       // fresh tracker per user turn
      existing.todosSnapshot = undefined;
      existing.pendingTaskCreate = undefined;
      // tasksRef/tasksMap are cleared in the done handler so mid-turn inbound
      // messages don't wipe in-flight task state from the previous turn.
      existing.suppress = suppress;
      noteTurnSender(session.id, existing.ctx);
    } else {
      const ctx: SlackContext = {
        client: outClientForPersona(dispatch?.personaId, app),
        apiAppId: app.apiAppId,
        channel: channelId,
        threadTs,
        inboundTs: eventTs,
        userId,
        teamId,
        botToken: context?.botToken,
        personaId: dispatch?.personaId,
        origin: "slack",
      };
      ctx.requestApproval = (req) =>
        approvals.request({
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          sessionId: session.id,
          app: appOf(ctx),
          ...req,
        });
      ctx.reloadSession = (prompt?) => agent.reload(session.id, prompt);
      noteTurnSender(session.id, ctx);
      routes.set(session.id, { ctx, surface: wrapSurface(surfaceForCtx(ctx), session.id), spoke: false, suppress, engagedBefore: dispatch?.engagedBefore });
    }

    // After the route is in place, so the reaction and status resolvers read
    // THIS turn's app and persona rather than the previous turn's (or, for a
    // new session, no route at all).
    if (!suppress) {
      // 👀 received
      void reactions.set(session.id, channelId, eventTs, REACT_RECEIVED);
      presence.enter(session.id, STATUS_THINKING);
      void status.set(session.id, channelId, threadTs, "thinking…");
    }

    // The dispatch tail (queue enqueue in gateway role, in-process
    // AgentManager in mono). Extracted so the active-surface lock can defer
    // and later replay it verbatim.
    const runDispatch = async () => {
      if (queueDispatch) {
        // Gateway role: the turn runs on a node (spec §2). Suppression rides on
        // the message so the node's suppress hook records without running the
        // model; the dispatcher's stream follower replays the node's events
        // into the local handler for reactions/status/errors.
        console.log(`[slaude] dispatch session=${session.id} model=${session.model}`);
        try {
          await queueDispatch.dispatch(session, envelope, {
            teamId,
            channelId,
            threadTs,
            eventTs,
            userId,
            personaId: dispatch?.personaId,
            apiAppId: app.apiAppId,
            origin: "slack",
            suppress,
          });
        } catch (e: any) {
          console.error("[slaude] dispatch threw:", e?.message ?? e, e?.stack);
        }
        return;
      }

      console.log(`[slaude] sendMessage session=${session.id} cwd=${session.working_dir} model=${session.model}`);
      if (suppress) agent.suppressNextTurn(session.id);
      try {
        await agent.sendMessage(session.id, envelope, { sender: { userId, teamId: teamId || null, origin: "slack" } });
      } catch (e: any) {
        console.error("[slaude] sendMessage threw:", e?.message ?? e, e?.stack);
      }
    };

    // Active-surface lock (design §Active-surface lock, inbound gate): while an
    // operator drives this session from the panel, defer the inbound Slack
    // message (hold + replay on release) and post ONE thread notice so the
    // Slack user isn't silently ignored. The lock owner is authoritative in
    // Redis, so a lock taken on another replica is honoured here too.
    if (panelInfra) {
      let held = false;
      try {
        held = await panelHeldAsync(session.id);
      } catch {
        /* Redis hiccup — fall through and dispatch rather than wedge Slack */
      }
      if (held) {
        panelDefer.hold(session.id, runDispatch);
        // Cross-replica notice dedup: only the replica that wins the Redis NX
        // posts the "handled in ops panel" notice, so the Slack user sees it
        // exactly once regardless of which replica each message lands on.
        let shouldNotice = false;
        try {
          shouldNotice = await panelInfra.panelLock.noticeOnce(session.id);
        } catch {
          /* Redis hiccup — skip the notice rather than risk a duplicate */
        }
        if (shouldNotice) {
          try {
            await outClientForPersona(dispatch?.personaId, app).chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: "⏸ handled in ops panel — I'll catch up on your messages here when the operator hands back.",
              mrkdwn: true,
            });
          } catch (e: any) {
            console.error("[panel] defer notice post failed:", e?.message ?? e);
          }
        }
        console.log(`[panel] deferred inbound session=${session.id} (operator driving)`);
        return;
      }
    }

    await runDispatch();
  }

  function escapeAttr(s: string) {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }


  // Generic diagnostic — log every event Bolt receives so we can see what's
  // arriving (or *not*) over the Socket Mode WebSocket.
  t.use(async ({ payload, next }) => {
    const ty = (payload as any)?.type ?? "?";
    const st = (payload as any)?.subtype ?? "-";
    const ch = (payload as any)?.channel ?? "-";
    const ts = (payload as any)?.ts ?? "-";
    console.log(`[slack-evt] ${ty}/${st} ch=${ch} ts=${ts}`);
    await next();
  });

  // Per-thread engagement state. Disengaged by default. @mentioning slaude
  // engages the thread (subsequent plain replies handled). @mentioning a
  // different user disengages (the user is now talking to a colleague).
  //
  // sessions.engaged is the ONLY source — the old in-memory Set is gone, so
  // engagement reads identically across restarts and (later) replicas. A
  // fresh session row is born engaged (schema default 1), which is what the
  // Set's add-on-mention used to express.
  const persistEngaged = async (teamId: string | undefined, channelId: string, threadTs: string, value: boolean, personaId = "default") => {
    if (!teamId) return;
    const row = await Sessions.findByThread({ team_id: teamId, channel_id: channelId, thread_ts: threadTs, persona_id: personaId });
    if (row) await Sessions.setEngaged(row.id, value);
  };
  /** A mention engages the thread and returns whether it was engaged before
   *  (no row, a first mention, is `false`). A second delivery of an event that
   *  was already handled (app_mention and message carry the same ts) writes
   *  nothing: it would re-engage a thread that the first delivery's turn gave
   *  back by passing. handleMessage drops that delivery as a duplicate. */
  const engageOnMention = async (teamId: string | undefined, channelId: string, threadTs: string, eventTs: string, personaId = "default") => {
    if (!teamId) return undefined;
    if (await SeenEvents.has(`${channelId}:${eventTs}`)) return undefined;
    const prior = await Sessions.findByThread({ team_id: teamId, channel_id: channelId, thread_ts: threadTs, persona_id: personaId });
    await persistEngaged(teamId, channelId, threadTs, true, personaId);
    return !!prior && !!prior.engaged;
  };

  // Bot identities (D1.4). With several registered apps in one channel, every
  // message reaches every app, so "self" must be the union of ALL registered
  // apps' bot ids: app A's reply delivered through app B is still our own
  // echo, or the bots answer each other. "This bot" (whom a mention engages)
  // is the delivering app's own bot user. Each app's ids come from its own
  // client's auth.test, cached per app.
  const botIdsCache = new Map<string, { userId: string; botId: string }>();
  const botIdsOf = async (key: string, client: any): Promise<{ userId: string; botId: string }> => {
    const hit = botIdsCache.get(key);
    if (hit) return hit;
    const res = await client.auth.test();
    const ids = { userId: res.user_id as string, botId: (res as any).bot_id as string };
    botIdsCache.set(key, ids);
    return ids;
  };
  /** The delivering app's own bot user id. */
  const getBotId = async (args: any) =>
    (await botIdsOf(`${args?.context?.apiAppId ?? ""}:${args?.context?.teamId ?? args?.event?.team ?? ""}`, args?.client ?? t.client)).userId;
  // Union over every registered app. Rebuilt when the registry's app list
  // changes (an install or removal counts at once) and at most once a minute
  // otherwise. One rebuild runs at a time; concurrent events wait for it. An
  // app whose auth.test fails (a revoked install) is left out and not retried
  // for a minute, so it never costs a Slack call per event.
  const registeredApps = async () => (t.apps ? await t.apps() : [{ apiAppId: "", teamId: "", client: t.client }]);
  const authFailedAt = new Map<string, number>();
  let selfBots: { sig: string; userIds: Set<string>; botIds: Set<string>; at: number } | null = null;
  let selfBotsRefresh: Promise<void> | null = null;
  const refreshSelfBots = async (apps: Awaited<ReturnType<typeof registeredApps>>, sig: string): Promise<void> => {
    const userIds = new Set<string>();
    const botIds = new Set<string>();
    for (const a of apps) {
      const key = `${a.apiAppId}:${a.teamId}`;
      const failed = authFailedAt.get(key);
      if (failed !== undefined && Date.now() - failed < 60_000) continue;
      try {
        const ids = await botIdsOf(key, a.client);
        authFailedAt.delete(key);
        if (ids.userId) userIds.add(ids.userId);
        if (ids.botId) botIds.add(ids.botId);
      } catch (e: any) {
        authFailedAt.set(key, Date.now());
        console.error(`[slack-auth] app=${a.apiAppId || "-"} auth.test failed:`, e?.data?.error ?? e?.message);
      }
    }
    selfBots = { sig, userIds, botIds, at: Date.now() };
  };
  const getSelfBots = async (args: any): Promise<{ userIds: Set<string>; botIds: Set<string> }> => {
    const apps = await registeredApps();
    const sig = apps.map((a) => `${a.apiAppId}:${a.teamId}`).join(",");
    if (!selfBots || selfBots.sig !== sig || Date.now() - selfBots.at > 60_000) {
      selfBotsRefresh ??= refreshSelfBots(apps, sig).finally(() => {
        selfBotsRefresh = null;
      });
      await selfBotsRefresh;
    }
    // The delivering app is always self, even before the next refresh.
    const own = await botIdsOf(`${args?.context?.apiAppId ?? ""}:${args?.context?.teamId ?? args?.event?.team ?? ""}`, args?.client ?? t.client);
    return {
      userIds: new Set([...selfBots!.userIds, own.userId].filter(Boolean)),
      botIds: new Set([...selfBots!.botIds, own.botId].filter(Boolean)),
    };
  };
  /** Whether any of `users` is a member of `channel`. A failed lookup answers
   *  yes: leaving the message to the other app is the safe side. */
  const anyInChannel = async (client: any, channel: string, users: string[]): Promise<boolean> => {
    try {
      const r = await client.conversations.members({ channel, limit: 1000 });
      const members = new Set<string>(r?.members ?? []);
      return users.some((u) => members.has(u));
    } catch {
      return true;
    }
  };
  /** A message posted by any registered app's bot. */
  const isSelfBotEcho = async (args: any, e: any): Promise<boolean> => {
    if (!e.bot_id && !e.user) return false;
    const self = await getSelfBots(args);
    return (Boolean(e.bot_id) && self.botIds.has(e.bot_id)) || (Boolean(e.user) && self.userIds.has(e.user));
  };

  // When posting as a real user (xoxp), the agent's own messages arrive as plain
  // `message` events with NO `bot_id` — the bot-id self-filter misses them and we
  // would re-ingest our own output (infinite loop). Resolve the default posting
  // identity's own user id once (auth.test) and drop events authored by it, UNION
  // every named persona's own `slackUserId` when that persona has a `userToken`
  // (known statically from config — no auth.test needed per persona). Personas
  // with no token post as the bot, already covered by the bot-id filter above.
  let cachedSelfUserId: string | null = null;
  let selfUserIdResolved = false;
  const getSelfUserIds = async (): Promise<Set<string>> => {
    if (!selfUserIdResolved) {
      if (postsAsUser) {
        try {
          const res = await outClient.auth.test();
          cachedSelfUserId = (res as any).user_id as string;
        } catch (e: any) {
          console.error("[slack-out] auth.test on user token failed:", e?.data?.error ?? e?.message);
          cachedSelfUserId = null;
        }
      }
      selfUserIdResolved = true;
    }
    const ids = new Set<string>();
    if (cachedSelfUserId) ids.add(cachedSelfUserId);
    for (const p of getPersonaRegistry().list()) {
      if (p.outClient) ids.add(p.slackUserId);
    }
    return ids;
  };

  // Decision gate (phase B): consulted before a mention or an engaged plain
  // reply starts a turn. Off until the boot-time runner resolves; a boot
  // failure leaves it off.
  let gateRunner: GateRunner | null = opts.gateRunner ?? null;
  if (!opts.gateRunner) {
    const resolver = providerSecretResolver();
    void gateRunnerFromEnv({ resolveSecret: (ref) => resolver.resolve(parseRef(ref), { persona: "default" }) })
      .then((r) => {
        gateRunner = r;
        if (r.mode !== "off") console.log(`[gate] mode=${r.mode}`);
      })
      .catch((e: any) => console.error(`[gate] boot failed (${e?.name ?? "error"}); decision gate off`));
  }

  /**
   * The gate's view of who the agent is. The identity addressed is the named
   * persona when the event is routed to one (its mentions become `<agent>`),
   * else the delivering bot. Every identity of this deployment (each app's bot,
   * each persona user, the post-as-user identity) authors role "agent" posts.
   */
  const gateSelfIds = async (args: any, personaId?: string) => {
    const registry = getPersonaRegistry();
    const persona = personaId && personaId !== "default" ? registry.lookupByName(personaId) : null;
    const bots = await getSelfBots(args);
    const userIds = new Set<string>([...bots.userIds, ...(await getSelfUserIds())]);
    for (const p of registry.list()) if (p.slackUserId) userIds.add(p.slackUserId);
    return { botUserId: persona?.slackUserId ?? (await getBotId(args)), botIds: bots.botIds, userIds };
  };

  /**
   * Why an event is dropped before any turn, or null if it is not. The early
   * filters, in handleMessage's order: missing team or user, self bot echo,
   * self user echo, ignore gate, hard blocklist, channel mode (the /1on1 lock
   * is checked after, by each caller). `reason` is the slackDropsTotal label
   * and `log` the line handleMessage prints; `log: null` is a silent drop
   * (no line, no metric). Read-only itself (no log, no metric); any claim
   * belongs to the caller's `afterSelfEcho` step.
   * `afterSelfEcho` is a caller step run after the self-echo checks and
   * before the ignore gate (handleMessage's dedup claim); the gate passes none.
   */
  // Both handleMessage and the decision gate (ingressDrops) depend on this: a filter added here reaches both.
  const preTurnDropReason = async (
    args: any,
    o: { afterSelfEcho?: () => Promise<PreTurnDrop | null> } = {},
  ): Promise<PreTurnDrop | null> => {
    const e: any = args.event;
    const teamId: string | undefined = args.context?.teamId ?? e.team;
    const channelId: string = e.channel;
    const userId: string | undefined = e.user;
    const eventTs: string = e.ts;
    const channelType: string = e.channel_type ?? "";
    if (!teamId || !userId) return { reason: "missing_identity", log: null };
    // Drop only self-echoes; other bots' messages flow through so slaude can
    // see CI alerts, summarizer bots, etc. in shared threads.
    if (await isSelfBotEcho(args, e)) {
      return { reason: "self_bot", log: `[slack-rx] drop ch=${channelId} ts=${eventTs} — self bot echo` };
    }
    // Self-echo when posting as a real user (xoxp) — default identity or a named
    // persona: own posts carry our user id and no bot_id. Drop them to avoid
    // re-ingesting our own output.
    if ((await getSelfUserIds()).has(userId)) {
      return { reason: "self_user", log: `[slack-rx] drop ch=${channelId} ts=${eventTs} — self user echo` };
    }
    if (o.afterSelfEcho) {
      const drop = await o.afterSelfEcho();
      if (drop) return drop;
    }
    // Ignore gate: temp/permanent ignores for users or threads. /unignore* must
    // bypass it — otherwise a thread-ignore drops the very message meant to lift it
    // (the /unignore-thread is in the ignored thread), and the thread is stuck
    // ignored forever. The blocklist + channel-mode gates below still apply, so this
    // doesn't grant a non-allowed user any new reach.
    {
      const text: string = (e.text || "").toString().trim();
      const threadTs: string = e.thread_ts || eventTs;
      // botUserId isn't resolved yet here; strip any leading user-mention so a
      // "<@bot> /unignore-thread" still parses.
      const peek = parseSlashCommand(text.replace(/<@[^>]+>/g, "").trim());
      const isUnignore = peek?.kind === "unignore";
      if (!isUnignore && (await ignoreGate.shouldDrop(userId, channelId, threadTs))) {
        return { reason: "ignored", log: `[slack-rx] drop ch=${channelId} user=${userId} thread=${threadTs} — ignored` };
      }
    }
    // Hard blocklist: blocked user → drop before any further processing.
    // Never reaches Claude (no token spend, no logs). Channel blocking is
    // unnecessary — default posture already denies anywhere not allowed/trusted.
    {
      const soul = soulData();
      if (soul.blockedUsers.includes(userId)) {
        return { reason: "blocked_user", log: `[slack-rx] drop ch=${channelId} user=${userId} — blocked user` };
      }
    }
    // Channel-mode gate, driven entirely by SOUL.md:
    //   - trusted channel → team zone, anyone can address slaude (most open)
    //   - allowed channel  → public zone, anyone can address slaude (mind exposure)
    //   - DM or unlisted   → manager-only (approvers can still click Approve /
    //     Deny on request_approval blocks but cannot chat)
    {
      const soul = soulData();
      if (!channelModeAdmits(soul, channelId, channelType, userId)) {
        const isDM_ = channelType === "im";
        return {
          reason: "whitelist",
          log:
            `[slack-rx] drop ch=${channelId} user=${userId} — non-whitelist/DM accepts manager/backup${isDM_ ? "/dm-allowlist" : ""} only` +
            (soul.manager.userId ? "" : " (no manager set in SOUL.md)"),
        };
      }
    }
    return null;
  };

  /**
   * Whether the decision gate must skip this event: handleMessage would drop
   * it before any turn (preTurnDropReason, without the dedup claim), or it is
   * a mention with no text. The gate never sees such a message, so nothing
   * the agent is configured never to read leaves the deployment, and nobody
   * it ignores gets a 🤔. Read-only: no claim, no log, no metric.
   */
  const ingressDrops = async (args: any): Promise<boolean> => {
    if (await preTurnDropReason(args)) return true;
    const e: any = args.event;
    const text: string = (e.text || "").toString().trim();
    const hasFiles = Array.isArray(e.files) && e.files.length > 0;
    return !text.replace(/<@[^>]+>/g, "").trim() && !hasFiles;
  };

  /**
   * Whether handleMessage would handle this event itself, with no turn: a
   * slaude text command (parsed after stripping the bot and persona mention,
   * exactly as handleMessage strips them) or, while a paste-back connect flow
   * is parked for this person in this thread, a possible pasted callback.
   * Commands bypass the gate (spec §7.2): a doubted /help must still answer,
   * and /abort must not wait for a decision.
   */
  const ingressHandlesLocally = async (args: any, personaId?: string): Promise<boolean> => {
    const e: any = args.event;
    const text: string = (e.text || "").toString().trim();
    const botUserId = await getBotId(args);
    const personaUserId = personaId ? getPersonaRegistry().lookupByName(personaId)?.slackUserId : undefined;
    const stripped = text
      .replace(new RegExp(`<@${botUserId}>`, "g"), "")
      .replace(personaUserId ? new RegExp(`<@${personaUserId}>`, "g") : /(?!x)/g, "")
      .trim();
    if (parseSlashCommand(stripped)) return true;
    const threadTs: string = e.thread_ts || e.ts;
    return Boolean(await SlackOauthFlows.peekFlow(pasteKey(e.channel, threadTs, e.user)));
  };

  /** Synchronous: with no runner or an off runner the call sites never await the gate. */
  const gateActive = (): boolean => gateRunner !== null && gateRunner.mode !== "off";

  /**
   * The gate's action for this event, or undefined for today's path: the gate
   * off, the thread under a /1on1 lock, a message the ingress would drop or
   * handle itself (a text command, a pasted connect callback), or any error.
   * `actual` is "run": what today's code does on every gated path.
   */
  const consultGate = async (
    args: any,
    o: { mentionsAgent: boolean; personaId?: string },
  ): Promise<GateAction | undefined> => {
    const runner = gateRunner;
    if (!runner || runner.mode === "off") return undefined;
    const e: any = args.event;
    const key = `${e.channel}:${e.ts}`;
    try {
      const threadTs: string = e.thread_ts || e.ts;
      if (await OneOnOne.find(e.channel, threadTs)) return undefined;
      if (await ingressDrops(args)) return undefined;
      if (await ingressHandlesLocally(args, o.personaId)) return undefined;
      const teamId: string | undefined = args.context?.teamId ?? e.team;
      const client = args.client ?? t.client;
      const input = async () => {
        const engaged = o.mentionsAgent
          ? !!teamId &&
            !!(await Sessions.findByThread({ team_id: teamId, channel_id: e.channel, thread_ts: threadTs, persona_id: o.personaId ?? "default" }))?.engaged
          : true;
        // Deliberately NO teamId: without a team resolveBrainScope adds no
        // profile source, so a person's profile never feeds the hit score sent
        // to the external decision classifier. Do not "fix" by adding teamId
        // (tests/gateway/core/decision-gate.test.ts pins this).
        const ctx = { channel: e.channel, threadTs, userId: e.user, personaId: o.personaId } as SlackContext;
        const deps: GateContextDeps = {
          replies: (channel, thread, limit) => threadTail(client, channel, thread, e.ts, limit),
          kbSearch: brainEnabled()
            ? async (q) => gather(q, resolveBrainScope({ ...(await brainGateFor(ctx)), kbSources: personaKbSourceIds(o.personaId) }))
            : null,
          selfIds: await gateSelfIds(args, o.personaId),
        };
        return buildGateInput(
          { channel: e.channel, ts: e.ts, thread_ts: e.thread_ts, text: (e.text ?? "").toString() },
          { mentionsAgent: o.mentionsAgent, engaged, channelTrust: GATE_TRUST[channelTrustFor(e.channel, soulData())], contextMessages: runner.contextMessages },
          deps,
        );
      };
      return await runner.gate(key, input, "run");
    } catch {
      console.error(`[gate] error key=${key}`);
      return undefined;
    }
  };

  /**
   * record_doubt on a mention: react, record into the persona's existing
   * session (suppressed), never engage. No session: nothing to record into.
   */
  const recordDoubt = async (args: any, personaId?: string): Promise<void> => {
    const e: any = args.event;
    const teamId: string | undefined = args.context?.teamId ?? e.team;
    const threadTs: string = e.thread_ts || e.ts;
    // Already claimed by handleMessage (the other copy of this mention ran or
    // was recorded): no 🤔 on a message the agent may be answering, and the
    // record below would be deduped anyway.
    if (await SeenEvents.has(`${e.channel}:${e.ts}`)) return;
    try {
      await outClientForPersona(personaId, { apiAppId: args.context?.apiAppId, teamId }).reactions.add({
        channel: e.channel, timestamp: e.ts, name: REACT_DOUBT,
      });
    } catch (err: any) {
      // The other copy of the same mention already reacted.
      if (err?.data?.error !== "already_reacted") {
        console.error(`[gate] doubt reaction failed ch=${e.channel} ts=${e.ts}:`, err?.data?.error ?? err?.message);
      }
    }
    const row = teamId
      ? await Sessions.findByThread({ team_id: teamId, channel_id: e.channel, thread_ts: threadTs, persona_id: personaId ?? "default" })
      : null;
    if (row) {
      console.log(`[slack-rx] record ch=${e.channel} ts=${e.ts} user=${e.user} — gate doubt, suppressed`);
      return await handleMessage(args, { suppress: true, personaId });
    }
    console.log(`[slack-rx] drop ch=${e.channel} ts=${e.ts} user=${e.user} — gate doubt, no session to record into`);
  };

  /** An engaged plain reply the gate records rather than runs. */
  const recordEngaged = async (args: any, personaId?: string): Promise<void> => {
    const e: any = args.event;
    console.log(`[slack-rx] record ch=${e.channel} ts=${e.ts} user=${e.user} — gate record, suppressed`);
    return await handleMessage(args, { suppress: true, personaId });
  };

  // app_mention is a guaranteed delivery path even if message.channels event
  // subscription isn't enabled. Engage the thread, then defer to handleMessage.
  // (handleMessage's seen_events dedup prevents double-handling when the same
  //  ts also arrives via the message event.)
  // Feedback on proactive posts (phase E): replies go through the message
  // router below; a reaction is recorded as an outcome (never a mute).
  const proactiveFeedbackDeps = (args: any): FeedbackDeps => ({
    call: brainCall,
    now: () => new Date(),
    reply: async (channel, threadTs, text) => {
      await (args.client ?? t.client).chat.postMessage({ channel, thread_ts: threadTs, text });
    },
    once: (key) => SeenEvents.tryInsert(key),
  });
  /**
   * Is this copy of a reply under a proactive post the copy of the app that
   * made the post? Slack delivers a channel message to every app installed
   * there, and the thread must be taken (its session stamped with the
   * receiving app) by the bot that posted. The root's author
   * (`parent_user_id`) being this app's bot decides it. A root posted as a
   * real user (xoxp), or an event without `parent_user_id`, names no app:
   * taken only when no other registered app's bot is in the channel (a
   * single-app deploy); a failed member lookup reads as one being there.
   */
  const postedThroughThisApp = async (args: any, e: any): Promise<boolean> => {
    const own = await getBotId(args);
    if (e.parent_user_id && e.parent_user_id === own) return true;
    if (e.parent_user_id && !(await getSelfUserIds()).has(e.parent_user_id)) return false;
    const others = [...(await getSelfBots(args)).userIds].filter((u) => u && u !== own);
    return !others.length || !(await anyInChannel(args.client ?? t.client, e.channel, others));
  };
  t.event("reaction_added", async (args: any) => {
    const e: any = args.event;
    if (e?.item?.type !== "message" || !e.user || !brainEnabled() || !brainReady()) return;
    if ((await getSelfUserIds()).has(e.user) || (await getSelfBots(args)).userIds.has(e.user)) return;
    try {
      await onProactiveReaction({ channel: e.item.channel, messageTs: e.item.ts, userId: e.user, reaction: String(e.reaction ?? "") }, proactiveFeedbackDeps(args));
    } catch (err) {
      console.error(`[proactive] reaction on ch=${e.item.channel} failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    }
  });

  t.event("app_mention", async (args: any) => {
    const e: any = args.event;
    const ts: string = e.thread_ts || e.ts;
    const act = gateActive() ? await consultGate(args, { mentionsAgent: true }) : undefined;
    if (act === "record_doubt") return await recordDoubt(args);
    const engagedBefore = await engageOnMention(args.context?.teamId ?? e.team, e.channel, ts, e.ts);
    await handleMessage(args, { engagedBefore });
  });

  // Single message router: every non-bot message goes here so we can manage
  // engagement state consistently. We dispatch to handleMessage when slaude
  // should answer.
  t.event("message", async (args: any) => {
    const e: any = args.event;
    // Drop only self bot-echoes (any registered app's bot); other bots flow through.
    if (await isSelfBotEcho(args, e)) {
      metric.slackDropsTotal.inc({ reason: "self_bot" });
      return;
    }
    if (!e.user) return;
    // Drop self-echoes when posting as a real user (xoxp) — default identity or a
    // named persona: own posts carry our user id and no bot_id, so they'd
    // otherwise drive engagement/disengagement.
    const selfUserIds = await getSelfUserIds();
    if (selfUserIds.has(e.user)) {
      metric.slackDropsTotal.inc({ reason: "self_user" });
      return;
    }
    // A reply under a proactive post (phase E): recorded as an outcome; a
    // "stop" mutes that topic for the replier and ends here. Any other reply
    // continues in a proactive thread (spec §5 Stitching): the agent started
    // it, so the decision gate is never consulted there, and a thread with no
    // session yet is engaged for the post's persona below.
    let proactive: { personaId: string | undefined } | null = null;
    if (e.thread_ts && e.thread_ts !== e.ts && brainEnabled() && brainReady()) {
      try {
        const fb = await onProactiveReply(
          { channel: e.channel, threadTs: e.thread_ts, ts: e.ts, userId: e.user, teamId: args.context?.teamId ?? e.team ?? null, text: String(e.text ?? "") },
          proactiveFeedbackDeps(args),
        );
        if (fb.result === "muted") return;
        // The post's agent is a named persona's Slack user, else the default persona's.
        if (fb.post && (await postedThroughThisApp(args, e))) {
          const name = getPersonaRegistry().lookupByUserId(fb.post.agentId)?.name;
          proactive = { personaId: name && name !== "default" ? name : undefined };
        }
      } catch (err) {
        console.error(`[proactive] feedback on ch=${e.channel} ts=${e.ts} failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
      }
    }

    const channelId: string = e.channel;
    const ts: string = e.thread_ts || e.ts;
    const text: string = (e.text || "").toString();
    const botId = await getBotId(args);

    // DMs: always handle, no engagement tracking needed.
    if (e.channel_type === "im") {
      return await handleMessage(args);
    }

    const mentions = Array.from(text.matchAll(/<@([A-Z0-9]+)>/g)).map((m) => m[1]);
    const mentionsBot = mentions.includes(botId);
    // A mention of ANOTHER registered app's bot is addressed to that app, which
    // gets its own copy of the message: this app neither answers it nor reads
    // it as a mention of a colleague (which would disengage the thread).
    // That app's copy only arrives if its bot is in the channel; a mention of a
    // registered bot that is not here is a colleague mention like any other.
    const selfBotUsers = (await getSelfBots(args)).userIds;
    const otherAppBots = mentionsBot ? [] : mentions.filter((u): u is string => Boolean(u) && u !== botId && selfBotUsers.has(u!));
    const absentAppBots = new Set<string>();
    if (otherAppBots.length) {
      if (await anyInChannel(args.client ?? t.client, channelId, otherAppBots)) {
        console.log(`[slack-rx] drop ch=${channelId} ts=${e.ts} — addressed to another registered app`);
        metric.slackDropsTotal.inc({ reason: "other_app" });
        return;
      }
      for (const u of otherAppBots) absentAppBots.add(u);
    }

    const teamId: string | undefined = args.context?.teamId ?? e.team;

    // Multi-persona: check if any mention targets a known persona user.
    const registry = getPersonaRegistry();
    const mentionedPersona = registry.isMultiPersonaMode()
      ? (mentions.map((id) => registry.lookupByUserId(id!)).find(Boolean) ?? null)
      : null;
    // A mention is "other" only when it targets neither the bot nor a known persona.
    const mentionsOther = mentions.some(
      (u) => u && u !== botId && (!selfBotUsers.has(u) || absentAppBots.has(u)) && !registry.lookupByUserId(u),
    );

    // No gate in a proactive thread (see above); everything else unchanged.
    const gated = (): boolean => !proactive && gateActive();

    if (mentionsBot) {
      const act = gated() ? await consultGate(args, { mentionsAgent: true }) : undefined;
      if (act === "record_doubt") return await recordDoubt(args);
      const engagedBefore = await engageOnMention(teamId, channelId, ts, e.ts);
      return await handleMessage(args, { engagedBefore });
    }
    if (!mentionedPersona) {
      // A retired persona's identity stops routing: drop what is addressed to it
      // rather than treat it as a colleague mention (which would disengage the
      // thread) or hand it to the default persona.
      const retired = mentions.map((id) => (id ? registry.tombstonedPersonaFor(id) : null)).find(Boolean);
      if (retired) {
        console.log(`[slack-rx] drop ch=${channelId} ts=${e.ts} — addressed to retired persona=${retired}`);
        metric.slackDropsTotal.inc({ reason: "persona_retired" });
        return;
      }
    }
    if (mentionedPersona) {
      // Re-engage the persona's row if it was disengaged; a first mention has
      // no row yet and the session is born engaged.
      const personaId = mentionedPersona.name;
      const act = gated() ? await consultGate(args, { mentionsAgent: true, personaId }) : undefined;
      if (act === "record_doubt") return await recordDoubt(args, personaId);
      const engagedBefore = await engageOnMention(teamId, channelId, ts, e.ts, mentionedPersona.name);
      return await handleMessage(args, { personaId: mentionedPersona.name, engagedBefore });
    }
    if (mentionsOther) {
      // Disengage the bot AND every persona in this thread (the user is
      // talking to a colleague now) — one durable write, no in-memory keys.
      if (teamId) await Sessions.setEngagedForThread({ team_id: teamId, channel_id: channelId, thread_ts: ts }, false);
      // Don't drop: if slaude has a session here, record the disengaging message
      // into the transcript (suppressed — the UserPromptSubmit hook halts the turn
      // before the model runs) so the session stays populated. On re-engage the
      // model resumes with the gap already in history. No session → nothing to
      // populate, so drop as before (never spin one up for an unrelated thread).
      const row = teamId
        ? await Sessions.findAnyByThread({ team_id: teamId, channel_id: channelId, thread_ts: ts })
        : null;
      if (row) {
        console.log(
          `[slack-rx] disengage ch=${channelId} ts=${e.ts} user=${e.user} — recording (suppressed), thread now disengaged`,
        );
        return await handleMessage(args, { suppress: true });
      }
      console.log(
        `[slack-rx] drop ch=${channelId} ts=${e.ts} user=${e.user} — mention to other user, no session to populate`,
      );
      metric.slackDropsTotal.inc({ reason: "mention_other" });
      return;
    }
    // Mention-only thread: a plain (non-@mention) message never triggers a reply,
    // even mid-conversation — the auto-continue paths below are skipped. The
    // message is still recorded (suppressed) if a session exists so the model has
    // context when next mentioned; otherwise dropped.
    const mentionOnly = await MentionOnly.find(channelId, ts) != null;
    if (mentionOnly) {
      const row = teamId
        ? await Sessions.findAnyByThread({ team_id: teamId, channel_id: channelId, thread_ts: ts })
        : null;
      if (row) {
        console.log(`[slack-rx] record ch=${channelId} ts=${e.ts} user=${e.user} — mention-only, suppressed`);
        return await handleMessage(args, { suppress: true });
      }
      console.log(`[slack-rx] drop ch=${channelId} ts=${e.ts} user=${e.user} — mention-only, no @mention`);
      metric.slackDropsTotal.inc({ reason: "mention_only" });
      return;
    }
    // Plain reply: engagement is read straight from sessions.engaged (the only
    // source — durable across restarts and replicas). The bot's own (default
    // persona) row is checked first, mirroring the bot-first ordering the old
    // in-memory Set had, then named personas in registry order, then any other
    // session row for the thread.
    // A thread already recorded under another registered app is continued by
    // that app's own copy of this message; answering here too would hand the
    // thread to whichever app's delivery won the dedup race.
    // Only an app still in the registry can continue it: a removed app's thread
    // falls through and is taken by this app (handleMessage records it).
    const liveApps = new Set((await registeredApps()).map((a) => `${a.apiAppId}:${a.teamId}`));
    const otherApp = (row: SessionRow | null | undefined): boolean => {
      const own = args.context?.apiAppId;
      if (!own || !row?.slack_app_id || row.slack_app_id === own) return false;
      if (!liveApps.has(`${row.slack_app_id}:${teamId}`)) return false;
      console.log(`[slack-rx] drop ch=${channelId} ts=${e.ts} — thread belongs to app ${row.slack_app_id}`);
      metric.slackDropsTotal.inc({ reason: "other_app" });
      return true;
    };
    if (teamId) {
      const def = await Sessions.findByThread({ team_id: teamId, channel_id: channelId, thread_ts: ts, persona_id: "default" });
      if (def?.engaged) {
        if (otherApp(def)) return;
        const act = gated() ? await consultGate(args, { mentionsAgent: false }) : undefined;
        if (act === "record") return await recordEngaged(args);
        return await handleMessage(args);
      }
      // Multi-persona: a plain reply continues whichever persona is engaged in this thread.
      if (registry.isMultiPersonaMode()) {
        for (const p of registry.list()) {
          const row = await Sessions.findByThread({ team_id: teamId, channel_id: channelId, thread_ts: ts, persona_id: p.name });
          if (row?.engaged) {
            if (otherApp(row)) return;
            const act = gated() ? await consultGate(args, { mentionsAgent: false, personaId: p.name }) : undefined;
            if (act === "record") {
              return await recordEngaged(args, p.name);
            }
            return await handleMessage(args, { personaId: p.name });
          }
        }
      }
      const any = def ?? (await Sessions.findAnyByThread({ team_id: teamId, channel_id: channelId, thread_ts: ts }));
      // On a managed tenant the registry is complete: a thread whose persona it
      // no longer lists belongs to a retired persona, and is never continued
      // (as that persona or as the default).
      if (any && any.persona_id && any.persona_id !== "default" && registry.isManaged() && !registry.lookupByName(any.persona_id)) {
        console.log(`[slack-rx] drop ch=${channelId} ts=${e.ts} — thread belongs to retired persona=${any.persona_id}`);
        metric.slackDropsTotal.inc({ reason: "persona_retired" });
        return;
      }
      if (any && any.engaged) {
        if (otherApp(any)) return;
        // Engaged session outside the registry (e.g. persona removed from
        // config) — keep handling plain replies as that persona.
        const restoredPersonaId = any.persona_id !== "default" ? any.persona_id : undefined;
        const act = gated() ? await consultGate(args, { mentionsAgent: false, personaId: restoredPersonaId }) : undefined;
        if (act === "record") {
          return await recordEngaged(args, restoredPersonaId);
        }
        return await handleMessage(args, { personaId: restoredPersonaId });
      }
      // Explicitly disengaged (row.engaged=0): record plain messages into the
      // transcript too (suppressed by the hook) so the session stays populated
      // for re-engage. No model run, no Slack feedback.
      if (any && any.engaged === 0) {
        if (otherApp(any)) return;
        const disengagedPersonaId = any.persona_id !== "default" ? any.persona_id : undefined;
        console.log(
          `[slack-rx] record ch=${channelId} ts=${e.ts} user=${e.user} — disengaged thread, suppressed`,
        );
        return await handleMessage(args, { suppress: true, personaId: disengagedPersonaId });
      }
    }
    // A reply under a proactive post with no session in the thread yet (an
    // inform post): the session handleMessage creates is born engaged. A
    // thread disengaged since (a colleague mention) stays disengaged above.
    if (proactive) {
      console.log(`[slack-rx] engage ch=${channelId} ts=${e.ts} user=${e.user} — reply under a proactive post`);
      return await handleMessage(args, { personaId: proactive.personaId });
    }
    console.log(
      `[slack-rx] drop ch=${channelId} ts=${e.ts} user=${e.user} — channel msg, thread not engaged (no @mention)`,
    );
    metric.slackDropsTotal.inc({ reason: "engagement" });
  });

  // REST /v1 (spec §3), built inside the gateway so the tool plane runs THE
  // SAME engines as the MCP tools: persona-resolved outbound clients, the
  // approval gate, the 1on1 / mention-only / connect engines, and brain
  // scoping. The SessionContext is derived from the verified job token, never
  // from the request body. src/server.ts mounts fetchV1 on the health server
  // when SLAUDE_ROLE is mono/gateway.
  //
  // The MCP bridge (WS-C §4.2) serves a node's relayed tools/list and
  // tools/call for the persona's remote MCP servers: the gateway is the MCP
  // client, and the credential never leaves it. Its servers resolve exactly as
  // the runtime bundle names them (bridgeExternalMcp: the managed persona's
  // config; files only with the operator's opt-in). mono
  // never calls it: its sessions mount external MCP directly, as before.
  const mcpBridge = createMcpBridge({
    servers: bridgeServers,
    onNeedsAuth: (claims, server, scope, reason) => postBridgeConnectCard(claims, server, scope, reason),
  });
  /** The `/mcp` connect card, posted in the turn's thread when a bridged server
   *  needs connecting or re-authorising. The clicker must be who the connect
   *  would be for: the runAs user (initiator), or the manager (the agent's
   *  shared identity), exactly as the card's click handler checks. */
  async function postBridgeConnectCard(claims: JobClaims, server: string, scope: ConnectScope, reason: "connect" | "reauth"): Promise<void> {
    const personaId = claims.persona && claims.persona !== "default" ? claims.persona : undefined;
    const runAs = parseRunAs(claims.runAs);
    const userId = scope === "initiator" ? (runAs?.kind === "user" ? runAs.slackUserId : "") : soulData().manager.userId;
    if (!userId) return; // nobody could click it
    const text = `:warning: ${reason === "connect" ? connectText(server) : reauthText(server)}.`;
    const button = await connectButton(claims.session, {
      channelId: claims.channel, threadTs: claims.thread, userId, serverName: server, scope, personaName: personaKey(personaId),
    });
    await outClientForPersona(personaId, { apiAppId: claims.app, teamId: claims.team }).chat.postMessage({
      channel: claims.channel,
      thread_ts: claims.thread,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }, { type: "actions", elements: [button] }],
      mrkdwn: true,
    });
  }
  /** The /v1 tool plane's SlackContext for a verified job token: everything
   *  (speaker, team, origin, persona, app) comes from the signed claims. */
  const v1SlackCtx = (claims: JobClaims): SlackContext => {
    const personaId = claims.persona && claims.persona !== "default" ? claims.persona : undefined;
    // The turn's app rides in the signed token; an older token carries
    // only the team, which resolves when it is unambiguous (D1.2).
    const app: AppRef = { apiAppId: claims.app, teamId: claims.team };
    const ctx: SlackContext = {
      client: outClientForPersona(personaId, app),
      apiAppId: claims.app,
      resolveBotToken: () => t.botTokenFor?.(app),
      channel: claims.channel,
      threadTs: claims.thread,
      // No live inbound message on the REST path — reactions and default
      // react targets anchor on the thread root.
      inboundTs: claims.thread,
      userId: claims.initiator,
      teamId: claims.team,
      personaId,
      sessionId: claims.session,
      // Signed at dispatch; absent (an older gateway) reads as not interactive.
      ...(claims.origin ? { origin: claims.origin } : {}),
      // The job's recorded senders (merged messages included); mono and a
      // token with no job claim have none, which refuses a profile write.
      turnSenders: async () => (queueDispatch && claims.job ? queueDispatch.turns.turnSenders(claims.job) : null),
    };
    ctx.requestApproval = (req) =>
      approvals.request({ channel: ctx.channel, threadTs: ctx.threadTs, app, ...req });
    ctx.reloadSession = (prompt?) => agent.reload(claims.session, prompt);
    return ctx;
  };
  const v1 = createV1Api({
    tools: {
      mcpBridge,
      slackCtx: v1SlackCtx,
      surfaceFor: (ctx) => wrapSurface(surfaceForCtx(ctx), ctx.sessionId ?? ""),
      surfaceOpts: (claims, ctx) => ({
        initiator: () => ctx.userId,
        setOneOnOne: (action, scope) => agentOneOnOne(claims.session, ctx, action, scope),
        setMentionOnly: (active) => agentMentionOnly(ctx, active),
      }),
      connect: (claims, ctx, server) => agentConnect(claims.session, ctx, server),
      brainDeps: (ctx, surface, claims) => brainDepsFor(ctx, surface, undefined, claims),
      // Non-blocking gate opens (spec §3 "Blocking tools"): the node long-polls
      // /v1/pending/:id; ANY replica's Block Kit click settles the durable row
      // and publishes gate:<id> for the instant wakeup.
      openPermission: (claims, args) =>
        permissions.open({
          sessionId: claims.session,
          toolName: args.toolName,
          input: args.input,
          toolUseId: args.toolUseId,
          channel: claims.channel,
          threadTs: claims.thread,
          decisionReason: args.decisionReason,
          suggestions: args.suggestions,
          app: { apiAppId: claims.app, teamId: claims.team },
        }),
      openApproval: (claims, args) =>
        approvals.open({
          channel: claims.channel,
          threadTs: claims.thread,
          sessionId: claims.session,
          app: { apiAppId: claims.app, teamId: claims.team },
          ...args,
        }),
    },
    // Instant long-poll wakeup on gate clicks when Redis is configured;
    // pure DB polling otherwise (mono default).
    pending: {
      wake: (id, cb) => {
        const bus = defaultGateBus();
        if (!bus) return Promise.resolve(async () => {});
        return bus.subscribe(id, cb);
      },
    },
    // token-reissue re-mints only for a job still in the turn queues (node
    // labels spec §4.4); mono has no queue, so nothing is reissuable there.
    ...(queueDispatch
      ? {
          jobLookup: async (queue: string, jobId: string) => {
            const j = await queueDispatch.turns.peekJob(queue, jobId);
            if (!j) return null;
            return { data: j.data ?? {}, timestamp: j.timestamp, state: await j.getState() };
          },
          // A held copy of a moved job runs under a new id with the original
          // token: refresh and reissue follow the job-moved marker to it (and
          // check the copy carries that token).
          jobMovedTo: (jobId: string) => queueDispatch.turns.movedTo(jobId),
        }
      : {}),
  });

  // Unified panel-chat enqueue (design Refinement 2): build a panel-sourced
  // channel envelope + DispatchMeta from the session row, then route it through
  // the SAME seam Slack uses — the node queue in the gateway role, the
  // in-process AgentManager in mono. The operator identity rides as the turn
  // initiator/userId.
  async function panelEnqueue(session: SessionRow, text: string, operatorId: string): Promise<void> {
    const eventTs = `${Date.now() / 1000}`;
    const meta = panelDispatchMeta(session, operatorId, eventTs);
    const { channelId, threadTs } = meta;
    // A session recorded before its app was: a live route on this replica
    // may still know it; with neither, the token carries the team alone.
    const liveApp = routes.get(session.id)?.ctx.apiAppId;
    if (!meta.apiAppId && liveApp) meta.apiAppId = liveApp;
    const envelope =
      `<channel source="panel" channel_id="${channelId}" thread_ts="${threadTs}" ` +
      `inbound_ts="${eventTs}" user_id="${operatorId}" user_name="${escapeAttr(operatorId)}" ` +
      `trust="restricted" one_on_one="false" locked_user="">\n${text}\n</channel>\n\n` +
      `Reply by calling \`mcp__${SURFACE_MCP_NAME}__reply\`, or call ` +
      `\`mcp__${SURFACE_MCP_NAME}__pass\` if the message is not for you or needs nothing from you. ` +
      `Plain assistant text is not delivered — only tool calls reach the operator.`;
    if (queueDispatch) {
      await queueDispatch.dispatch(session, envelope, meta);
    } else {
      // Mono: the route's context is the speaker the tools see. Without this
      // the panel turn would run as the last Slack speaker, and as interactive
      // for them; the operator is the speaker, as the node token's initiator is.
      const route = routes.get(session.id);
      if (route) {
        route.ctx.userId = operatorId;
        route.ctx.origin = "panel";
        noteTurnSender(session.id, route.ctx);
      }
      await agent.sendMessage(session.id, envelope, { sender: { userId: operatorId, teamId: meta.teamId || null, origin: "panel" } });
    }
  }

  // The end-user portal is its own mount with its own guard: an ordinary user
  // never reaches an operator route, and the panel's guard is not relaxed.
  // createPortalApi returns null for every request while SLAUDE_PORTAL is off.
  const portalApi = createPortalApi();
  // Reuses whichever pub/sub this gateway already holds; with none (mono, no
  // Redis) the reload is local-only, which is all there is to notify.
  // With a queue, a persona whose runsOn no live node carries is reported as a
  // warning (node labels spec §4.5); mono has no nodes to ask.
  const labelRegistry = queueDispatch?.registry ?? panelInfra?.registry;
  const deployApi = createDeployApi({
    pubsub: queueDispatch?.pubsub ?? panelInfra?.pubsub ?? null,
    ...(labelRegistry ? { liveLabels: () => labelRegistry.liveLabels() } : {}),
  });

  const brainImportApi = createBrainImportApi();

  const panelApi = panelInfra
    ? createPanelApi({
        registry: panelInfra.registry,
        pubsub: panelInfra.pubsub,
        panelLock: panelInfra.panelLock,
        chat: panelEnqueue,
        onLockHeld: (sessionId, _operatorId, ttlMs) => panelMarkHeld(sessionId, ttlMs),
        // Release (give control back to Slack): drain locally + broadcast so
        // every replica replays its own deferred inbound.
        onLockReleased: (sessionId) => broadcastPanelResume(sessionId),
        // A warm mono session keeps its remote tools until reloaded.
        onUnlock: (sessionId) => { agent.reload(sessionId); },
        // The persona view says where a persona's stdio MCP servers run.
        role: queueDispatch ? "gateway" : "mono",
        // Label status (node labels spec §4.7): only with a node queue.
        labels: queueDispatch
          ? (() => {
              const mon = makeLabelMonitor({
                redis: queueDispatch.turns.redis,
                keys: queueDispatch.turns.keys,
                turns: queueDispatch.turns,
                registry: queueDispatch.registry,
                personaLabels: () => labelsInUse(),
                unservedSecs: () => env.labelUnservedSec(),
              });
              return () => mon.read();
            })()
          : null,
      })
    : null;

  return {
    start: () => t.start(),
    stop: async () => {
      // End live voice calls first, while the transport can still carry each
      // call's summary turn; bounded so shutdown never hangs on a call.
      await drainVoiceCalls(voiceCalls, VOICE_SHUTDOWN_GRACE_MS);
      cancelNightlyMaintenance();
      await cronLeader?.stop().catch(() => {});
      // Aborts a pass in flight; bounded (STOP_GRACE_MS, 10 s) so shutdown never waits out a review.
      await backgroundScheduler?.stop().catch(() => {});
      cronScheduler.stop();
      if (panelSweeper) clearInterval(panelSweeper);
      await panelResumeUnsub?.().catch(() => {});
      await panelHoldUnsub?.().catch(() => {});
      await mcpBridge.close().catch(() => {});
      await backgroundBridge?.close().catch(() => {});
      await t.stop();
      // Never rejects (errors are logged above). While closing, the KB import
      // stops before its next KB, so shutdown does not wait for a full import.
      if (brainBootstrap) await whileClosing(() => brainBootstrap!);
    },
    fetchV1: (req: Request) => v1.fetch(req),
    fetchPanel: (req: Request) => (panelApi ? panelApi.fetch(req) : Promise.resolve(null)),
    fetchPortal: (req: Request) => portalApi.fetch(req),
    fetchDeploy: (req: Request) => deployApi.fetch(req),
    fetchBrainImport: (req: Request) => brainImportApi.fetch(req),
    __pendingSource: () => v1.pendingSource,
    __sessionCtx: (sessionId: string) => sessionCtx.get(sessionId),
    __resolveMcp: (sessionId: string) => mcpResolver(sessionId),
    __promises: backgroundSlack.promises!,
    __proactive: backgroundSlack.proactive!,
    __voiceCalls: voiceCalls,
    __brainGate: async (sessionId: string) => {
      const route = routes.get(sessionId);
      return route ? brainGateFor(route.ctx) : undefined;
    },
    __brainGateForClaims: (claims: JobClaims) => brainGateFor(v1SlackCtx(claims)),
    __panelChat: (session: SessionRow, text: string, operatorId: string) => panelEnqueue(session, text, operatorId),
    __agentConnect: (sessionId: string, server: string) => {
      const route = routes.get(sessionId);
      if (!route) return Promise.resolve("no active thread for this session");
      return agentConnect(sessionId, route.ctx, server);
    },
    __agentOneOnOne: (sessionId: string, action: "lock" | "open" | "off", scope?: string) => {
      const route = routes.get(sessionId);
      if (!route) return Promise.resolve("no active thread for this session");
      return agentOneOnOne(sessionId, route.ctx, action, scope);
    },
    __agentMentionOnly: (sessionId: string, active: boolean) => {
      const route = routes.get(sessionId);
      if (!route) return Promise.resolve("no active thread for this session");
      return agentMentionOnly(route.ctx, active);
    },
  };
}
