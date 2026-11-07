import type { SkillSourceKind, SkillStatus, SkillSummaryView } from "../../../../gateway/panel/api-types";
import { Badge, type BadgeTone } from "../../../ui";

export const SOURCE_LABEL: Record<SkillSourceKind, string> = {
  "built-in": "Built-in",
  installed: "Installed",
  plugin: "Plugin",
  "agent-authored": "Agent-authored",
};

const SOURCE_TONE: Record<SkillSourceKind, BadgeTone> = {
  "built-in": "neutral",
  installed: "accent",
  plugin: "accent",
  "agent-authored": "warning",
};

export const SOURCE_HINT: Record<SkillSourceKind, string> = {
  "built-in": "Part of slaude itself (slaude:*), in every session.",
  installed: "Placed in a skills root by the dependency manifest, the release, or an operator.",
  plugin: "From a Claude Code plugin installed from the manifest, in every session.",
  "agent-authored": "Written by the agent itself with write_skill.",
};

export function SourceBadge({ source }: { source: SkillSourceKind }) {
  return (
    <span title={SOURCE_HINT[source]}>
      <Badge tone={SOURCE_TONE[source] ?? "neutral"}>{SOURCE_LABEL[source] ?? source}</Badge>
    </span>
  );
}

export function StatusBadge({ status }: { status: SkillStatus }) {
  return status === "active" ? <Badge tone="success">Active</Badge> : <Badge>Retired</Badge>;
}

export const skillPath = (id: string) => `/skills/${encodeURIComponent(id)}`;

/** "Every agent" when it reaches all of `all`, else the names. */
export function agentsText(s: Pick<SkillSummaryView, "agents" | "status">, all: readonly string[]): string {
  if (s.status === "retired") return "None (retired)";
  if (s.agents.length === 0) return "None";
  if (all.length > 1 && all.every((a) => s.agents.includes(a))) return "Every agent";
  return s.agents.join(", ");
}

/** A short line for where a skill came from. */
export function originLine(s: Pick<SkillSummaryView, "origin" | "source">): string {
  const o = s.origin;
  if (s.source === "built-in") return o.version ? `slaude ${o.version}` : "slaude";
  if (s.source === "plugin") return [o.plugin, o.marketplace && `from ${o.marketplace}`, o.version && `v${o.version}`].filter(Boolean).join(" ");
  if (o.retiredId && !o.authoredBy) return "Retired copy";
  if (s.source === "agent-authored") return `Written by ${o.authoredBy ?? "the agent"}`;
  if (o.repo) return `${o.repo.replace(/^https?:\/\//, "").replace(/\.git$/, "")}${o.commit ? ` @ ${o.commit.slice(0, 7)}` : ""}`;
  if (o.bundled) return "Shipped with slaude";
  if (o.local) return "Placed by hand (in no lock)";
  return "";
}
