import { rmSync, writeFileSync } from "node:fs";
import { createGateway, type GatewayHandle } from "../core/gateway";
import { SimTransport, type OutboundCard } from "./transport";
import { StubAgent } from "./stub-agent";
import { writeSoulFixture, type SoulFixture } from "./soul-fixture";
import { getPreset } from "./presets";
import { AgentManager, type AgentEvent } from "../../agent/manager";
import { __resetSoulDataMemo, loadSoulData, setSoulData, soulData } from "../../soul/extract";
import { paths } from "../../config/home";
import { m as metric } from "../../metrics";

export type { SoulFixture };          // re-export so transcript.ts can import from "./engine"

const TEAM = "T0SIM";
const SIM_BOT = "U_SLAUDE";           // must match SimTransport default botUserId

export class SimSession {
  transport: SimTransport;
  agent: StubAgent | AgentManager;
  handle: GatewayHandle;
  actor = "U0MGR";
  channel = "C0TEAM";
  dm = false;
  behavior = "reply";
  /** Shared mode runs against the operator's REAL $SLAUDE_HOME — dispose must NOT touch
   *  the real SOUL.md. Set true only by #createShared. */
  #shared = false;
  #drops: { reason: string }[] = [];
  #restoreDropInc: () => void;

  private constructor(transport: SimTransport, agent: StubAgent | AgentManager, handle: GatewayHandle) {
    this.transport = transport; this.agent = agent; this.handle = handle;
    const counter: any = metric.slackDropsTotal;
    const orig = counter.inc.bind(counter);
    counter.inc = (labels: any) => { this.#drops.push({ reason: labels?.reason ?? "unknown" }); return orig(labels); };
    this.#restoreDropInc = () => { counter.inc = orig; };
  }

  static async create(opts: { preset?: string; soul?: SoulFixture; agent: "stub" | "real"; behavior?: string; soulMd?: string; mode?: "fixture" | "shared" }): Promise<SimSession> {
    if (opts.mode === "shared") return SimSession.#createShared(opts);

    let soul: SoulFixture | undefined = opts.soul;
    let actor = "U0MGR", channel = "C0TEAM", dm = false, behavior = opts.behavior ?? "reply";
    if (opts.preset) {
      const p = getPreset(opts.preset);
      if (!p) throw new Error(`unknown preset: ${opts.preset}`);
      soul = p.soul; actor = p.actor; channel = p.channel; dm = p.dm ?? false; behavior = opts.behavior ?? p.behavior;
    }
    if (!soul) soul = { manager: "U0MGR", approvers: ["U0APP"], trusted: ["C0TEAM"], allowed: ["C0PUB"] };
    writeSoulFixture(soul);   // also injects SoulData (gates) via setSoulData
    // Optional: drive the agent's persona/voice from a real SOUL.md. The system prompt
    // reads paths.soul live (loadSoul()), so overwriting the synthetic fixture file makes
    // the agent adopt that persona. Gates stay from the preset (setSoulData memo) — the
    // custom file's approvers/channels are NOT re-extracted in the sim.
    if (opts.soulMd) writeFileSync(paths.soul, opts.soulMd, "utf8");

    // The real gateway eagerly reads env.slack.botToken() per inbound turn (for
    // attachment downloads). The sim never has real files, so the token is never
    // used to hit Slack — seed a dummy so the accessor doesn't throw.
    process.env.SLACK_BOT_TOKEN ??= "xoxb-sim";

    // Enable the connect-broker so connect_borrow scenarios can exercise the
    // broker MCP (mcp_call returns a needs-connect hint when no connection
    // exists). The broker is OFF by default in production (gated behind
    // SLAUDE_ENABLE_CONNECT_BROKER + the key); the sim opts in so the borrow
    // path stays covered. Uses ??= so already-set values are never overwritten.
    process.env.SLAUDE_ENABLE_CONNECT_BROKER ??= "1";
    process.env.SLAUDE_ENCRYPTION_KEY ??= Buffer.alloc(32).toString("base64");

    const transport = new SimTransport({ users: { U0MGR: "Manager", U0APP: "Approver", U0ALICE: "Alice", U0BOB: "Bob", U0BACKUP: "Backup" } });
    const agent: StubAgent | AgentManager = opts.agent === "real" ? new AgentManager() : new StubAgent();
    const handle = createGateway(agent, transport);
    if (agent instanceof StubAgent) { agent.attachGateway(handle); agent.setBehavior(behavior); }

    const s = new SimSession(transport, agent, handle);
    s.actor = actor; s.channel = channel; s.dm = dm; s.behavior = behavior;
    return s;
  }

  /** Shared mode: boot exactly like `server.ts` (real $SLAUDE_HOME config, real soul
   *  extraction → real gates) but bind a SimTransport instead of Slack. No fixtures, no
   *  forced env — the only gap vs prod is the absence of the real Slack wire. The default
   *  actor is the real SOUL.md manager so approval/authz behaves as in prod; chat happens in
   *  a synthetic DM thread. cli.ts has already pointed db + workspaces at $SLAUDE_HOME/sim/. */
  static async #createShared(opts: { agent: "stub" | "real"; behavior?: string }): Promise<SimSession> {
    // Same prewarm as server.ts main(): warm the structured-soul cache from the real
    // SOUL.md. Best-effort — falls back to regex internally if the LLM is unavailable.
    try { setSoulData(await loadSoulData()); }
    catch (e) { console.warn("[sim] soul prewarm failed (regex fallback):", e); }

    // Attachment-download accessor reads the bot token even though the sim never hits Slack.
    process.env.SLACK_BOT_TOKEN ??= "xoxb-sim";

    const manager = soulData().manager?.userId;
    const actor = manager ?? "U0MGR";
    const transport = new SimTransport({ users: manager ? { [manager]: "You (manager)" } : {} });
    const agent: StubAgent | AgentManager = opts.agent === "real" ? new AgentManager() : new StubAgent();
    const handle = createGateway(agent, transport);
    const behavior = opts.behavior ?? "reply";
    if (agent instanceof StubAgent) { agent.attachGateway(handle); agent.setBehavior(behavior); }

    const s = new SimSession(transport, agent, handle);
    s.#shared = true;
    s.actor = actor; s.channel = "D0SIM"; s.dm = true; s.behavior = behavior;
    return s;
  }

  loadPreset(nameOrIndex: string): void {
    const p = getPreset(nameOrIndex);
    if (!p) throw new Error(`unknown preset: ${nameOrIndex}`);
    this.actor = p.actor; this.channel = p.channel; this.dm = p.dm ?? false; this.behavior = p.behavior;
    if (this.agent instanceof StubAgent) this.agent.setBehavior(this.behavior);
  }

  async send(step: { as?: string; channel?: string; text: string; dm?: boolean; thread?: string }): Promise<void> {
    const as = step.as ?? this.actor;
    const channel = step.channel ?? this.channel;
    const dm = step.dm ?? (step.channel ? false : this.dm);
    if (this.agent instanceof StubAgent) this.agent.setBehavior(this.behavior);
    // Non-DM channels require an @mention to engage the thread (real engagement gate).
    const text = dm ? step.text : `<@${SIM_BOT}> ${step.text}`;
    // `thread` pins messages to a shared thread_ts so multi-message, thread-scoped
    // behaviors (e.g. /1on1 locks) model one real Slack thread. Omitted → each send
    // is its own thread (handleMessage falls back to the message ts).
    const turn = this.#armTurn();
    await this.transport.feedMessage({ channel, user: as, text, channel_type: dm ? "im" : "channel", team: TEAM, thread_ts: step.thread });
    await this.#drain();
    await turn;
  }

  async click(step: { as?: string; action: string }): Promise<void> {
    const as = step.as ?? this.actor;
    const card = [...this.transport.outbound].reverse().find((c) => !c.resolved && c.actionIds.some((id) => id.split(":")[1] === step.action));
    if (!card) throw new Error(`no live card with action ${step.action}`);
    const actionId = card.actionIds.find((id) => id.split(":")[1] === step.action)!;
    const turn = this.#armTurn();
    await this.transport.feedAction(actionId, as);
    await this.#drain();
    await turn;
  }

  cards() { return this.transport.outbound; }
  drops() { return this.#drops; }

  /** Live agent-event stream (real agent only) — for claude-code-style rendering.
   *  Returns an unsubscribe fn; no-op for the stub. */
  onAgentEvent(cb: (e: AgentEvent) => void): () => void {
    if (this.agent instanceof StubAgent) return () => {};
    const mgr = this.agent;
    mgr.on("event", cb);
    return () => mgr.off("event", cb);
  }

  /** Live outbound-card stream — for rendering replies + gate prompts. */
  onCard(cb: (c: OutboundCard) => void): () => void { return this.transport.onCard(cb); }

  /** The currently-open permission/approval gate awaiting a human click, if any. */
  pendingGate(): OutboundCard | undefined {
    return [...this.transport.outbound].reverse().find(
      (c) => (c.kind === "permission" || c.kind === "approval") && !c.resolved && c.actionIds.length > 0,
    );
  }

  /** Resolve the open gate with a verb (allow|always|deny|approve|reject…), then
   *  await the turn's continuation (which may stop at the next gate or finish). */
  async resolveGate(verb: string): Promise<void> {
    const gate = this.pendingGate();
    if (!gate) throw new Error("no pending gate");
    const actionId = gate.actionIds.find((id) => id.split(":")[1] === verb) ?? gate.actionIds[0]!;
    const turn = this.#armTurn();
    await this.transport.feedAction(actionId, this.actor);
    await turn;
  }

  async #drain(): Promise<void> {
    if (this.agent instanceof StubAgent) await this.agent.drain();
    else await new Promise((r) => setTimeout(r, 0));
  }

  // Real AgentManager runs the LLM turn async — feedMessage returns before the
  // reply lands. Arm this BEFORE feeding so we don't miss the event, then await
  // it after. Resolves on done/error, OR when a permission/approval gate opens —
  // a gate pauses the SDK turn awaiting a human click, so we hand control back to
  // the REPL to prompt inline; resolveGate() re-arms for the continuation.
  #armTurn(): Promise<void> {
    if (this.agent instanceof StubAgent) return Promise.resolve();
    const mgr = this.agent;
    return new Promise<void>((resolve) => {
      const onEvent = (e: AgentEvent) => {
        if (e.type === "done" || e.type === "error") { cleanup(); resolve(); }
      };
      const offCard = this.transport.onCard((c) => {
        if ((c.kind === "permission" || c.kind === "approval") && !c.resolved && c.actionIds.length > 0) { cleanup(); resolve(); }
      });
      const timer = setTimeout(() => { cleanup(); resolve(); }, 180_000);
      const cleanup = () => { clearTimeout(timer); mgr.off("event", onEvent); offCard(); };
      mgr.on("event", onEvent);
    });
  }

  async dispose(): Promise<void> {
    this.#restoreDropInc();
    await this.handle.stop();
    __resetSoulDataMemo();
    // Fixture mode wrote a synthetic SOUL.md to clean up. Shared mode runs against the
    // operator's REAL $SLAUDE_HOME — NEVER delete their SOUL.md.
    if (!this.#shared) { try { rmSync(paths.soul, { force: true }); } catch {} }
  }
}
