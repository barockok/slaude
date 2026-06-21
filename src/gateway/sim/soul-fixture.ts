import { writeFileSync } from "node:fs";
import { paths } from "../../config/home";
import { setSoulData } from "../../soul/extract";
import { SoulDataSchema } from "../../soul/data";

export interface SoulFixture {
  manager: string;
  backup?: string;
  approvers: string[];
  trusted: string[];
  allowed: string[];
  /** Users allowed to DM directly, on top of manager/backup. */
  dmAllowed?: string[];
  /** Per-channel mandate/approver overrides. `approvers` empty → keep global. */
  channelOverrides?: Array<{ channel: string; mandate?: string; approvers?: string[] }>;
}

/** The default sim world: a manager, a backup, one approver, one trusted + one allowed
 *  channel. Every layer (dm/trusted/allowed/restricted) and role (manager/approver/backup/
 *  member/outsider) is expressible against it — no per-scenario soul needed. */
export const WORLD: SoulFixture = {
  manager: "U0MGR", backup: "U0BACKUP", approvers: ["U0APP"], trusted: ["C0TEAM"], allowed: ["C0PUB"],
};

/** Write a SOUL.md fixture into $SLAUDE_HOME AND inject the matching structured
 *  SoulData via the production setSoulData() accessor — because the regex
 *  fallback only fills approvers, the sim must populate manager/channels directly.
 *  The data is validated through the real SoulDataSchema (so it stays honest). */
export function writeSoulFixture(f: SoulFixture): void {
  // SOUL.md still written for any code path that reads the file (system prompt, etc.)
  const lines = [
    "# SOUL",
    "",
    "## Identity",
    "Sim agent.",
    "",
    "## Reporting",
    `- Manager: ${f.manager}`,
    `- Backup manager: ${f.backup ?? ""}`,
    "",
    "## Approvers",
    ...f.approvers.map((a) => `- <@${a}>: anything ; catchall`),
    "",
    "## Allowed channels",
    ...f.allowed.map((c) => `- ${c}`),
    "",
    "## Trusted channels",
    ...f.trusted.map((c) => `- ${c}`),
    "",
    "## DM allowlist",
    ...(f.dmAllowed ?? []).map((u) => `- <@${u}>`),
    "",
    ...(f.channelOverrides ?? []).flatMap((co) => [
      `## Channel ${co.channel}`,
      "",
      ...(co.mandate ? ["### Mandate", `- ${co.mandate}`, ""] : []),
      ...(co.approvers?.length
        ? ["### Approvers", ...co.approvers.map((a) => `- <@${a}>: anything ; catchall`), ""]
        : []),
    ]),
  ];
  writeFileSync(paths.soul, lines.join("\n"), "utf8");

  // Inject structured data the gates read. Validated through the real schema so
  // any shape mismatch surfaces immediately rather than silently at gate time.
  const data = SoulDataSchema.parse({
    manager: { userId: f.manager },
    backupManager: f.backup !== undefined ? { userId: f.backup } : {},
    approvers: f.approvers.map((userId) => ({ userId, scope: "anything", catchall: true })),
    trustedChannels: f.trusted,
    allowedChannels: f.allowed,
    dmAllowedUsers: f.dmAllowed ?? [],
    channelOverrides: (f.channelOverrides ?? []).map((co) => ({
      channel: co.channel,
      ...(co.mandate ? { mandate: co.mandate } : {}),
      approvers: (co.approvers ?? []).map((userId) => ({ userId, scope: "anything", catchall: true })),
    })),
  });
  setSoulData(data);
}
