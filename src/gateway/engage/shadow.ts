/**
 * Phase 1 of implicit engagement: the shadow classifier. After the ladder has
 * run, a tier 3 candidate (and a capped sample of tier 2 run decisions) is
 * put to the classifier and the answer is counted and logged. NOTHING ACTS ON
 * IT: the candidate is always handed to the classifier in shadow mode, whatever
 * the channel's mode, and the handler never waits for the job.
 *
 * Order inside a job (each step ends it as a counted pass, never a run):
 *   claim (one app copy owns the message) -> tier 2 sample draw -> pass memory
 *   and root cooldown (unless the name was used) -> breaker -> budget ->
 *   input (one Slack read) -> classifier (own deadline).
 * With no classifier (no adapter) a tier 3 candidate is a counted `noadapter`
 * pass before anything else: no input is built and no Slack read is made.
 * The job never throws and never sees message text in a log line.
 */
import { m as metric } from "../../metrics";
import { engageBreaker, engageState, type CircuitBreaker, type EngageState } from "./budget";
import type { BuiltInput } from "./input";
import type { TierResult } from "./tiers";
import type { ClassifierVerdict, EngageClassifier } from "./types";
import type { ImplicitLevel } from "../gate/types";

export type ShadowReason = ClassifierVerdict["reason"] | "budget" | "breaker" | "pass_memory" | "cooldown" | "answered" | "stale";

/** The ladder reasons where the message used the agent's name (a classifier "no" earlier does not cover these). */
export const NAME_USED_REASONS: ReadonlySet<string> = new Set(["name_mid", "name_colon", "same_named_human", "name_no_request_shape"]);

export interface ShadowDeps {
  /** null: no adapter is configured. */
  classifier: EngageClassifier | null;
  /** Builds the classifier's input for this delivery (the one Slack read happens here). */
  buildInput: (req: { level: ImplicitLevel; continuation: boolean; thread: string | null }) => Promise<BuiltInput>;
  /**
   * Whether the ingress would hear this message (a blocked or ignored author, a
   * /1on1 or other lock, a command). Asked before the budget is spent: false or
   * a throw is a counted `input` pass that costs nothing.
   */
  admit?: () => Promise<boolean>;
  /**
   * After a debounce, whether the message is still worth asking about: "answered"
   * (a human other than the author replied) or "stale" (deleted or edited). A throw reads as `input`.
   */
  recheck?: () => Promise<"ok" | "answered" | "stale">;
  /**
   * Phase 2 (the channel's mode is on): the candidate is a real one, not a shadow one. The answer
   * is the one the caller acts on, the gate counts the decision, and the log line says the outcome is pending.
   */
  acting?: boolean;
  /** Phase 2, a debounced candidate: called after a model "run" answer, from the timer, in place of the caller awaiting the outcome. */
  onRun?: () => Promise<void>;
  /** Slack team, for the tenant part of the budget keys. */
  tenant?: string;
  /** Aborted when the gateway stops: pending timers are cancelled and their jobs dropped. */
  signal?: AbortSignal;
  state?: EngageState;
  breaker?: CircuitBreaker;
  /** The classifier call's own deadline (default 15 s). */
  deadlineMs?: number;
  /** Runs the job later; the default is a timer (zero, or the root debounce when there is one). */
  schedule?: (job: () => Promise<void>, delayMs: number) => void;
  log?: (line: string) => void;
}

export interface ShadowCandidate {
  channel: string;
  ts: string;
  /** The thread the message is in; null for a root message. */
  thread: string | null;
  author: string;
  level: ImplicitLevel;
  persona?: string;
  app?: string;
  result: TierResult;
}

export interface ShadowOutcome {
  action: "run" | "pass";
  reason: ShadowReason;
  ms: number;
}

const inflight = new Set<Promise<unknown>>();
/** Resolves when every scheduled shadow job has finished (tests). */
export async function shadowIdle(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

/** What the `[engage]` line says about the classifier for a result, before anything runs. */
export function plan(r: TierResult, d: ShadowDeps | undefined): { kind: "tier3" | "sample" } | { skip: string } {
  if (!d) return { skip: "disabled" };
  if (r.action === "classify") return { kind: "tier3" };
  if (r.tier === 2 && r.action === "run") return { kind: "sample" };
  return { skip: "not_candidate" };
}

const withDeadline = <T>(p: Promise<T>, ms: number, onLate: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {});
  return Promise.race([p, new Promise<T>((r) => { timer = setTimeout(() => r(onLate), ms); })]).finally(() => clearTimeout(timer));
};

let debounceOverride: number | null = null;
/** TEST SEAM: replace the root debounce (null restores it). */
export function __setDebounceForTests(ms: number | null): void {
  debounceOverride = ms;
}

/** Put a candidate to the classifier in the background. Returns at once; never throws. */
export function scheduleShadow(c: ShadowCandidate, d: ShadowDeps): void {
  const run = async (): Promise<void> => {
    try {
      if (d.signal?.aborted) return;
      await job(c, d);
    } catch {
      /* the shadow classifier must never fail anything */
    }
  };
  const delay = c.result.debounceMs === undefined ? 0 : (debounceOverride ?? c.result.debounceMs);
  const job0 = () => {
    const p = run().finally(() => inflight.delete(p));
    inflight.add(p);
    return p;
  };
  const schedule =
    d.schedule ??
    ((fn, ms) => {
      const timer = setTimeout(() => void fn(), ms);
      timer.unref?.();
      d.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
    });
  schedule(job0, delay);
}

/**
 * The classifier job for one candidate, awaited by the caller (phase 2 acts on its
 * outcome). `null`: this copy does not own the call (another copy of the persona does), or the gateway is stopping.
 */
export async function runCandidate(c: ShadowCandidate, d: ShadowDeps): Promise<ShadowOutcome | null> {
  return job(c, d);
}

async function job(c: ShadowCandidate, d: ShadowDeps): Promise<ShadowOutcome | null> {
  const t0 = Date.now();
  const state = d.state ?? engageState();
  const breaker = d.breaker ?? engageBreaker();
  const log = d.log ?? ((l: string) => console.log(l));
  const sample = c.result.tier === 2;
  const tier = c.result.tier;
  const persona = c.persona ?? "default";
  const done = (action: "run" | "pass", reason: ShadowReason): ShadowOutcome => {
    metric.engageClassifierTotal.inc({ result: action, reason, level: c.level });
    const ms = Date.now() - t0;
    log(`[gate] engage implicit=${c.level} tier=${tier} action=${action} actual=${d.acting ? "pending" : "pass"} reason=${reason} ms=${ms} key=${c.channel}:${c.ts}${sample ? " sampled=1" : ""}`);
    return { action, reason, ms };
  };

  // A tier 2 sample is drawn first: a draw that misses must not take the message's claim from anyone.
  if (sample) {
    if (!d.classifier) return null;
    if (!(await state.sample(c.channel, d.tenant))) return null;
  }
  // One app copy of this persona owns the call: its other copies do nothing and count nothing.
  if (!(await state.claim(c.channel, c.ts, persona))) return null;
  if (!d.classifier) return done("pass", "noadapter");

  const nameUsed = NAME_USED_REASONS.has(c.result.reason);
  if (!sample && !nameUsed) {
    if (c.thread ? await state.passed(c.channel, c.thread, persona, c.author) : await state.cooling(c.channel, persona)) return done("pass", c.thread ? "pass_memory" : "cooldown");
  }
  const ticket = breaker.allow();
  if (!ticket) return done("pass", "breaker");

  // Nothing here costs budget: a message the ingress would not hear, or one that went stale while it waited.
  try {
    if (d.admit && !(await d.admit())) {
      breaker.release(ticket);
      return done("pass", "input");
    }
    if (c.result.debounceMs !== undefined && d.recheck) {
      const r = await d.recheck();
      if (r !== "ok") {
        breaker.release(ticket);
        return done("pass", r);
      }
    }
  } catch {
    breaker.release(ticket);
    return done("pass", "input");
  }
  if (d.signal?.aborted) {
    breaker.release(ticket);
    return null;
  }
  if ((await state.spend(c.channel, d.tenant)) !== "ok") {
    breaker.release(ticket);
    return done("pass", "budget");
  }

  const continuation = sample || c.result.reason === "follower_failed_test";
  let built: BuiltInput | null = null;
  let verdict: ClassifierVerdict;
  try {
    const classifyDetailed = d.classifier.classifyDetailed
      ? d.classifier.classifyDetailed.bind(d.classifier)
      : async (x: Parameters<EngageClassifier["classify"]>[0]): Promise<ClassifierVerdict> => ({ answer: await d.classifier!.classify(x), reason: "answer" });
    verdict = await withDeadline(
      classifyDetailed({
        channel: c.channel,
        ts: c.ts,
        persona: c.persona,
        app: c.app,
        level: c.level,
        // In shadow (phase 1) the candidate is always a shadow one; only a channel whose mode is on acts.
        mode: d.acting ? "on" : "shadow",
        continuation,
        input: async () => {
          built = await d.buildInput({ level: c.level, continuation, thread: c.thread });
          return built.input;
        },
      }),
      d.deadlineMs ?? 15_000,
      { answer: "pass", reason: "timeout" } as ClassifierVerdict,
    );
  } catch {
    verdict = { answer: "pass", reason: "error" };
  }
  if (verdict.reason === "timeout" || verdict.reason === "error") breaker.failure(ticket);
  else if (verdict.reason === "answer") breaker.success(ticket);
  else breaker.release(ticket);
  const b = built as BuiltInput | null;
  if (b?.alternated && c.thread) void state.markAlternated(c.channel, c.thread).catch(() => {});
  if (verdict.reason === "answer" && verdict.answer === "pass" && !sample) {
    if (c.thread) void state.markPass(c.channel, c.thread, persona, c.author).catch(() => {});
    else void state.markCooldown(c.channel, persona).catch(() => {});
  }
  const out = done(verdict.answer, verdict.reason);
  if (d.onRun && !sample && out.action === "run" && out.reason === "answer") {
    try {
      await d.onRun();
    } catch {
      /* acting is the caller's; it logs its own failures */
    }
  }
  return out;
}
