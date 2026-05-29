import { rmSync } from "node:fs";
import { createGateway, type GatewayHandle } from "../core/gateway";
import { SimTransport } from "./transport";
import { StubAgent } from "./stub-agent";
import { writeSoulFixture, type SoulFixture } from "./soul-fixture";
import { getPreset } from "./presets";
import { AgentManager } from "../../agent/manager";
import { __resetSoulDataMemo } from "../../soul/extract";
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
  #drops: { reason: string }[] = [];
  #restoreDropInc: () => void;

  private constructor(transport: SimTransport, agent: StubAgent | AgentManager, handle: GatewayHandle) {
    this.transport = transport; this.agent = agent; this.handle = handle;
    const counter: any = metric.slackDropsTotal;
    const orig = counter.inc.bind(counter);
    counter.inc = (labels: any) => { this.#drops.push({ reason: labels?.reason ?? "unknown" }); return orig(labels); };
    this.#restoreDropInc = () => { counter.inc = orig; };
  }

  static async create(opts: { preset?: string; soul?: SoulFixture; agent: "stub" | "real"; behavior?: string }): Promise<SimSession> {
    let soul: SoulFixture | undefined = opts.soul;
    let actor = "U0MGR", channel = "C0TEAM", dm = false, behavior = opts.behavior ?? "reply";
    if (opts.preset) {
      const p = getPreset(opts.preset);
      if (!p) throw new Error(`unknown preset: ${opts.preset}`);
      soul = p.soul; actor = p.actor; channel = p.channel; dm = p.dm ?? false; behavior = opts.behavior ?? p.behavior;
    }
    if (!soul) soul = { manager: "U0MGR", approvers: ["U0APP"], trusted: ["C0TEAM"], allowed: ["C0PUB"] };
    writeSoulFixture(soul);   // also injects SoulData via setSoulData

    // The real gateway eagerly reads env.slack.botToken() per inbound turn (for
    // attachment downloads). The sim never has real files, so the token is never
    // used to hit Slack — seed a dummy so the accessor doesn't throw.
    process.env.SLACK_BOT_TOKEN ??= "xoxb-sim";

    // Enable the connect-broker so connect_borrow scenarios can exercise the
    // broker MCP (mcp_call returns a needs-connect hint when no connection
    // exists). Uses ??= so an already-set key is never overwritten.
    process.env.SLAUDE_ENCRYPTION_KEY ??= Buffer.alloc(32).toString("base64");

    const transport = new SimTransport({ users: { U0MGR: "Manager", U0APP: "Approver", U0ALICE: "Alice", U0BOB: "Bob", U0BACKUP: "Backup" } });
    const agent: StubAgent | AgentManager = opts.agent === "real" ? new AgentManager() : new StubAgent();
    const handle = createGateway(agent, transport);
    if (agent instanceof StubAgent) { agent.attachGateway(handle); agent.setBehavior(behavior); }

    const s = new SimSession(transport, agent, handle);
    s.actor = actor; s.channel = channel; s.dm = dm; s.behavior = behavior;
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
    await this.transport.feedMessage({ channel, user: as, text, channel_type: dm ? "im" : "channel", team: TEAM, thread_ts: step.thread });
    await this.#drain();
  }

  async click(step: { as?: string; action: string }): Promise<void> {
    const as = step.as ?? this.actor;
    const card = [...this.transport.outbound].reverse().find((c) => !c.resolved && c.actionIds.some((id) => id.split(":")[1] === step.action));
    if (!card) throw new Error(`no live card with action ${step.action}`);
    const actionId = card.actionIds.find((id) => id.split(":")[1] === step.action)!;
    await this.transport.feedAction(actionId, as);
    await this.#drain();
  }

  cards() { return this.transport.outbound; }
  drops() { return this.#drops; }

  async #drain(): Promise<void> {
    if (this.agent instanceof StubAgent) await this.agent.drain();
    else await new Promise((r) => setTimeout(r, 0));
  }

  async dispose(): Promise<void> {
    this.#restoreDropInc();
    await this.handle.stop();
    __resetSoulDataMemo();
    try { rmSync(paths.soul, { force: true }); } catch {}
  }
}
