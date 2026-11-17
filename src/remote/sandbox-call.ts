import { env } from "../config/env";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface SandboxCallResult {
  ok: boolean;
  text: string;
}

/**
 * Run one shell command in a thread's sandbox, outside any agent turn: a plain JSON-RPC
 * `tools/call` to the sandbox MCP server's `bash` tool, with the same bearer and
 * `X-Sandbox-Session` header the agent's MCP connection sends. The server is stateless per
 * request, so no `initialize` handshake is needed. Note the server creates and provisions
 * the sandbox on any `tools/call`, so callers decide beforehand that a sandbox is wanted.
 *
 * Never throws: an unreachable server, a timeout or an error reply is `{ ok: false, text }`.
 */
export async function sandboxBash(sessionId: string, command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SandboxCallResult> {
  const base = env.sandbox.activeUrl();
  if (!base) return { ok: false, text: "sandbox is not enabled" };
  const token = env.sandbox.mcpToken();
  let res: Response;
  try {
    res = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "X-Sandbox-Session": sessionId,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: { command } } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, text: `sandbox unreachable: ${(e as Error).message}` };
  }
  const raw = await res.text();
  if (!res.ok) return { ok: false, text: `sandbox returned ${res.status}: ${raw.slice(0, 200)}` };
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return { ok: false, text: "sandbox sent a reply that is not JSON" }; }
  if (msg?.error) return { ok: false, text: String(msg.error.message ?? "sandbox error").slice(0, 300) };
  const content: Array<{ type?: string; text?: string }> = msg?.result?.content ?? [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  return { ok: !msg?.result?.isError, text };
}
