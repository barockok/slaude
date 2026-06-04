import { SimSession } from "./engine";
import { PRESETS, getPreset } from "./presets";
import type { OutboundCard } from "./transport";
import type { AgentEvent } from "../../agent/manager";
import { soulData } from "../../soul/extract";
import { toolLine, resultLine, replyLine, errorLine, statusLabel, gateBox, isReplyTool, thinkingLine, usageLine } from "./render";
import { parseSlashCommand, AGENT_COMMANDS } from "../slack/commands";
import { LAYERS, ROLE_NAMES, findLayer, resolveRole } from "./roles";

/** REPL-native command heads (sim-only; not parsed by the gateway). */
export const SIM_COMMANDS = [
  "/scenario", "/scenarios", "/state", "/as", "/layer", "/channel", "/dm", "/thread", "/behavior", "/cards", "/click", "/help",
];
/** Every command name the REPL accepts — sim-native + the agent slash heads — for Tab-completion. */
export function replCommandNames(): string[] {
  return [...SIM_COMMANDS, ...AGENT_COMMANDS.map((c) => c.usage.split(" ")[0]!)];
}

/** Transport-agnostic REPL logic: feed it command lines, it emits two streams —
 *   - onOutput(line): committed scrollback (tool tree, replies, gate boxes)
 *   - onStatus(label|null): the live bottom spinner label ("Thinking…", "Bash…"), or null to clear.
 *  cli.ts paints these onto a real TTY (LiveTerminal); tests capture them directly.
 *
 *  With a real agent it renders a claude-code-style live feed: the spinner tracks the current
 *  activity while tool calls/results/replies scroll above, and permission/approval gates print
 *  as a bordered box and pause for an inline a/d/A answer. The stub path renders the same gate
 *  box but is otherwise card-dump simple. */
export class ReplController {
  #session?: SimSession;
  #out: (line: string) => void = () => {};
  #status: (label: string | null) => void = () => {};
  #agent: "stub" | "real";
  #unsub: Array<() => void> = [];
  #lastText = "";            // dedup: assistant text vs reply-tool text
  #sessionId?: string;       // latest agent sessionId seen — target for abort/usage
  #shown = 0;                // stub render cursor: cards already shown this session
  #soulMd?: string;
  #shared: boolean;
  constructor(agent: "stub" | "real" = "stub", soulMd?: string, shared = false) { this.#agent = agent; this.#soulMd = soulMd; this.#shared = shared; }
  onOutput(fn: (line: string) => void) { this.#out = fn; }
  onStatus(fn: (label: string | null) => void) { this.#status = fn; }

  async handle(line: string): Promise<void> {
    const trimmed = line.trim();
    const [cmd, ...rest] = trimmed.split(/\s+/);
    // Fixture scenarios write a synthetic SOUL.md — forbidden in shared mode (it runs
    // against the operator's REAL $SLAUDE_HOME). Actor/surface switches never touch SOUL.md,
    // so /as /channel /dm stay allowed in shared mode (that's how you simulate group activity).
    if ((cmd === "/scenarios" || cmd === "/scenario") && this.#shared) {
      this.#out("scenarios are disabled in shared mode (would overwrite your real SOUL.md). Run `bun run sim --fixture` for preset scenarios.");
      return;
    }
    if (cmd === "/scenarios") return this.#listScenarios();
    if (cmd === "/scenario") return this.#loadScenario(rest[0] ?? "");
    if (cmd === "/state") return this.#state();
    if (cmd === "/as") return this.#as(rest);
    if (cmd === "/layer") return this.#layer(rest[0]);
    if (cmd === "/channel") { const s = this.#requireSession(); s.channel = rest[0] ?? s.channel; s.dm = false; return; }
    if (cmd === "/dm") { this.#requireSession().dm = true; return; }
    if (cmd === "/thread") { const s = this.#requireSession(); s.thread = rest[0] && rest[0] !== "off" ? rest[0] : undefined; return; }
    if (cmd === "/behavior") { const s = this.#requireSession(); s.behavior = rest[0] ?? s.behavior; return; }
    if (cmd === "/cards") return this.#dumpCards();
    if (cmd === "/click") return this.#click(rest);
    if (cmd === "/help") return this.#help();
    // Agent-side slash commands (/1on1, /ignore-thread, /mode, /abort, /cron-*, …) are parsed
    // by the gateway from message TEXT — forward them as a message, not a REPL command. Real
    // typos (parse returns null) still get the unknown-command error.
    if (cmd?.startsWith("/")) {
      if (parseSlashCommand(trimmed)) return this.#send({ text: trimmed });
      this.#out(`unknown command: ${cmd}`); return;
    }

    // A gate is open and waiting on a human — interpret bare input as the verb.
    const gate = this.#session?.pendingGate();
    if (gate) return this.#answerGate(gate, trimmed);

    await this.#send({ text: trimmed });
  }

  /** Send as the current actor, render the turn (live status + committed lines + any gate). */
  async #send(step: { text: string; as?: string }) {
    const s = this.#requireSession();
    this.#lastText = "";
    this.#status("Thinking…");
    try {
      await s.send(step);
      if (this.#agent === "stub") this.#renderStubTurn();
      // real: events rendered live via #subscribe; a gate (if any) was printed by #renderCard.
    } finally {
      // If the turn paused on a gate, keep the spinner off; the gate box already showed.
      this.#status(null);
    }
  }

  /** `/as <role|U>` switches the actor; `/as <role|U> hey team` sends one message as them
   *  without changing the actor — staging group/multi-user activity. A role name
   *  (manager/approver/backup/member/outsider) resolves to a user id via the active soul. */
  async #as(rest: string[]) {
    const s = this.#requireSession();
    const who = rest[0];
    if (!who) { this.#out(`actor=${s.actor} — usage: /as <role|U> [text]  (roles: ${ROLE_NAMES.join(", ")})`); return; }
    const id = (ROLE_NAMES as readonly string[]).includes(who) ? resolveRole(who, soulData()) : who;
    if (!id) { this.#out(`role "${who}" doesn't resolve in the current soul (try a raw user id)`); return; }
    const text = rest.slice(1).join(" ");
    if (!text) { s.actor = id; return; }        // no text → permanent switch
    await this.#send({ as: id, text });          // text → one-shot, actor preserved
  }

  /** `/layer <dm|trusted|allowed|restricted>` moves the conversation to that engagement zone. */
  #layer(name?: string) {
    const s = this.#requireSession();
    if (!name) { this.#out(`current: ${s.dm ? "dm" : s.channel} — layers: ${LAYERS.map((l) => l.name).join(", ")}`); return; }
    const l = findLayer(name);
    if (!l) { this.#out(`unknown layer "${name}" — try: ${LAYERS.map((x) => x.name).join(", ")}`); return; }
    s.channel = l.channel; s.dm = l.dm;
  }

  /** Render only the cards produced since the last turn, the claude-code way: a reply as an
   *  `⏺` bullet, an open gate as a box. Reactions/typing-status are noise — skip them.
   *  (`/cards` still dumps the full bracketed listing for explicit inspection.) */
  #renderStubTurn() {
    const cards = this.#session!.cards();
    for (let i = this.#shown; i < cards.length; i++) {
      const c = cards[i]!;
      if (c.kind === "reaction" || c.kind === "status") continue;
      if ((c.kind === "permission" || c.kind === "approval") && !c.resolved) { this.#status(null); this.#out(gateBox(c)); continue; }
      if (c.text) this.#out(replyLine(c.text));
    }
    this.#shown = cards.length;
  }

  #listScenarios() { this.#out("Scenarios:\n" + PRESETS.map((p, i) => `  ${i + 1}) ${p.name} — ${p.title}`).join("\n")); }

  #help() {
    // Agent commands are derived from AGENT_COMMANDS (commands.ts) — add one there and it
    // shows here automatically. The sim-native commands above are REPL-only, so they stay local.
    const agent = AGENT_COMMANDS.map((c) => `  ${c.usage.padEnd(30)}${c.summary}`).join("\n");
    this.#out([
      "sim commands:",
      "  <text>            send a message as the current actor",
      "  a / d / A         answer an open permission gate (allow / deny / always)",
      "  /as <role|U> [txt] switch/send-as a role (manager·approver·backup·member·outsider) or id",
      "  /layer <zone>     move to dm · trusted · allowed · restricted",
      "  /channel <C>      move to a raw channel  /dm   move to a DM",
      "  /thread <ts|off>  pin a thread (needed for /1on1, /ignore-thread to persist)",
      "  /scenario <n>     load scenario n        /scenarios  list them",
      "  /behavior <b>     set stub behavior      /state  show actor/channel",
      "  /click <n> <vb>   click card n           /cards  /help",
      "",
      "agent commands (forwarded to the agent like a real Slack message):",
      agent,
    ].join("\n"));
  }

  #subscribe(s: SimSession) {
    if (this.#agent !== "real") return;
    this.#unsub.push(s.onAgentEvent((e) => this.#renderEvent(e)));
    this.#unsub.push(s.onCard((c) => this.#renderCard(c)));
  }

  /** Shared mode (default for `bun run sim`): boot like `bun run start` against the real
   *  $SLAUDE_HOME (real config + soul/gates), bind a SimTransport, and start chatting in a
   *  DM as the real manager — no /scenario needed. */
  async startShared() {
    await this.dispose();
    this.#shown = 0;
    this.#session = await SimSession.create({ agent: this.#agent, soulMd: this.#soulMd, mode: "shared" });
    const s = this.#session;
    this.#subscribe(s);
    this.#out(`ready — chatting as ${s.actor} in a DM (shared config: real SOUL.md + gates). Just type. /help for commands.`);
    if (!soulData().manager?.userId) {
      this.#out("⚠️  no manager resolved from SOUL.md — the DM gate will drop your messages (real gate behavior, same as prod). Manager extraction needs the LLM; set working creds in ~/.slaude/.env (or run with --real). The regex fallback alone can't resolve a manager.");
    }
  }

  async #loadScenario(sel: string) {
    await this.dispose();
    this.#shown = 0;
    const effectiveSel = sel || "1";
    this.#session = await SimSession.create({ preset: effectiveSel, agent: this.#agent, soulMd: this.#soulMd });
    const s = this.#session;
    this.#subscribe(s);
    const preset = getPreset(effectiveSel);
    const name = preset?.name ?? effectiveSel;
    this.#out(`loaded ${name} — as ${s.actor} in ${s.channel}${s.dm ? " (dm)" : ""}, behavior=${s.behavior}`);
  }

  /** Abort the running turn (mid-turn interrupt) — Esc in the TTY routes here. */
  abort() { if (this.#sessionId) this.#session?.abort(this.#sessionId); }

  // ── live render (real agent) ───────────────────────────────────────────────
  #renderEvent(e: AgentEvent) {
    this.#sessionId = e.sessionId;
    const label = statusLabel(e);
    if (label) this.#status(label);
    if (e.type === "assistantText") {
      const t = e.text.trim();
      if (t) { this.#lastText = t; this.#out(replyLine(t)); }
    } else if (e.type === "thinking") {
      const t = e.text.trim();
      if (t) this.#out(thinkingLine(t));
    } else if (e.type === "toolCall") {
      if (isReplyTool(e.tool)) {
        const t = String((e.input as any)?.text ?? "").trim();
        if (t && t !== this.#lastText) { this.#lastText = t; this.#out(replyLine(t)); }
      } else {
        this.#out(toolLine(e.tool, e.input));
      }
    } else if (e.type === "toolResult") {
      if (!isReplyTool(e.tool)) this.#out(resultLine(e.result));
    } else if (e.type === "done") {
      const snap = this.#session?.usage(e.sessionId);
      if (snap) this.#out(usageLine(snap));
    } else if (e.type === "error") {
      this.#out(errorLine(String((e as any).error ?? "error")));
    }
  }

  #renderCard(c: OutboundCard) {
    if (c.kind === "permission" || c.kind === "approval") {
      this.#status(null);           // pause the spinner — a human answer is needed
      this.#out(gateBox(c));
    }
    // message / reaction cards are already covered by the event stream — skip.
  }

  async #answerGate(gate: OutboundCard, input: string) {
    const verbs = gate.actionIds.map((a) => a.split(":")[1]).filter(Boolean) as string[];
    const verb = mapVerb(input, verbs);
    if (!verb) { this.#out(`open gate — type allow / deny${verbs.includes("always") ? " / always" : ""} (a / d${verbs.includes("always") ? " / A" : ""})`); return; }
    this.#status("Thinking…");
    try { await this.#session!.resolveGate(verb); if (this.#agent === "stub") this.#renderStubTurn(); }
    finally { this.#status(null); }
  }

  #state() {
    const s = this.#requireSession();
    this.#out(`actor=${s.actor} channel=${s.channel} dm=${s.dm}${s.thread ? ` thread=${s.thread}` : ""} behavior=${s.behavior}`);
  }

  async #click(rest: string[]) {
    const s = this.#requireSession();
    const n = Number(rest[0]);
    const live = s.cards().filter((c) => !c.resolved && c.actionIds.length);
    const card = live[n - 1];
    if (!card) { this.#out(`no live card #${n}`); return; }
    const verb = rest[1] ?? card.actionIds[0]!.split(":")[1]!;
    await s.click({ action: verb });
    if (this.#agent === "stub") this.#dumpCards();
  }

  #dumpCards() {
    const s = this.#requireSession();
    // Reactions (:eyes: ack) are visual noise in the REPL — hide them so the
    // agent's actual reply/cards stand out.
    s.cards().forEach((c: OutboundCard, i) => {
      if (c.kind === "reaction") return;
      const buttons = c.actionIds.map((a) => a.split(":")[1]).join(" | ");
      this.#out(`[card ${i + 1}] ${c.kind}${c.resolved ? " (resolved)" : ""} ${c.text ?? ""}${buttons ? `  [${buttons}]` : ""}`);
    });
  }

  #requireSession(): SimSession { if (!this.#session) throw new Error("no scenario loaded — use /scenario <n>"); return this.#session; }

  async dispose() {
    for (const u of this.#unsub) u();
    this.#unsub = [];
    await this.#session?.dispose();
    this.#session = undefined;
  }
}

/** Map a bare REPL line to one of the gate's actual verbs. Accepts numeric (1/2/3) too. */
function mapVerb(input: string, verbs: string[]): string | undefined {
  if (verbs.includes(input)) return input;
  const n = Number(input);
  if (Number.isInteger(n) && n >= 1 && n <= verbs.length) return verbs[n - 1];
  const lo = input.toLowerCase();
  if (input === "A" || lo === "always") return verbs.find((v) => v === "always");
  if (["a", "allow", "y", "yes", "approve", "ok"].includes(lo)) return verbs.find((v) => /allow|approve/.test(v));
  if (["d", "deny", "n", "no", "reject"].includes(lo)) return verbs.find((v) => /deny|reject/.test(v));
  return undefined;
}
