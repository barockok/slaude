/**
 * Jev adapter (TypeSafe AI System One). Maps the neutral decision request to
 * one Jev "choice" question per neutral question and maps the answers back.
 * Never logs the API key or a request body.
 */
import { z } from "zod";
import { safeFetch, type OutboundPolicyOptions } from "../../net/outbound-policy";
import { parseRef } from "../../secrets";
import { registerAdapter } from "../registry";
import { DecisionError, type DecisionAdapter, type DecisionRequest, type DecisionResult } from "../types";

export const JEV_DEFAULT_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
const DEFAULT_BUDGET_MS = 800;

export interface JevOpts {
  url: string;
  apiKey: string;
  model: string;
  outboundOpts?: OutboundPolicyOptions;
  /** Local heuristic for the retry-after check; decide()'s own timeout is the hard bound. */
  budgetMs?: number;
}

function statusError(status: number): DecisionError {
  if (status === 401) return new DecisionError("auth", "Jev rejected the credentials (401)");
  if (status === 422) return new DecisionError("invalid_request", "Jev rejected the request (422)");
  if (status === 429) return new DecisionError("rate_limited", "Jev rate limited the request (429)");
  if (status === 529) return new DecisionError("overloaded", "Jev is overloaded (529)");
  return new DecisionError("transport", `Jev returned HTTP ${status}`);
}

function retryAfterMs(h: string | null): number | null {
  if (h === null) return null;
  const s = Number(h.trim());
  return h.trim() !== "" && Number.isFinite(s) && s >= 0 ? s * 1000 : null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DecisionError("timeout", "decision aborted"));
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DecisionError("timeout", "decision aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function makeJevAdapter(o: JevOpts): DecisionAdapter {
  const budgetMs = o.budgetMs ?? DEFAULT_BUDGET_MS;

  async function post(body: string, signal: AbortSignal) {
    try {
      return await safeFetch(
        o.url,
        { method: "POST", headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" }, body, signal },
        o.outboundOpts,
      );
    } catch (e) {
      if (signal.aborted) throw new DecisionError("timeout", "decision aborted");
      // safeFetch messages are address-free; surface the cause without the URL query.
      throw new DecisionError("transport", e instanceof Error ? e.message : "request failed");
    }
  }

  return {
    name: "jev",
    async decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      const startedAt = Date.now();
      const questions: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        questions[id] = { type: "choice", instructions: q.instructions, criteria: q.options };
      }
      const body = JSON.stringify({ model: o.model, state: req.state, questions });

      let res = await post(body, signal);
      if (res.status === 429 || res.status === 529) {
        const wait = retryAfterMs(res.headers.get("retry-after"));
        const remaining = budgetMs - (Date.now() - startedAt);
        if (wait === null || wait >= remaining) throw statusError(res.status);
        await sleep(wait, signal);
        res = await post(body, signal);
      }
      if (res.status < 200 || res.status >= 300) throw statusError(res.status);

      let parsed: unknown;
      try { parsed = await res.json(); } catch { throw new DecisionError("bad_output", "Jev response is not JSON"); }
      const bad = (why: string) => new DecisionError("bad_output", why);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw bad("Jev response is not an object");
      const envelope = parsed as Record<string, unknown>;
      const answers = (envelope.answers && typeof envelope.answers === "object" ? envelope.answers : envelope) as Record<string, any>;

      const out: DecisionResult = {};
      for (const id of Object.keys(req.questions)) {
        const a = answers[id];
        if (!a || typeof a !== "object" || typeof a.choice !== "string" || typeof a.confidence !== "number") {
          throw bad(`Jev answer "${id}" is missing or malformed`);
        }
        out[id] = { choice: a.choice, confidence: a.confidence };
      }
      return out;
    },
  };
}

const blockSchema = z
  .object({
    type: z.literal("jev"),
    url: z.string().url().optional(),
    model: z.string().min(1).optional(),
    apiKey: z.string(),
  })
  .strict();

registerAdapter("jev", async (block, deps) => {
  const b = blockSchema.parse(block);
  parseRef(b.apiKey, "decision.adapter.apiKey"); // throws on a literal or malformed reference
  const apiKey = await deps.resolveSecret(b.apiKey);
  return makeJevAdapter({ url: b.url ?? JEV_DEFAULT_URL, model: b.model ?? JEV_DEFAULT_MODEL, apiKey });
});
