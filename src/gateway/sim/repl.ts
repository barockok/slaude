import { SimSession } from "./engine";
import { PRESETS, getPreset } from "./presets";
import type { OutboundCard } from "./transport";
import type { AgentEvent } from "../../agent/manager";

/** Transport-agnostic REPL logic: feed it command lines, it emits output lines.
 *  cli.ts wires this to stdin/stdout.
 *
 *  With a real agent it renders a claude-code-style live feed: tool calls, results
 *  and the reply stream in as the turn runs, and permission/approval gates prompt
 *  inline (type a/allow, d/deny, A/always). The stub path stays card-dump simple. */
export class ReplController {
  #session?: SimSession;
  #out: (line: string) => void = () => {};
  #agent: "stub" | "real";
  #unsub: Array<() => void> = [];
  #lastText = "";            // dedup: assistant text vs reply-tool text
  #soulMd?: string;
  constructor(agent: "stub" | "real" = "stub", soulMd?: string) { this.#agent = agent; this.#soulMd = soulMd; }
  onOutput(fn: (line: string) => void) { this.#out = fn; }

  async handle(line: string): Promise<void> {
    const trimmed = line.trim();
    const [cmd, ...rest] = trimmed.split(/\s+/);
    if (cmd === "/scenarios") return this.#listScenarios();
    if (cmd === "/scenario") return this.#loadScenario(rest[0] ?? "");
    if (cmd === "/state") return this.#state();
    if (cmd === "/as") { this.#requireSession().actor = rest[0] ?? this.#requireSession().actor; return; }
    if (cmd === "/channel") { const s = this.#requireSession(); s.channel = rest[0] ?? s.channel; s.dm = false; return; }
    if (cmd === "/dm") { this.#requireSession().dm = true; return; }
    if (cmd === "/behavior") { const s = this.#requireSession(); s.behavior = rest[0] ?? s.behavior; return; }
    if (cmd === "/cards") return this.#dumpCards();
    if (cmd === "/click") return this.#click(rest);
    if (cmd === "/help") return this.#help();
    if (cmd?.startsWith("/")) { this.#out(`unknown command: ${cmd}`); return; }

    // A gate is open and waiting on a human — interpret bare input as the verb.
    const gate = this.#session?.pendingGate();
    if (gate) return this.#answerGate(gate, trimmed);

    const s = this.#requireSession();
    this.#lastText = "";
    if (this.#agent === "stub") { await s.send({ text: trimmed }); this.#dumpCards(); return; }
    await s.send({ text: trimmed });   // real: events render live via subscription
    // If the turn paused on a gate, the gate prompt was already rendered by #renderCard.
  }

  #listScenarios() { this.#out("Scenarios:\n" + PRESETS.map((p, i) => `  ${i + 1}) ${p.name} — ${p.title}`).join("\n")); }

  #help() {
    this.#out([
      "commands:",
      "  <text>           send a message as the current actor",
      "  a / d / A        answer an open permission gate (allow / deny / always)",
      "  /scenario <n>    load scenario n      /scenarios   list them",
      "  /as <U>          switch actor         /dm /channel <C>  switch surface",
      "  /click <n> <vb>  click card n         /cards  /state  /help",
    ].join("\n"));
  }

  async #loadScenario(sel: string) {
    await this.dispose();
    const effectiveSel = sel || "1";
    this.#session = await SimSession.create({ preset: effectiveSel, agent: this.#agent, soulMd: this.#soulMd });
    const s = this.#session;
    if (this.#agent === "real") {
      this.#unsub.push(s.onAgentEvent((e) => this.#renderEvent(e)));
      this.#unsub.push(s.onCard((c) => this.#renderCard(c)));
    }
    const preset = getPreset(effectiveSel);
    const name = preset?.name ?? effectiveSel;
    this.#out(`loaded ${name} — as ${s.actor} in ${s.channel}${s.dm ? " (dm)" : ""}, behavior=${s.behavior}`);
  }

  // ── live render (real agent) ───────────────────────────────────────────────
  #renderEvent(e: AgentEvent) {
    if (e.type === "assistantText") {
      const t = e.text.trim();
      if (t) { this.#lastText = t; this.#out(`\n🤖 ${t}`); }
    } else if (e.type === "toolCall") {
      if (isReplyTool(e.tool)) {
        const t = String((e.input as any)?.text ?? "").trim();
        if (t && t !== this.#lastText) { this.#lastText = t; this.#out(`\n🤖 ${t}`); }
      } else {
        this.#out(`\n⏺ ${shortTool(e.tool)}(${summarizeInput(e.tool, e.input)})`);
      }
    } else if (e.type === "toolResult") {
      if (!isReplyTool(e.tool)) this.#out(`  ⎿ ${summarizeResult(e.result)}`);
    } else if (e.type === "error") {
      this.#out(`\n⚠️  ${String((e as any).error ?? "error")}`);
    }
  }

  #renderCard(c: OutboundCard) {
    if (c.kind === "permission" || c.kind === "approval") {
      const verbs = c.actionIds.map((a) => a.split(":")[1]).filter(Boolean) as string[];
      const tool = (c.text?.match(/`([^`]+)`/)?.[1]) ?? (c.kind === "approval" ? "action" : "tool");
      const hint = `a=${verbs.find((v) => /allow|approve/.test(v)) ?? "allow"} d=${verbs.find((v) => /deny|reject/.test(v)) ?? "deny"}${verbs.includes("always") ? " A=always" : ""}`;
      this.#out(`\n🔒 ${c.kind === "approval" ? "Approval" : "Permission"} needed: ${tool}  →  type ${hint}`);
    }
    // message / reaction cards are already covered by the event stream — skip.
  }

  async #answerGate(gate: OutboundCard, input: string) {
    const verbs = gate.actionIds.map((a) => a.split(":")[1]).filter(Boolean) as string[];
    const verb = mapVerb(input, verbs);
    if (!verb) { this.#out(`open gate — type allow / deny${verbs.includes("always") ? " / always" : ""} (a / d${verbs.includes("always") ? " / A" : ""})`); return; }
    await this.#session!.resolveGate(verb);
  }

  #state() {
    const s = this.#requireSession();
    this.#out(`actor=${s.actor} channel=${s.channel} dm=${s.dm} behavior=${s.behavior}`);
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

// ── render helpers ────────────────────────────────────────────────────────────
function isReplyTool(tool: string): boolean { return tool.endsWith("__reply") || tool === "reply"; }
function shortTool(tool: string): string { const i = tool.lastIndexOf("__"); return i >= 0 ? tool.slice(i + 2) : tool; }

function summarizeInput(tool: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, any>;
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url ?? o.prompt;
  const s = pick !== undefined ? String(pick) : JSON.stringify(o);
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

function summarizeResult(result: unknown): string {
  let s = typeof result === "string" ? result : JSON.stringify(result);
  if (!s) return "(empty)";
  s = s.split("\n")[0]!.trim();
  return s.length > 100 ? s.slice(0, 97) + "…" : s;
}

/** Map a bare REPL line to one of the gate's actual verbs. */
function mapVerb(input: string, verbs: string[]): string | undefined {
  if (verbs.includes(input)) return input;
  const lo = input.toLowerCase();
  if (input === "A" || lo === "always") return verbs.find((v) => v === "always");
  if (["a", "allow", "y", "yes", "approve", "ok"].includes(lo)) return verbs.find((v) => /allow|approve/.test(v));
  if (["d", "deny", "n", "no", "reject"].includes(lo)) return verbs.find((v) => /deny|reject/.test(v));
  return undefined;
}
