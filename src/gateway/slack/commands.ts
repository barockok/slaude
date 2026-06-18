import type { PermissionMode } from "../../agent/manager";

export const MODE_ALIASES: Record<string, PermissionMode> = {
  ask: "default",
  default: "default",
  "accept-edits": "acceptEdits",
  edits: "acceptEdits",
  acceptedits: "acceptEdits",
  plan: "plan",
  bypass: "bypassPermissions",
  yolo: "bypassPermissions",
  bypasspermissions: "bypassPermissions",
  "dont-ask": "dontAsk",
  dontask: "dontAsk",
  deny: "dontAsk",
};

export const MODE_LABELS: Record<PermissionMode, string> = {
  default: "ask (default — prompt per tool)",
  acceptEdits: "accept-edits (auto-allow Read/Write/Edit; still ask for Bash etc.)",
  bypassPermissions: "bypass (YOLO — every tool auto-allowed)",
  plan: "plan (no execution; planning only)",
  dontAsk: "dont-ask (deny anything not pre-approved)",
};

export type SlashHit =
  | { kind: "mode"; mode: PermissionMode }
  | { kind: "mode-help" }
  | { kind: "abort" }
  | { kind: "help" }
  | { kind: "ingest" }
  | { kind: "ignore"; target: "user"; userId: string; duration: string | null }
  | { kind: "ignore"; target: "thread"; duration: string | null }
  | { kind: "unignore"; target: "user"; userId: string }
  | { kind: "unignore"; target: "thread" }
  | { kind: "cron-add"; cronExpr: string; prompt: string; target: "thread" | "channel"; whenActive: "fire" | "skip" }
  | { kind: "cron-list" }
  | { kind: "cron-remove"; id: string }
  | { kind: "cron-pause"; id: string }
  | { kind: "cron-resume"; id: string }
  | { kind: "cron-run"; id: string }
  | { kind: "cron-edit"; id: string; cronExpr: string; prompt: string; target: "thread" | "channel"; whenActive: "fire" | "skip" }
  | { kind: "one-on-one"; action: "on" | "off" }
  | { kind: "mention-only"; action: "on" | "off" }
  | { kind: "mcp"; action: "status" | "connect" | "disconnect"; server?: string }
  | { kind: "soul"; field: "trust" | "allow" | "dm" | "block"; action: "add" | "remove"; value: string }
  | { kind: "soul-list" }
  | { kind: "soul-clear"; field: "trust" | "allow" | "dm" | "block" | "all" }
  | { kind: "model"; id?: string };

/** One descriptor per agent slash command — the single source of truth for every help
 *  surface (Slack `/help`, the sim REPL `/help`). Add a command here and it shows up
 *  everywhere; the parser branch below is the only other place to touch. */
export interface SlashSpec { usage: string; summary: string }
export const AGENT_COMMANDS: SlashSpec[] = [
  { usage: "/mode <name>", summary: "set the tool-permission mode (per session/thread)" },
  { usage: "/abort", summary: "cancel the current turn" },
  { usage: "/1on1 [off]", summary: "lock this thread to you + the manager; `off` releases" },
  { usage: "/mention-only [off]", summary: "reply only when @-mentioned in this thread; `off` restores normal" },
  { usage: "/mcp [connect|disconnect <server>]", summary: "list/connect/disconnect OAuth HTTP MCP servers — in 1on1: as you; outside 1on1: manager manages the agent's shared identity" },
  { usage: "/ignore @user [dur]", summary: "ignore a user (optional duration, e.g. 1h, 30m)" },
  { usage: "/ignore-thread [dur]", summary: "ignore this thread (optional duration)" },
  { usage: "/unignore @user", summary: "stop ignoring a user" },
  { usage: "/unignore-thread", summary: "stop ignoring this thread" },
  { usage: `/cron-add "<expr>" "<prompt>" [channel] [passive]`, summary: "schedule a prompt; `channel` posts to channel root, `passive` skips when a human is active" },
  { usage: "/cron-list", summary: "list scheduled crons" },
  { usage: `/cron-edit <id> "<expr>" "<prompt>" [channel] [passive]`, summary: "update a scheduled cron's expression, prompt, target, and passive mode" },
  { usage: "/cron-pause <id>", summary: "pause a scheduled cron without deleting it" },
  { usage: "/cron-resume <id>", summary: "resume a paused cron and recompute its next run" },
  { usage: "/cron-run <id>", summary: "queue a cron to run on the next scheduler tick" },
  { usage: "/cron-remove <id>", summary: "remove a scheduled cron" },
  { usage: "/soul <trust|allow|dm|block> <add|remove> <id>", summary: "manager-only: runtime override of soul ACLs (channels/users) — immediate, shadows SOUL.md" },
  { usage: "/soul list", summary: "show runtime soul overrides vs SOUL.md base" },
  { usage: "/soul clear <trust|allow|dm|block|all>", summary: "manager-only: drop runtime overrides (revert to SOUL.md)" },
  { usage: "/model [id]", summary: "show or set this thread's model (manager/approver) — no arg lists available models" },
  { usage: "/help", summary: "show this help" },
];

const HELP_NAMES = new Set(["help", "h", "?"]);

function parseCronCreateTail(t: string): Pick<Extract<SlashHit, { kind: "cron-add" }>, "cronExpr" | "prompt" | "target" | "whenActive"> | null {
  // Match: "expr" "prompt" [channel|thread] [passive]   (both flags optional, any order)
  const quoteMatch = t.match(/^"([^"]+)"\s+"([^"]+)"((?:\s+(?:channel|thread|passive))*)$/);
  if (!quoteMatch) return null;
  const flags = quoteMatch[3] ?? "";
  const target = /\bchannel\b/.test(flags) ? "channel" : "thread";
  const whenActive = /\bpassive\b/.test(flags) ? "skip" : "fire";
  return { cronExpr: quoteMatch[1]!, prompt: quoteMatch[2]!, target, whenActive };
}

function parseCronEditTail(t: string): Extract<SlashHit, { kind: "cron-edit" }> | null {
  const match = t.match(/^(\S+)\s+"([^"]+)"\s+"([^"]+)"((?:\s+(?:channel|thread|passive))*)$/);
  if (!match) return null;
  const flags = match[4] ?? "";
  return {
    kind: "cron-edit",
    id: match[1]!,
    cronExpr: match[2]!,
    prompt: match[3]!,
    target: /\bchannel\b/.test(flags) ? "channel" : "thread",
    whenActive: /\bpassive\b/.test(flags) ? "skip" : "fire",
  };
}

export function parseSlashCommand(text: string): SlashHit | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const [head, ...rest] = t.slice(1).split(/\s+/);
  const arg = rest.join(" ").toLowerCase();
  const cmd = (head ?? "").toLowerCase();
  if (cmd === "mode") {
    if (!arg) return { kind: "mode-help" };
    const mode = MODE_ALIASES[arg];
    if (!mode) return { kind: "mode-help" };
    return { kind: "mode", mode };
  }
  if (cmd === "abort" || cmd === "stop" || cmd === "cancel") {
    return { kind: "abort" };
  }
  if (cmd === "ingest") {
    return { kind: "ingest" };
  }
  if (cmd === "ignore") {
    const mentionMatch = t.match(/<@([UW][A-Z0-9]+)>/);
    const userId = mentionMatch?.[1];
    if (!userId) return null;
    const dur = rest.filter((r) => !r.startsWith("<@"))[0] ?? null;
    return { kind: "ignore", target: "user", userId, duration: dur };
  }
  if (cmd === "ignore-thread") {
    const dur = rest[0] ?? null;
    return { kind: "ignore", target: "thread", duration: dur };
  }
  if (cmd === "unignore") {
    const mentionMatch = t.match(/<@([UW][A-Z0-9]+)>/);
    const userId = mentionMatch?.[1];
    if (!userId) return null;
    return { kind: "unignore", target: "user", userId };
  }
  if (cmd === "unignore-thread") {
    return { kind: "unignore", target: "thread" };
  }
  if (cmd === "cron-add") {
    const parsed = parseCronCreateTail(t.replace(/^\/cron-add\s+/, ""));
    return parsed ? { kind: "cron-add", ...parsed } : null;
  }
  if (cmd === "cron-list") {
    return { kind: "cron-list" };
  }
  if (cmd === "cron-remove") {
    const id = rest[0];
    if (!id) return null;
    return { kind: "cron-remove", id };
  }
  if (cmd === "cron-pause" || cmd === "cron-resume" || cmd === "cron-run") {
    const id = rest[0];
    if (!id) return null;
    return { kind: cmd as "cron-pause" | "cron-resume" | "cron-run", id };
  }
  if (cmd === "cron-edit") {
    return parseCronEditTail(rest.join(" "));
  }
  if (cmd === "cron") {
    const sub = (rest[0] ?? "").toLowerCase();
    const tail = rest.slice(1).join(" ");
    if (sub === "list" || sub === "ls") return { kind: "cron-list" };
    if (sub === "add" || sub === "create") {
      const parsed = parseCronCreateTail(tail);
      return parsed ? { kind: "cron-add", ...parsed } : null;
    }
    if (sub === "remove" || sub === "rm" || sub === "delete") {
      const id = rest[1];
      return id ? { kind: "cron-remove", id } : null;
    }
    if (sub === "pause" || sub === "resume" || sub === "run") {
      const id = rest[1];
      return id ? { kind: `cron-${sub}` as "cron-pause" | "cron-resume" | "cron-run", id } : null;
    }
    if (sub === "edit" || sub === "update") {
      return parseCronEditTail(tail);
    }
    return null;
  }
  if (cmd === "1on1") {
    return { kind: "one-on-one", action: arg === "off" ? "off" : "on" };
  }
  if (cmd === "mention-only") {
    return { kind: "mention-only", action: arg === "off" ? "off" : "on" };
  }
  if (cmd === "soul") {
    const sub = (rest[0] ?? "").toLowerCase();
    if (sub === "list") return { kind: "soul-list" };
    if (sub === "clear") {
      const f = (rest[1] ?? "").toLowerCase();
      if (!["trust", "allow", "dm", "block", "all"].includes(f)) return null;
      return { kind: "soul-clear", field: f as "trust" | "allow" | "dm" | "block" | "all" };
    }
    if (["trust", "allow", "dm", "block"].includes(sub)) {
      const action = (rest[1] ?? "").toLowerCase();
      if (action !== "add" && action !== "remove") return null;
      const value = rest[2]; // case-preserved: raw ids / <#…|name> / <@…> wrappers
      if (!value) return null;
      return { kind: "soul", field: sub as "trust" | "allow" | "dm" | "block", action, value };
    }
    return null;
  }
  if (cmd === "mcp") {
    const sub = (rest[0] ?? "").toLowerCase();
    if (sub === "connect") {
      return { kind: "mcp", action: "connect", server: rest[1] };
    }
    if (sub === "disconnect") {
      return { kind: "mcp", action: "disconnect", server: rest[1] };
    }
    return { kind: "mcp", action: "status" };
  }
  if (cmd === "model") {
    const id = rest[0]; // case-preserved provider id; ignore trailing tokens
    return id ? { kind: "model", id } : { kind: "model" };
  }
  if (HELP_NAMES.has(cmd)) {
    return { kind: "help" };
  }
  return null;
}

export function helpText(): string {
  // Render the command table inside a code fence with the summary column aligned
  // to a single gutter (longest usage + 2). Slack renders fences monospace, so
  // space-padding lines up cleanly; tabs render at inconsistent widths and are
  // avoided. Usages are NOT backtick-wrapped — backticks show literally inside a
  // fence.
  const gutter = Math.max(...AGENT_COMMANDS.map((c) => c.usage.length)) + 2;
  const cmds = AGENT_COMMANDS.map((c) => c.usage.padEnd(gutter) + c.summary).join("\n");
  const modes = Object.values(MODE_ALIASES)
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((m) => `  • \`/mode ${humanModeName(m)}\` — ${MODE_LABELS[m]}`)
    .join("\n");
  return ["*slaude commands*", "```", cmds, "```", "tool-permission modes:", modes].join("\n");
}

export function humanModeName(m: PermissionMode): string {
  switch (m) {
    case "default":
      return "ask";
    case "acceptEdits":
      return "accept-edits";
    case "bypassPermissions":
      return "bypass";
    case "plan":
      return "plan";
    case "dontAsk":
      return "dont-ask";
  }
}
