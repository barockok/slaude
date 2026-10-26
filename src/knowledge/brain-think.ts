import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { scrubChildEnv, TOOLS_SURVIVING_EMPTY_SET } from "../agent/child-env";
import { join } from "node:path";
import { getBrain } from "./brain";
import type { BrainScope } from "./scope";

/**
 * kb_think synthesis routed through the claude-agent-sdk instead of gbrain's
 * raw Anthropic client. Why: the SDK honors slaude's existing auth
 * (CLAUDE_CODE_OAUTH_TOKEN subscription or ANTHROPIC_* gateway env) — putting
 * a bare ANTHROPIC_API_KEY in the pod env just for gbrain would also flip the
 * main agent loop's billing (explicit key beats subscription). One auth path,
 * decided once, reused here.
 */

type AnthropicishParams = {
  model?: string;
  max_tokens?: number;
  system?: unknown;
  messages: Array<{ role: string; content: unknown }>;
};

export type ThinkClient = {
  create(params: AnthropicishParams, opts?: { signal?: AbortSignal }): Promise<unknown>;
};

const blocksToText = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("")
      : "";

const SYNTHESIS_PREAMBLE = "Synthesis request follows.\n\n";

export function sdkThinkClient(runner: typeof sdkQuery = sdkQuery): ThinkClient {
  return {
    async create(params) {
      const system = blocksToText(params.system) || undefined;
      // A fixed first line, so the prompt never starts with "/": the CLI
      // would read page content there as a slash command.
      const userText = SYNTHESIS_PREAMBLE + params.messages.map((m) => blocksToText(m.content)).join("\n\n");
      let text = "";
      const it = runner({
        prompt: (async function* () {
          yield { type: "user" as const, message: { role: "user" as const, content: userText }, parent_tool_use_id: null };
        })() as never,
        options: {
          systemPrompt: system,
          // Pure synthesis: no tools, no side effects, one turn. gbrain's
          // resolved model id is ignored on purpose — the SDK session default
          // (subscription / gateway env) is the one auth+model decision.
          // The prompt carries untrusted page content, so tools are removed
          // outright: `tools: []` is the SDK's "no built-ins" (`--tools ""`).
          // `allowedTools: []` is NOT — it only auto-approves, and the SDK
          // drops an empty list; with bypassPermissions that ran Bash (D5.2).
          // dontAsk denies anything not pre-approved; no MCP servers or
          // settings (hooks, plugins) are loaded either.
          tools: [],
          disallowedTools: [...TOOLS_SURVIVING_EMPTY_SET],
          permissionMode: "dontAsk" as const,
          strictMcpConfig: true,
          settingSources: [],
          maxTurns: 1,
          // No tools, but the child still inherits the environment: scrub it.
          env: scrubChildEnv({ ...process.env }),
        },
      });
      for await (const msg of it as AsyncIterable<{ type: string; message?: { content?: Array<{ type: string; text?: string }> } }>) {
        if (msg.type === "assistant") {
          for (const b of msg.message?.content ?? []) if (b.type === "text") text += b.text ?? "";
        }
      }
      return {
        id: "sdk-think",
        type: "message",
        role: "assistant",
        model: "sdk-session-default",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  };
}

type TakeHitish = { page_id?: number | string };
type ScopableEngine = {
  executeRaw(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
};

/**
 * The engine as runThink's gather sees it: every page search is forced to the
 * caller's sources, and take hits are kept only when their page is in them.
 *
 * runThink accepts `allowedSources` but uses it only to resolve entities; its
 * page gather calls hybridSearch with no source filter, so it searched every
 * source in the brain. A live run saw a /1on1 page (in `user-<id>`) reach a
 * channel turn's synthesis prompt, kept out of the answer only by the model.
 * Takes are filtered by holder alone upstream, so they get the same check here.
 */
export function scopedThinkEngine<E extends object>(engine: E, allowedSources: readonly string[]): E {
  const sourceIds = [...allowedSources];
  const scopePages = (fn: (...a: unknown[]) => Promise<unknown>) =>
    (q: unknown, opts?: Record<string, unknown>) => {
      const { sourceId: _ignored, ...rest } = opts ?? {};
      return fn(q, { ...rest, sourceIds });
    };
  const scopeTakes = (fn: (...a: unknown[]) => Promise<unknown>) =>
    async (q: unknown, opts?: Record<string, unknown>) => {
      const hits = (await fn(q, opts)) as TakeHitish[];
      const ids = [...new Set(hits.map((h) => Number(h.page_id)).filter(Number.isFinite))];
      if (ids.length === 0) return [];
      const rows = await (engine as unknown as ScopableEngine).executeRaw(
        "SELECT id FROM pages WHERE id = ANY($1::int[]) AND source_id = ANY($2::text[])",
        [ids, sourceIds],
      );
      const keep = new Set(rows.map((r) => Number(r.id)));
      return hits.filter((h) => keep.has(Number(h.page_id)));
    };
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      const bound = v.bind(target) as (...a: unknown[]) => Promise<unknown>;
      if (prop === "searchKeyword" || prop === "searchVector") return scopePages(bound);
      if (prop === "searchTakes" || prop === "searchTakesVector") return scopeTakes(bound);
      return bound;
    },
  });
}

/**
 * Scoped think: gbrain's gather (pages + takes + graph + trajectory) with the
 * caller's source scope, synthesized through the SDK client above.
 * runThink isn't in gbrain's package exports — imported by file path.
 */
export async function brainThink(
  question: string,
  scope: BrainScope,
  deps: { client?: ThinkClient } = {},
): Promise<unknown> {
  const engine = scopedThinkEngine(await getBrain(), scope.allowedSources);
  const thinkPath = join(import.meta.dir, "../../node_modules/gbrain/src/core/think/index.ts");
  const { runThink } = (await import(thinkPath)) as {
    runThink: (e: unknown, o: Record<string, unknown>) => Promise<unknown>;
  };
  return runThink(engine, {
    question,
    remote: true,
    sourceId: scope.sourceId,
    allowedSources: scope.allowedSources,
    takesHoldersAllowList: [scope.clientId, "world"],
    client: deps.client ?? sdkThinkClient(),
  });
}
