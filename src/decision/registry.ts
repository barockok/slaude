import { m } from "../metrics";
import { DecisionError, type DecisionAdapter, type DecisionRequest, type DecisionResult } from "./types";

export interface AdapterDeps {
  resolveSecret: (ref: string) => Promise<string>;
}

/** Builds an adapter from its config block; throws on an invalid block. */
export type AdapterFactory = (block: Record<string, unknown>, deps: AdapterDeps) => Promise<DecisionAdapter>;

const factories = new Map<string, AdapterFactory>();

export function registerAdapter(type: string, factory: AdapterFactory): void {
  factories.set(type, factory);
}

/**
 * Resolve the configured adapter. Returns null for an absent block, an unknown
 * type, a factory throw or a secret failure; logs once with the type name only
 * (never the block, an error message or any value).
 */
export async function adapterFromConfig(block: unknown, deps: AdapterDeps): Promise<DecisionAdapter | null> {
  if (block === undefined || block === null) return null;
  if (typeof block !== "object" || Array.isArray(block)) {
    console.warn("[decision] adapter config is not an object; adapter disabled");
    return null;
  }
  const b = block as Record<string, unknown>;
  const type = typeof b.type === "string" ? b.type : "";
  const factory = factories.get(type);
  if (!factory) {
    console.warn(`[decision] unknown adapter type "${type.slice(0, 40)}"; adapter disabled`);
    return null;
  }
  try {
    return await factory(b, deps);
  } catch {
    // The error text may carry a value; log the type only.
    console.warn(`[decision] adapter "${type}" failed to initialise (invalid config or unresolved secret); adapter disabled`);
    return null;
  }
}

function validate(req: DecisionRequest, res: unknown): DecisionResult {
  const bad = (why: string) => new DecisionError("bad_output", why);
  if (!res || typeof res !== "object" || Array.isArray(res)) throw bad("result is not an object");
  const r = res as Record<string, unknown>;
  const ids = Object.keys(req.questions);
  for (const k of Object.keys(r)) if (!(k in req.questions)) throw bad(`unexpected answer "${k}"`);
  const out: DecisionResult = {};
  for (const id of ids) {
    const a = r[id] as { choice?: unknown; confidence?: unknown } | undefined;
    if (!a || typeof a !== "object") throw bad(`missing answer "${id}"`);
    if (typeof a.choice !== "string" || !Object.prototype.hasOwnProperty.call(req.questions[id]!.options, a.choice)) {
      throw bad(`answer "${id}" is not a declared option`);
    }
    if (typeof a.confidence !== "number" || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) {
      throw bad(`answer "${id}" has an out-of-range confidence`);
    }
    out[id] = { choice: a.choice, confidence: a.confidence };
  }
  return out;
}

/** Ask the adapter, bounded by timeoutMs; validates the answers against the request. */
export async function decide(adapter: DecisionAdapter, req: DecisionRequest, timeoutMs: number): Promise<DecisionResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DecisionError("timeout", `decision timed out after ${timeoutMs}ms`));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    const raw = await Promise.race([adapter.decide(req, signal), aborted]);
    const result = validate(req, raw);
    m.decisionRequestsTotal.inc({ adapter: adapter.name, outcome: "ok" });
    return result;
  } catch (e) {
    let err: DecisionError;
    if (e instanceof DecisionError) err = e;
    else if (signal.aborted) err = new DecisionError("timeout", `decision timed out after ${timeoutMs}ms`);
    else err = new DecisionError("transport", "adapter call failed");
    m.decisionRequestsTotal.inc({ adapter: adapter.name, outcome: err.kind === "timeout" ? "timeout" : "error" });
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
