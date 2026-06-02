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
}

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
  });
  setSoulData(data);
}
