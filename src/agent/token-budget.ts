/**
 * Per-session token-usage tracker. Records `usage` + `modelUsage` from the
 * SDK's `result` message and computes how close we are to the model's
 * advertised context window. `evaluateThreshold` fires once per session per
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

type State = {
  snap: UsageSnapshot;
  warned: boolean;
  critical: boolean;
};

const FALLBACK_CONTEXT_WINDOW = 200_000;

export class TokenBudget {
  #state = new Map<string, State>();

  record(sessionId: string, input: RecordInput): void {
    const u = input.usage;
    const totalInput =
      u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    let contextWindow = FALLBACK_CONTEXT_WINDOW;
    for (const m of Object.values(input.modelUsage)) {
      if (m.contextWindow > contextWindow) contextWindow = m.contextWindow;
    }
    const pctUsed = totalInput / contextWindow;
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
