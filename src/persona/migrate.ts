/**
 * `slaude personas migrate <name|default>`: a SOUL.md persona on disk becomes an
 * agent.yaml beside it.
 *
 * The structure is read once, from the soul's existing extraction, and written
 * out. Two things make the result behave as the old persona did:
 *  - an agent.yaml persona inherits nothing from the default, a SOUL.md persona
 *    inherits the access fields it leaves out. Migration writes the effective
 *    values (`withAclFallback`), so access is exactly what it was.
 *  - the global `## Proactive` section moves to the `proactive` key.
 * Before anything is written the file is compiled and compared with what the old
 * persona read: access, mandates and the proactive settings. A difference stops
 * the migration with the field named, and nothing is written.
 *
 * Secrets are never copied. A soul text that holds a token-shaped value is
 * refused; a persona's Slack user token stays in config.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { AGENT_YAML_MODELINE } from "./agent-schema";
import {
  AGENT_YAML,
  agentDocument,
  documentPartsFromSoul,
  exportedChannelSettings,
  globalProactive,
  parseAgentYaml,
  proseOnlySoul,
  withoutProactiveSection,
} from "./agent-def";
import { PayloadError, PERSONA_NAME_RE } from "./sync/payload";
import { withAclFallback } from "../soul/per-persona";
import type { SoulData } from "../soul/data";
import { parseProactive } from "../soul/proactive";

export interface MigrateOptions {
  /** $SLAUDE_HOME. */
  home: string;
  /** `default` or a directory name under `personas/`. */
  name: string;
  /** Reads a soul's structure (the strict extraction, cache first). */
  extract: (soulMd: string) => Promise<SoulData>;
  /** Write under this directory (same layout) and touch nothing else. Absent: write in place and move SOUL.md aside. */
  out?: string;
  /** In place only: leave SOUL.md where it is (the loader then refuses the persona until it is moved). */
  keepSoul?: boolean;
}

export interface MigrateResult {
  file: string;
  warnings: string[];
  /** Where SOUL.md went, when it was moved. */
  soulMovedTo?: string;
}

/** The suffix SOUL.md gets when it is moved aside. */
export const SOUL_BACKUP_SUFFIX = ".pre-agent-yaml";

const TOKEN_SHAPE = /xox[baprs]-[0-9A-Za-z-]{10,}|sk-ant-[0-9A-Za-z_-]{20,}|ghp_[0-9A-Za-z]{36}|AGE-SECRET-KEY-1[0-9A-Z]{58}|-----BEGIN [A-Z ]*PRIVATE KEY/;

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : undefined);

export async function migratePersona(o: MigrateOptions): Promise<MigrateResult> {
  const { name } = o;
  if (name !== "default" && !PERSONA_NAME_RE.test(name)) throw new PayloadError(`'${name}' is not a valid persona name`);
  const dirOf = (root: string) => (name === "default" ? root : join(root, "personas", name));
  const dir = dirOf(o.home);
  const soulFile = join(dir, "SOUL.md");
  const soulMd = read(soulFile);
  if (soulMd === undefined) {
    throw new PayloadError(existsSync(join(dir, AGENT_YAML)) ? `persona '${name}' already has an ${AGENT_YAML}` : `persona '${name}' has no SOUL.md to migrate`);
  }
  if (existsSync(join(dir, AGENT_YAML))) throw new PayloadError(`persona '${name}' already has an ${AGENT_YAML}; remove it first to migrate again`);
  if (TOKEN_SHAPE.test(soulMd.replace(/^[-*]\s.*;\s.*$/gm, ""))) {
    throw new PayloadError(`persona '${name}': SOUL.md holds a value shaped like a secret; remove it first, a migrated file is meant for git`);
  }

  const own = await o.extract(soulMd);
  let effective = own;
  if (name !== "default") {
    const defDir = o.home;
    const defSoul = read(join(defDir, "SOUL.md"));
    if (defSoul !== undefined) effective = withAclFallback(own, await o.extract(defSoul));
    else if (existsSync(join(defDir, AGENT_YAML))) {
      // The default is already migrated: what it compiles to is what this persona inherited.
      effective = withAclFallback(own, parseAgentYaml("default", readFileSync(join(defDir, AGENT_YAML), "utf8")).spec.definition.soulData);
    }
  }

  let slackUserId: string | undefined;
  if (name !== "default") {
    try {
      const cfg = JSON.parse(read(join(dir, "config.json")) ?? "{}") as { slackUserId?: unknown };
      if (typeof cfg.slackUserId === "string" && cfg.slackUserId) slackUserId = cfg.slackUserId;
    } catch {
      throw new PayloadError(`persona '${name}': config.json is malformed`);
    }
    if (!slackUserId) throw new PayloadError(`persona '${name}': config.json has no slackUserId`);
  }

  const warnings: string[] = [];
  const prose = withoutProactiveSection(proseOnlySoul(soulMd));
  const exported = exportedChannelSettings(soulMd);
  for (const d of exported.dropped) warnings.push(`persona '${name}': channel ${d.channel}: ${d.keys.join(", ")} not carried over, agent.yaml has no key for them`);
  const global = globalProactive(soulMd);
  if (global.dropped.length) warnings.push(`persona '${name}': ## Proactive ${global.dropped.join(", ")} not carried over, agent.yaml has no key for ${global.dropped.length > 1 ? "them" : "it"}`);

  const doc = agentDocument({
    name,
    description: effective.identity.role,
    slackUserId,
    soul: prose.trim() ? prose : `${name}\n`,
    ...documentPartsFromSoul(effective),
    channels: exported.channels,
    proactive: global.proactive,
  });
  const yaml = `${AGENT_YAML_MODELINE}\n${yamlStringify(doc, { lineWidth: 0 })}`;

  // Compile it as the loader will, and compare with what the old persona read.
  const compiled = parseAgentYaml(name, yaml);
  warnings.push(...compiled.warnings);
  assertSame(name, effective, parseProactive(soulMd), compiled.spec.definition.soulData, parseProactive(compiled.spec.soul));

  const file = join(dirOf(o.out ?? o.home), AGENT_YAML);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, yaml);
  const result: MigrateResult = { file, warnings };
  if (!o.out && !o.keepSoul) {
    const moved = `${soulFile}${SOUL_BACKUP_SUFFIX}`;
    renameSync(soulFile, moved);
    result.soulMovedTo = moved;
  }
  return result;
}

/** The fields that decide who may do what, and what the agent works on, must be the same. Names the field, never a value. */
function assertSame(name: string, before: SoulData, beforeProactive: ReturnType<typeof parseProactive>, after: SoulData, afterProactive: ReturnType<typeof parseProactive>): void {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const sorted = (xs: string[]) => [...xs].sort();
  const checks: [string, unknown, unknown][] = [
    ["manager", before.manager.userId, after.manager.userId],
    ["backup manager", before.backupManager.userId, after.backupManager.userId],
    ["approvers", before.approvers, after.approvers],
    ["channel blocks", before.channelOverrides, after.channelOverrides],
    ["public channels", sorted(before.allowedChannels), sorted(after.allowedChannels)],
    ["trusted channels", sorted(before.trustedChannels), sorted(after.trustedChannels)],
    ["dm allowlist", sorted(before.dmAllowedUsers), sorted(after.dmAllowedUsers)],
    ["blocked users", sorted(before.blockedUsers), sorted(after.blockedUsers)],
    ["redaction", before.redactPatterns, after.redactPatterns],
    ["approval timeout", before.approvalTimeoutSeconds, after.approvalTimeoutSeconds],
    ["mandate", (before.mandate ?? "").trim(), (after.mandate ?? "").trim()],
    ["scoped mandates", before.scopeMandates, after.scopeMandates],
    ["proactive enabled", beforeProactive.enabled, afterProactive.enabled],
    ["proactive read", sorted(beforeProactive.read), sorted(afterProactive.read)],
    ["proactive watch", beforeProactive.watch, afterProactive.watch],
    ["quiet hours", beforeProactive.quietHours, afterProactive.quietHours],
    ["max per day", beforeProactive.maxPerPersonPerDay, afterProactive.maxPerPersonPerDay],
    ["channel proactive", beforeProactive.channels, afterProactive.channels],
    ["channel sessions", beforeProactive.sessions, afterProactive.sessions],
  ];
  const differs = checks.filter(([, a, b]) => !same(a, b)).map(([field]) => field);
  if (differs.length) throw new PayloadError(`persona '${name}': the migrated file would not behave as the soul does (${differs.join(", ")}); nothing was written`);
}
