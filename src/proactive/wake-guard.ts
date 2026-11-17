/**
 * What a wake may call (heartbeat wake spec, section 5). An allow-list: nobody
 * is in the turn, so a tool not named here is refused, including any tool added
 * later. Enforced twice: the session's `disallowedTools` denies the tools, and the
 * gateway's /v1 tool plane refuses them from the signed `wake` claim, which is
 * what holds if a node disagrees.
 */
import { connectContract } from "../tools/contracts/connect";
import { kbContract } from "../tools/contracts/kb";
import { runtimeContract } from "../tools/contracts/runtime";
import { skillsContract } from "../tools/contracts/skills";
import { slackContract } from "../tools/contracts/slack";
import { surfaceContract } from "../tools/contracts/surface";
import { mcpMountedTools, type ServerContract } from "../tools/contracts/types";
import { VOICE_MCP_NAME, VOICE_SERVER_TOOLS } from "../voice/turn-flags";

/** Tool server (the /v1 path segment) → the tools a wake may call. */
const ALLOWED: Readonly<Record<string, readonly string[] | "all">> = {
  surface: ["pass"],
  // post_message is limited further, to threads of the agent's own posts (wake-tools.ts).
  slack: ["get_user_profile", "read_canvas", "post_message"],
  runtime: ["proactive_post", "read_channel", "finish_round"],
  skills: ["list_skills", "read_skill"],
  kb: "all",
  connect: [],
};

/** The allow-list as data, for the console's guardrails view (read-only). */
export const WAKE_TOOL_ALLOWLIST: Readonly<Record<string, readonly string[] | "all">> = ALLOWED;

const CONTRACTS: Readonly<Record<string, ServerContract>> = {
  surface: surfaceContract,
  slack: slackContract,
  runtime: runtimeContract,
  skills: skillsContract,
  kb: kbContract,
  connect: connectContract,
};

export function wakeAllows(server: string, tool: string): boolean {
  const allowed = Object.hasOwn(ALLOWED, server) ? ALLOWED[server] : undefined;
  return allowed === "all" || (allowed?.includes(tool) ?? false);
}

export const wakeRefusal = (tool: string): string =>
  `refused: ${tool} is not available when you woke on your own, because nobody is in this turn. To reach someone, use proactive_post; to follow up on a post you made, use post_message with its thread_ts.`;

/** The tools that only mean something in a wake: a normal session is refused them. */
export const WAKE_ONLY_TOOL_IDS: readonly string[] = ["proactive_post", "finish_round"].map((t) => `mcp__${runtimeContract.server}__${t}`);

/** The full tool ids a wake session is refused: every contract tool that is not allowed. */
export function wakeDeniedToolIds(): string[] {
  const out: string[] = [];
  for (const [key, contract] of Object.entries(CONTRACTS)) {
    for (const t of mcpMountedTools(contract)) {
      if (!wakeAllows(key, t.name)) out.push(`mcp__${contract.server}__${t.name}`);
    }
  }
  // Not on the /v1 tool plane, so no contract lists them. Denied here because
  // the permission gates that also refuse them do not run in bypass mode.
  for (const t of VOICE_SERVER_TOOLS) out.push(`mcp__${VOICE_MCP_NAME}__${t}`);
  return out;
}
