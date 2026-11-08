import { clientForApp, type AppRef, type Transport } from "../core/transport";
import type {
  CanUseTool,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { env } from "../../config/env";
import * as PendingGates from "../../db/pending-gates";
import { defaultGateBus, type GateBus } from "../../queue/gate-bus";
import { voiceStartProblem } from "../../agent/voice-mcp";
import { matchAudioOrigin, type AudioPolicy } from "../../voice/audio-acl";
import { audioPolicyFromEnv } from "../../voice/config";
import { redactTree } from "../../redact";
import { auditGateRow } from "../../audit/emit";
import * as OneOnOne from "../../db/one-on-one";
import { canDecidePermission } from "../../access/permission-auth";
import type { TurnOrigin } from "../../knowledge/gated-dispatch";
import type { PermissionContext } from "../../agent/manager";
import { memoryToolIdTwin, memoryToolTwin } from "../../tools/contracts/kb";

type PendingKey = string; // toolUseID

/** Durable-row deadline for a permission prompt. Orphans (dead process) drain
 *  via sweepExpired at this horizon; a live waiter that outlasts it is denied
 *  on the next click or torn down by the turn's abort signal. */
export const PERM_GATE_TTL_MS = 60 * 60 * 1000;
type Pending = {
  channel: string;
  threadTs: string;
  messageTs: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: Awaited<ReturnType<CanUseTool>>) => void;
  /** gate-bus unsubscribe, when a bus is configured. */
  unsub?: () => Promise<void>;
  /** The durable row as written: the click's authorisation inputs and the
   *  refusal audit read it without a DB round-trip. */
  row: Pick<PendingGates.PendingGate, "kind" | "id" | "payload" | "sessionId">;
};

/** Who started the turn a permission prompt belongs to, stamped into the
 *  `perm` row so any replica can authorise a click. */
export interface TurnStamp {
  /** Slack user who started the turn; null when no human did. */
  initiator: string | null;
  origin?: TurnOrigin;
}


const TURN_ORIGIN_SET: ReadonlySet<string> = new Set<TurnOrigin>(["slack", "panel", "cron"]);

/**
 * The stamp for a prompt from the senders of the inputs the turn is
 * processing (AgentManager.turnSenders in process, the job's recorded senders
 * on the node path), never from the route context, which every delivered
 * message rewrites. The initiator is the sole sender of a Slack message, and
 * only when there is exactly one sender and the turn is not synthetic; any
 * other case (no senders known, several people, a cron or panel input, an
 * injected turn) stamps null and needs an approver or manager. `expect`, when
 * given, must equal that sender (the job token's own initiator). `origin` is
 * recorded for the audit trail only; it never grants anything.
 */
export function stampFromSenders(
  senders: readonly { userId: string; origin: string | null }[] | null | undefined,
  opts: { synthetic?: boolean; origin?: TurnOrigin; expect?: string } = {},
): TurnStamp {
  const sole = !opts.synthetic && senders?.length === 1 ? senders[0]! : null;
  const soleOrigin = sole?.origin && TURN_ORIGIN_SET.has(sole.origin) ? (sole.origin as TurnOrigin) : undefined;
  const origin = soleOrigin ?? opts.origin;
  const ok = !!sole && sole.origin === "slack" && !!sole.userId && (opts.expect === undefined || opts.expect === sole.userId);
  return { initiator: ok ? sole!.userId : null, ...(origin ? { origin } : {}) };
}

/** The in-process stamp for `sessionId`'s running turn, read from the agent
 *  manager's per-input bookkeeping. `ctxOrigin` (the route's) is recorded
 *  only; it is rewritten by every delivered message and grants nothing. */
export function liveTurnStamp(
  agent: { turnSenders?: (sessionId: string) => readonly { userId: string; origin: string | null }[] | null; isSyntheticTurn?: (sessionId: string) => boolean },
  sessionId: string,
  ctxOrigin: TurnOrigin | undefined,
): TurnStamp {
  return stampFromSenders(typeof agent.turnSenders === "function" ? agent.turnSenders(sessionId) : null, {
    synthetic: typeof agent.isSyntheticTurn === "function" && agent.isSyntheticTurn(sessionId),
    origin: ctxOrigin,
  });
}

/** The stamp for a turn with one known sender (see stampFromSenders): only
 *  a Slack-message turn has a human initiator. A panel turn's speaker is an
 *  operator, a cron or background turn's is the job's creator, and an unknown
 *  origin is not trusted, so all of those stamp null. */
export function turnStamp(userId: string | null | undefined, origin: TurnOrigin | undefined): TurnStamp {
  return stampFromSenders(userId ? [{ userId, origin: origin ?? null }] : null, { origin });
}

/** The `initiator`/`origin` payload keys for a stamp. */
function stampPayload(stamp: TurnStamp | undefined): Record<string, unknown> {
  return { initiator: stamp?.initiator ?? null, ...(stamp?.origin ? { origin: stamp.origin } : {}) };
}

export const PERM_REFUSED_TEXT = "Only the person who asked or an approver can decide this.";

export type PermissionDecision = Awaited<ReturnType<CanUseTool>>;

/** Comma-separated SLAUDE_AUTO_ALLOW_TOOLS → set. Shared by gateway + node.
 *  A memory tool listed under either name (memory_save or its deprecated alias
 *  kb_memoize, bare or as `mcp__slaude_kb__<name>`) allows both names. */
export function autoAllowFromEnv(): Set<string> {
  const out = new Set<string>();
  for (const raw of (process.env.SLAUDE_AUTO_ALLOW_TOOLS ?? "").split(",")) {
    const name = raw.trim();
    if (!name) continue;
    out.add(name);
    const twin = memoryToolIdTwin(name) ?? memoryToolTwin(name);
    if (twin) out.add(twin);
  }
  return out;
}

const VOICE_MID_CALL_TOOLS = new Set([
  "mcp__slaude_voice__voice_say",
  "mcp__slaude_voice__voice_context",
  "mcp__slaude_voice__voice_stop",
]);

/**
 * Static permission policy — every short-circuit that never needs a human.
 * Returns the decision, or null when a prompt is required. Pure over its
 * inputs so the node-side permissionResolver applies the IDENTICAL policy
 * before spending a REST round-trip (and the gateway re-applies it on the
 * can_use_tool endpoint — defense in depth against a divergent node).
 */
export function permissionPolicy(
  toolName: string,
  input: Record<string, unknown>,
  autoAllow: Set<string>,
  /** The deployment's audio policy, where it is known (gateway, mono): an
   *  off-allowlist endpoint or a header breach is then denied before a card.
   *  null = known and off (voice disabled or no allowlist): voice_start is
   *  denied outright. undefined = not known here (a node): schema only. */
  voiceAudio?: AudioPolicy | null,
): PermissionDecision | null {
  // voice_start is validated strictly before anything else, so no card is
  // ever rendered from input the call would not run as shown.
  if (toolName === VOICE_START) {
    if (voiceAudio === null) return { behavior: "deny", message: "VOICE_DISABLED: voice mode is not configured" };
    const problem = voiceStartProblem(input, voiceAudio);
    if (problem) return { behavior: "deny", message: `${problem.code}: ${problem.message}` };
  }
  if (autoAllow.has(toolName)) {
    return { behavior: "allow", updatedInput: input };
  }
  // Hard-deny the runtime/SDK-synthesized OAuth bootstrap tools. MCP OAuth must
  // only ever start through our deterministic engine (`/mcp connect` or the
  // mcp__slaude_connect__ tool), which owns the loopback, signed-state redirect,
  // URL-safe out-of-band post, and redact-teardown. The synthesized path uses an
  // uncontrolled redirect and would launder the auth URL — never let it run, and
  // never even prompt the user to approve it.
  if (/^mcp__.+__(authenticate|complete_authentication)$/.test(toolName)) {
    return { behavior: "deny", message: "OAuth connect must go through `/mcp connect` (or ask me to connect it) — the synthesized auth tool is disabled." };
  }
  // Our own connect tool is the controlled entry point — never gate it (it only
  // posts an authorize link; nothing is granted until the user clicks + approves).
  if (toolName.startsWith("mcp__slaude_connect__")) {
    return { behavior: "allow", updatedInput: input };
  }
  // Surface (interaction) + runtime (control-plane) + the legacy slack namespace are
  // the agent's path to user output / housekeeping — never gate. Surface reply/edit/
  // upload especially MUST stay un-gated or every message would prompt for approval.
  if (
    toolName.startsWith("mcp__slaude_surface__") ||
    toolName.startsWith("mcp__slaude_runtime__") ||
    toolName.startsWith("mcp__slaude_slack__")
  ) {
    return { behavior: "allow", updatedInput: input };
  }
  // Skill introspection is read-only — auto-allow so evolution checks
  // don't spam the user. Write/delete still flow through approval.
  if (
    toolName === "mcp__slaude_skills__list_skills" ||
    toolName === "mcp__slaude_skills__read_skill"
  ) {
    return { behavior: "allow", updatedInput: input };
  }
  // Session introspection (token budget) is pure read — agent uses it to
  // decide whether to summarize and reset. Never gate.
  if (toolName.startsWith("mcp__slaude_session__")) {
    return { behavior: "allow", updatedInput: input };
  }
  // Memory tools (memory_* and their kb_* aliases): reads never card, and
  // writes that need one are carded by the gated dispatch, not here.
  if (toolName.startsWith("mcp__slaude_kb__")) {
    return { behavior: "allow", updatedInput: input };
  }
  // Mid-call voice controls. A card posted during a call would break the
  // quiet thread and stall the answer, and stopping a call must never wait on
  // a click. voice_start is NOT here: joining a meeting and capturing its
  // audio keeps the normal approval (its card is redacted by permBlocks).
  if (VOICE_MID_CALL_TOOLS.has(toolName)) {
    return { behavior: "allow", updatedInput: input };
  }
  return null;
}

/**
 * Build the "always allow" permission updates from the SDK's suggestions
 * (they encode the specific pattern, e.g. Bash(ls:*)), falling back to a
 * tool-wide session allow rule. Shared by the in-process click path and the
 * node-side long-poll mapping.
 */
export function alwaysAllowUpdates(
  toolName: string,
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  if (suggestions && suggestions.length > 0) return [...suggestions];
  return [
    {
      type: "addRules",
      rules: [{ toolName }],
      behavior: "allow",
      destination: "session",
    },
  ];
}

/** Map a settled pending_gates perm row to the SDK decision. Used by the
 *  gate-bus waiter wakeup here and by the node's long-poll resolver. */
export function decisionFromPermRow(
  row: { status: string; resolvedBy: string | null; payload: Record<string, unknown> },
  toolName: string,
  input: Record<string, unknown>,
  suggestions: PermissionUpdate[] | undefined,
): PermissionDecision {
  if (row.status === "approved") {
    // An owner guardrail's card never grants more than this call.
    const always = (row.payload as any)?.decision === "always" && !(row.payload as any)?.guardrail;
    return {
      behavior: "allow",
      updatedInput: input,
      ...(always ? { updatedPermissions: alwaysAllowUpdates(toolName, suggestions) } : {}),
    };
  }
  if (row.status === "denied") {
    return { behavior: "deny", message: `Denied by <@${row.resolvedBy ?? "unknown"}>` };
  }
  return { behavior: "deny", message: row.status === "expired" ? "expired before a decision" : "cancelled" };
}

/** Copy of `value` with secret-named keys, header values and capability URLs
 *  redacted (see redactTree). The card is posted into a shared thread. */
export function redactForCard(value: unknown): unknown {
  return redactTree(value);
}

const VOICE_START = "mcp__slaude_voice__voice_start";

/** One code point as shown literally inside the card's code fence. Slack's
 *  control characters are entity-escaped (no mention, link or ping can form),
 *  and every character that could break, reorder or hide a line (line breaks,
 *  tabs, other control characters, line/paragraph separators, format
 *  characters such as zero-width spaces and bidi overrides) is shown as a
 *  visible escape. A backslash is doubled so an escape cannot be imitated. */
function literalToken(ch: string): string {
  switch (ch) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case "\\": return "\\\\";
    case "\n": return "\\n";
    case "\r": return "\\r";
    case "\t": return "\\t";
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u.test(ch)) {
    const cp = ch.codePointAt(0)!;
    return cp > 0xffff ? `\\u{${cp.toString(16).toUpperCase()}}` : `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return ch;
}
/** `s` as visible tokens, one per code point; runs of three backticks are
 *  broken up so the fence cannot be closed. */
function literalTokens(s: string): string[] {
  const out: string[] = [];
  let ticks = 0;
  for (const ch of s) {
    ticks = ch === "`" ? ticks + 1 : 0;
    out.push(ticks >= 3 ? "\u200b`" : literalToken(ch));
    if (ticks >= 3) ticks = 1;
  }
  return out;
}
/** A single-line field shown literally. */
const cardLiteral = (s: string): string => literalTokens(s).join("");

/** Rule text on a card: Slack's control characters escaped, so it cannot mention or link. */
function escapeCardText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Three or more backticks cannot end the card's fence early. */
function unfence(s: string): string {
  return s.replace(/`{3,}/g, (run) => run.split("").join("\u200b"));
}

/** What voice_start's card needs from the deployment: the audio allowlist and
 *  the defaults a call without `voice` will use. */
export interface VoiceCardConfig {
  audio?: AudioPolicy | null;
  model?: string;
  voiceName?: string;
}
export function voiceCardConfig(): VoiceCardConfig {
  return { audio: audioPolicyFromEnv(), model: env.voice.model(), voiceName: env.voice.voiceName() };
}
/** voice_start's policy at the gate (gateway or mono, which hold the voice
 *  env): null when voice is off. Read only for voice_start. */
const gateVoiceAudio = (toolName: string): AudioPolicy | null | undefined =>
  toolName !== VOICE_START ? undefined : env.voice.enabled() ? audioPolicyFromEnv() : null;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Room for one fenced block's body under Slack's 3000-character section text. */
const CARD_BLOCK_MAX = 2900;

/**
 * voice_start's approval card, as the bodies of its fenced blocks: a
 * deterministic rendering of the exact input that will run (the approved
 * `updatedInput` is this same object, and the gate has already validated it
 * against the strict schema). It shows every field that changes behaviour and
 * hides only secrets: each capability URL as its own origin (the path holds
 * the audio session's secret), flagged when no allowlist entry matches it,
 * and route header names with values [hidden]. The
 * brief is shown whole and literally (never redacted, never truncated), one
 * prefixed line per source line, in as many blocks as Slack's limits need.
 */
export function voiceStartCard(input: Record<string, unknown>, cfg: VoiceCardConfig): string[] {
  const a = isRecord(input.audio) ? input.audio : {};
  const policy = cfg.audio ?? null;
  const lines = ["voice_start: the values below are what will run; only secrets are hidden."];
  for (const name of ["stream", "clear"] as const) {
    const u = String(a[`${name}_url`]);
    let origin = "";
    try {
      const p = new URL(u);
      if (p.protocol === "http:" || p.protocol === "https:") origin = p.origin;
    } catch {}
    if (!origin || origin === "null") lines.push(`${name}: (not an absolute URL; voice_start will refuse it)`);
    else {
      const off = policy && matchAudioOrigin(u, policy.origins) ? "" : " (not on the audio allowlist; voice_start will refuse it)";
      lines.push(`${name}: ${cardLiteral(origin)}/… (path hidden: capability secret)${off}`);
    }
  }
  lines.push(`audio allowlist: ${policy ? policy.origins.map((r) => cardLiteral(r.entry)).join(", ") : "(not configured; voice_start will refuse it)"}`);
  lines.push(`sample rate: ${a.sample_rate === undefined ? "24000 (default)" : cardLiteral(String(a.sample_rate))}`);
  if (a.format !== undefined) lines.push(`format: ${cardLiteral(String(a.format))}`);
  if (a.channels !== undefined) lines.push(`channels: ${cardLiteral(String(a.channels))}`);
  // The value is never printed: it is not used, and an id could carry a secret.
  if (a.session_id !== undefined) lines.push("session_id: (present)");
  if (a.restarted !== undefined) lines.push(`restarted: ${cardLiteral(String(a.restarted))} (informational; not used)`);
  const headerMap = isRecord(a.headers) ? a.headers : {};
  const headers = Object.keys(headerMap);
  const allowed = policy?.allowedHeaders ?? [];
  lines.push(`route headers: ${headers.length
    ? headers.map((h) => `${cardLiteral(h)}=[hidden]${allowed.includes(h.toLowerCase()) ? "" : " (not allowed; voice_start will refuse it)"}`).join(", ")
    : "(none)"}`);
  for (const req of policy?.requiredHeaders ?? []) {
    const present = Object.entries(headerMap).some(([k, v]) => k.toLowerCase() === req && typeof v === "string" && v.length > 0);
    if (!present) lines.push(`missing required route header: ${cardLiteral(req)} (voice_start will refuse it)`);
  }
  lines.push(`voice: ${typeof input.voice === "string"
    ? cardLiteral(input.voice)
    : cfg.voiceName ? `${cardLiteral(cfg.voiceName)} (configured default)` : "(provider default)"}`);
  lines.push(`model: ${cfg.model ? cardLiteral(cfg.model) : "(not configured)"} (configured; not set by the call)`);
  const blocks = [lines.join("\n")];

  const brief = typeof input.brief === "string" ? input.brief : "";
  let cur = `brief (${[...brief].length} characters, written by the agent; shown literally):`;
  const flush = () => { blocks.push(cur); cur = ""; };
  const add = (line: string) => {
    if (cur && cur.length + 1 + line.length > CARD_BLOCK_MAX) flush();
    cur = cur ? `${cur}\n${line}` : line;
  };
  for (const src of brief.split(/\r?\n|\u2028|\u2029/)) {
    // A source line too long for one block continues on "|+ " lines.
    let prefix = "| ";
    let piece = prefix;
    for (const tok of literalTokens(src)) {
      if (piece.length + tok.length > CARD_BLOCK_MAX) {
        add(piece);
        prefix = "|+ ";
        piece = prefix;
      }
      piece += tok;
    }
    add(piece);
  }
  if (cur) flush();
  return blocks;
}

/** An owner guardrail's card: the rule asks for it, and it offers no "always allow". */
export interface ForcedCard {
  /** `<slug>#<rule id>`. */
  ruleId: string;
  /** The rule's message. */
  message: string;
}

function permBlocks(toolName: string, input: Record<string, unknown>, toolUseId: string, decisionReason?: string, forced?: ForcedCard) {
  // voice_start's card is never truncated: it spans as many blocks as needed.
  const bodies = toolName === VOICE_START
    ? voiceStartCard(input, voiceCardConfig())
    : [truncate(unfence(JSON.stringify(redactForCard(input), null, 2)), 2500)];
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:lock: *Approval needed* — \`${toolName}\`` },
    },
    ...(forced
      ? [
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `Owner guardrail \`${cardLiteral(forced.ruleId)}\`: ${escapeCardText(forced.message)} Only the person who asked or an approver can decide.` }],
          },
        ]
      : decisionReason
      ? [
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `_${decisionReason}_` }],
          },
        ]
      : []),
    ...bodies.map((body) => ({
      type: "section",
      text: { type: "mrkdwn", text: "```\n" + body + "\n```" },
    })),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Allow once" },
          action_id: `slaude_perm:allow:${toolUseId}`,
        },
        ...(forced
          ? []
          : [
              {
                type: "button",
                text: { type: "plain_text", text: "Always allow" },
                action_id: `slaude_perm:always:${toolUseId}`,
              },
            ]),
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          action_id: `slaude_perm:deny:${toolUseId}`,
        },
      ],
    },
  ];
}

/**
 * Slack approval gate. When the SDK asks for a tool permission, we post a
 * Block Kit message to the active session's thread with Allow / Always /
 * Deny buttons, then resolve the SDK promise on the user's click.
 *
 * Durable state: every prompt writes a pending_gates row (kind 'perm') and a
 * click settles it through the repo's status='pending' guarded UPDATE, so a
 * duplicate or cross-replica click loses cleanly.
 *
 * Wakeups (spec §5 "Interactions across replicas"): every winning click also
 * publishes `gate:<id>` on the gate bus (when Redis is configured), so
 *   - a sibling replica holding the in-process SDK waiter delivers it, and
 *   - a node long-polling /v1/pending/:id wakes instantly.
 * Rows opened for node workers (`open()`, payload.waiter='poll') have no
 * in-process waiter anywhere — ANY replica's click settles them. Without a
 * bus, foreign in-process rows keep the conservative "pending on another
 * replica" answer, exactly as before.
 *
 * Pre-approved tools (env SLAUDE_AUTO_ALLOW_TOOLS, comma-separated) return
 * allow without prompting — useful for safe read-only ops like Read/Grep/Glob.
 */
export class PermissionGate {
  #transport: Pick<Transport, "client" | "clientFor">;
  #autoAllow: Set<string>;
  /** sessionId → channel/thread for routing the prompt. */
  #routes = new Map<string, { channel: string; threadTs: string; app?: AppRef; persona?: string }>();
  #pending = new Map<PendingKey, Pending>();
  /** Explicit bus override (tests/sim); undefined = env-driven default. */
  #busOverride: GateBus | null | undefined;
  /** The live turn of an in-process session (its route context), read when a
   *  prompt opens: the initiator is the speaker of THIS turn, never a stale one. */
  #turnOf: (sessionId: string) => TurnStamp | undefined;

  constructor(
    transport: Transport,
    opts: { gateBus?: GateBus | null; turnOf?: (sessionId: string) => TurnStamp | undefined } = {},
  ) {
    this.#transport = transport;
    this.#busOverride = opts.gateBus;
    this.#turnOf = opts.turnOf ?? (() => undefined);
    this.#autoAllow = autoAllowFromEnv();

    transport.action(
      /^slaude_perm:(allow|always|deny):.+$/,
      async ({ ack, action, body, respond }) => {
        await ack();
        const a = action as { action_id: string };
        const m = a.action_id.match(/^slaude_perm:(allow|always|deny):(.+)$/);
        if (!m) return;
        const decision = m[1] as "allow" | "always" | "deny";
        const toolUseId = m[2]!;
        const clicker = (body as any).user?.id;
        if (typeof clicker !== "string" || !clicker) {
          // No clicker identity: nobody to authorise, so nothing is decided.
          console.warn(`[permission-gate] click on ${toolUseId} without a user id refused`);
          try {
            await respond({ response_type: "ephemeral", replace_original: false, text: PERM_REFUSED_TEXT });
          } catch {}
          return;
        }
        const userId: string = clicker;
        const status = decision === "deny" ? ("denied" as const) : ("approved" as const);
        const stale = async (status?: string) => {
          // Duplicate click, expiry, abort, or another replica won. Answer
          // ephemerally and leave the card alone: a decided card's rewrite is
          // the only visible record. Expired/cancelled rows were never decided.
          try {
            await respond({
              response_type: "ephemeral",
              replace_original: false,
              text:
                status === "expired" || status === "cancelled"
                  ? `:hourglass: \`${a.action_id.split(":")[2]}\` ${status}`
                  : `:lock: \`${a.action_id.split(":")[2]}\` already decided`,
            });
          } catch {}
        };
        const decidedText = (toolName: string) => {
          const decided =
            decision === "allow"
              ? "*Allowed* once"
              : decision === "always"
                ? "*Always-allowed* for this session"
                : "*Denied*";
          return `${toolName} → ${decided} by <@${userId}>`;
        };
        // Authorisation runs before any resolve, publish or waiter delivery,
        // so a refused click never consumes the row: the card and the row stay
        // pending for someone who may decide. Accepted window: a role or lock
        // revoked between this check and the guarded resolve below still lets
        // this one click through.
        const refused = async (row: Pick<PendingGates.PendingGate, "kind" | "id" | "payload" | "sessionId">): Promise<boolean> => {
          let ok = false;
          let failure: string | undefined;
          try {
            ok = await mayDecide(row, userId);
          } catch (e) {
            failure = e instanceof Error ? e.message : String(e);
            console.error(`[permission-gate] authorisation check failed for ${toolUseId}, refusing: ${failure}`);
          }
          if (ok) return false;
          auditPermRefused(row, userId, decision, failure);
          try {
            await respond({ response_type: "ephemeral", replace_original: false, text: PERM_REFUSED_TEXT });
          } catch {}
          return true;
        };
        const pend = this.#pending.get(toolUseId);
        if (!pend) {
          const cur = await PendingGates.get(toolUseId);
          if (!cur || cur.status !== "pending") return void (await stale(cur?.status));
          const isPollRow = (cur.payload as any)?.waiter === "poll";
          if (!isPollRow && cur.instanceId === PendingGates.INSTANCE_ID) {
            // Our own in-process row with no waiter: the abort raced the
            // click. Settle the stray so it doesn't linger until expiry.
            // Deliberately not authorised: nothing is decided here (the turn
            // that asked is gone), any click only clears the dead row.
            const settled = await PendingGates.resolve(toolUseId, "cancelled", userId);
            if (settled) auditPermCancelled(settled, "slack_user", userId, "click raced the turn's abort");
            await this.#publish(toolUseId);
            return void (await stale());
          }
          if (await refused(cur)) return;
          const bus = this.#bus();
          if (isPollRow || bus) {
            // poll row: the waiter is a node long-poll — any replica decides.
            // foreign in-process row + bus: the sibling's subscription wakes
            // its waiter, so deciding here is safe (spec §5).
            const row = await PendingGates.resolve(toolUseId, status, userId, { decision });
            if (!row) return void (await stale());
            // No input in details here: a poll row deliberately does not store
            // the tool input (it can carry secrets, and the row outlives the
            // decision by 24 h), and this replica holds no waiter that has it.
            auditPermDecided(row, userId, decision);
            await this.#publish(toolUseId);
            try {
              await respond({
                replace_original: true,
                text: decidedText(String((cur.payload as any)?.toolName ?? "tool")),
                blocks: [],
              });
            } catch {}
            return;
          }
          // Foreign pending row and no bus: a sibling replica may be alive and
          // holding the waiter with no way to wake it from here — never cancel
          // it. Tell the clicker where the gate lives and keep the buttons.
          try {
            await respond({
              response_type: "ephemeral",
              replace_original: false,
              text: ":hourglass: This approval is pending on another replica — it will be decided there (or auto-expire).",
            });
          } catch {}
          return;
        }
        if (await refused(pend.row)) return;
        // DB row is the source of truth: exactly one click wins the guarded
        // UPDATE; every later click sees null and is stale. The decision
        // granularity (allow vs always) rides along in the payload so
        // long-pollers and bus-woken siblings can honor "always".
        const row = await PendingGates.resolve(toolUseId, status, userId, { decision });
        if (!row) {
          // A sweep may have expired (or an abort cancelled) the row while the
          // waiter is still alive — deliver the deny locally, never hang.
          const cur = await PendingGates.get(toolUseId);
          if (cur && (cur.status === "expired" || cur.status === "cancelled") && this.#pending.delete(toolUseId)) {
            void pend.unsub?.().catch(() => {});
            pend.resolve({ behavior: "deny", message: cur.status === "expired" ? "expired before a decision" : "cancelled" });
          }
          return void (await stale(cur?.status));
        }
        this.#pending.delete(toolUseId);
        void pend.unsub?.().catch(() => {});
        auditPermDecided(row, userId, decision, pend.input);
        await this.#publish(toolUseId);

        // Use respond() — fires against the click's response_url and is much
        // faster than chat.update, so the buttons disappear before the user
        // has a chance to double-click.
        try {
          await respond({
            replace_original: true,
            text: decidedText(pend.toolName),
            blocks: [],
          });
        } catch (e) {
          console.error("[permission-gate] respond failed", e);
        }

        if (decision === "deny") {
          pend.resolve({ behavior: "deny", message: `Denied by <@${userId}>` });
          return;
        }

        pend.resolve({
          behavior: "allow",
          updatedInput: pend.input,
          ...(decision === "always" && !pend.row.payload.guardrail
            ? { updatedPermissions: alwaysAllowUpdates(pend.toolName, pend.suggestions) }
            : {}),
        });
      },
    );
  }

  #bus(): GateBus | null {
    return this.#busOverride !== undefined ? this.#busOverride : defaultGateBus();
  }

  async #publish(id: string): Promise<void> {
    try {
      await this.#bus()?.publish(id);
    } catch (e) {
      console.error("[permission-gate] gate publish failed", e);
    }
  }

  /** Adapter calls this when it knows where a session lives in Slack, and
   *  which app it belongs to: the card is posted as that app (D1.2). `persona`
   *  is stamped into the gate row so its audit rows need no session lookup. */
  bindSession(sessionId: string, channel: string, threadTs: string, app?: AppRef, persona?: string | null) {
    this.#routes.set(sessionId, { channel, threadTs, ...(app ? { app } : {}), ...(persona ? { persona } : {}) });
  }

  unbindSession(sessionId: string) {
    this.#routes.delete(sessionId);
  }

  /**
   * Non-blocking open for the REST tool plane (spec §3 "Blocking tools"):
   * apply the static policy; when a human is needed, write the durable row
   * (payload.waiter='poll' — the waiter is the node's /v1/pending long-poll,
   * so no replica registers an in-process one) and post the card. Returns
   * either the immediate decision or the pendingId to long-poll.
   */
  async open(args: {
    sessionId: string;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId: string;
    channel: string;
    threadTs: string;
    decisionReason?: string;
    suggestions?: unknown[];
    /** Slack app the session belongs to (D1.2). */
    app?: AppRef;
    /** Persona name, stamped into the row for its audit rows. */
    persona?: string | null;
    /** Who started the turn (from the job token), stamped for click authorisation. */
    turn?: TurnStamp;
    /** An owner guardrail asks for this card (already re-evaluated by the
     *  caller): the policy's allows are skipped (its denies hold), no "always allow", expires within ttlMs. */
    forced?: ForcedCard & { ttlMs?: number };
  }): Promise<{ decision: PermissionDecision } | { pendingId: string }> {
    // A forced card skips only the policy's allows; its hard denies (the
    // synthesized OAuth tools, voice_start's checks) still hold.
    const policy = permissionPolicy(args.toolName, args.input, this.#autoAllow, gateVoiceAudio(args.toolName));
    if (policy && (!args.forced || policy.behavior === "deny")) return { decision: policy };
    const ttl = Math.min(PERM_GATE_TTL_MS, args.forced?.ttlMs ?? PERM_GATE_TTL_MS);

    await PendingGates.create({
      id: args.toolUseId,
      kind: "perm",
      sessionId: args.sessionId,
      payload: {
        toolName: args.toolName,
        channel: args.channel,
        threadTs: args.threadTs,
        waiter: "poll",
        ...(args.persona ? { personaName: args.persona } : {}),
        ...stampPayload(args.turn),
        ...(args.suggestions?.length ? { suggestions: args.suggestions } : {}),
        ...(args.forced ? { guardrail: args.forced.ruleId } : {}),
      },
      expiresAt: Date.now() + ttl,
    });
    try {
      await clientForApp(this.#transport, args.app).chat.postMessage({
        channel: args.channel,
        thread_ts: args.threadTs,
        text: `:lock: Approval needed: \`${args.toolName}\``,
        blocks: permBlocks(args.toolName, args.input, args.toolUseId, args.decisionReason, args.forced),
      });
    } catch (e) {
      // The prompt never reached Slack — settle the row and rethrow.
      await PendingGates.resolve(args.toolUseId, "cancelled", "system")
        .then((row) => row && auditPermCancelled(row, "system", "system", "card post failed", args.input))
        .catch(() => {});
      throw e;
    }
    return { pendingId: args.toolUseId };
  }

  /** Closure passed into AgentManager.setPermissionResolver. */
  resolver: import("../../agent/manager").PermissionResolver = async (
    sessionId,
    toolName,
    input,
    ctx,
  ) => {
    // An owner guardrail's approve rule forces the card: the auto-allow
    // policy does not apply to it (the rule is the owner's, the policy ours).
    const forced = (ctx as PermissionContext).ownerApproval;
    // Only the policy's allows are skipped: its hard denies still hold.
    const policy = permissionPolicy(toolName, input, this.#autoAllow, gateVoiceAudio(toolName));
    if (policy && (!forced || policy.behavior === "deny")) return policy;
    const route = this.#routes.get(sessionId);
    if (!route) {
      // No live thread — fail closed so we don't silently grant ops.
      return { behavior: "deny", message: "no active slaude thread to ask in" };
    }

    const toolUseId = ctx.toolUseID;

    // Durable pending state FIRST, then the in-process waiter, then the
    // buttons: by the time a click can exist, both stores are in place — no
    // window where a click finds half-initialized state.
    const payload: Record<string, unknown> = {
      toolName,
      channel: route.channel,
      threadTs: route.threadTs,
      ...(route.persona ? { personaName: route.persona } : {}),
      ...stampPayload(this.#turnOf(sessionId)),
      ...(forced ? { guardrail: forced.ruleId } : {}),
    };
    await PendingGates.create({
      id: toolUseId,
      kind: "perm",
      sessionId,
      payload,
      // An owner card ends with its hook's deadline (the hook aborts the
      // signal then, which cancels the row below).
      expiresAt: forced ? Math.min(forced.deadline, Date.now() + PERM_GATE_TTL_MS) : Date.now() + PERM_GATE_TTL_MS,
    });

    let resolveFn!: (r: Awaited<ReturnType<CanUseTool>>) => void;
    const promise = new Promise<Awaited<ReturnType<CanUseTool>>>((resolve) => {
      resolveFn = resolve;
    });
    const pend: Pending = {
      channel: route.channel,
      threadTs: route.threadTs,
      messageTs: "",
      toolName,
      input,
      suggestions: ctx.suggestions,
      resolve: resolveFn,
      row: { kind: "perm", id: toolUseId, payload, sessionId },
    };
    this.#pending.set(toolUseId, pend);
    // Cross-replica wakeup: a click landing on a sibling replica resolves the
    // row and publishes; this subscription delivers the SDK promise here.
    const bus = this.#bus();
    if (bus) {
      try {
        pend.unsub = await bus.subscribe(toolUseId, () => {
          void (async () => {
            const cur = await PendingGates.get(toolUseId);
            if (!cur || cur.status === "pending") return;
            if (!this.#pending.delete(toolUseId)) return; // local click already delivered
            void pend.unsub?.().catch(() => {});
            pend.resolve(decisionFromPermRow(cur, toolName, input, ctx.suggestions));
          })();
        });
      } catch (e) {
        console.error("[permission-gate] gate subscribe failed (falling back to click-only)", e);
      }
    }
    // Honor abort signal — tear down the prompt and deny.
    ctx.signal.addEventListener(
      "abort",
      () => {
        if (!this.#pending.has(toolUseId)) return;
        this.#pending.delete(toolUseId);
        void pend.unsub?.().catch(() => {});
        // Settle the durable row too; a click that raced the abort loses.
        void PendingGates.resolve(toolUseId, "cancelled", "system")
          .then((row) => row && auditPermCancelled(row, "system", "system", "turn aborted", input))
          .catch(() => {});
        resolveFn({ behavior: "deny", message: "aborted" });
      },
      { once: true },
    );

    try {
      const posted = await clientForApp(this.#transport, route.app).chat.postMessage({
        channel: route.channel,
        thread_ts: route.threadTs,
        text: `:lock: Approval needed: \`${toolName}\``,
        blocks: permBlocks(toolName, input, toolUseId, ctx.decisionReason, forced ? { ruleId: forced.ruleId, message: forced.message } : undefined),
      });
      pend.messageTs = (posted.ts as string) ?? "";
    } catch (e) {
      // The prompt never reached Slack — tear both stores down and rethrow.
      this.#pending.delete(toolUseId);
      void pend.unsub?.().catch(() => {});
      void PendingGates.resolve(toolUseId, "cancelled", "system")
        .then((row) => row && auditPermCancelled(row, "system", "system", "card post failed", input))
        .catch(() => {});
      throw e;
    }

    return promise;
  };
}

/** Audit a click that won the guarded resolve. Fire-and-forget: the writer
 *  redacts and caps the tool input, and never blocks the decision. */
function auditPermDecided(
  row: PendingGates.PendingGate,
  userId: string,
  decision: "allow" | "always" | "deny",
  input?: Record<string, unknown>,
): void {
  const tool = String(row.payload.toolName ?? "tool");
  auditGateRow(row, {
    verb: "decided",
    actorKind: "slack_user",
    actorId: userId,
    decision,
    summary: `${tool}: ${decision}`,
    ...(input ? { details: { input } } : {}),
  });
}

/** A non-empty string payload value, else null. */
const strOf = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * May `clicker` decide this perm row? Inputs come from the row alone, so any
 * replica answers the same. A row written before the initiator was stamped
 * has no `initiator` key and is treated as a turn with no initiator (approver
 * or manager required). A throw (lock or role lookup) propagates: the caller
 * refuses the click.
 */
async function mayDecide(
  row: Pick<PendingGates.PendingGate, "payload">,
  clicker: string,
): Promise<boolean> {
  const p = row.payload ?? {};
  const channel = strOf(p.channel);
  const threadTs = strOf(p.threadTs);
  let lockOwner: string | null = null;
  if (channel && threadTs) lockOwner = (await OneOnOne.find(channel, threadTs))?.locked_user ?? null;
  return canDecidePermission({
    clicker,
    initiator: strOf(p.initiator),
    lockOwner,
    persona: strOf(p.personaName),
    channel,
  });
}

/** Audit a click refused by the authorisation check. The row is untouched. */
function auditPermRefused(
  row: Pick<PendingGates.PendingGate, "kind" | "id" | "payload" | "sessionId">,
  userId: string,
  attempted: "allow" | "always" | "deny",
  failure?: string,
): void {
  auditGateRow(row, {
    verb: "refused",
    actorKind: "slack_user",
    actorId: userId,
    decision: "refused",
    summary: `${String(row.payload.toolName ?? "tool")}: refused (${failure ? "authorisation check failed" : "not the requester or an approver"})`,
    details: { attempted, ...(failure ? { error: failure } : {}) },
  });
}

/** Audit a prompt settled as cancelled (abort, post failure, raced click).
 *  Only the caller whose guarded resolve won calls this, so it is once per row.
 *  Expiry has no in-process path here: sweepExpired owns it. */
function auditPermCancelled(
  row: PendingGates.PendingGate,
  actorKind: "slack_user" | "system",
  actorId: string,
  reason: string,
  input?: Record<string, unknown>,
): void {
  auditGateRow(row, {
    verb: "cancelled",
    actorKind,
    actorId,
    decision: "cancelled",
    summary: `${String(row.payload.toolName ?? "tool")}: cancelled (${reason})`,
    details: { reason, ...(input ? { input } : {}) },
  });
}

function truncate(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max) + "\n…(truncated)";
}

// silence unused-import warning
void env;
