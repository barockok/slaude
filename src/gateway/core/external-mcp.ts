import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "../../config/home";

/** Return a copy of a server config with all injected secrets removed.
 *  stdio → env emptied; sse/http → headers emptied + url userinfo/query stripped.
 *  command/args and url host/path are preserved so the server still launches/reaches
 *  its endpoint — just anonymous. The input is never mutated. */
export function clearCredentials(cfg: McpServerConfig): McpServerConfig {
  const c: any = { ...(cfg as any) };
  if ("env" in c) c.env = {};
  if ("headers" in c) c.headers = {};
  if (typeof c.url === "string") {
    try {
      const u = new URL(c.url);
      u.username = "";
      u.password = "";
      u.search = "";
      u.hash = "";
      c.url = u.toString();
    } catch {
      // Non-absolute URL: leave as-is (can't carry userinfo/query meaningfully).
    }
  }
  return c as McpServerConfig;
}
