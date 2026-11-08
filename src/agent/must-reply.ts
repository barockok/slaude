/**
 * The must-reply Stop guard's shared parts: which tool calls satisfy it and
 * the instruction a blocked stop carries. The gateway (mono) and the node
 * worker both install a guard built on these, so the two cannot drift.
 */
import { SLACK_SERVER } from "../tools/contracts/slack";
import { SURFACE_SERVER } from "../tools/contracts/surface";

/** The instruction a turn that ended without a reply or a pass is sent back with. */
export const MUST_REPLY_INSTRUCTION =
  "You ended the turn without a reply or a pass. If the message needs an answer, call `mcp__slaude_surface__reply`; if it is not for you, call `mcp__slaude_surface__pass` with a reason. Then stop.";

const USER_VISIBLE = new Set(
  [SURFACE_SERVER, SLACK_SERVER].flatMap((server) => ["reply", "edit", "upload"].map((t) => `mcp__${server}__${t}`)),
);

/**
 * What a tool call means for the Stop guard: "spoke" for a user-visible tool
 * (reply, edit, upload on the surface namespace, or the deprecated slack
 * namespace during the transition), "passed" for the surface `pass`, null for
 * anything else. A reaction alone is not an answer.
 */
export function mustReplyEffect(tool: string): "spoke" | "passed" | null {
  if (tool === `mcp__${SURFACE_SERVER}__pass`) return "passed";
  return USER_VISIBLE.has(tool) ? "spoke" : null;
}
