import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKbs } from "./loader";

export const KB_MCP_NAME = "slaude_kb";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function scoreKb(kb: ReturnType<typeof loadKbs>[number], queryTokens: string[]): number {
  let score = 0;
  const labelTokens = tokenize(kb.label);
  const descTokens = tokenize(kb.description);
  // Split hyphenated tags so "service-a" yields "service-a", "service", "a"
  const tagTokens = kb.tags.flatMap((t) => [t, ...t.split(/[^a-z0-9]+/)]);
  for (const qt of queryTokens) {
    if (tagTokens.some((t) => t === qt)) score += 10;
    if (labelTokens.some((t) => t === qt)) score += 5;
    if (labelTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 2;
    if (descTokens.some((t) => t === qt)) score += 3;
    if (descTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 1;
  }
  return score;
}

export const kbHandlers = {
  async list_kbs(): Promise<ToolResult> {
    const kbs = loadKbs();
    if (kbs.length === 0) return ok("(no knowledge bases installed)");
    return ok(JSON.stringify(kbs, null, 2));
  },

  async open_kb({ label }: { label: string }): Promise<ToolResult> {
    const kbs = loadKbs();
    const kb = kbs.find((k) => k.label === label);
    if (!kb) return err(`unknown knowledge base "${label}". Use list_kbs to see available labels.`);
    const indexPath = join(kb.path, kb.index_file);
    if (!existsSync(indexPath)) return err(`index file ${kb.index_file} not found in "${label}"`);
    return ok(readFileSync(indexPath, "utf8"));
  },

  async search_kbs({ query, limit }: { query: string; limit?: number }): Promise<ToolResult> {
    const kbs = loadKbs();
    if (kbs.length === 0) return ok("(no knowledge bases installed)");
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return err("query too short or empty after tokenization");
    const scored = kbs
      .map((kb) => ({ kb, score: scoreKb(kb, queryTokens) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit ?? 5)
      .map((s) => s.kb);
    if (scored.length === 0) return ok("(no matching knowledge bases)");
    return ok(JSON.stringify(scored, null, 2));
  },
};

export function createKbMcp(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: KB_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "list_kbs",
        "List installed knowledge bases. Returns JSON array with label, description, path, and index_file for each KB.",
        {},
        kbHandlers.list_kbs,
      ),
      tool(
        "open_kb",
        "Open a knowledge base by label. Returns the full contents of its index file (README.md, index.md, or first .md). Use this to discover the wiki's structure, then navigate with Read/Grep/Glob.",
        { label: z.string().describe("Knowledge base label as listed by list_kbs.") },
        kbHandlers.open_kb,
      ),
      tool(
        "search_kbs",
        "Search installed knowledge bases by tags or keywords. Returns ranked matching KBs. Use this BEFORE acting when a user query mentions a service, domain, or topic that may have curated documentation.",
        {
          query: z.string().describe("Search query — keywords from the user's request (e.g. 'service-a grafana alerts')."),
          limit: z.number().optional().describe("Max results (default 5)."),
        },
        kbHandlers.search_kbs,
      ),
    ],
  });
}
