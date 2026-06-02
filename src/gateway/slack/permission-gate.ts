import type { Transport, WebClientLike } from "../core/transport";
import type {
  CanUseTool,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { env } from "../../config/env";

type PendingKey = string; // toolUseID
type Pending = {
  channel: string;
  threadTs: string;
  messageTs: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: Awaited<ReturnType<CanUseTool>>) => void;
};

/**
 * Slack approval gate. When the SDK asks for a tool permission, we post a
 * Block Kit message to the active session's thread with Allow / Always /
 * Deny buttons, then resolve the SDK promise on the user's click.
 *
 * Pre-approved tools (env SLAUDE_AUTO_ALLOW_TOOLS, comma-separated) return
 * allow without prompting — useful for safe read-only ops like Read/Grep/Glob.
 */
export class PermissionGate {
  #client: WebClientLike;
  #autoAllow: Set<string>;
  /** sessionId → channel/thread for routing the prompt. */
  #routes = new Map<string, { channel: string; threadTs: string }>();
  #pending = new Map<PendingKey, Pending>();

  constructor(transport: Transport) {
    this.#client = transport.client;
    this.#autoAllow = new Set(
      (process.env.SLAUDE_AUTO_ALLOW_TOOLS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

    transport.action(
      /^slaude_perm:(allow|always|deny):.+$/,
      async ({ ack, action, body, respond }) => {
        await ack();
        const a = action as { action_id: string };
        const m = a.action_id.match(/^slaude_perm:(allow|always|deny):(.+)$/);
        if (!m) return;
        const decision = m[1] as "allow" | "always" | "deny";
        const toolUseId = m[2]!;
        const pend = this.#pending.get(toolUseId);
        if (!pend) {
          // Already decided (e.g. duplicate click). Make sure the buttons go
          // away by replacing the message via the click's response_url.
          try {
            await respond({
              replace_original: true,
              text: `:lock: \`${a.action_id.split(":")[2]}\` already decided`,
              blocks: [],
            });
          } catch {}
          return;
        }
        this.#pending.delete(toolUseId);

        const userId = (body as any).user?.id ?? "unknown";
        const decided =
          decision === "allow"
            ? "*Allowed* once"
            : decision === "always"
              ? "*Always-allowed* for this session"
              : "*Denied*";
        // Use respond() — fires against the click's response_url and is much
        // faster than chat.update, so the buttons disappear before the user
        // has a chance to double-click.
        try {
          await respond({
            replace_original: true,
            text: `${pend.toolName} → ${decided} by <@${userId}>`,
            blocks: [],
          });
        } catch (e) {
          console.error("[permission-gate] respond failed", e);
        }

        if (decision === "deny") {
          pend.resolve({ behavior: "deny", message: `Denied by <@${userId}>` });
          return;
        }

        // Build the permission updates for "always allow":
        //   - If the SDK supplied suggestions, honor them (they encode the
        //     specific pattern, e.g. Bash(ls:*)).
        //   - Else fall back to a tool-wide allow rule for the session so we
        //     don't keep asking on every Bash call.
        const permissions: PermissionUpdate[] = [];
        if (decision === "always") {
          if (pend.suggestions && pend.suggestions.length > 0) {
            permissions.push(...pend.suggestions);
          } else {
            permissions.push({
              type: "addRules",
              rules: [{ toolName: pend.toolName }],
              behavior: "allow",
              destination: "session",
            });
          }
        }

        pend.resolve({
          behavior: "allow",
          updatedInput: pend.input,
          ...(permissions.length ? { updatedPermissions: permissions } : {}),
        });
      },
    );
  }

  /** Adapter calls this when it knows where a session lives in Slack. */
  bindSession(sessionId: string, channel: string, threadTs: string) {
    this.#routes.set(sessionId, { channel, threadTs });
  }

  unbindSession(sessionId: string) {
    this.#routes.delete(sessionId);
  }

  /** Closure passed into AgentManager.setPermissionResolver. */
  resolver: import("../../agent/manager").PermissionResolver = async (
    sessionId,
    toolName,
    input,
    ctx,
  ) => {
    if (this.#autoAllow.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    // Slack MCP tools are the agent's *only* path to user output — never gate.
    if (toolName.startsWith("mcp__slaude_slack__")) {
      return { behavior: "allow", updatedInput: input };
    }
    // Skill introspection is read-only — auto-allow so evolution checks
    // don't spam the user. Write/delete still flow through approval.
    if (
      toolName === "mcp__slaude_skills__list_skills" ||
      toolName === "mcp__slaude_skills__read_skill"
    ) {
      return { behavior: "allow", updatedInput: input };
    }
    // Session introspection (token budget) is pure read — agent uses it to
    // decide whether to summarize and reset. Never gate.
    if (toolName.startsWith("mcp__slaude_session__")) {
      return { behavior: "allow", updatedInput: input };
    }
    // KB introspection is read-only — agent uses it to discover and read
    // knowledge bases without spamming the user.
    if (toolName.startsWith("mcp__slaude_kb__")) {
      return { behavior: "allow", updatedInput: input };
    }
    const route = this.#routes.get(sessionId);
    if (!route) {
      // No live thread — fail closed so we don't silently grant ops.
      return { behavior: "deny", message: "no active slaude thread to ask in" };
    }

    const toolUseId = ctx.toolUseID;
    const text = `:lock: Approval needed: \`${toolName}\``;
    const inputPreview = truncate(JSON.stringify(input, null, 2), 2500);
    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `:lock: *Approval needed* — \`${toolName}\`` },
      },
      ...(ctx.decisionReason
        ? [
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: `_${ctx.decisionReason}_` }],
            },
          ]
        : []),
      {
        type: "section",
        text: { type: "mrkdwn", text: "```\n" + inputPreview + "\n```" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Allow once" },
            action_id: `slaude_perm:allow:${toolUseId}`,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Always allow" },
            action_id: `slaude_perm:always:${toolUseId}`,
          },
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "Deny" },
            action_id: `slaude_perm:deny:${toolUseId}`,
          },
        ],
      },
    ];

    const posted = await this.#client.chat.postMessage({
      channel: route.channel,
      thread_ts: route.threadTs,
      text,
      blocks,
    });

    return new Promise<Awaited<ReturnType<CanUseTool>>>((resolve) => {
      this.#pending.set(toolUseId, {
        channel: route.channel,
        threadTs: route.threadTs,
        messageTs: posted.ts as string,
        toolName,
        input,
        suggestions: ctx.suggestions,
        resolve,
      });
      // Honor abort signal — tear down the prompt and deny.
      ctx.signal.addEventListener(
        "abort",
        () => {
          if (!this.#pending.has(toolUseId)) return;
          this.#pending.delete(toolUseId);
          resolve({ behavior: "deny", message: "aborted" });
        },
        { once: true },
      );
    });
  };
}

function truncate(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max) + "\n…(truncated)";
}

// silence unused-import warning
void env;
