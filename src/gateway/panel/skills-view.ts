/**
 * Read model behind the console's Resources > Skills pages: every skill an
 * agent can use, where it came from, which agents see it, and how often they
 * used it. Built from the same sources the runtime reads; nothing here writes.
 *
 * Sources (how a skill reaches an agent today):
 *   built-in        src/soul/builtin (`slaude:*`), mounted into every session
 *                   as its own plugin (agent/manager.ts, allPlugins).
 *   base root       $SLAUDE_HOME/skills, mounted into every session as the home
 *                   plugin; filled by the dependency installer (slaude.json and
 *                   slaude.lock), the bundled seed (skills/), an operator, or the
 *                   default persona's own write_skill.
 *   agent overlay   $SLAUDE_HOME/personas/<name>/skills, the named persona's own
 *                   write_skill root; shadows a base skill of the same slug.
 *   plugins         Claude Code plugins from the manifest, listed in
 *                   .claude/plugins/installed_plugins.json, mounted into every session.
 *   retired copies  <root>/.retired/<slug>-<stamp>, moved there by the weekly
 *                   skill review (or the console), restorable.
 * Nodes share $SLAUDE_HOME and mount the same roots, so nothing differs per node.
 *
 * Usage keys are what the runtime records (skills/usage.ts skillUsageKey): the
 * name the Skill tool was called with, a leading "/" and the home plugin's
 * prefix removed. So a base or overlay skill counts under its slug and its CLI
 * name, a built-in under `slaude:<name>`, and a plugin skill under
 * `<plugin>:<CLI name of its frontmatter name>` (the name the CLI lists),
 * `<plugin>:<directory>`, and its bare CLI name when no other skill answers
 * to that name.
 */
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { paths } from "../../config/home";
import { BUILTIN_PLUGIN_DIR, cliPluginName, cliSkillName, listBuiltinSkills } from "../../soul/builtin";
import { discoverSkills, globalSkillsRoot, personaSkillsRoot, RETIRED_DIR, SKILL_MD_MAX_BYTES, type Skill } from "../../skills/loader";
import { provenanceSources, skillProvenance, type ProvenanceSources } from "../../skills/provenance";
import { usageKeysOf } from "../../skills/usage";
import { skillOps } from "../../skills/mcp-tools";
import { versionScope } from "../../skills/versions";
import * as SkillUsage from "../../db/skill-usage";
import * as SkillVersions from "../../db/skill-versions";
import * as Proposals from "../../db/proposals";
import { agentIdSync } from "../../knowledge/agent-identity";
import { getPersonaRegistry } from "../../persona/registry";
import { agentNames } from "./console-views";
import type {
  SkillDetailResponse,
  SkillFileView,
  SkillOrigin,
  SkillProposalView,
  SkillSourceKind,
  SkillSummaryView,
  SkillUsageRowView,
  SkillVersionDetailResponse,
  SkillVersionsResponse,
  SkillVersionView,
} from "./api-types";

/** A summary plus what the detail and the actions need, never sent as is. */
export interface SkillEntry extends SkillSummaryView {
  /** The skill's directory on disk. */
  dir: string;
  /** Usage keys it is counted under. */
  keys: string[];
  /** The persona whose root holds it (base and retired-from-base: `default`). */
  owner: string | null;
}

const RETIRED_ID_RE = /^([a-z0-9][a-z0-9-]{0,63})-(\d{8}T\d{6}Z)(?:-(\d{1,3}))?$/;
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

interface LockFile {
  skills?: Record<string, { git?: string; ref?: string; sha?: string; path?: string }>;
}

function readLock(): LockFile | null {
  const file = join(paths.home, "slaude.lock");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as LockFile;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

interface PluginRecord {
  installPath?: string;
  version?: string;
  gitCommitSha?: string;
}

/** Installed plugins: `<plugin>@<marketplace>` -> its records (installed_plugins.json). */
function readPlugins(): Array<{ key: string; record: PluginRecord }> {
  const file = join(paths.claudeConfig, "plugins", "installed_plugins.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { plugins?: Record<string, PluginRecord[]> };
    return Object.entries(parsed.plugins ?? {}).flatMap(([key, recs]) => (recs ?? []).map((record) => ({ key, record })));
  } catch {
    return [];
  }
}

/** A SKILL.md split into frontmatter (parsed leniently) and body. */
export function parseSkillMd(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1] ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
  } catch {
    fm = {};
  }
  return { frontmatter: fm, body: m[2] ?? "" };
}

export { SKILL_MD_MAX_BYTES };

export type SkillFileRead = { ok: true; text: string; truncated: boolean } | { ok: false; reason: string };

/**
 * Read a file the skills API returns content of, safely: it must be a regular
 * file (never a symlink), its real path must stay inside the skill's real
 * directory, and only the first SKILL_MD_MAX_BYTES are read (truncated set).
 */
export function readSkillFileSafe(dir: string, rel = "SKILL.md", max = SKILL_MD_MAX_BYTES): SkillFileRead {
  const file = join(dir, rel);
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "a symlink, not read" };
  if (!st.isFile()) return { ok: false, reason: "not a regular file" };
  try {
    const root = realpathSync(dir);
    const real = realpathSync(file);
    if (real !== root && !real.startsWith(root + sep)) return { ok: false, reason: "outside the skill directory, not read" };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = Math.min(st.size, max);
    const buf = Buffer.alloc(size);
    const n = size > 0 ? readSync(fd, buf, 0, size, 0) : 0;
    return { ok: true, text: buf.subarray(0, n).toString("utf8"), truncated: st.size > max };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readSkillMd(dir: string): string | null {
  const r = readSkillFileSafe(dir);
  return r.ok ? r.text : null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** `20261101T120000Z` -> epoch ms. */
function stampTime(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
}

/** Persona name -> the agent id its usage rows are keyed on (as backgroundAgentId resolves it, without waiting). */
export function agentIdsByName(names: string[] = agentNames()): Map<string, string> {
  const out = new Map<string, string>();
  const r = getPersonaRegistry();
  for (const n of names) {
    const id = n === "default" ? agentIdSync() : r.lookupByName(n)?.slackUserId;
    if (id) out.set(n, id);
  }
  return out;
}

function sourceOf(prov: ReturnType<typeof skillProvenance>): SkillSourceKind {
  return prov === "agent" ? "agent-authored" : "installed";
}

function originOf(s: Skill, prov: ReturnType<typeof skillProvenance>, lock: LockFile | null, owner: string): SkillOrigin {
  const root = s.source === "persona" ? "agent" : "base";
  if (prov === "agent") return { root, authoredBy: owner, authoredAt: s.authoredAt ?? null };
  if (prov === "bundled") return { root, bundled: true };
  const l = lock?.skills?.[s.slug];
  if (l) return { root, ...(l.git ? { repo: l.git } : {}), ...(l.ref ? { ref: l.ref } : {}), ...(l.sha ? { commit: l.sha } : {}), ...(l.path ? { path: l.path } : {}) };
  return { root, local: true };
}

interface Built {
  entries: SkillEntry[];
  notes: string[];
}

/**
 * The last moment a retired copy's history can include: the retirement. Its
 * stamp has whole seconds and the retire captures at the same instant with
 * milliseconds, so the cutoff is the end of that second. Undefined for a live skill.
 */
function versionCutoff(e: Pick<SkillEntry, "status" | "origin">): number | undefined {
  return e.status === "retired" ? (e.origin.retiredAt ?? 0) + 999 : undefined;
}

/** Every skill, with agents, origin and usage. */
export async function buildSkills(): Promise<Built> {
  const notes: string[] = [];
  const names = agentNames();
  const named = names.filter((n) => n !== "default");
  const ids = agentIdsByName(names);
  const lock = readLock();
  if (lock === null) notes.push("slaude.lock could not be read: installed skills show without their repo and commit, and count as installed.");
  const src: ProvenanceSources = provenanceSources();
  const entries: SkillEntry[] = [];
  const base = (keys: string[], agents: string[]) => ({ keys, agents, usage: { uses: 0, lastUsedAt: null, trackedSince: null }, currentVersion: null });

  // Built-in slaude:* skills: every agent.
  try {
    for (const b of listBuiltinSkills()) {
      const dir = join(BUILTIN_PLUGIN_DIR, "skills", b.name);
      entries.push({
        id: `builtin:${b.name}`,
        slug: b.name,
        name: b.name,
        description: b.description,
        invocation: b.qualified,
        source: "built-in",
        status: "active",
        origin: { root: "built-in", version: b.version },
        dir,
        owner: null,
        ...base([b.qualified], names),
      });
    }
  } catch (e) {
    notes.push(`built-in skills could not be listed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The loader read these for the runtime; what the console shows is read
  // again under the API's rules (regular file inside the dir, size cap).
  const safely = (sk: Skill): Skill => {
    const r = readSkillFileSafe(sk.dir);
    if (!r.ok) return { ...sk, name: sk.slug, description: `(SKILL.md ${r.reason})` };
    const { frontmatter } = parseSkillMd(r.text);
    return { ...sk, name: str(frontmatter.name) || sk.slug, description: str(frontmatter.description) };
  };

  // Overlays first, so the base knows which agents its slugs are shadowed for.
  const overlay = new Map<string, Skill[]>();
  for (const p of named) overlay.set(p, discoverSkills(p).filter((s) => s.source === "persona"));

  for (const s of discoverSkills().map(safely)) {
    const shadowed = named.filter((p) => overlay.get(p)!.some((o) => o.slug === s.slug));
    const prov = skillProvenance(s, src);
    entries.push({
      id: `base:${s.slug}`,
      slug: s.slug,
      name: s.name,
      description: s.description,
      invocation: `/${s.slug}`,
      source: sourceOf(prov),
      status: "active",
      origin: originOf(s, prov, lock, "default"),
      dir: s.dir,
      owner: "default",
      ...(shadowed.length ? { shadowedFor: shadowed } : {}),
      ...base(usageKeysOf(s), names.filter((n) => !shadowed.includes(n))),
    });
  }
  for (const [p, skills] of overlay) {
    for (const s of skills.map(safely)) {
      const prov = skillProvenance(s, src);
      entries.push({
        id: `agent:${p}:${s.slug}`,
        slug: s.slug,
        name: s.name,
        description: s.description,
        invocation: `/${s.slug}`,
        source: sourceOf(prov),
        status: "active",
        origin: originOf(s, prov, lock, p),
        dir: s.dir,
        owner: p,
        ...base(usageKeysOf(s), [p]),
      });
    }
  }

  // Claude Code plugins installed from the manifest: every agent.
  const builtinDir = BUILTIN_PLUGIN_DIR;
  const seenPaths = new Set<string>();
  for (const { key, record } of readPlugins()) {
    const dir = record.installPath;
    if (!dir || seenPaths.has(dir) || dir === builtinDir || !existsSync(dir)) continue;
    seenPaths.add(dir);
    const plugin = cliPluginName(dir);
    const marketplace = key.includes("@") ? key.slice(key.lastIndexOf("@") + 1) : undefined;
    const root = join(dir, "skills");
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(".")) continue;
      const sdir = join(root, entry);
      const raw = readSkillMd(sdir);
      if (raw === null) continue;
      const { frontmatter } = parseSkillMd(raw);
      const name = str(frontmatter.name) || entry;
      const invocation = `${plugin}:${cliSkillName(name)}`;
      entries.push({
        id: `plugin:${plugin}:${entry}`,
        slug: entry,
        name,
        description: str(frontmatter.description),
        invocation,
        source: "plugin",
        status: "active",
        origin: {
          root: "plugin",
          plugin,
          ...(marketplace ? { marketplace } : {}),
          ...(record.version ? { version: record.version } : {}),
          ...(record.gitCommitSha ? { commit: record.gitCommitSha } : {}),
        },
        dir: sdir,
        owner: null,
        ...base([...new Set([invocation, `${plugin}:${entry}`])], names),
      });
    }
  }

  // A plugin skill called by its bare name is recorded under that name: count
  // it there too, unless another skill answers to the same bare name.
  const bareOwners = new Map<string, number>();
  const bareOf = (e: SkillEntry) => (e.source === "plugin" ? e.invocation.slice(e.invocation.indexOf(":") + 1) : null);
  for (const e of entries) {
    const answersTo = e.source === "plugin" ? [bareOf(e)!] : e.keys;
    for (const k of answersTo) bareOwners.set(k, (bareOwners.get(k) ?? 0) + 1);
  }
  for (const e of entries) {
    const bare = bareOf(e);
    if (bare && bareOwners.get(bare) === 1) e.keys.push(bare);
  }

  // Retired copies, in each agent's own root.
  for (const p of names) {
    const store = join(p === "default" ? globalSkillsRoot() : personaSkillsRoot(p), RETIRED_DIR);
    if (!existsSync(store)) continue;
    for (const rid of readdirSync(store).filter((e) => RETIRED_ID_RE.test(e)).sort()) {
      const m = RETIRED_ID_RE.exec(rid)!;
      const dir = join(store, rid);
      const raw = readSkillMd(dir);
      if (raw === null) continue;
      const { frontmatter } = parseSkillMd(raw);
      const agentMade = str(frontmatter.authored_by) === "agent";
      const slug = m[1]!;
      const name = str(frontmatter.name) || slug;
      entries.push({
        id: `retired:${p}:${rid}`,
        slug,
        name,
        description: str(frontmatter.description),
        invocation: `/${slug}`,
        source: agentMade ? "agent-authored" : "installed",
        status: "retired",
        origin: {
          root: p === "default" ? "base" : "agent",
          ...(agentMade ? { authoredBy: p, authoredAt: str(frontmatter.authored_at) || null } : {}),
          retiredAt: stampTime(m[2]!),
          retiredId: rid,
        },
        dir,
        owner: p,
        keys: usageKeysOf({ slug, name }),
        agents: [],
        usage: { uses: 0, lastUsedAt: null, trackedSince: null },
        currentVersion: null,
      });
    }
  }

  // Usage, summed over the agents that use each skill (a retired copy: its owner's history).
  let rows: SkillUsage.SkillUsageRow[] = [];
  try {
    rows = await SkillUsage.allRows();
  } catch (e) {
    notes.push(`skill usage could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const byAgent = new Map<string, Map<string, SkillUsage.SkillUsageRow>>();
  for (const r of rows) {
    let m = byAgent.get(r.agentId);
    if (!m) byAgent.set(r.agentId, (m = new Map()));
    m.set(r.skill, r);
  }
  for (const e of entries) {
    const who = e.status === "retired" ? (e.owner ? [e.owner] : []) : e.agents;
    for (const n of who) {
      const m = byAgent.get(ids.get(n) ?? "");
      if (!m) continue;
      for (const k of e.keys) {
        const r = m.get(k);
        if (!r) continue;
        e.usage.uses += r.uses;
        if (r.lastUsedAt !== null && (e.usage.lastUsedAt === null || r.lastUsedAt > e.usage.lastUsedAt)) e.usage.lastUsedAt = r.lastUsedAt;
        if (e.usage.trackedSince === null || r.firstSeenAt < e.usage.trackedSince) e.usage.trackedSince = r.firstSeenAt;
      }
    }
  }

  // The version log: an owned skill (base, overlay, retired) has an identity; built-ins and plugins do not.
  try {
    const current = await SkillVersions.currentVersions();
    for (const e of entries) {
      if (e.owner === null) continue;
      const scope = versionScope(e.owner);
      const upTo = versionCutoff(e);
      // A later skill may hold this slug now: a retired copy shows the version it had when retired.
      e.currentVersion = upTo === undefined
        ? current.get(SkillVersions.versionKey(scope, e.slug)) ?? null
        : (await SkillVersions.list(scope, e.slug, 1, upTo))[0]?.version ?? null;
    }
  } catch (e) {
    notes.push(`skill versions could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }

  const order: Record<SkillSourceKind, number> = { "built-in": 0, installed: 1, plugin: 2, "agent-authored": 3 };
  entries.sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) || order[a.source] - order[b.source] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { entries, notes };
}

/** The summary as sent: without the on-disk path and the internal keys. */
export function summaryOf(e: SkillEntry): SkillSummaryView {
  const { dir: _d, keys: _k, owner: _o, ...view } = e;
  return view;
}

const FILES_MAX = 300;
const FILES_DEPTH = 6;

/** Files under a skill's directory, relative and sorted; symlinks are listed but never followed. */
function listFiles(dir: string): { files: SkillFileView[]; truncated: boolean } {
  const files: SkillFileView[] = [];
  let truncated = false;
  const walk = (d: string, depth: number) => {
    if (truncated) return;
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (files.length >= FILES_MAX) {
        truncated = true;
        return;
      }
      const p = join(d, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < FILES_DEPTH) walk(p, depth + 1);
        else truncated = true;
        continue;
      }
      files.push({ path: relative(dir, p).split(sep).join("/"), size: st.isSymbolicLink() ? 0 : st.size });
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, 0);
  return { files, truncated };
}

/** One skill in full. Null when the id names no skill. */
export async function skillDetail(id: string): Promise<SkillDetailResponse | null> {
  const { entries } = await buildSkills();
  const e = entries.find((x) => x.id === id);
  if (!e) return null;
  const read = readSkillFileSafe(e.dir);
  const raw = read.ok ? read.text : "";
  const { frontmatter, body } = parseSkillMd(raw);
  const { files, truncated } = listFiles(e.dir);
  const ids = agentIdsByName();
  const nameOf = new Map([...ids].map(([n, aid]) => [aid, n]));
  const who = new Set(e.status === "retired" ? (e.owner ? [e.owner] : []) : e.agents);
  const keys = new Set(e.keys);

  let usageHistory: SkillUsageRowView[] = [];
  try {
    usageHistory = (await SkillUsage.allRows())
      .filter((r) => keys.has(r.skill) && who.has(nameOf.get(r.agentId) ?? ""))
      .map((r) => ({ agent: nameOf.get(r.agentId)!, key: r.skill, uses: r.uses, lastUsedAt: r.lastUsedAt, firstSeenAt: r.firstSeenAt }))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  } catch {
    usageHistory = [];
  }

  let proposals: SkillProposalView[] = [];
  try {
    const relevant = new Set([...(e.owner ? [e.owner] : []), ...e.agents].map((n) => ids.get(n)).filter(Boolean) as string[]);
    proposals = (await Proposals.listSkillProposals())
      .filter((p) => p.payload.slug === e.slug && relevant.has(p.agentId))
      .filter((p) => e.status !== "retired" || p.kind !== Proposals.SKILL_RETIRED_KIND || p.payload.retiredId === e.origin.retiredId)
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        status: p.status,
        agent: nameOf.get(p.agentId) ?? p.agentId,
        createdAt: p.createdAt,
        decidedBy: p.decidedBy,
        decidedAt: p.decidedAt,
        reason: typeof p.payload.reason === "string" ? p.payload.reason : null,
      }));
  } catch {
    proposals = [];
  }

  return {
    ...summaryOf(e),
    frontmatter,
    body,
    raw,
    rawTruncated: read.ok && read.truncated,
    ...(read.ok ? {} : { rawUnreadable: `SKILL.md is ${read.reason}` }),
    files,
    filesTruncated: truncated,
    usageHistory,
    proposals,
    actions: actionsFor(e, entries),
  };
}

const VERSIONS_MAX = 200;

const versionView = (v: SkillVersions.SkillVersionMeta): SkillVersionView => ({
  version: v.version,
  hash: v.contentHash,
  capturedAt: v.capturedAt,
  origin: v.origin,
  fileCount: v.fileCount,
  totalBytes: v.totalBytes,
  skillMdTruncated: v.skillMdTruncated,
});

/** A skill's recorded versions, newest first. Null when the id names no skill; empty for one with no identity. */
export async function skillVersions(id: string): Promise<SkillVersionsResponse | null> {
  const { entries } = await buildSkills();
  const e = entries.find((x) => x.id === id);
  if (!e) return null;
  if (e.owner === null) return { versions: [], truncated: false };
  const rows = await SkillVersions.list(versionScope(e.owner), e.slug, VERSIONS_MAX + 1, versionCutoff(e));
  return { versions: rows.slice(0, VERSIONS_MAX).map(versionView), truncated: rows.length > VERSIONS_MAX };
}

/** One recorded version with its SKILL.md. Null when the skill or the version does not exist. */
export async function skillVersionDetail(id: string, version: number): Promise<SkillVersionDetailResponse | null> {
  const { entries } = await buildSkills();
  const e = entries.find((x) => x.id === id);
  if (!e || e.owner === null) return null;
  const row = await SkillVersions.get(versionScope(e.owner), e.slug, version);
  const upTo = versionCutoff(e);
  if (!row || (upTo !== undefined && row.capturedAt > upTo)) return null;
  return { ...versionView(row), skillMd: row.skillMd };
}

/**
 * What the console may do: retire an active agent-authored skill in an
 * agent's own root (as the weekly review may), or restore a retired copy whose
 * slug is free again in that root.
 */
export function actionsFor(e: SkillEntry, all: SkillEntry[]): { retire: boolean; restore: boolean } {
  const retire = e.status === "active" && e.source === "agent-authored" && (e.origin.root === "base" || e.origin.root === "agent");
  const liveIdFor = (owner: string) => (owner === "default" ? `base:${e.slug}` : `agent:${owner}:${e.slug}`);
  const restore = e.status === "retired" && e.owner !== null && !all.some((x) => x.id === liveIdFor(e.owner!));
  return { retire, restore };
}

export type SkillActionResult = { ok: true; id: string; entry: SkillEntry; retiredId: string } | { ok: false; status: number; error: string };

/**
 * Retire an agent-authored skill from the console: the weekly review's own
 * path (skillOps.retire, then a `skill-retired` row so the digest lists it and
 * a manager can restore it from Slack too).
 */
export async function retireSkill(id: string, a: { by: string; reason: string; now?: Date }): Promise<SkillActionResult> {
  const { entries } = await buildSkills();
  const e = entries.find((x) => x.id === id);
  if (!e) return { ok: false, status: 404, error: "no such skill" };
  if (!actionsFor(e, entries).retire) {
    return { ok: false, status: 409, error: "only an active skill the agent wrote itself can be retired; propose removing others in the personas repo or the manifest" };
  }
  const owner = e.owner ?? "default";
  const now = a.now ?? new Date();
  let retiredId: string;
  try {
    retiredId = skillOps.retire(e.slug, owner === "default" ? undefined : owner, now).id;
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  const agentId = agentIdsByName([owner]).get(owner);
  if (agentId) {
    await Proposals.recordSkillRetired({
      agentId,
      payload: { slug: e.slug, retiredId, persona: owner, reason: a.reason, uses: e.usage.uses, lastUsedAt: e.usage.lastUsedAt },
      at: now.getTime(),
      decidedBy: a.by,
    }).catch((err) => console.error(`[panel] retired skill ${e.slug} (${retiredId}) but could not record it: ${err instanceof Error ? err.message : String(err)}`));
  }
  return { ok: true, id: `retired:${owner}:${retiredId}`, entry: e, retiredId };
}

/**
 * Restore a retired copy: claim its `skill-retired` row when it has one (one
 * winner across replicas and the Slack Restore button), move it back with
 * skillOps.restore, and give the claim back when the move fails.
 */
export async function restoreSkill(id: string, a: { by: string; now?: Date }): Promise<SkillActionResult> {
  const { entries } = await buildSkills();
  const e = entries.find((x) => x.id === id);
  if (!e) return { ok: false, status: 404, error: "no such skill" };
  if (!actionsFor(e, entries).restore) return { ok: false, status: 409, error: "this copy cannot be restored: a live skill holds its slug" };
  const owner = e.owner ?? "default";
  const rid = e.origin.retiredId!;
  const at = (a.now ?? new Date()).getTime();
  const agentId = agentIdsByName([owner]).get(owner);
  const row = agentId
    ? (await Proposals.listSkillProposals()).find(
        (p) => p.kind === Proposals.SKILL_RETIRED_KIND && p.agentId === agentId && p.payload.retiredId === rid && p.status === "approved",
      )
    : undefined;
  if (row && !(await Proposals.claimSkillRestore(row.id, a.by, at))) return { ok: false, status: 409, error: "this skill was already restored" };
  try {
    const back = skillOps.restore(rid, owner === "default" ? undefined : owner);
    return { ok: true, id: owner === "default" ? `base:${back.slug}` : `agent:${owner}:${back.slug}`, entry: e, retiredId: rid };
  } catch (err) {
    if (row) await Proposals.releaseSkillRestore(row.id, a.by, at).catch(() => {});
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
}
