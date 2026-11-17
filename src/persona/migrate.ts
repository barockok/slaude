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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /** Migrate although the soul sets `Wake`, `Highest` or `Cooldown`, which agent.yaml has no key for (they only narrow, so the file would be looser). */
  allowLoss?: boolean;
}

export interface MigrateResult {
  file: string;
  warnings: string[];
  /** Where SOUL.md went, when it was moved. */
  soulMovedTo?: string;
}

/** The suffix SOUL.md gets when it is moved aside. */
export const SOUL_BACKUP_SUFFIX = ".pre-agent-yaml";

const TOKEN_SHAPE = /xox[baprs]-[0-9A-Za-z-]{10,}|xapp-[0-9A-Za-z-]{10,}|sk-ant-[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{20,}|glpat-[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|AGE-SECRET-KEY-1[0-9A-Z]{58}|Bearer\s+[A-Za-z0-9._~+\/-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY/;

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
  if (TOKEN_SHAPE.test(soulMd)) {
    throw new PayloadError(`persona '${name}': SOUL.md holds a value shaped like a secret; remove it first, a migrated file is meant for git`);
  }

  const own = await o.extract(soulMd);
  const warnings: string[] = [];
  let effective = own;
  if (name !== "default") {
    const defDir = o.home;
    const defSoul = read(join(defDir, "SOUL.md"));
    let def: SoulData | null = null;
    if (defSoul !== undefined) def = await o.extract(defSoul);
    // The default is already migrated: what it compiles to is what this persona inherited.
    else if (existsSync(join(defDir, AGENT_YAML))) def = parseAgentYaml("default", readFileSync(join(defDir, AGENT_YAML), "utf8")).spec.definition.soulData;
    if (def) {
      effective = withAclFallback(own, def);
      const mine = (own.trustedChannels.length || own.allowedChannels.length) > 0;
      const differs = JSON.stringify([[...own.trustedChannels].sort(), [...own.allowedChannels].sort()]) !== JSON.stringify([[...def.trustedChannels].sort(), [...def.allowedChannels].sort()]);
      if (mine && differs) {
        warnings.push(`persona '${name}': it lists its own trusted or public channels; a SOUL.md persona's knowledge scope and trust classes were read from the default persona's lists, an agent.yaml persona's from its own, so review which channels count as trusted`);
      }
    }
    warnings.push(`persona '${name}': access added at runtime with /soul is not in the file: only what the soul text says is written`);
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

  const prose = withoutProactiveSection(proseOnlySoul(soulMd));
  const exported = exportedChannelSettings(soulMd);
  for (const d of exported.dropped) warnings.push(`persona '${name}': channel ${d.channel}: ${d.keys.join(", ")} not carried over, agent.yaml has no key for them`);
  const global = globalProactive(soulMd);
  if (global.dropped.length && !o.allowLoss) {
    throw new PayloadError(`persona '${name}': the soul sets ${global.dropped.join(", ")} under ## Proactive, which agent.yaml has no key for; the file would be looser than the soul. Remove the line(s) or pass --allow-loss`);
  }
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
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, yaml);
  renameSync(tmp, file);
  const result: MigrateResult = { file, warnings };
  if (!o.out && !o.keepSoul) {
    const moved = `${soulFile}${SOUL_BACKUP_SUFFIX}`;
    try {
      renameSync(soulFile, moved);
    } catch (e) {
      // Both files would stop the persona loading: put things back.
      rmSync(file, { force: true });
      throw new PayloadError(`persona '${name}': could not move SOUL.md aside (${(e as { code?: string }).code ?? "error"}); nothing was changed`);
    }
    result.soulMovedTo = moved;
  }
  return result;
}

/**
 * A channel block as it behaves: an absent mandate mode is `override` (what the
 * resolver reads), and a mandate is its trimmed text. Without this an extraction
 * that leaves the mode out would differ from a file that states it.
 */
function blocks(xs: SoulData["channelOverrides"]) {
  return xs
    .map((c) => {
      const mandate = c.mandate?.trim() || null;
      return { channel: c.channel, approvers: c.approvers, mandate, mode: mandate ? (c.mandateMode ?? "override") : null };
    })
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

/** The fields that decide who may do what, and what the agent works on, must be the same. Names the field, never a value. */
function assertSame(name: string, before: SoulData, beforeProactive: ReturnType<typeof parseProactive>, after: SoulData, afterProactive: ReturnType<typeof parseProactive>): void {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const sorted = (xs: string[]) => [...xs].sort();
  const checks: [string, unknown, unknown][] = [
    ["manager", before.manager.userId, after.manager.userId],
    ["backup manager", before.backupManager.userId, after.backupManager.userId],
    ["approvers", before.approvers, after.approvers],
    ["channel blocks", blocks(before.channelOverrides), blocks(after.channelOverrides)],
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
