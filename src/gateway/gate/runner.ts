import "../../decision/adapters/index";
import { parseDecisionConfig } from "../../decision/config";
import { adapterFromConfig, decide } from "../../decision/registry";
import type { DecisionAdapter } from "../../decision/types";
import { env } from "../../config/env";
import { m } from "../../metrics";
import { decideAction, rulesDecision } from "./policy";
import { GATE_QUESTIONS, toGateDecision } from "./questions";
import type { Answer, GateAction, GateDecision, GateInput } from "./types";

export type GateMode = "off" | "shadow" | "on";

export interface GateResult {
  action: GateAction;
  mode: GateMode;
  source: "adapter" | "rules";
  adapter: string | null;
  decision: GateDecision;
  latencyMs: number;
}

export interface GateRunner {
  readonly mode: GateMode;
  readonly contextMessages: number;
  /** off → undefined (caller keeps today's path). shadow → resolves "run" immediately; the decision runs detached and is logged. on → the decided action. */
  gate(key: string, input: () => Promise<GateInput>, actual: GateAction): Promise<GateAction | undefined>;
}

const fmt = (a: Answer) => `${a.value ? "yes" : "no"}:${a.confidence.toFixed(2)}`;

/** One line per decision; shadow adds what actually happened. Never carries message text. */
function logLine(key: string, r: GateResult, actual: GateAction): string {
  const d = r.decision;
  return (
    `[gate] mode=${r.mode} source=${r.source} adapter=${r.adapter ?? "-"} action=${r.action} ms=${r.latencyMs} key=${key} ` +
    `a=${fmt(d.addressedToAgent)} q=${fmt(d.isQuestionOrRequest)} h=${fmt(d.agentCanHelp)} d=${fmt(d.alreadyAnswered)}` +
    (r.mode === "shadow" ? ` actual=${actual}` : "")
  );
}

/** The input builder did not finish inside the decision deadline. */
class InputTimeout extends Error {}

/** input(), bounded by ms; a late settle is swallowed so it can never be an unhandled rejection. */
function boundedInput(input: () => Promise<GateInput>, ms: number): Promise<GateInput> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const p = Promise.resolve().then(input);
  p.catch(() => {});
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InputTimeout()), ms);
  });
  return Promise.race([p, expiry]).finally(() => clearTimeout(timer));
}

export function makeGateRunner(o: {
  mode: GateMode;
  adapter: DecisionAdapter | null;
  tAct: number;
  timeoutMs: number;
  contextMessages: number;
  log?: (line: string) => void;
  memoTtlMs?: number;
}): GateRunner {
  const log = o.log ?? ((l: string) => console.log(l));
  const ttl = o.memoTtlMs ?? 60_000;
  const memo = new Map<string, Promise<GateResult>>();

  /** The whole path (input + decide) is bounded by timeoutMs. */
  async function compute(key: string, input: () => Promise<GateInput>, actual: GateAction): Promise<GateResult> {
    const t0 = Date.now();
    const gi = await boundedInput(input, o.timeoutMs);
    let decision: GateDecision | null = null;
    if (o.adapter) {
      try {
        // decide() applies the (remaining) timeout, validates and counts the request.
        const left = Math.max(1, o.timeoutMs - (Date.now() - t0));
        decision = toGateDecision(await decide(o.adapter, { state: gi, questions: GATE_QUESTIONS }, left));
      } catch {
        decision = null; // fall back to rules; an error is never read as "no"
      }
    }
    const source = decision ? "adapter" : "rules";
    const d = decision ?? rulesDecision(gi);
    const r: GateResult = {
      action: decideAction(gi, d, o.tAct),
      mode: o.mode,
      source,
      adapter: o.adapter?.name ?? null,
      decision: d,
      latencyMs: Date.now() - t0,
    };
    m.gateDecisionsTotal.inc({ action: r.action, source: r.source, mode: r.mode });
    log(logLine(key, r, actual));
    return r;
  }

  /** The shared in-flight decision for key, and whether this call started it. */
  function decision(key: string, input: () => Promise<GateInput>, actual: GateAction): { p: Promise<GateResult>; fresh: boolean } {
    const hit = memo.get(key);
    if (hit) return { p: hit, fresh: false };
    const p = compute(key, input, actual);
    memo.set(key, p);
    const evict = () => {
      if (memo.get(key) === p) memo.delete(key);
    };
    setTimeout(evict, ttl).unref?.();
    p.catch(evict); // a failed or timed-out input build may be retried by a later delivery
    return { p, fresh: true };
  }

  return {
    mode: o.mode,
    contextMessages: o.contextMessages,
    async gate(key, input, actual) {
      if (o.mode === "off") return undefined;
      const { p, fresh } = decision(key, input, actual);
      if (o.mode === "shadow") {
        // Detached: dispatch never waits, and nothing can escape as an unhandled rejection.
        void p
          .then((r) => {
            if (fresh && r.action !== actual) m.gateShadowDisagreeTotal.inc({ would: r.action, actual });
          })
          .catch((e) => {
            try {
              log(e instanceof InputTimeout ? `[gate] input timeout key=${key}` : `[gate] mode=shadow input failed key=${key}`);
            } catch {
              // a throwing logger must not become an unhandled rejection
            }
          });
        // Shadow acts exactly as off.
        return actual;
      }
      try {
        return (await p).action;
      } catch (e) {
        log(e instanceof InputTimeout ? `[gate] input timeout key=${key}` : `[gate] mode=on input failed key=${key}; keeping today's path`);
        return undefined;
      }
    },
  };
}

/** Builds the gate from SLAUDE_DECISION_CONFIG. Never throws over the config; a problem leaves the gate off. */
export async function gateRunnerFromEnv(deps: { resolveSecret: (ref: string) => Promise<string> }): Promise<GateRunner> {
  const { config, error } = parseDecisionConfig(env.decisionConfigRaw());
  if (error) console.warn(`[gate] ${error}; decision gate off`);
  const { mode, tAct, contextMessages } = config.gate;
  // An off gate never calls an adapter, so it resolves no secret either.
  const adapter = mode === "off" ? null : await adapterFromConfig(config.adapter, deps);
  return makeGateRunner({ mode, adapter, tAct, timeoutMs: config.timeoutMs, contextMessages });
}
