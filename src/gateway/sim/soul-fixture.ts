import { writeFileSync } from "node:fs";
import { paths } from "../../config/home";
import { __setLoadSoulDataFixture } from "../../soul/extract";
import type { SoulData } from "../../soul/data";

export interface SoulFixture {
  manager: string;
  backup?: string;
  approvers: string[];
  trusted: string[];
  allowed: string[];
}

/**
 * Write a minimal SOUL.md fixture into $SLAUDE_HOME that the real soul loader
 * parses into manager/backup/approvers/trusted/allowed.
 *
 * Because the simulation and unit tests use arbitrary placeholder IDs (e.g.
 * "U_MGR") that don't satisfy the production Slack-id regex, this function
 * also primes the `loadSoulData()` fixture override so callers get the full
 * structured SoulData immediately — no LLM call, no Zod id validation.
 *
 * The written SOUL.md follows the canonical format used by the real loader
 * so downstream code that reads SOUL.md directly (e.g. `loadApproverEntries`)
 * also works correctly for IDs that DO satisfy the Slack-id regex.
 */
export function writeSoulFixture(f: SoulFixture): void {
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

  // Prime the fixture override so loadSoulData() returns full structured data
  // without requiring a valid API key or production-format Slack IDs.
  const data: SoulData = {
    identity: { name: "Sim agent" },
    manager: { userId: f.manager },
    backupManager: f.backup ? { userId: f.backup } : {},
    allowedChannels: f.allowed,
    trustedChannels: f.trusted,
    blockedUsers: [],
    approvers: f.approvers.map((id) => ({ userId: id, scope: "anything", catchall: true })),
    redactPatterns: [],
    approvalTimeoutSeconds: 0,
    values: [],
  };
  __setLoadSoulDataFixture(data);
}
