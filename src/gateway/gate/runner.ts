import "../../decision/adapters/index";
import { parseDecisionConfig } from "../../decision/config";
import { adapterFromConfig, decide } from "../../decision/registry";
import { DecisionError, type DecisionAdapter } from "../../decision/types";
import { env } from "../../config/env";
import { m } from "../../metrics";
import { decideAction, rulesDecision } from "./policy";
import { questionsFor, toGateDecision } from "./questions";
import type { Answer, GateAction, GateDecision, GateInput, ImplicitLevel } from "./types";

export type GateMode = "off" | "shadow" | "on";

export interface GateResult {
  action: GateAction;
  mode: GateMode;
  source: "adapter" | "rules";
  adapter: string | null;
  decision: GateDecision;
  latencyMs: number;
  implicit?: GateInput["implicit"];
  continuation?: boolean;
  /** Why no model answered (implicit consults and the rules path): no adapter, a timeout, or another failure. */
  why?: "noadapter" | "timeout" | "error";
}

/** The flags a memoised decision must have been made under to be reused. */
interface Want {
  implicit?: ImplicitLevel;
  continuation: boolean;
}
const NOT_IMPLICIT: Want = { continuation: false };
const matches = (r: GateResult, w: Want) => r.implicit === w.implicit && !!r.continuation === w.continuation;

/**
 * What a consult settled on. `adapter`: a model answered. `rules`: no model
 * answer, today's rules decided (never for an implicit consult, which drops
 * instead). `shadow`: shadow mode, the caller's own `actual` is returned.
 */
export interface GateConsult {
  action: GateAction;
  source: "adapter" | "rules" | "shadow";
}

export interface GateRunner {
  readonly mode: GateMode;
  readonly contextMessages: number;
  /** The decision config's deadline for the whole input-and-answer path, in ms (phase 2 awaits an implicit consult within it). */
  readonly timeoutMs?: number;
  /** Whether a decision adapter is configured (an implicit consult answers from it whatever the mode). */
  readonly hasAdapter: boolean;
  /** off → undefined (caller keeps today's path). shadow → resolves `actual` immediately; the decision runs detached and is logged. on → the decided action. */
  gate(key: string, input: () => Promise<GateInput>, actual: GateAction): Promise<GateAction | undefined>;
  /**
   * `gate` with the source of the answer, for the mention paths. Honors the
   * deployment mode exactly as `gate` does.
   */
  consult(key: string, input: () => Promise<GateInput>, actual: GateAction): Promise<GateConsult | undefined>;
  /**
   * An implicit-engagement consult. Independent of the deployment mode: it is
   * awaited and answers from the adapter whenever one is configured, even
   * with the gate off or in shadow (the channel's own engage mode decides
   * whether to act). `input` must build a GateInput with `implicit` set to
   * `want.level` and `continuation` equal to `want.continuation`; a memoised
   * decision made under other flags is never reused. `quiet` (a shadow
   * consult, which nothing acts on) counts no gate decision and prints no
   * `[gate] mode=...` line: the caller records its own outcome. No adapter, an adapter
   * error, a timeout or an input failure is a pass: undefined, or a "drop"
   * with source "rules". It never returns "run" without a model answer.
   */
  consultImplicit(
    key: string,
    input: () => Promise<GateInput>,
    want: { level: ImplicitLevel; continuation: boolean; quiet?: boolean },
  ): Promise<{ action: "run" | "drop"; source: "adapter" | "rules"; why?: "noadapter" | "timeout" | "error" } | undefined>;
}

/**
 * The decision memo key: one decision per message, persona, app and flavour.
 * Two personas (or two apps delivering the same event) must not share a
 * memoised answer, and an implicit or continuation consult asks a different
 * question of the same message than a mention does.
 */
export function gateKey(o: { channel: string; ts: string; persona?: string; app?: string; continuation?: boolean; implicit?: string }): string {
  return `${o.channel}:${o.ts}:p=${o.persona ?? "-"}:a=${o.app ?? "-"}:c=${o.continuation ? 1 : 0}:i=${o.implicit ?? "-"}`;
}

const fmt = (a: Answer) => `${a.value ? "yes" : "no"}:${a.confidence.toFixed(2)}`;

/** One line per decision; shadow adds what actually happened. Never carries message text. */
function logLine(key: string, r: GateResult, actual: GateAction): string {
  const d = r.decision;
  return (
    `[gate] mode=${r.mode} source=${r.source} adapter=${r.adapter ?? "-"} action=${r.action} ms=${r.latencyMs} key=${key} ` +
    (r.implicit ? `implicit=${r.implicit} ` : "") +
    // An implicit decision never prints rules answers as if a model gave them
    // (the mention paths keep their long-standing line).
    (r.source === "adapter" || !r.implicit
      ? `a=${fmt(d.addressedToAgent)} q=${fmt(d.isQuestionOrRequest)} h=${fmt(d.agentCanHelp)} d=${fmt(d.alreadyAnswered)}`
      : "a=- q=- h=- d=-") +
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
  async function compute(key: string, input: () => Promise<GateInput>, actual: GateAction, quiet = false): Promise<GateResult> {
    const t0 = Date.now();
    const gi = await boundedInput(input, o.timeoutMs);
    let decision: GateDecision | null = null;
    let why: GateResult["why"] = o.adapter ? undefined : "noadapter";
    if (o.adapter) {
      try {
        // decide() applies the (remaining) timeout, validates and counts the request.
        const left = Math.max(1, o.timeoutMs - (Date.now() - t0));
        decision = toGateDecision(await decide(o.adapter, { state: gi, questions: questionsFor(gi) }, left));
      } catch (e) {
        decision = null; // fall back to rules; an error is never read as "no"
        why = e instanceof DecisionError && e.kind === "timeout" ? "timeout" : "error";
      }
    }
    const source = decision ? "adapter" : "rules";
    // An implicit consult has no rules fallback: the rules read every candidate
    // as an open request, which at `contribute` would run on every message
    // during an outage. No model answer is a drop.
    const implicitNoAnswer = !!gi.implicit && !decision;
    const d = decision ?? rulesDecision(gi);
    const r: GateResult = {
      action: implicitNoAnswer ? "drop" : decideAction(gi, d, o.tAct),
      ...(gi.implicit ? { implicit: gi.implicit, continuation: !!gi.continuation } : {}),
      mode: o.mode,
      source,
      adapter: o.adapter?.name ?? null,
      decision: d,
      latencyMs: Date.now() - t0,
      ...(!decision && why ? { why } : {}),
    };
    if (!quiet) {
      m.gateDecisionsTotal.inc({ action: r.action, source: r.source, mode: r.mode });
      log(logLine(key, r, actual));
    }
    return r;
  }

  /** The shared in-flight decision for key, and whether this call started it. */
  function decision(key: string, input: () => Promise<GateInput>, actual: GateAction, want: Want, quiet = false): { p: Promise<GateResult>; fresh: boolean } {
    const hit = memo.get(key);
    // A stored decision made under other flags (a mention's under an implicit
    // consult, a continuation's under a fresh message) is a miss: recomputed,
    // not shared and not stored.
    if (hit) return { p: hit.then((r) => (matches(r, want) ? r : compute(key, input, actual, quiet))), fresh: false };
    const p = compute(key, input, actual, quiet);
    memo.set(key, p);
    const evict = () => {
      if (memo.get(key) === p) memo.delete(key);
    };
    setTimeout(evict, ttl).unref?.();
    p.catch(evict); // a failed or timed-out input build may be retried by a later delivery
    return { p, fresh: true };
  }

  const consult: GateRunner["consult"] = async (key, input, actual) => {
    if (o.mode === "off") return undefined;
    const { p, fresh } = decision(key, input, actual, NOT_IMPLICIT);
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
      return { action: actual, source: "shadow" };
    }
    try {
      const r = await p;
      return { action: r.action, source: r.source };
    } catch (e) {
      log(e instanceof InputTimeout ? `[gate] input timeout key=${key}` : `[gate] mode=on input failed key=${key}; keeping today's path`);
      return undefined;
    }
  };
  return {
    mode: o.mode,
    contextMessages: o.contextMessages,
    timeoutMs: o.timeoutMs,
    hasAdapter: o.adapter !== null,
    consult,
    async consultImplicit(key, input, want) {
      try {
        const r = await decision(key, input, "drop", { implicit: want.level, continuation: want.continuation }, want.quiet).p;
        // A decision not made as an implicit one is never read as a yes.
        if (!matches(r, { implicit: want.level, continuation: want.continuation })) return undefined;
        return { action: r.action === "run" ? "run" : "drop", source: r.source, ...(r.why ? { why: r.why } : {}) };
      } catch (e) {
        log(e instanceof InputTimeout ? `[gate] input timeout key=${key}` : `[gate] implicit input failed key=${key}`);
        return undefined;
      }
    },
    async gate(key, input, actual) {
      return (await consult(key, input, actual))?.action;
    },
  };
}

/** Builds the gate from SLAUDE_DECISION_CONFIG. Never throws over the config; a problem leaves the gate off. */
export async function gateRunnerFromEnv(deps: { resolveSecret: (ref: string) => Promise<string> }): Promise<GateRunner> {
  const { config, error } = parseDecisionConfig(env.decisionConfigRaw());
  if (error) console.warn(`[gate] ${error}; decision gate off`);
  const { mode, tAct, contextMessages } = config.gate;
    // Implicit engagement answers from the adapter whatever the gate mode, so a
  // configured adapter is built even with the gate off. With the gate off and
  // no adapter configured nothing is built or resolved, as before.
  const adapter = mode === "off" && config.adapter === null ? null : await adapterFromConfig(config.adapter, deps);
  return makeGateRunner({ mode, adapter, tAct, timeoutMs: config.timeoutMs, contextMessages });
}
