/**
 * One real CLI turn through the agent SDK's query() against the fake
 * Messages API: the model calls Bash once (`touch <marker>`), then ends the
 * turn. Reports whether the command ran, what the CLI sent back as the tool
 * result, and whether canUseTool was asked.
 */
import { query, type CanUseTool, type HookCallbackMatcher, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeApi } from "./fake-messages-api";

export interface SpikeRun {
  ran: boolean;
  toolResults: string[];
  canUseToolCalls: number;
  elapsedMs: number;
  result: string | null;
}

export async function spikeRun(o: {
  preToolUse: HookCallbackMatcher[];
  permissionMode: PermissionMode;
  canUseTool?: CanUseTool;
  wallMs?: number;
}): Promise<SpikeRun> {
  const dir = mkdtempSync(join(tmpdir(), "slaude-sdk-spike-"));
  const marker = join(dir, "ran.marker");
  const api = startFakeApi({ name: "Bash", input: { command: `touch ${marker}`, description: "spike" } });
  let canUseToolCalls = 0;
  const canUseTool: CanUseTool | undefined = o.canUseTool
    ? async (name, input, ctx) => {
        canUseToolCalls++;
        return o.canUseTool!(name, input, ctx);
      }
    : undefined;
  const abort = new AbortController();
  const wall = setTimeout(() => abort.abort(), o.wallMs ?? 120_000);
  const t0 = Date.now();
  let result: string | null = null;
  try {
    const q = query({
      prompt: "run the spike",
      options: {
        cwd: dir,
        abortController: abort,
        model: "claude-test",
        permissionMode: o.permissionMode,
        ...(o.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        ...(canUseTool ? { canUseTool } : {}),
        settingSources: [],
        persistSession: false,
        tools: ["Bash"],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          CLAUDE_CONFIG_DIR: join(dir, ".claude"),
          ANTHROPIC_API_KEY: "sk-spike-dummy",
          ANTHROPIC_BASE_URL: api.url,
          DISABLE_TELEMETRY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        hooks: { PreToolUse: o.preToolUse },
      },
    });
    for await (const m of q) {
      if (m.type === "result") result = m.subtype === "success" ? m.result : m.subtype;
    }
  } finally {
    clearTimeout(wall);
    api.stop();
  }
  const ran = existsSync(marker);
  rmSync(dir, { recursive: true, force: true });
  return { ran, toolResults: api.toolResults, canUseToolCalls, elapsedMs: Date.now() - t0, result };
}
