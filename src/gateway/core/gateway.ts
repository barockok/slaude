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
import { mutateOverride, FIELD_ALIASES } from "../../soul/overrides";
import * as SoulOverrides from "../../db/soul-overrides";
import { createSlackMcp, SLACK_MCP_NAME, createRuntimeMcp, RUNTIME_MCP_NAME, createConnectMcp, CONNECT_MCP_NAME, type SlackContext, parseDuration } from "../slack/mcp-tools";
import { makeSlackSurfaceFactory } from "../slack/surface";
import { createSurfaceMcp, SURFACE_MCP_NAME } from "./surface-mcp";
import { humanizeToolStatus } from "./status-text";
import type { Surface, SurfaceFactory, SessionBinding } from "./surface";
import { createSkillsMcp, SKILLS_MCP_NAME } from "../../skills/mcp-tools";
import { createSessionMcp, SESSION_MCP_NAME } from "../../agent/session-mcp";
import { createKbMcp, KB_MCP_NAME } from "../../knowledge/mcp-tools";
import { brainEnabled, ensureSources } from "../../knowledge/brain";
import { brainMode } from "../../knowledge/brain-config";
import { syncKbWikis } from "../../knowledge/brain-sync";
import { scheduleNightlyMaintenance } from "../../knowledge/brain-cycle";
import { channelTrustFor, kbSourceId, resolveBrainScope } from "../../knowledge/scope";
import type { GateInput } from "../../knowledge/gated-dispatch";
import { loadKbs } from "../../knowledge/loader";
import { resolveUserName } from "../slack/users";
import { downloadAttachments, type SlackFile } from "../slack/attachments";
import * as Sessions from "../../db/sessions";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { loadExternalMcp, privateOverrides } from "./external-mcp";
import { randomBytes } from "node:crypto";
import { ensureInitiatorConfigDir, agentConfigDir } from "../../agent/oauth-home";
import { writeEntry, removeEntry, type OAuthServerConfig, type OAuthTokens } from "../../agent/mcp-oauth/store";
import { discover } from "../../agent/mcp-oauth/discovery";
import { beginConnect, prepareConnect } from "../../agent/mcp-oauth/client";
import { beginConnectShared } from "../../agent/mcp-oauth/shared-client";
import { parseOAuthCallback } from "../../agent/mcp-oauth/callback";
import { canTriggerIngest } from "../slack/ingest-auth";
import { canChangeModel } from "../slack/model-auth";
import { listModels } from "../../agent/models";
import * as kbIngest from "../../knowledge/ingest";
import * as Ignores from "../../db/ignores";
import * as CronJobs from "../../db/cron-jobs";
import * as OneOnOne from "../../db/one-on-one";
import * as MentionOnly from "../../db/mention-only";
import { CronScheduler } from "../slack/cron-scheduler";
import { getNextRun } from "../slack/cron-parser";
import type { Transport } from "./transport";

export interface SessionMcpCtx { slack: SlackContext; surface: Surface }
export interface GatewayHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** TEST/SIM SEAM ONLY. Live per-session MCP contexts built by the resolver.
   *  Undefined until the session's resolver has run. Production never calls this. */
  __sessionCtx(sessionId: string): SessionMcpCtx | undefined;
  /** TEST/SIM SEAM ONLY. Re-run the per-session MCP resolver and return the
   *  mounted server map (incl. /1on1 private-service credential overlays).
   *  Requires the session's route to exist (feed a message first). Production
   *  never calls this. */
  __resolveMcp(sessionId: string): Record<string, McpServerConfig> | undefined;
  /** TEST/SIM SEAM ONLY. Drive the natural-language connect path (what the
   *  mcp__slaude_connect__connect_mcp tool calls) for a live session. */
  __agentConnect(sessionId: string, server: string): Promise<string>;
  /** TEST/SIM SEAM ONLY. Drive the agent-facing 1on1 toggle
   *  (mcp__slaude_surface__set_one_on_one) for a live session. */
  __agentOneOnOne(sessionId: string, active: boolean): Promise<string>;
  /** TEST/SIM SEAM ONLY. Drive the agent-facing mention-only toggle
   *  (mcp__slaude_surface__set_mention_only) for a live session. */
  __agentMentionOnly(sessionId: string, active: boolean): Promise<string>;
}

const REACT_RECEIVED = "eyes";
const REACT_WORKING = "gear";
const REACT_DONE = "white_check_mark";
const REACT_ERROR = "x";

const STATUS_THINKING = { text: "thinking", emoji: ":thought_balloon:" };

type SessionRoute = {
  ctx: SlackContext;
  /** The interaction Surface for this session. Built once; reads ctx live (getters). */
  surface: Surface;
  /** Whether the agent has emitted user-visible output this turn (surface reply/edit/upload). */
  spoke: boolean;
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
  }) => Promise<{ authorizeUrl: string; state: string; exchange: (code: string) => Promise<import("../../agent/mcp-oauth/store").OAuthTokens> }>;
  /** Disable `/mcp connect` when the boot-time store-format canary fails. Defaults to enabled. */
  mcpConnectEnabled?: boolean;
  /** Test seam: inject the outbound (post-as-user) client directly, bypassing the
   *  SLACK_POST_AS_USER / SLACK_USER_TOKEN env path. When set, the gateway behaves as
   *  if posting-as-user is enabled (self-user echo guard active). */
  outClient?: any;
}

/** Render a TaskCreate/TaskUpdate tasks map as a compact markdown task list. */
function formatTaskList(tasks: Map<string, { subject: string; status: string; completedAt?: string }>): string {
  const lines = [...tasks.values()].map((t) => {
    if (t.status === "completed") return `✅ ${t.subject}${t.completedAt ? ` _(${t.completedAt})_` : ""}`;
    if (t.status === "in_progress") return `▶ **${t.subject}**`;
    return `○ ${t.subject}`;
  });
  return `**Tasks**\n${lines.join("\n")}`;
}

/** Render a TodoWrite todos array as a compact markdown task list for the Slack surface. */
function formatTodoList(todos: Array<{ content: string; status: string }>): string {
  const lines = todos.map((t) => {
    if (t.status === "completed") return `✅ ${t.content}`;
    if (t.status === "in_progress") return `▶ **${t.content}**`;
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
    reloadSession: () => ctx.reloadSession?.() ?? false,
  };
}

export function createGateway(agent: AgentManager, t: Transport, opts: GatewayOptions = {}): GatewayHandle {

  // Outbound content client. When SLACK_USER_TOKEN (xoxp) is set, agent replies,
  // edits, reactions and uploads go out AS the real Slack user account rather than
  // the app bot. Interactivity-bound paths (gates) keep using `t.client` (bot).
  // No user token → outClient IS the bot client, preserving current behavior.
  const userToken = env.slack.userToken();
  const postsAsUser = Boolean(opts.outClient) || (env.slack.postAsUser() && Boolean(userToken));
  const outClient: any = opts.outClient
    ? opts.outClient
    : postsAsUser
    ? new (require("@slack/web-api").WebClient)(userToken)
    : (t.client as any);
  if (postsAsUser) console.log("[slack-out] posting as user (xoxp) — bot token reserved for gates/events");
  else if (env.slack.postAsUser()) console.warn("[slack-out] SLACK_POST_AS_USER=true but SLACK_USER_TOKEN unset — posting as bot");

  const surfaceFactory: SurfaceFactory = opts.surfaceFactory ?? makeSlackSurfaceFactory(outClient);

  const reactions = new ReactionTracker(t.client);
  const presence = new Presence(t.client as any);
  const status = new Status(t.client);
  const permissions = new PermissionGate(t);
  const approvals = new ApprovalGate(t, env.slack.approvers(), {
    timeoutSeconds: () => soulData().approvalTimeoutSeconds || 300,
  });
  const ignoreGate = new IgnoreGate();
  // Clean up expired ignores + abandoned paste-back OAuth flows every 5 minutes.
  // Each pendingPaste entry closes over live client creds + the PKCE verifier, so
  // an abandoned flow must not linger in memory until the initiator happens to
  // message again (the lazy check in the inbound path).
  setInterval(() => {
    import("../../db/ignores").then((m) => m.cleanupExpired());
    const now = Date.now();
    for (const [k, p] of pendingPaste) if (now > p.expiresAt) pendingPaste.delete(k);
  }, 5 * 60 * 1000);

  const cronScheduler = new CronScheduler({
    agent,
    client: t.client as any,
    onExecute: (job, sessionId) => {
      // Register a route so cron sessions get Slack MCP tools + event handling.
      const ctx: SlackContext = {
        client: outClient,
        channel: job.slackChannelId!,
        threadTs: job.slackThreadTs ?? job.channelId,
        inboundTs: String(Date.now()), // synthetic — no real inbound msg for cron
        userId: job.createdBy,
        teamId: job.slackTeamId ?? undefined,
        postTarget: job.target,
      };
      ctx.requestApproval = (req) =>
        approvals.request({
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          ...req,
        });
      ctx.reloadSession = () => agent.reload(sessionId);
      routes.set(sessionId, { ctx, surface: surfaceFactory(bindingFor(ctx)), spoke: false });
    },
  });
  agent.setPermissionResolver(permissions.resolver);

  // Diag: dump bot identity + granted scopes once at startup.
  void (async () => {
    try {
      const res = await t.client.auth.test();
      const scopesHeader = (res as any).response_metadata?.scopes ?? (res as any).headers?.["x-oauth-scopes"];
      console.log(`[slack-auth] team=${(res as any).team} user=${(res as any).user} bot_id=${(res as any).bot_id} url=${(res as any).url}`);
      console.log(`[slack-auth] scopes=${scopesHeader ?? "(unknown — check app OAuth page)"}`);
    } catch (e: any) {
      console.error("[slack-auth] auth.test failed:", e?.data?.error ?? e?.message);
    }
  })();

  // Per-session route + slack context. Mutated on each new inbound user message.
  const routes = new Map<string, SessionRoute>();
  const sessionCtx = new Map<string, SessionMcpCtx>();
  // Start the cron scheduler only after `routes` exists: start() synchronously runs any
  // due job through onExecute, which registers into `routes`. Starting earlier would hit
  // a temporal-dead-zone ReferenceError when a cron job is already due at boot.
  cronScheduler.start();
  // Dedup events by (channel, ts).
  const seenEvents = new Set<string>();

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
  if (brainEnabled() && brainMode() === "local") {
    void ensureSources()
      .then(() => syncKbWikis())
      .then((rs) => {
        for (const r of rs) {
          if (r.ok) console.log(`[brain] kb wiki indexed: ${r.label}`);
          else console.error(`[brain] kb sync failed for ${r.label}: ${r.error}`);
        }
      })
      .catch((e) => console.error("[brain] source bootstrap failed:", e));
    // Nightly maintenance (03:00 local default; SLAUDE_BRAIN_CYCLE="HH:MM"|"off").
    scheduleNightlyMaintenance();
  }
  // Stop-hook enforcement: if a turn ends without any user-visible Slack tool
  // (reply / edit / upload), block the stop once with an instruction that
  // forces the agent to call `mcp__slaude_slack__reply` before exiting.
  agent.setStopGuard((sessionId) => {
    const route = routes.get(sessionId);
    if (!route) return null;
    if (route.spoke) return null;
    return "You have not delivered a reply to the user. Call `mcp__slaude_surface__reply` now with your answer to the inbound message, then stop. Do not stop without replying.";
  });

  // Brain gate input from the live SlackContext — read per tool call so the
  // current turn's author (not the session creator) drives KB scoping.
  const brainGateFor = (ctx: SlackContext): GateInput => {
    const soul = soulData();
    const lock = OneOnOne.find(ctx.channel, ctx.threadTs);
    return {
      userId: ctx.userId ?? null,
      lockedUser: lock?.locked_user ?? null,
      channelTrust: channelTrustFor(ctx.channel, soul),
      isManager: !!ctx.userId && (ctx.userId === soul.manager.userId || ctx.userId === soul.backupManager.userId),
      threadKey: `${ctx.channel}:${ctx.threadTs}`,
    };
  };

  const mcpResolver = (sessionId: string): Record<string, McpServerConfig> | undefined => {
    const route = routes.get(sessionId);
    if (!route) return undefined;
    const servers: Record<string, McpServerConfig> = {
      [SURFACE_MCP_NAME]: createSurfaceMcp(route.surface, {
        initiator: () => route.ctx.userId,
        setOneOnOne: (active) => agentOneOnOne(sessionId, route.ctx, active),
        setMentionOnly: (active) => agentMentionOnly(route.ctx, active),
      }),
      [RUNTIME_MCP_NAME]: createRuntimeMcp(route.ctx),
      [CONNECT_MCP_NAME]: createConnectMcp({ connect: (server) => agentConnect(sessionId, route.ctx, server) }),
      [SLACK_MCP_NAME]: createSlackMcp(route.ctx),
      [SKILLS_MCP_NAME]: createSkillsMcp(),
      [SESSION_MCP_NAME]: createSessionMcp({
        getSnapshot: () => agent.getTokenSnapshot(sessionId),
      }),
      [KB_MCP_NAME]: createKbMcp(
        brainEnabled()
          ? {
              scope: () => resolveBrainScope({ ...brainGateFor(route.ctx), kbSources: loadKbs().map((k) => kbSourceId(k.label)) }),
              gate: () => brainGateFor(route.ctx),
              managers: () => {
                const soul = soulData();
                return [soul.manager.userId, soul.backupManager.userId].filter((u): u is string => !!u);
              },
              requestApproval: (r) => route.surface.requestApproval(r),
            }
          : undefined,
      ),
      ...externalMcp.servers,
    };
    // 1on1 privacy: when this session's effective identity is locked (live /1on1
    // lock, or a cron job's captured initiator), whitelisted external services mount
    // with the agent's credentials stripped so they run as that identity (self-prompt
    // auth). Other sessions/threads keep the agent identity (source map untouched).
    const effectiveIdentity = agent.resolveEffectiveIdentity(sessionId, route.ctx.channel, route.ctx.threadTs);
    Object.assign(servers, privateOverrides(externalMcp.servers, privateServiceSet, !!effectiveIdentity));
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
  const runPrepare = opts.oauthPrepare ?? (async ({ serverName, serverConfig, redirectUri }) => {
    const meta = await discover(serverConfig.url);
    return prepareConnect({ serverName, serverConfig, meta, redirectUri });
  });

  // OAuth connect scope: "initiator" writes to the per-user config home (inside a
  // /1on1 lock); "global" writes to the agent's own config dir (manager-driven, no
  // lock — connects the agent's shared identity).
  type ConnectScope = "initiator" | "global";

  // Pending /mcp connect buttons: token → the context needed to run the connect.
  const pendingMcp = new Map<string, { sessionId: string; channelId: string; threadTs: string; userId: string; serverName: string; scope: ConnectScope }>();

  // Paste-back: a started-but-not-completed OAuth flow, keyed by channel:thread:user
  // (one in-flight connect per initiator per thread). The initiator completes it by
  // pasting the callback URL/code into the locked thread.
  type PendingPaste = {
    state: string;
    exchange: (code: string) => Promise<OAuthTokens>;
    serverName: string;
    serverConfig: OAuthServerConfig;
    sessionId: string; channelId: string; threadTs: string; userId: string;
    scope: ConnectScope;
    /** ts of the posted authorize-URL message, redacted in place on settle. */
    authMsgRef?: string;
    expiresAt: number;
  };
  const pendingPaste = new Map<string, PendingPaste>();
  const pasteKey = (channelId: string, threadTs: string, userId: string) => `${channelId}:${threadTs}:${userId}`;

  // Only HTTP servers participate in the OAuth connect flow.
  const httpExternalServers = (): Record<string, { url: string; headers?: Record<string, string> }> => {
    const out: Record<string, { url: string; headers?: Record<string, string> }> = {};
    for (const [name, cfg] of Object.entries<any>(externalMcp.servers)) {
      if (cfg?.type === "http" && typeof cfg.url === "string") out[name] = { url: cfg.url, headers: cfg.headers };
    }
    return out;
  };

  /** Persist freshly-exchanged tokens into the CLI store and reboot the session so
   *  the CLI picks them up. "initiator" scope writes the per-user config home;
   *  "global" scope writes the agent's own config dir. Shared by loopback + paste. */
  async function persistTokens(a: { sessionId: string; userId: string; serverName: string; serverConfig: OAuthServerConfig; scope: ConnectScope }, tokens: OAuthTokens) {
    // initiator: ensureInitiatorConfigDir seeds + creates the dir (the connect flow
    // may run before any locked session has booted). global: the agent config dir is
    // the live CLAUDE_CONFIG_DIR — already present, just write into it.
    const configDir = a.scope === "global" ? agentConfigDir() : ensureInitiatorConfigDir(a.userId);
    writeEntry(configDir, a.serverName, a.serverConfig, tokens);
    agent.noteSessionEvent(a.sessionId, `Connected MCP server \`${a.serverName}\`${a.scope === "global" ? " (agent's shared identity)" : ""}.`);
    agent.reload(a.sessionId);
  }

  // Build a Surface for the connect channel/thread so the OAuth flow talks to
  // whatever platform the session is on (Slack, sim, …) instead of hard-coding the
  // Slack client. The connect flow may run outside a live turn (button click /
  // pre-session global connect), so we mint a binding from the ids in hand;
  // requestApproval/reloadSession aren't used by reply/edit.
  const connectSurface = (channelId: string, threadTs: string, userId: string): Surface =>
    surfaceFactory({
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

  async function connectServer(a: { sessionId: string; channelId: string; threadTs: string; userId: string; serverName: string; serverCfg: any; scope: ConnectScope }) {
    const surface = connectSurface(a.channelId, a.threadTs, a.userId);
    const post = (text: string) => surface.reply({ text });
    const serverConfig: OAuthServerConfig = { type: "http", url: a.serverCfg.url, headers: a.serverCfg.headers };
    const redirectUrl = env.oauthRedirectUrl();

    // Paste-back mode (k8s / remote): the loopback isn't reachable, so register the
    // operator's fixed redirect page, post the authorize URL, and park a pending
    // flow the initiator completes by pasting the callback back into the thread.
    // The injectable `oauthConnect` stub forces loopback semantics, so paste mode
    // is gated on the redirect URL being set AND no loopback stub being supplied.
    if (redirectUrl && !opts.oauthConnect) {
      try {
        const prepared = await runPrepare({ serverName: a.serverName, serverConfig, redirectUri: redirectUrl });
        const { ref } = await post(
          `:link: Authorize \`${a.serverName}\`:\n${prepared.authorizeUrl}\n\n` +
            `After you approve, the page will show a code. *Paste the full redirect URL (or just the code) back here in this thread* to finish.`,
        );
        pendingPaste.set(pasteKey(a.channelId, a.threadTs, a.userId), {
          state: prepared.state,
          exchange: prepared.exchange,
          serverName: a.serverName,
          serverConfig,
          sessionId: a.sessionId, channelId: a.channelId, threadTs: a.threadTs, userId: a.userId,
          scope: a.scope,
          authMsgRef: ref,
          expiresAt: Date.now() + 10 * 60_000,
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
      await persistTokens({ sessionId: a.sessionId, userId: a.userId, serverName: a.serverName, serverConfig, scope: a.scope }, tokens);
      await redactAuthMessage(surface, authMsgRef, a.serverName);
      await post(`:white_check_mark: \`${a.serverName}\` connected. Next message will use it.`);
    } catch (e) {
      await redactAuthMessage(surface, authMsgRef, a.serverName);
      await post(`:x: \`${a.serverName}\` connect failed: ${(e as Error).message}`);
    }
  }

  /** Complete a parked paste-back flow once the initiator pastes the callback. */
  async function completePaste(pend: PendingPaste, code: string, state?: string): Promise<void> {
    const surface = connectSurface(pend.channelId, pend.threadTs, pend.userId);
    const post = (text: string) => surface.reply({ text });
    if (state && state !== pend.state) {
      // Not terminal — the initiator can paste the right URL; leave the link intact.
      await post(":x: OAuth `state` mismatch — paste the URL from the same authorize step, or rerun `/mcp connect`.");
      return;
    }
    try {
      const tokens = await pend.exchange(code);
      await persistTokens(pend, tokens);
      await redactAuthMessage(surface, pend.authMsgRef, pend.serverName);
      await post(`:white_check_mark: \`${pend.serverName}\` connected. Next message will use it.`);
    } catch (e) {
      await redactAuthMessage(surface, pend.authMsgRef, pend.serverName);
      await post(`:x: \`${pend.serverName}\` connect failed: ${(e as Error).message}`);
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
    const lock = OneOnOne.find(ctx.channel, threadTs);
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
    const httpServers = httpExternalServers();
    const cfg = httpServers[serverName];
    if (!cfg) {
      const names = Object.keys(httpServers);
      return `unknown MCP server \`${serverName}\`.` +
        (names.length ? ` Connectable: ${names.map((n) => `\`${n}\``).join(", ")}.` : " None are configured.");
    }
    void connectServer({ sessionId, channelId: ctx.channel, threadTs, userId: userId, serverName, serverCfg: cfg, scope })
      .catch(() => { /* connectServer posts its own failure out-of-band */ });
    return `Started authorizing \`${serverName}\` — I've posted the authorization link in this thread. Open it to approve; I'll confirm here once it's connected. You won't need to paste anything back.`;
  }

  // Agent-facing 1on1 toggle — same engine as the /1on1 command (lock to the current
  // speaker + session reboot). No gating, matching the slash command: anyone who can
  // chat can start/release it.
  async function agentOneOnOne(sessionId: string, ctx: SlackContext, active: boolean): Promise<string> {
    const userId = ctx.userId ?? "";
    const threadTs = ctx.threadTs ?? ctx.inboundTs ?? "";
    if (active) {
      OneOnOne.lock({ channelId: ctx.channel, threadTs, lockedUser: userId, createdBy: userId });
      agent.reload(sessionId); // reboot so the resolver + session-mode block pick it up
      return `Locked this thread to a 1on1 with <@${userId}> — only they and the manager are heard here now.`;
    }
    if (!OneOnOne.find(ctx.channel, threadTs)) return "No active 1on1 in this thread — nothing to release.";
    OneOnOne.unlock(ctx.channel, threadTs);
    agent.reload(sessionId);
    return "Released 1on1 — the thread is open again.";
  }

  // Agent-facing mention-only toggle — same engine as /mention-only. No reboot: it's
  // a receive-time routing flag, not session-baked. No gating.
  async function agentMentionOnly(ctx: SlackContext, active: boolean): Promise<string> {
    const threadTs = ctx.threadTs ?? ctx.inboundTs ?? "";
    if (active) {
      MentionOnly.set({ channelId: ctx.channel, threadTs, createdBy: ctx.userId ?? "" });
      return "Mention-only on — I'll reply in this thread only when @-mentioned.";
    }
    if (!MentionOnly.find(ctx.channel, threadTs)) return "This thread isn't in mention-only mode — nothing to change.";
    MentionOnly.clear(ctx.channel, threadTs);
    return "Mention-only off — I'll follow this thread normally again.";
  }

  t.action(/^slaude_mcp:connect:.+$/, async ({ ack, action, body }) => {
    await ack();
    const token = (action as { action_id: string }).action_id.replace(/^slaude_mcp:connect:/, "");
    const ctx = pendingMcp.get(token);
    if (!ctx) return;
    // Slack shows the button to everyone in the thread. The clicker must be the user
    // who originally requested the card, and still authorized for the card's scope:
    //   initiator → they must still own the /1on1 lock (bystanders can't drive an
    //               initiator's OAuth grant; a dropped lock invalidates the card).
    //   global    → no lock, and they must still be the manager/backup.
    const clicker = (body as any).user?.id;
    if (clicker !== ctx.userId) return;
    if (ctx.scope === "initiator") {
      const lock = OneOnOne.find(ctx.channelId, ctx.threadTs);
      if (!lock || lock.locked_user !== ctx.userId) return;
    } else {
      if (OneOnOne.find(ctx.channelId, ctx.threadTs)) return; // a lock appeared — global no longer applies
      const soul = soulData();
      if (ctx.userId !== soul.manager.userId && ctx.userId !== soul.backupManager.userId) return;
    }
    pendingMcp.delete(token);
    const cfg = httpExternalServers()[ctx.serverName];
    if (!cfg) return;
    await connectServer({ ...ctx, serverCfg: cfg });
  });

  agent.on("event", (e: AgentEvent) => {
    console.log(`[agent-evt] ${e.type} session=${e.sessionId}${"tool" in e ? ` tool=${e.tool}` : ""}${"error" in e ? ` err=${e.error}` : ""}`);
    const route = routes.get(e.sessionId);
    if (!route) return;

    switch (e.type) {
      case "toolCall": {
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
        if (userVisible) {
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
          void status.set(
            e.sessionId,
            route.ctx.channel,
            route.ctx.threadTs,
            humanizeToolStatus(e.tool, e.input as any),
          );
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
        void (async () => {
          // Suppressed (disengaged) turns set no 👀/status and must not stamp a
          // ✅ on the recorded-but-unprocessed message. Nothing to clean up.
          if (route.suppress) return;
          // Auto-evolve turns are internal — don't reset reactions/presence
          // (they were already finalized on the user-visible turn's done).
          if (e.autoEvolve) return;
          // Stamp the todo message "all done" when every task completed.
          if (route.todoRef && route.todosSnapshot?.length &&
              route.todosSnapshot.every((t) => t.status === "completed") &&
              route.surface.capabilities.has("edit") && route.surface.edit) {
            const doneText = `**Tasks** ✅\n${route.todosSnapshot.map((t) => `✅ ${t.content}`).join("\n")}`;
            await route.surface.edit({ ref: route.todoRef, text: doneText }).catch(() => {});
          }
          // Stamp the structured task block "all done" when every task is completed/deleted.
          if (route.tasksRef && route.tasksMap?.size &&
              [...route.tasksMap.values()].every((t) => t.status === "completed" || t.status === "deleted") &&
              route.surface.capabilities.has("edit") && route.surface.edit) {
            const completedTasks = [...route.tasksMap.values()].filter((t) => t.status === "completed");
            const doneText = `**Tasks** ✅\n${completedTasks.map((t) => `✅ ${t.subject}${t.completedAt ? ` _(${t.completedAt})_` : ""}`).join("\n")}`;
            await route.surface.edit({ ref: route.tasksRef, text: doneText }).catch(() => {});
          }
          route.tasksRef = undefined;
          route.tasksMap = undefined;
          // No fallback notice: setStopGuard above forces a reply via the SDK
          // Stop hook. If the agent still stops without spoke, manager logs
          // to stderr — surfacing a Slack message here would be redundant.
          await reactions.set(e.sessionId, route.ctx.channel, route.ctx.inboundTs, REACT_DONE);
          reactions.forget(e.sessionId);
          presence.exit(e.sessionId);
          await status.clear(e.sessionId);
        })();
        break;
      }
      case "error": {
        void (async () => {
          try {
            await t.client.chat.postMessage({
              channel: route.ctx.channel,
              thread_ts: route.ctx.threadTs,
              text: `:warning: error: \`${e.error}\``,
              mrkdwn: true,
            });
          } catch {}
          await reactions.set(e.sessionId, route.ctx.channel, route.ctx.inboundTs, REACT_ERROR);
          reactions.forget(e.sessionId);
          presence.exit(e.sessionId);
          await status.clear(e.sessionId);
        })();
        break;
      }
      case "compacting": {
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

  async function handleMessage(args: any, dispatch?: { suppress?: boolean }) {
    const suppress = dispatch?.suppress === true;
    const { event, client, context } = args;
    const teamId: string | undefined = context.teamId ?? event.team;
    const channelId: string = event.channel;
    const userId: string | undefined = event.user;
    const eventTs: string = event.ts;
    const text: string = (event.text || "").trim();
    const channelType: string = event.channel_type ?? "";

    console.log(
      `[slack-rx] type=${event.type} subtype=${event.subtype ?? "-"} ch=${channelId} ts=${eventTs} thread=${event.thread_ts ?? "-"} user=${userId} txt=${JSON.stringify(text.slice(0, 80))}`,
    );

    if (!teamId || !userId) return;
    // Drop only self-echoes; other bots' messages flow through so slaude can
    // see CI alerts, summarizer bots, etc. in shared threads.
    const selfBotId = await getSelfBotId();
    if (event.bot_id && selfBotId && event.bot_id === selfBotId) {
      console.log(`[slack-rx] drop ch=${channelId} ts=${eventTs} — self bot echo`);
      metric.slackDropsTotal.inc({ reason: "self_bot" });
      return;
    }
    // Self-echo when posting as a real user (xoxp): own posts carry our user id
    // and no bot_id. Drop them to avoid re-ingesting our own output.
    const selfUserId = await getSelfUserId();
    if (selfUserId && userId === selfUserId) {
      console.log(`[slack-rx] drop ch=${channelId} ts=${eventTs} — self user echo`);
      metric.slackDropsTotal.inc({ reason: "self_user" });
      return;
    }

    // Dedup
    const dedupKey = `${channelId}:${eventTs}`;
    if (seenEvents.has(dedupKey)) {
      console.log(`[slack-rx] drop ch=${channelId} ts=${eventTs} — dedup (already seen)`);
      metric.slackDropsTotal.inc({ reason: "dedup" });
      return;
    }
    seenEvents.add(dedupKey);

    const isDM = channelType === "im";
    const threadTs: string = event.thread_ts || (isDM ? eventTs : eventTs);

    // Ignore gate: temp/permanent ignores for users or threads. /unignore* must
    // bypass it — otherwise a thread-ignore drops the very message meant to lift it
    // (the /unignore-thread is in the ignored thread), and the thread is stuck
    // ignored forever. The blocklist + channel-mode gates below still apply, so this
    // doesn't grant a non-allowed user any new reach.
    {
      // botUserId isn't resolved yet here; strip any leading user-mention so a
      // "<@bot> /unignore-thread" still parses.
      const peek = parseSlashCommand(text.replace(/<@[^>]+>/g, "").trim());
      const isUnignore = peek?.kind === "unignore";
      if (!isUnignore && ignoreGate.shouldDrop(userId, channelId, threadTs)) {
        console.log(`[slack-rx] drop ch=${channelId} user=${userId} thread=${threadTs} — ignored`);
        metric.slackDropsTotal.inc({ reason: "ignored" });
        return;
      }
    }

    // Hard blocklist: blocked user → drop before any further processing.
    // Never reaches Claude (no token spend, no logs). Channel blocking is
    // unnecessary — default posture already denies anywhere not allowed/trusted.
    {
      const soul = soulData();
      if (soul.blockedUsers.includes(userId)) {
        console.log(`[slack-rx] drop ch=${channelId} user=${userId} — blocked user`);
        metric.slackDropsTotal.inc({ reason: "blocked_user" });
        return;
      }
    }

    // Channel-mode gate, driven entirely by SOUL.md:
    //   - trusted channel → team zone, anyone can address slaude (most open)
    //   - allowed channel  → public zone, anyone can address slaude (mind exposure)
    //   - DM or unlisted   → manager-only (approvers can still click Approve /
    //     Deny on request_approval blocks but cannot chat)
    {
      const soul = soulData();
      const isDM_ = channelType === "im";
      const isTrusted = !isDM_ && soul.trustedChannels.includes(channelId);
      const isAllowed = !isDM_ && soul.allowedChannels.includes(channelId);
      const publicZone = isTrusted || isAllowed;
      if (!publicZone) {
        const managerId = soul.manager.userId;
        const backupId = soul.backupManager.userId;
        // Whitelisted DM users may engage in 1:1 DMs (not in non-whitelisted
        // channels) on top of manager/backup. Grants chat only — admin commands
        // still gate on manager/backup/approver below.
        const dmAllowed = isDM_ && soul.dmAllowedUsers.includes(userId);
        const allowed = (managerId && userId === managerId) || (backupId && userId === backupId) || dmAllowed;
        if (!allowed) {
          console.log(
            `[slack-rx] drop ch=${channelId} user=${userId} — non-whitelist/DM accepts manager/backup${isDM_ ? "/dm-allowlist" : ""} only` +
              (managerId ? "" : " (no manager set in SOUL.md)"),
          );
          metric.slackDropsTotal.inc({ reason: "whitelist" });
          return;
        }
      }
    }

    // 1on1 lock: while active, only the locked user + manager/backup are heard in
    // this thread. After channel-mode (overrides "anyone can chat" in trusted/allowed
    // channels) and before slash parsing (a non-allowed user can't /1on1 off to hijack
    // someone else's lock). Approval buttons are unaffected — they go through
    // ApprovalGate's action handler, not this path.
    {
      const lock = OneOnOne.find(channelId, threadTs);
      if (lock) {
        const soul = soulData();
        const isMgr = userId === soul.manager.userId || userId === soul.backupManager.userId;
        if (userId !== lock.locked_user && !isMgr) {
          console.log(`[slack-rx] drop ch=${channelId} user=${userId} thread=${threadTs} — 1on1 locked to ${lock.locked_user}`);
          metric.slackDropsTotal.inc({ reason: "one_on_one" });
          return;
        }
      }
    }

    const botUserId = (await client.auth.test()).user_id as string;
    const stripped = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
    const hasFiles = Array.isArray(event.files) && event.files.length > 0;
    if (!stripped && !hasFiles) return;

    const session = agent.ensureSession({
      team_id: teamId,
      channel_id: channelId,
      thread_ts: threadTs,
    });

    // Paste-back OAuth completion: if this user has a parked /mcp connect in this
    // thread and the message carries the callback (URL or bare code), finish the flow
    // here and do NOT forward to the model. The binding is the pendingPaste key
    // (channel:thread:userId) on the signed inbound userId — a bystander's paste maps
    // to a different key and finds no entry. (Holds for both initiator and global
    // scope; global has no lock, so the key, not the lock, is what binds.)
    {
      const pkey = pasteKey(channelId, threadTs, userId);
      const pend = pendingPaste.get(pkey);
      if (pend) {
        if (Date.now() > pend.expiresAt) {
          pendingPaste.delete(pkey);
        } else {
          const parsed = parseOAuthCallback(stripped);
          if (parsed.code) {
            pendingPaste.delete(pkey);
            await completePaste(pend, parsed.code, parsed.state);
            return;
          }
        }
      }
    }

    // Slash commands: /mode, /abort, /help. Handled locally; do not forward to model.
    const slash = parseSlashCommand(stripped);
    if (slash) {
      const reply = async (txt: string) => {
        await client.chat.postMessage({
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
      if (slash.kind === "one-on-one") {
        if (slash.action === "on") {
          OneOnOne.lock({ channelId, threadTs, lockedUser: userId, createdBy: userId });
          agent.reload(session.id);   // reboot so the resolver clears private services next turn
          await reply(`:lock: *1on1 mode* — only <@${userId}> and the manager will be heard in this thread. \`/1on1 off\` to release.`);
          return;
        }
        const existing = OneOnOne.find(channelId, threadTs);
        if (!existing) {
          await reply("No active 1on1 in this thread.");
          return;
        }
        OneOnOne.unlock(channelId, threadTs);
        agent.reload(session.id);     // reboot so the resolver restores agent-cred mounts next turn
        await reply(":unlock: 1on1 released — the thread is open again.");
        return;
      }
      if (slash.kind === "mention-only") {
        if (slash.action === "on") {
          MentionOnly.set({ channelId, threadTs, createdBy: userId });
          await reply(":speech_balloon: *mention-only* — I'll reply in this thread only when @-mentioned. `/mention-only off` to restore.");
          return;
        }
        if (!MentionOnly.find(channelId, threadTs)) {
          await reply("This thread isn't in mention-only mode.");
          return;
        }
        MentionOnly.clear(channelId, threadTs);
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
          const res = mutateOverride(
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
          if (slash.field === "all") SoulOverrides.clear();
          else SoulOverrides.clear(FIELD_ALIASES[slash.field]);
          agent.noteSessionEvent(session.id, `Soul ACL overrides cleared (\`${slash.field}\`) — reverted to SOUL.md.`);
          await reply(`:leftwards_arrow_with_hook: soul overrides cleared (\`${slash.field}\`) — reverted to SOUL.md.`);
          return;
        }
        // soul-list: provenance — SOUL.md base vs runtime overlay.
        const base = soulDataBase();
        const rows = SoulOverrides.list();
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
      if (slash.kind === "mcp") {
        // Two scopes:
        //   inside a /1on1 lock → "initiator": the connect writes into THIS user's
        //     isolated config home, so it must be their own lock.
        //   no lock → "global": the connect writes into the agent's own config dir,
        //     wiring the agent's shared identity — manager/backup only.
        const lock = OneOnOne.find(channelId, threadTs);
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
        const httpServers = httpExternalServers();

        if (slash.action === "connect") {
          const name = slash.server;
          if (!name || !httpServers[name]) {
            await reply(`:warning: unknown HTTP MCP server \`${name ?? ""}\`. Run \`/mcp\` to list connectable servers.`);
            return;
          }
          await connectServer({ sessionId: session.id, channelId, threadTs, userId, serverName: name, serverCfg: httpServers[name], scope });
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
          const configDir = scope === "global" ? agentConfigDir() : ensureInitiatorConfigDir(userId);
          // Reconstruct the SAME OAuthServerConfig shape connectServer wrote with
          // ({type:"http", url, headers}) — httpExternalServers drops `type`, so
          // passing its bare {url,headers} would compute a different oauthKey and
          // never match the stored grant.
          const cfg: OAuthServerConfig = { type: "http", url: httpServers[name]!.url, headers: httpServers[name]!.headers };
          const removed = removeEntry(configDir, name, cfg);
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
          const elements = connectable.map((s) => {
            const token = randomBytes(8).toString("hex");
            pendingMcp.set(token, { sessionId: session.id, channelId, threadTs, userId, serverName: s.name, scope });
            return {
              type: "button",
              text: { type: "plain_text", text: `Connect ${s.name}` },
              action_id: `slaude_mcp:connect:${token}`,
            };
          });
          blocks.push({ type: "actions", elements });
        }
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: "MCP servers", mrkdwn: true });
        return;
      }
      if (slash.kind === "ignore" || slash.kind === "unignore") {
        // Authorization: manager or approver only
        const soul = soulData();
        const managerId = soul.manager.userId;
        const backupId = soul.backupManager.userId;
        const isManager = (managerId && userId === managerId) || (backupId && userId === backupId);
        const isApprover = soul.approvers.some((a) => a.userId === userId);
        if (!isManager && !isApprover) {
          await reply(":no_entry: only manager or approver can manage ignores");
          return;
        }

        if (slash.kind === "ignore") {
          if (slash.target === "user") {
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
            Ignores.remove({ targetType: "user", userId: slash.userId });
            Ignores.create({ targetType: "user", userId: slash.userId, createdBy: userId, expiresAt, reason: "manual" });
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
            Ignores.remove({ targetType: "thread", channelId, threadTs });
            Ignores.create({ targetType: "thread", channelId, threadTs, createdBy: userId, expiresAt, reason: "manual" });
            const durText = duration ? `for ${duration}` : "permanently";
            await reply(`:mute: ignoring this thread ${durText}`);
          }
          return;
        }

        if (slash.kind === "unignore") {
          if (slash.target === "user") {
            Ignores.remove({ targetType: "user", userId: slash.userId });
            await reply(`:speaker: stopped ignoring <@${slash.userId}>`);
          } else {
            Ignores.remove({ targetType: "thread", channelId, threadTs });
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
        const findJob = (id: string) => {
          try {
            return CronJobs.findByPrefix(id);
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
          const jobs = CronJobs.listActive();
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
          const job = findJob(slash.id);
          if (typeof job === "string") {
            await reply(`:warning: ${job}`);
            return;
          }
          if (!job) {
            await reply(`:warning: cron job \`${slash.id}\` not found`);
            return;
          }
          CronJobs.deactivate(job.id);
          agent.noteSessionEvent(session.id, `Removed scheduled cron job \`${job.id.slice(0, 8)}\`.`);
          await reply(`:wastebasket: cron job \`${job.id.slice(0, 8)}\` removed`);
          return;
        }

        if (slash.kind === "cron-pause" || slash.kind === "cron-resume") {
          if (!isManager && !isApprover) {
            await reply(`:no_entry: only manager or approver can ${slash.kind.replace("cron-", "")} cron jobs`);
            return;
          }
          const job = findJob(slash.id);
          if (typeof job === "string") {
            await reply(`:warning: ${job}`);
            return;
          }
          if (!job) {
            await reply(`:warning: cron job \`${slash.id}\` not found`);
            return;
          }
          if (slash.kind === "cron-pause") {
            CronJobs.pause(job.id);
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
          CronJobs.resume(job.id, nextRun);
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
              risks: "Changes unattended scheduled agent execution.",
            });
            if (!approval.approved) return void (await reply(":x: cron edit denied by manager"));
          }
          const job = findJob(slash.id);
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
          CronJobs.update(job.id, {
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
          const cronLock = OneOnOne.find(channelId, threadTs);
          const job = CronJobs.create({
            slackTeamId: teamId,
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
        if (!slash.id) {
          try {
            const models = await listModels();
            const lines = models.map((m) => `• \`${m.id}\``).join("\n") || "_none returned_";
            await reply(`*available models*\n${lines}\n\ncurrent: \`${session.model}\``);
          } catch {
            await reply(`can't fetch model list from provider. current: \`${session.model}\``);
          }
          return;
        }
        let verified = false;
        try {
          verified = (await listModels()).some((m) => m.id === slash.id);
        } catch {
          // provider has no /v1/models (non-Anthropic gateway) — pass through.
        }
        await agent.setSessionModel(session.id, slash.id);
        agent.noteSessionEvent(session.id, `Model changed to \`${slash.id}\`.`);
        await reply(
          verified
            ? `model → \`${slash.id}\``
            : `model → \`${slash.id}\` :warning: couldn't verify against provider`,
        );
        return;
      }
    }

    let userText = stripped;
    const skillHit = matchSkillInvocation(stripped, discoverSkills());
    if (skillHit) {
      userText = buildSkillInvocation(skillHit.skill, skillHit.args, session.id);
    }

    // Resolve username and download any file attachments into the session dir.
    const [userName, files] = await Promise.all([
      resolveUserName(client, userId),
      downloadAttachments({
        files: ((event.files ?? []) as SlackFile[]),
        botToken: env.slack.botToken(),
        workingDir: session.working_dir,
        inboundTs: eventTs,
      }),
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
    // and a clear directive to reply via the MCP tool — not as plain text.
    const oneOnOneLock = OneOnOne.find(channelId, threadTs);
    const oneOnOneAttr = oneOnOneLock
      ? ` one_on_one="true" locked_user="<@${oneOnOneLock.locked_user}>"`
      : "";
    const envelope =
      `<channel source="slack" channel_id="${channelId}" thread_ts="${threadTs}" ` +
      `inbound_ts="${eventTs}" user_id="${userId}" user_name="${escapeAttr(userName)}" ` +
      `trust="${trust}"${oneOnOneAttr}>\n` +
      `${userText}${attachmentBlock}\n</channel>\n\n` +
      (files.length
        ? `User attached ${files.length} file(s); paths above are local — Read them directly.\n`
        : "") +
      (suppress
        ? `You are currently disengaged from this thread, so this message is recorded ` +
          `for context only — do NOT reply to it. You will catch up on it when re-engaged.`
        : `Reply to the user by calling the \`mcp__${SLACK_MCP_NAME}__reply\` tool. ` +
          `Plain assistant text is not delivered to Slack — only tool calls reach the user.`);

    if (!suppress) {
      // 👀 received
      void reactions.set(session.id, channelId, eventTs, REACT_RECEIVED);
      presence.enter(session.id, STATUS_THINKING);
      void status.set(session.id, channelId, threadTs, "thinking…");
    }
    permissions.bindSession(session.id, channelId, threadTs);

    // First turn for this session → seed the SlackContext + route.
    // Subsequent turns → mutate the existing context so the bound MCP tools
    // keep targeting the right thread / inbound message.
    const existing = routes.get(session.id);
    if (existing) {
      existing.ctx.channel = channelId;
      existing.ctx.threadTs = threadTs;
      existing.ctx.inboundTs = eventTs;
      existing.ctx.userId = userId;
      existing.ctx.reloadSession = () => agent.reload(session.id);
      existing.spoke = false;
      existing.todoRef = undefined;       // fresh tracker per user turn
      existing.todosSnapshot = undefined;
      existing.pendingTaskCreate = undefined;
      // tasksRef/tasksMap are cleared in the done handler so mid-turn inbound
      // messages don't wipe in-flight task state from the previous turn.
      existing.suppress = suppress;
    } else {
      const ctx: SlackContext = {
        client: outClient,
        channel: channelId,
        threadTs,
        inboundTs: eventTs,
        userId,
        teamId,
      };
      ctx.requestApproval = (req) =>
        approvals.request({
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          ...req,
        });
      ctx.reloadSession = () => agent.reload(session.id);
      routes.set(session.id, { ctx, surface: surfaceFactory(bindingFor(ctx)), spoke: false, suppress });
    }

    console.log(`[slaude] sendMessage session=${session.id} cwd=${session.working_dir} model=${session.model}`);
    try {
      await agent.sendMessage(session.id, envelope);
    } catch (e: any) {
      console.error("[slaude] sendMessage threw:", e?.message ?? e, e?.stack);
    }
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
  // The Set is a hot cache only — engagement is persisted on the session row
  // (sessions.engaged). Without persistence a disengage lasted zero messages:
  // every engaged thread has a session row, so the next plain reply fell
  // through to the restore path and re-engaged (restarts had the same effect).
  const engaged = new Set<string>(); // key: `${channel}:${thread_ts}`
  const threadKey = (channel: string, ts: string) => `${channel}:${ts}`;
  const persistEngaged = (teamId: string | undefined, channelId: string, threadTs: string, value: boolean) => {
    if (!teamId) return;
    const row = Sessions.findByThread({ team_id: teamId, channel_id: channelId, thread_ts: threadTs });
    if (row) Sessions.setEngaged(row.id, value);
  };

  let cachedBotId: string | null = null;
  let cachedSelfBotId: string | null = null;
  const getBotId = async () => {
    if (cachedBotId) return cachedBotId;
    const res = await t.client.auth.test();
    cachedBotId = res.user_id as string;
    cachedSelfBotId = (res as any).bot_id as string;
    return cachedBotId;
  };
  const getSelfBotId = async () => {
    if (cachedSelfBotId) return cachedSelfBotId;
    await getBotId();
    return cachedSelfBotId;
  };

  // When posting as a real user (xoxp), the agent's own messages arrive as plain
  // `message` events with NO `bot_id` — the bot-id self-filter misses them and we
  // would re-ingest our own output (infinite loop). Resolve the user-token's own
  // user id once and drop events authored by it. Null when posting as bot (the
  // bot_id filter already covers self-echoes there).
  let cachedSelfUserId: string | null = null;
  let selfUserIdResolved = false;
  const getSelfUserId = async (): Promise<string | null> => {
    if (selfUserIdResolved) return cachedSelfUserId;
    if (!postsAsUser) {
      selfUserIdResolved = true;
      return null;
    }
    try {
      const res = await outClient.auth.test();
      cachedSelfUserId = (res as any).user_id as string;
    } catch (e: any) {
      console.error("[slack-out] auth.test on user token failed:", e?.data?.error ?? e?.message);
      cachedSelfUserId = null;
    }
    selfUserIdResolved = true;
    return cachedSelfUserId;
  };

  // app_mention is a guaranteed delivery path even if message.channels event
  // subscription isn't enabled. Engage the thread, then defer to handleMessage.
  // (handleMessage's seenEvents dedup prevents double-handling when the same
  //  ts also arrives via the message event.)
  t.event("app_mention", async (args: any) => {
    const e: any = args.event;
    const ts: string = e.thread_ts || e.ts;
    engaged.add(threadKey(e.channel, ts));
    persistEngaged(args.context?.teamId ?? e.team, e.channel, ts, true);
    await handleMessage(args);
  });

  // Single message router: every non-bot message goes here so we can manage
  // engagement state consistently. We dispatch to handleMessage when slaude
  // should answer.
  t.event("message", async (args: any) => {
    const e: any = args.event;
    // Drop only self bot-echoes; other bots flow through.
    const selfBotId = await getSelfBotId();
    if (e.bot_id && selfBotId && e.bot_id === selfBotId) return;
    if (!e.user) return;
    // Drop self-echoes when posting as a real user (xoxp): own posts carry our
    // user id and no bot_id, so they'd otherwise drive engagement/disengagement.
    const selfUserId = await getSelfUserId();
    if (selfUserId && e.user === selfUserId) {
      metric.slackDropsTotal.inc({ reason: "self_user" });
      return;
    }

    const channelId: string = e.channel;
    const ts: string = e.thread_ts || e.ts;
    const key = threadKey(channelId, ts);
    const text: string = (e.text || "").toString();
    const botId = await getBotId();

    // DMs: always handle, no engagement tracking needed.
    if (e.channel_type === "im") {
      engaged.add(key);
      return await handleMessage(args);
    }

    const mentions = Array.from(text.matchAll(/<@([A-Z0-9]+)>/g)).map((m) => m[1]);
    const mentionsBot = mentions.includes(botId);
    const mentionsOther = mentions.some((u) => u && u !== botId);

    const teamId: string | undefined = args.context?.teamId ?? e.team;
    if (mentionsBot) {
      engaged.add(key);
      persistEngaged(teamId, channelId, ts, true);
      return await handleMessage(args);
    }
    if (mentionsOther) {
      engaged.delete(key);
      persistEngaged(teamId, channelId, ts, false);
      // Don't drop: if slaude has a session here, record the disengaging message
      // into the transcript (suppressed — the UserPromptSubmit hook halts the turn
      // before the model runs) so the session stays populated. On re-engage the
      // model resumes with the gap already in history. No session → nothing to
      // populate, so drop as before (never spin one up for an unrelated thread).
      const row = teamId
        ? Sessions.findByThread({ team_id: teamId, channel_id: channelId, thread_ts: ts })
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
    const mentionOnly = MentionOnly.find(channelId, ts) != null;
    if (mentionOnly) {
      const row = teamId
        ? Sessions.findByThread({ team_id: teamId, channel_id: channelId, thread_ts: ts })
        : null;
      if (row) {
        console.log(`[slack-rx] record ch=${channelId} ts=${e.ts} user=${e.user} — mention-only, suppressed`);
        return await handleMessage(args, { suppress: true });
      }
      console.log(`[slack-rx] drop ch=${channelId} ts=${e.ts} user=${e.user} — mention-only, no @mention`);
      metric.slackDropsTotal.inc({ reason: "mention_only" });
      return;
    }
    if (engaged.has(key)) {
      return await handleMessage(args);
    }
    // Restore engagement across restarts: a session row means the bot was
    // engaged here historically — keep handling plain replies without forcing
    // a re-@mention, unless the thread was explicitly disengaged (row.engaged=0).
    if (teamId) {
      const row = Sessions.findByThread({ team_id: teamId, channel_id: channelId, thread_ts: ts });
      if (row && row.engaged) {
        engaged.add(key);
        return await handleMessage(args);
      }
      // Explicitly disengaged (row.engaged=0): record plain messages into the
      // transcript too (suppressed by the hook) so the session stays populated
      // for re-engage. No model run, no Slack feedback.
      if (row && row.engaged === 0) {
        console.log(
          `[slack-rx] record ch=${channelId} ts=${e.ts} user=${e.user} — disengaged thread, suppressed`,
        );
        return await handleMessage(args, { suppress: true });
      }
    }
    console.log(
      `[slack-rx] drop ch=${channelId} ts=${e.ts} user=${e.user} — channel msg, thread not engaged (no @mention)`,
    );
    metric.slackDropsTotal.inc({ reason: "engagement" });
  });

  return {
    start: () => t.start(),
    stop: () => t.stop(),
    __sessionCtx: (sessionId: string) => sessionCtx.get(sessionId),
    __resolveMcp: (sessionId: string) => mcpResolver(sessionId),
    __agentConnect: (sessionId: string, server: string) => {
      const route = routes.get(sessionId);
      if (!route) return Promise.resolve("no active thread for this session");
      return agentConnect(sessionId, route.ctx, server);
    },
    __agentOneOnOne: (sessionId: string, active: boolean) => {
      const route = routes.get(sessionId);
      if (!route) return Promise.resolve("no active thread for this session");
      return agentOneOnOne(sessionId, route.ctx, active);
    },
    __agentMentionOnly: (sessionId: string, active: boolean) => {
      const route = routes.get(sessionId);
      if (!route) return Promise.resolve("no active thread for this session");
      return agentMentionOnly(route.ctx, active);
    },
  };
}
