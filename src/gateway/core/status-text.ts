import { SURFACE_MCP_NAME } from "./surface-mcp";
import { SLACK_MCP_NAME } from "../slack/mcp-tools";

/**
 * Renders the glanceable text for the Slack "is thinking…" status indicator
 * (`assistant.threads.setStatus`) from a tool-call event.
 *
 * SECURITY / PRIVACY. This string is BROADCAST to Slack, so it must never mirror
 * raw tool arguments — a secret inlined in a `curl` command or an absolute path
 * revealing filesystem layout must not leak into the ambient status. Two layers,
 * both fully deterministic (switch / string ops / regex — no model, no I/O):
 *
 *  1. STRUCTURAL (primary, complete by construction). We never emit args that
 *     could carry a secret or directory structure: Bash shows only the program
 *     name, file tools show a basename (never an absolute/outside-workspace
 *     path), WebFetch shows only the host. There is simply nothing to leak.
 *  2. redactSecrets() (backstop). A regex net over the final string, for the few
 *     branches that still echo user-supplied text (Grep pattern, WebSearch query).
 *     Regexes can miss novel secret shapes, so this is secondary to layer 1.
 */

/** Collapse a path to something safe for a broadcast status line. */
export function shortPath(p: string | undefined): string {
  if (!p) return "";
  // Relative paths are already workspace-scoped — show the tail (≤2 segments).
  if (!p.startsWith("/")) {
    const parts = p.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || p;
  }
  // Absolute paths: basename only. Never expose directory structure (inside OR
  // outside the workspace) in a status line that gets broadcast to Slack.
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

// Secret-shaped substrings to mask. Deterministic; order does not matter.
const SECRET_PATTERNS: RegExp[] = [
  /(authorization|x-api-key)\s*[:=]\s*\S+/gi, // headers: Authorization: …, x-api-key=…
  /bearer\s+[A-Za-z0-9._-]+/gi, // bearer <token>
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd)\s*[:=]\s*\S+/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{8,}/g, // sk-… style provider keys
  /\bgh[oprsu]_[A-Za-z0-9]{20,}/g, // github tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // slack tokens
  /\bglpat-[A-Za-z0-9_-]{10,}/g, // gitlab PAT
  /\bAKIA[0-9A-Z]{12,}/g, // aws access key id
  /\bAIza[0-9A-Za-z._-]{20,}/g, // google api key
  /\beyJ[A-Za-z0-9._-]{10,}/g, // JWT
];

/** Deterministic regex backstop: mask anything secret-shaped. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "••••");
  return out;
}

/** Host-only render of a URL; empty string if unparseable. */
function urlHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

/** Map a tool-call to a safe, glanceable status line. Always redaction-netted. */
export function humanizeToolStatus(tool: string, input: any): string {
  const inp = input ?? {};
  let label: string;
  switch (tool) {
    case "Read":
      label = `reading ${shortPath(inp.file_path) || "file"}`;
      break;
    case "Write":
      label = `writing ${shortPath(inp.file_path) || "file"}`;
      break;
    case "Edit":
    case "MultiEdit":
      label = `editing ${shortPath(inp.file_path) || "file"}`;
      break;
    case "NotebookEdit":
      label = "editing notebook";
      break;
    case "Bash": {
      // Program name only — NEVER the args (they carry secrets / paths / URLs).
      const prog = (inp.command ?? "").toString().trim().split(/\s+/)[0] ?? "";
      const name = prog.split("/").filter(Boolean).pop() || prog; // strip any path on the binary
      label = name ? `running \`${name}\`` : "running command";
      break;
    }
    case "Grep":
      label = `searching for "${(inp.pattern ?? "").toString().slice(0, 40)}"`;
      break;
    case "Glob":
      label = `finding files (${(inp.pattern ?? "").toString().slice(0, 40)})`;
      break;
    case "LS":
      label = `listing ${shortPath(inp.path) || "directory"}`;
      break;
    case "TodoWrite":
      label = "updating todos";
      break;
    case "WebFetch": {
      const host = urlHost((inp.url ?? "").toString());
      label = host ? `fetching ${host}` : "fetching url";
      break;
    }
    case "WebSearch":
      label = `searching web: "${(inp.query ?? "").toString().slice(0, 40)}"`;
      break;
    case "Task":
      label = "delegating to subagent";
      break;
    case `mcp__${SURFACE_MCP_NAME}__reply`:
    case `mcp__${SLACK_MCP_NAME}__reply`:
      label = "replying";
      break;
    case `mcp__${SURFACE_MCP_NAME}__edit`:
    case `mcp__${SLACK_MCP_NAME}__edit`:
      label = "editing reply";
      break;
    case `mcp__${SURFACE_MCP_NAME}__upload`:
    case `mcp__${SLACK_MCP_NAME}__upload`:
      label = `uploading ${shortPath(inp.path) || "file"}`;
      break;
    case `mcp__${SURFACE_MCP_NAME}__react`:
    case `mcp__${SURFACE_MCP_NAME}__unreact`:
    case `mcp__${SLACK_MCP_NAME}__react`:
      label = `reacting :${inp.name ?? "?"}:`;
      break;
    case `mcp__${SURFACE_MCP_NAME}__request_approval`:
    case `mcp__${SLACK_MCP_NAME}__request_approval`:
      label = "requesting approval";
      break;
    case `mcp__${SURFACE_MCP_NAME}__get_history`:
      label = "reading conversation history";
      break;
    case `mcp__${SLACK_MCP_NAME}__get_user_profile`:
      label = "fetching user profile";
      break;
    case `mcp__${SLACK_MCP_NAME}__get_channel_info`:
      label = "fetching channel info";
      break;
    case `mcp__${SLACK_MCP_NAME}__get_thread_history`:
      label = "reading thread history";
      break;
    case `mcp__${SLACK_MCP_NAME}__list_users_in_channel`:
      label = "listing channel members";
      break;
    case `mcp__${SLACK_MCP_NAME}__search_messages`:
      label = "searching messages";
      break;
    default: {
      // Generic mcp tool: mcp__<server>__<tool> → "tool (server)"
      const mm = tool.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
      label = mm ? `running ${mm[2]} (${mm[1]})` : `running ${tool}`;
      break;
    }
  }
  // Central backstop — mask any secret-shaped substring that slipped through.
  return redactSecrets(label);
}
