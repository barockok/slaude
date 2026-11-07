/**
 * Per-session token-usage tracker. Records `usage` + `modelUsage` from the
 * SDK's `result` message and computes how close we are to the model's
 * advertised context window.
 *
 * The result's `usage` is the SUM over every model call of the turn (one per
 * tool-loop iteration), so a turn with N tool calls reports roughly N times
 * the prompt size. The context fill is the size of the LAST prompt the model
 * saw: the manager notes each assistant message's own usage (notePrompt) and
 * record() measures from the last one, falling back to the result's usage
 * only when no assistant usage was noted. `evaluateThreshold` fires once per session per
 * threshold (warn / auto-resume), letting transports surface the warning or
 * trigger a cooperative resume without spamming on every subsequent turn.
 */

export type ResultUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export type ResultModelUsage = Record<
  string,
  { contextWindow: number; [k: string]: unknown }
>;

export type RecordInput = {
  usage: ResultUsage;
  modelUsage: ResultModelUsage;
};

export type UsageSnapshot = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** input + cache_read + cache_creation — full size of the prompt the model saw last turn. */
  totalInput: number;
  contextWindow: number;
  pctUsed: number;
  remaining: number;
};

export type ThresholdEvent = "warn" | "critical";

/** One model call's usage, as an assistant message carries it. */
export type PromptUsage = Partial<ResultUsage>;

type State = {
  snap: UsageSnapshot;
  warned: boolean;
  critical: boolean;
};

const DEFAULT_FALLBACK_CONTEXT_WINDOW = 200_000;

export class TokenBudget {
  #state = new Map<string, State>();
  /** Usage of the latest assistant message per session (one model call). */
  #lastPrompt = new Map<string, ResultUsage>();
  #fallbackContextWindow: number;

  constructor(opts: { fallbackContextWindow?: number } = {}) {
    const f = opts.fallbackContextWindow;
    this.#fallbackContextWindow =
      typeof f === "number" && Number.isFinite(f) && f > 0
        ? f
        : DEFAULT_FALLBACK_CONTEXT_WINDOW;
  }

  /** Note one model call's usage (an assistant message's `usage`). The last
   *  one noted before record() is what the context fill is measured from. */
  notePrompt(sessionId: string, usage: PromptUsage | null | undefined): void {
    if (!usage || typeof usage !== "object") return;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    const u: ResultUsage = {
      input_tokens: n(usage.input_tokens),
      output_tokens: n(usage.output_tokens),
      cache_read_input_tokens: n(usage.cache_read_input_tokens),
      cache_creation_input_tokens: n(usage.cache_creation_input_tokens),
    };
    if (u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens === 0) return;
    this.#lastPrompt.set(sessionId, u);
  }

  record(sessionId: string, input: RecordInput): void {
    // The last model call's prompt, not the turn's summed usage (see the header).
    const last = this.#lastPrompt.get(sessionId);
    const u = last ? { ...last, output_tokens: input.usage.output_tokens } : input.usage;
    const totalInput =
      u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    let contextWindow = this.#fallbackContextWindow;
    for (const m of Object.values(input.modelUsage)) {
      if (m.contextWindow > contextWindow) contextWindow = m.contextWindow;
    }
    const pctUsed = contextWindow > 0 ? totalInput / contextWindow : 0;
    const snap: UsageSnapshot = {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadInputTokens: u.cache_read_input_tokens,
      cacheCreationInputTokens: u.cache_creation_input_tokens,
      totalInput,
      contextWindow,
      pctUsed,
      remaining: contextWindow - totalInput,
    };
    const prior = this.#state.get(sessionId);
    this.#state.set(sessionId, {
      snap,
      warned: prior?.warned ?? false,
      critical: prior?.critical ?? false,
    });
  }

  snapshot(sessionId: string): UsageSnapshot | null {
    return this.#state.get(sessionId)?.snap ?? null;
  }

  forget(sessionId: string): void {
    this.#state.delete(sessionId);
    this.#lastPrompt.delete(sessionId);
  }

  /**
   * Edge-trigger threshold crossings. Returns the highest unfired threshold
   * the current usage crosses, then marks it as fired so subsequent calls in
   * the same session don't re-emit. `criticalPct <= 0` disables the critical tier.
   */
  evaluateThreshold(
    sessionId: string,
    warnPct: number,
    criticalPct: number,
  ): ThresholdEvent | null {
    const st = this.#state.get(sessionId);
    if (!st) return null;
    const p = st.snap.pctUsed;
    if (criticalPct > 0 && p >= criticalPct && !st.critical) {
      st.critical = true;
      return "critical";
    }
    if (p >= warnPct && !st.warned) {
      st.warned = true;
      return "warn";
    }
    return null;
  }
}
