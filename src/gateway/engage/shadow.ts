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

export type ShadowReason = ClassifierVerdict["reason"] | "budget" | "breaker" | "pass_memory" | "cooldown";

/** The ladder reasons where the message used the agent's name (a classifier "no" earlier does not cover these). */
export const NAME_USED_REASONS: ReadonlySet<string> = new Set(["name_mid", "name_colon", "same_named_human", "name_no_request_shape"]);

export interface ShadowDeps {
  /** null: no adapter is configured. */
  classifier: EngageClassifier | null;
  /** Builds the classifier's input for this delivery (the one Slack read happens here). */
  buildInput: (req: { level: ImplicitLevel; continuation: boolean; thread: string | null }) => Promise<BuiltInput>;
  state?: EngageState;
  breaker?: CircuitBreaker;
  /** The classifier call's own deadline (default 15 s). */
  deadlineMs?: number;
  /** Runs the job later; the default is a zero timer, or the root debounce when there is one. */
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

/** Put a candidate to the classifier in the background. Returns at once; never throws. */
export function scheduleShadow(c: ShadowCandidate, d: ShadowDeps): void {
  const run = async (): Promise<void> => {
    try {
      await job(c, d);
    } catch {
      /* the shadow classifier must never fail anything */
    }
  };
  const delay = c.result.debounceMs ?? 0;
  const job0 = () => {
    const p = run().finally(() => inflight.delete(p));
    inflight.add(p);
    return p;
  };
  const schedule = d.schedule ?? ((fn, ms) => void setTimeout(() => void fn(), ms).unref?.());
  schedule(job0, delay);
}

async function job(c: ShadowCandidate, d: ShadowDeps): Promise<ShadowOutcome | null> {
  const t0 = Date.now();
  const state = d.state ?? engageState();
  const breaker = d.breaker ?? engageBreaker();
  const log = d.log ?? ((l: string) => console.log(l));
  const sample = c.result.tier === 2;
  const tier = c.result.tier;
  const done = (action: "run" | "pass", reason: ShadowReason): ShadowOutcome => {
    metric.engageClassifierTotal.inc({ result: action, reason, level: c.level });
    const ms = Date.now() - t0;
    log(`[gate] engage implicit=${c.level} tier=${tier} action=${action} actual=pass reason=${reason} ms=${ms} key=${c.channel}:${c.ts}${sample ? " sampled=1" : ""}`);
    return { action, reason, ms };
  };

  // One app copy owns the call: the others do nothing and count nothing.
  if (!(await state.claim(c.channel, c.ts))) return null;
  if (!d.classifier) return sample ? null : done("pass", "noadapter");
  if (sample && !(await state.sample(c.channel))) return null;

  const nameUsed = NAME_USED_REASONS.has(c.result.reason);
  if (!sample && !nameUsed) {
    if (c.thread ? await state.passed(c.channel, c.thread, c.author) : await state.cooling(c.channel)) return done("pass", c.thread ? "pass_memory" : "cooldown");
  }
  if (!breaker.allow()) return done("pass", "breaker");
  if ((await state.spend(c.channel)) !== "ok") {
    breaker.release();
    return done("pass", "budget");
  }

  const continuation = sample || c.result.reason === "follower_failed_test";
  let built: BuiltInput | null = null;
  let verdict: ClassifierVerdict;
  try {
    verdict =
      (await withDeadline(
        (d.classifier.classifyDetailed
          ? d.classifier.classifyDetailed.bind(d.classifier)
          : async (x: Parameters<EngageClassifier["classify"]>[0]): Promise<ClassifierVerdict> => ({ answer: await d.classifier!.classify(x), reason: "answer" }))({
          channel: c.channel,
          ts: c.ts,
          persona: c.persona,
          app: c.app,
          level: c.level,
          // Whatever the channel's mode, phase 1 never acts: the candidate is always a shadow one.
          mode: "shadow",
          continuation,
          input: async () => {
            built = await d.buildInput({ level: c.level, continuation, thread: c.thread });
            return built.input;
          },
        }),
        d.deadlineMs ?? 15_000,
        { answer: "pass", reason: "timeout" } as ClassifierVerdict,
      ));
  } catch {
    verdict = { answer: "pass", reason: "error" };
  }
  if (verdict.reason === "timeout" || verdict.reason === "error") breaker.failure();
  else if (verdict.reason === "answer") breaker.success();
  else breaker.release();
  const b = built as BuiltInput | null;
  if (b?.alternated && c.thread) void state.markAlternated(c.channel, c.thread).catch(() => {});
  if (verdict.reason === "answer" && verdict.answer === "pass" && !sample) {
    if (c.thread) void state.markPass(c.channel, c.thread, c.author).catch(() => {});
    else void state.markCooldown(c.channel).catch(() => {});
  }
  return done(verdict.answer, verdict.reason);
}
