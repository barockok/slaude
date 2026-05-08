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
  | { kind: "help" };

const HELP_NAMES = new Set(["help", "h", "?"]);

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
  if (HELP_NAMES.has(cmd)) {
    return { kind: "help" };
  }
  return null;
}

export function helpText(): string {
  const modes = Object.values(MODE_ALIASES)
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((m) => `  • \`/mode ${humanModeName(m)}\` — ${MODE_LABELS[m]}`)
    .join("\n");
  return [
    "*slaude commands*",
    "`/mode <name>` — set tool-permission mode (per session/thread)",
    modes,
    "`/abort` — cancel the current turn",
    "`/help` — this message",
  ].join("\n");
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
