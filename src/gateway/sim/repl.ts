import { SimSession } from "./engine";
import { PRESETS, getPreset } from "./presets";
import type { OutboundCard } from "./transport";

/** Transport-agnostic REPL logic: feed it command lines, it emits output lines.
 *  cli.ts wires this to stdin/stdout. */
export class ReplController {
  #session?: SimSession;
  #out: (line: string) => void = () => {};
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
    if (cmd?.startsWith("/")) { this.#out(`unknown command: ${cmd}`); return; }
    await this.#requireSession().send({ text: trimmed });
    this.#dumpCards();
  }

  #listScenarios() { this.#out("Scenarios:\n" + PRESETS.map((p, i) => `  ${i + 1}) ${p.name} — ${p.title}`).join("\n")); }

  async #loadScenario(sel: string) {
    await this.#session?.dispose();
    const effectiveSel = sel || "1";
    this.#session = await SimSession.create({ preset: effectiveSel, agent: "stub" });
    const s = this.#session;
    const preset = getPreset(effectiveSel);
    const name = preset?.name ?? effectiveSel;
    this.#out(`loaded ${name} — as ${s.actor} in ${s.channel}${s.dm ? " (dm)" : ""}, behavior=${s.behavior}`);
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
    this.#dumpCards();
  }

  #dumpCards() {
    const s = this.#requireSession();
    s.cards().forEach((c: OutboundCard, i) => {
      const buttons = c.actionIds.map((a) => a.split(":")[1]).join(" | ");
      this.#out(`[card ${i + 1}] ${c.kind}${c.resolved ? " (resolved)" : ""} ${c.text ?? ""}${buttons ? `  [${buttons}]` : ""}`);
    });
  }

  #requireSession(): SimSession { if (!this.#session) throw new Error("no scenario loaded — use /scenario <n>"); return this.#session; }

  async dispose() { await this.#session?.dispose(); this.#session = undefined; }
}
