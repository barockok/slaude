/**
 * `personas/<name>/agent.yaml`: one file that defines an agent. It compiles to
 * the same sync payload the older three-file layout renders to; the structured
 * parts (mandates, access) build `SoulData` here, deterministically, so a
 * persona defined this way never goes through soul extraction.
 *
 * Plugins are deliberately not a field: every agent on a machine gets every
 * plugin installed there, and `runsOn` picks the machines.
 *
 * Errors name the persona and the key, never the value.
 */
import { parse as parseYaml, YAMLParseError } from "yaml";
import { MANDATE_LINE_MAX, subMandatesOf, type SubMandate } from "../soul/mandate-scope";
import { env } from "../config/env";
import { SoulDataSchema, type AccessEntry, type AccessRef, type ApproverEntry, type ChannelOverride, type ScopeMandate, type SoulData } from "../soul/data";
import { channelOf, endsInOpenFence, isCodeFence, parseProactive, parseWindow } from "../soul/proactive";
import { AgentSchema, BOUNDARY_RE, CHANNEL_ID_RE, DESCRIPTION_MAX, USER_ID_RE, type AgentFile } from "./agent-schema";
import { anchored, parseRef, refScheme, SRC } from "../refs/parse";
import type { Ref } from "../refs/types";
import type { ZodIssue } from "zod";
import { PayloadError, safeKey } from "./sync/payload";

export const AGENT_YAML = "agent.yaml";
/** The older layout's files, which cannot sit beside an agent.yaml. */
export const LEGACY_FILES = ["persona.yaml", "SOUL.md", "mcp.json"] as const;

const MODES = new Set(["override", "extend", "reduce"]);
export { DESCRIPTION_MAX };

/** Exactly what `channels` compiles to; anything else under a `## Channel` heading was authored. */
const GENERATED_CHANNEL_SECTION_RE = /^## Channel <#[CGD][A-Z0-9]+>(?=\n###)(?:\n### Session\n- Mode: channel)?(?:\n### Proactive\n- Enabled: (?:yes|no))?$/;

/** A soul section that agent.yaml keeps in its own keys (headings a SOUL.md may carry). */
const STRUCTURED_HEADING_RE =
  /^##\s+(?:mandate|reporting|manager|backup manager|secondary manager|deputy|approvers?|allowed channels|public channels|trusted channels|team channel|home channel|bu channel|blocked|blacklist|banned|ignore|dm allowlist|allowed dms|direct message allowlist|who can dm|redaction|redact|pii patterns|approval timeout|auto-deny|channel\b.*|scope\s+(?:dm|public|trusted))\s*$/i;

/**
 * The issue to report: an unknown key first (the nearest to the top), then the
 * first in the schema's own order. Its text comes from the schema's messages,
 * which never carry a value; a key is echoed only through safeKey.
 */
function firstIssue(issues: ZodIssue[]): { path: string; message: string } {
  const unknown = issues
    .filter((i) => i.code === "unrecognized_keys")
    .sort((a, b) => a.path.length - b.path.length)[0];
  const issue = unknown ?? issues[0]!;
  const base = issue.path.map((seg, i) => pathSegment(seg, i, issue.path)).reduce((acc, s) => (s.startsWith("[") || !acc ? acc + s : `${acc}.${s}`), "");
  if (issue.code === "unrecognized_keys") {
    const k = String(issue.keys[0] ?? "");
    return { path: `${base ? `${base}.` : ""}${safeKey(k)}`, message: "is not a known key" };
  }
  return { path: base, message: issue.message };
}

/** A `channels` key that is safe to name in a path: a Slack channel id or reference, bare or typed. Any other key is a placeholder. */
const SLACK_KEY_RE = new RegExp(anchored(`${SRC.slackChannel}|${SRC.bareChannel}`));

/** One path segment: a schema key as is, an index in brackets, a `channels` key only when it is a channel id. */
function pathSegment(seg: string | number, i: number, path: (string | number)[]): string {
  if (typeof seg === "number") return `[${seg}]`;
  if (i === 1 && path[0] === "channels") return SLACK_KEY_RE.test(seg) ? seg : "<key>";
  return seg;
}

function isMap(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export interface CompiledAgent {
  /** The payload persona, before the gateway's own field validation. */
  spec: {
    name: string;
    soul: string;
    slackUserId?: string;
    userToken?: string;
    model?: string;
    runsOn?: string;
    provider?: unknown;
    mcp?: unknown;
    kbSources?: unknown;
    background?: unknown;
    definition: { description?: string; skills?: string[]; guardrails?: string[]; soulData: SoulData };
  };
  warnings: string[];
}

/** Parse one agent.yaml. Throws PayloadError naming the persona and key for anything malformed. */
export function parseAgentYaml(name: string, text: string): CompiledAgent {
  const fail = (key: string, why: string): never => {
    throw new PayloadError(`persona '${name}': agent.yaml ${key} ${why}`);
  };
  const noRepeats = (key: string, list: string[] | undefined): string[] | undefined => {
    const seen = new Set<string>();
    list?.forEach((x, i) => {
      if (seen.has(x)) fail(`${key}[${i}]`, "repeats an earlier entry");
      seen.add(x);
    });
    return list;
  };
  let raw: unknown;
  try {
    // The `yaml` package refuses a duplicate key. Its message quotes the source
    // line, so only its code and position are reported.
    raw = parseYaml(text);
  } catch (e) {
    const where = e instanceof YAMLParseError ? `${e.code}${e.linePos ? ` at line ${e.linePos[0].line}` : ""}` : "unreadable";
    throw new PayloadError(`persona '${name}': agent.yaml is not valid YAML (${where})`);
  }
  if (!isMap(raw)) fail("", "must be a mapping of the agent's fields");
  const doc = raw as Record<string, unknown>;

  const warnings: string[] = [];
  /**
   * A reference field read down to the bare Slack id the runtime uses today. A
   * bare id is accepted with a warning that names the field, never the value;
   * a `slack:` reference loses its workspace for now; any other scheme parses
   * but cannot be resolved until records exist, and is refused here.
   */
  const slackRef = (path: string, value: string | number, role: "user" | "channel"): { id: string; workspace?: string } => {
    const v = String(value);
    if (!v.includes(":")) {
      const writeAs = role === "user" ? "slack:user:<id>" : "slack:channel:<id>";
      warnings.push(`persona '${name}': agent.yaml ${path} is a bare Slack id, which is accepted for one more release; write ${writeAs}`);
      return { id: v };
    }
    const r = parseRef(v, [role]);
    if (!r.ok) return fail(path, `is not a valid reference: ${r.reason}`);
    const id = resolvedSlackId(path, r.ref);
    return r.ref.kind === "external" && r.ref.workspace ? { id, workspace: r.ref.workspace } : { id };
  };
  const slackId = (path: string, value: string | number, role: "user" | "channel"): string => slackRef(path, value, role).id;
  const resolvedSlackId = (path: string, ref: Ref): string => {
    if (ref.kind === "external" && ref.service === "slack") return ref.id;
    if (ref.kind === "selector") return fail(path, "is a selector, which is not a reference to one record and cannot be used here");
    return fail(path, `uses the '${refScheme(ref)}' scheme, which cannot be resolved yet: records for it arrive in a later release, so for now write a slack: reference`);
  };
  // Shape (keys, types, patterns, lengths, nulls) is the schema's; see agent-schema.ts.
  const checked = AgentSchema.safeParse(doc);
  if (!checked.success) {
    const issue = firstIssue(checked.error.issues);
    fail(issue.path, issue.message);
  }
  const file = checked.data as AgentFile;

  if (file.name !== name) fail("name", `must equal the directory name '${name}'`);
  const soulText = file.soul;
  const description = file.description ?? undefined;
  const model = file.model ?? undefined;
  const userToken = file.userToken ?? undefined;
  const runsOn = file.runsOn ?? undefined;
  const slackUserIdRaw = file.slackUserId == null ? undefined : String(file.slackUserId);
  const slackUserId = slackUserIdRaw ? slackId("slackUserId", slackUserIdRaw, "user") : undefined;
  const provider = file.provider ?? undefined;
  const mcp = file.mcp ?? undefined;
  const skills = noRepeats("skills", file.skills ?? undefined);
  const guardrails = noRepeats("guardrails", file.guardrails ?? undefined);

  const memory = file.memory ?? {};

  const mandate = file.mandate ?? {};
  const global = mandate.global ?? undefined;
  const channels = new Map<string, ChannelOverride>();
  const channelBlock = (channel: string): ChannelOverride => {
    let block = channels.get(channel);
    if (!block) {
      block = { channel, approvers: [] };
      channels.set(channel, block);
    }
    return block;
  };
  const scopes: ScopeMandate[] = [];
  const seenBoundary = new Set<string>();
  (mandate.scoped ?? []).forEach((e, i) => {
    const key = `mandate.scoped[${i}]`;
    // The compiled form is what mandate-scope.ts reads: channel:<id>, trust:<class> or dm.
    let boundary: string;
    if (BOUNDARY_RE.test(e.boundary)) {
      boundary = e.boundary;
      if (boundary.startsWith("channel:")) {
        warnings.push(`persona '${name}': agent.yaml ${key}.boundary is the older channel:<id> form, which is accepted for one more release; write slack:channel:<id>`);
      }
    } else {
      const r = parseRef(e.boundary, ["channel", "selector"]);
      if (!r.ok) return fail(`${key}.boundary`, `is not a valid reference: ${r.reason}`);
      boundary = r.ref.kind === "selector" ? r.ref.name : `channel:${resolvedSlackId(`${key}.boundary`, r.ref)}`;
    }
    if (seenBoundary.has(boundary)) fail(`${key}.boundary`, "repeats an earlier boundary");
    seenBoundary.add(boundary);
    // As a soul's `Mode:` line: absent is override, and an unknown value reads
    // as extend, so a typo keeps the global mandate instead of replacing it.
    const written = typeof e.mode === "string" ? e.mode.trim().toLowerCase() : "";
    let mode = "override";
    if (e.mode != null) {
      mode = MODES.has(written) ? written : "extend";
      if (!MODES.has(written)) warnings.push(`persona '${name}': agent.yaml ${key}.mode is not override, extend or reduce; it reads as extend`);
    }
    const text = e.text;
    const m = mode as "override" | "extend" | "reduce";
    if (m !== "override" && text.trim().length > MANDATE_LINE_MAX) {
      warnings.push(`persona '${name}': agent.yaml ${key}.text is longer than ${MANDATE_LINE_MAX} characters; a ${m} is carried whole, so keep it short`);
    }
    if (boundary.startsWith("channel:")) {
      const b = channelBlock(boundary.slice("channel:".length));
      b.mandate = text.trim();
      b.mandateMode = m;
    } else {
      const scope = boundary === "dm" ? "dm" : (boundary.slice("trust:".length) as "public" | "trusted");
      scopes.push({ scope, mandate: text.trim(), mode: m });
    }
  });

  const access = file.access ?? {};
  const accessEntries: AccessEntry[] = [];
  /** Read one access reference and keep its typed form beside the bare id the legacy arrays carry. */
  const accessRefs: AccessRef[] = [];
  const entryId = (
    path: string,
    value: string | number,
    e: Pick<AccessEntry, "field" | "kind" | "role"> & Partial<Pick<AccessEntry, "deny" | "dmOnly" | "channel">>,
  ): string | undefined => {
    // An `email:` or `user:` reference is a person, not a Slack id: only while the access source is `internal` (task 22) is it accepted,
    // and then it is kept in `accessRefs` and never in the legacy arrays. Under any other source it is refused as before.
    if (e.kind === "user" && typeof value === "string" && value.includes(":") && env.access.source() === "internal") {
      const p = parseRef(value, ["user"]);
      if (p.ok && (p.ref.kind === "email" || (p.ref.kind === "internal" && p.ref.type === "user"))) {
        accessRefs.push({
          field: e.field as AccessRef["field"],
          ref: p.ref.kind === "email" ? { service: "email", address: p.ref.address } : { service: "user", userId: p.ref.id },
          role: e.role,
          deny: e.deny ?? false,
          dmOnly: e.dmOnly ?? false,
          ...(e.channel ? { channel: e.channel } : {}),
        });
        return undefined;
      }
    }
    const r = slackRef(path, value, e.kind);
    accessEntries.push({ deny: false, dmOnly: false, ...e, id: r.id, ...(r.workspace ? { workspace: r.workspace } : {}) });
    return r.id;
  };
  const channelLists = access.channels ?? {};
  const approvers: ApproverEntry[] = [];
  (access.approvers ?? []).forEach((e, i) => {
    const channel = e.channel ? slackId(`access.approvers[${i}].channel`, e.channel, "channel") : undefined;
    const userId = entryId(`access.approvers[${i}].user`, e.user, { field: "approvers", kind: "user", role: "approver", ...(channel ? { channel } : {}) });
    if (userId === undefined) return; // an email or user reference: in accessRefs, not in the Slack-id list
    const entryOut: ApproverEntry = {
      userId,
      scope: e.scope ?? "anything",
      catchall: typeof e.catchall === "boolean" ? e.catchall : e.scope == null,
    };
    if (channel) channelBlock(channel).approvers.push(entryOut);
    else approvers.push(entryOut);
  });
  const redact = access.redact ?? [];
  redact.forEach((p, i) => {
    try {
      new RegExp(p, "gi");
    } catch {
      fail(`access.redact[${i}]`, "is not a valid regular expression");
    }
  });
  const manager = access.manager ? entryId("access.manager", access.manager, { field: "manager", kind: "user", role: "manager" }) : undefined;
  const backupManager = access.backupManager ? entryId("access.backupManager", access.backupManager, { field: "backupManager", kind: "user", role: "manager" }) : undefined;
  const idList = (path: string, list: string[] | null | undefined, e: Pick<AccessEntry, "field" | "kind" | "role"> & Partial<Pick<AccessEntry, "deny" | "dmOnly">>) =>
    (list ?? []).map((v, i) => entryId(`${path}[${i}]`, v, e)).filter((id): id is string => id !== undefined);

  const soulData = SoulDataSchema.parse({
    identity: { name, ...(description ? { role: description } : {}) },
    manager: manager ? { userId: manager } : {},
    backupManager: backupManager ? { userId: backupManager } : {},
    allowedChannels: idList("access.channels.public", channelLists.public, { field: "channels.public", kind: "channel", role: "member" }),
    trustedChannels: idList("access.channels.trusted", channelLists.trusted, { field: "channels.trusted", kind: "channel", role: "member" }),
    blockedUsers: idList("access.blocked", access.blocked, { field: "blocked", kind: "user", role: "member", deny: true }),
    dmAllowedUsers: idList("access.dm", access.dm, { field: "dm", kind: "user", role: "member", dmOnly: true }),
    approvers,
    redactPatterns: redact,
    approvalTimeoutSeconds: access.approvalTimeoutSeconds ?? 0,
    ...(global?.trim() ? { mandate: global.trim() } : {}),
    channelOverrides: [...channels.values()],
    scopeMandates: scopes,
    accessEntries,
    accessRefs,
  });

  // Per-channel session and proactive settings compile to the `## Channel` block
  // the soul parser reads. The warnings below run on the authored soul alone:
  // this block is generated, not a section left in the prose by mistake.
  const authoredChannels = new Set(channelSections(soulText).map((s) => s.channel));
  let channelBlocks = "";
  const seenChannel = new Set<string>();
  for (const [key, entry] of Object.entries(file.channels ?? {})) {
    const keyPath = `channels.${SLACK_KEY_RE.test(key) ? key : "<key>"}`;
    const channel = slackId(keyPath, key, "channel");
    if (seenChannel.has(channel)) fail(keyPath, "repeats an earlier channel");
    seenChannel.add(channel);
    if (authoredChannels.has(channel)) fail(keyPath, "also has a ## Channel section in soul: keep it in one place");
    let settings = "";
    if (entry?.session === "channel") settings += "\n### Session\n- Mode: channel";
    if (entry?.proactive != null) settings += `\n### Proactive\n- Enabled: ${entry.proactive ? "yes" : "no"}`;
    if (settings) channelBlocks += `\n\n## Channel <#${channel}>${settings}`;
  }
  if (channelBlocks && endsInOpenFence(soulText)) fail("soul", "ends inside an open code fence, so the channels settings would not be read");

  // The global `proactive` key compiles to the `## Proactive` section parseProactive reads.
  let proactiveBlock = "";
  const pro = file.proactive;
  if (pro) {
    const lines: string[] = [];
    if (pro.enabled != null) lines.push(`- Enabled: ${pro.enabled ? "yes" : "no"}`);
    if (pro.read?.length) lines.push(`- Read: ${pro.read.map((v, i) => `<#${slackId(`proactive.read[${i}]`, v, "channel")}>`).join(", ")}`);
    if (pro.watch?.length) lines.push(`- Watch: ${pro.watch.map((w) => w.trim()).join(", ")}`);
    if (pro.quietHours) {
      if (!parseWindow(pro.quietHours)) fail("proactive.quietHours", "is not a valid window: hours are 0 to 23, minutes 0 to 59");
      lines.push(`- Quiet hours: ${pro.quietHours}`);
    }
    if (pro.maxPerDay != null) lines.push(`- Max per day: ${pro.maxPerDay}`);
    if (lines.length) {
      if (hasProactiveSection(soulText)) fail("proactive", "is also written as a ## Proactive section in soul: keep it in one place");
      if (endsInOpenFence(soulText)) fail("soul", "ends inside an open code fence, so the proactive settings would not be read");
      proactiveBlock = `\n\n## Proactive\n${lines.join("\n")}`;
    }
  }

  for (const h of structuredHeadings(soulText)) {
    warnings.push(`persona '${name}': agent.yaml soul has a '${h}' section; mandates and access are read from their own keys, so that section is only prose`);
  }

  return {
    spec: {
      name,
      soul: soulText + proactiveBlock + channelBlocks,
      ...(slackUserId ? { slackUserId } : {}),
      ...(userToken ? { userToken } : {}),
      ...(model ? { model } : {}),
      ...(runsOn ? { runsOn } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(mcp !== undefined ? { mcp } : {}),
      ...(memory.kbSources != null ? { kbSources: memory.kbSources } : {}),
      ...(memory.background != null ? { background: memory.background } : {}),
      definition: {
        ...(description !== undefined ? { description } : {}),
        ...(skills !== undefined ? { skills } : {}),
        ...(guardrails !== undefined ? { guardrails } : {}),
        soulData,
      },
    },
    warnings,
  };
}

/** Whether the authored soul has a `## Proactive` section outside a code fence. */
function hasProactiveSection(soul: string): boolean {
  let fenced = false;
  for (const line of soul.split("\n")) {
    if (isCodeFence(line)) fenced = !fenced;
    else if (!fenced && /^##\s+proactive\s*$/i.test(line.trim())) return true;
  }
  return false;
}

function structuredHeadings(soul: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of soul.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    else if (!fenced && STRUCTURED_HEADING_RE.test(line)) out.push(line.trim());
  }
  return out;
}

/**
 * A SOUL.md with the sections agent.yaml holds in its own keys removed: what is
 * left is identity, voice and other prose. A section it does not recognise
 * stays, so migrating never drops prose.
 */
export function proseOnlySoul(soulMd: string): string {
  const kept: string[] = [];
  let skipping = false;
  let fenced = false;
  for (const line of soulMd.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    if (!fenced && /^##\s/.test(line)) skipping = STRUCTURED_HEADING_RE.test(line);
    else if (!fenced && /^#\s/.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** One entry of agent.yaml's `channels` key: only the keys that are set. */
export interface ChannelSetting {
  session?: "channel";
  proactive?: boolean;
}

/**
 * A soul's per-channel settings, as agent.yaml's `channels` key holds them: what
 * the soul writes, so a `proactive: true` channel round-trips as `proactive: true`
 * and `session:` appears only where a `Mode` was written (proactive alone already
 * means a channel session). A channel with an invalid `Mode` reads as off, so it
 * exports as `proactive: false`: exported as written, importing it would turn on
 * a session and wakes the soul never had.
 */
export function channelSettings(soulMd: string): Record<string, ChannelSetting> {
  const { sessions, channels, invalidSessions } = parseProactive(soulMd);
  const out: Record<string, ChannelSetting> = {};
  for (const id of new Set([...Object.keys(sessions), ...Object.keys(channels)])) {
    out[id] = {
      ...(sessions[id] ? { session: "channel" as const } : {}),
      ...(channels[id] !== undefined ? { proactive: invalidSessions.includes(id) ? false : channels[id] } : {}),
    };
  }
  return out;
}

/**
 * What `personas export` can carry. A channel's limits have no key in agent.yaml.
 * They mean nothing in a channel session (`Mode: channel` or `Enabled: yes`), and
 * nothing where the channel is off, so nothing changes by losing them; the off
 * cases are reported so an author does not think they still apply.
 */
export function exportedChannelSettings(soulMd: string): { channels: Record<string, ChannelSetting>; dropped: { channel: string; keys: string[] }[] } {
  const c = parseProactive(soulMd);
  const channels = channelSettings(soulMd);
  const dropped: { channel: string; keys: string[] }[] = [];
  for (const channel of new Set([...Object.keys(c.channelHighest), ...Object.keys(c.channelCooldownHours), ...Object.keys(c.channelMaxPerDay)])) {
    if (c.sessions[channel] || (c.channels[channel] === true && !c.invalidSessions.includes(channel))) continue;
    const keys = [
      ...(channel in c.channelHighest ? ["Highest"] : []),
      ...(channel in c.channelCooldownHours ? ["Cooldown"] : []),
      ...(channel in c.channelMaxPerDay ? ["Max per day"] : []),
    ];
    dropped.push({ channel, keys });
  }
  return { channels, dropped };
}

const clock = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * A soul's global `## Proactive` section as agent.yaml's `proactive` key holds
 * it: only what the soul wrote, so a migrated file compiles back to the same
 * section. `Wake`, `Highest` and `Cooldown` have no key (they only narrow, and
 * waking is per channel); they come back as `dropped` so the author hears of it.
 */
export function globalProactive(soulMd: string): { proactive: Record<string, unknown>; dropped: string[] } {
  const section = proactiveSectionLines(soulMd);
  const c = parseProactive(soulMd);
  const proactive: Record<string, unknown> = {};
  const dropped: string[] = [];
  const has = (key: string) => section.some((l) => new RegExp(`^\\s*[-*]\\s*${key}\\s*:`, "i").test(l));
  if (has("enabled")) proactive.enabled = c.enabled;
  if (c.read.length) proactive.read = c.read.map(slackChannelRef);
  if (c.watch.length) proactive.watch = c.watch;
  if (c.quietHours) proactive.quietHours = `${clock(c.quietHours.start)}-${clock(c.quietHours.end)}`;
  if (has("max per day") || has("max per person per day")) proactive.maxPerDay = c.maxPerPersonPerDay;
  if (has("wake")) dropped.push("Wake");
  if (has("highest")) dropped.push("Highest");
  if (has("cooldown")) dropped.push("Cooldown");
  return { proactive, dropped };
}

/** The lines of the first global `## Proactive` section outside a code fence. */
function proactiveSectionLines(soulMd: string): string[] {
  const out: string[] = [];
  let inside = false;
  let fenced = false;
  for (const line of soulMd.split(/\r?\n/)) {
    if (isCodeFence(line)) fenced = !fenced;
    if (!fenced && /^#{1,2}\s/.test(line)) inside = /^##\s+proactive\s*$/i.test(line.trim());
    else if (!fenced && /^###\s/.test(line)) inside = false;
    else if (inside) out.push(line);
  }
  return out;
}

/** A soul with its global `## Proactive` section removed (the `proactive` key holds it). */
export function withoutProactiveSection(soulMd: string): string {
  const kept: string[] = [];
  let skipping = false;
  let fenced = false;
  for (const line of soulMd.split("\n")) {
    if (isCodeFence(line)) fenced = !fenced;
    if (!fenced && /^#{1,2}\s/.test(line)) skipping = /^##\s+proactive\s*$/i.test(line.trim());
    else if (!fenced && /^###\s/.test(line)) skipping = false; // parseProactive stops reading the section here too
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function channelSections(soulMd: string): { channel: string; lines: string[] }[] {
  const out: { channel: string; lines: string[] }[] = [];
  let open: string[] | null = null;
  let fenced = false;
  for (const line of soulMd.split(/\r?\n/)) {
    if (isCodeFence(line)) fenced = !fenced;
    else if (!fenced && /^#{1,2}\s/.test(line)) {
      const channel = channelOf(line);
      open = channel ? [] : null;
      if (channel && open) out.push({ channel, lines: open });
    }
    open?.push(line);
  }
  return out;
}

/**
 * The generated `## Channel` sections of a compiled soul, for the channels
 * `edited` has none for, ready to append to it: a console edit of an agent.yaml
 * persona's soul changes the prose and keeps the structure. A section the author
 * wrote is prose, so an edit can remove it. Empty when there are none.
 */
export function compiledChannelSections(compiled: string, edited: string): string {
  const present = new Set(channelSections(edited).map((s) => s.channel));
  return channelSections(compiled)
    .map((s) => ({ channel: s.channel, text: s.lines.join("\n").trimEnd() }))
    .filter((s) => !present.has(s.channel) && GENERATED_CHANNEL_SECTION_RE.test(s.text))
    .map((s) => `\n\n${s.text}`)
    .join("");
}

export interface AgentDocumentInput {
  name: string;
  description?: string | null;
  model?: string | null;
  slackUserId?: string | null;
  userToken?: string | null;
  provider?: unknown;
  runsOn?: string | null;
  soul: string;
  mandate: { global: string; scoped: SubMandate[] };
  access: Pick<SoulData, "manager" | "backupManager" | "approvers" | "channelOverrides" | "allowedChannels" | "trustedChannels" | "dmAllowedUsers" | "blockedUsers" | "redactPatterns" | "approvalTimeoutSeconds">;
  mcp?: unknown;
  skills?: string[] | null;
  guardrails?: string[] | null;
  kbSources?: string[] | null;
  background?: unknown;
  channels?: Record<string, ChannelSetting> | null;
  /** The global `proactive` key, as written (see {@link globalProactive}). */
  proactive?: Record<string, unknown> | null;
}

/** The canonical typed form of a Slack id, for export. An id of another shape is left as it is (the schema refuses it, as it always did). */
const slackUserRef = (id: string): string => (USER_ID_RE.test(id) ? `slack:user:${id}` : id);
const slackChannelRef = (id: string): string => (CHANNEL_ID_RE.test(id) ? `slack:channel:${id}` : id);

const nonEmpty = <T extends object>(o: T): boolean => Object.keys(o).length > 0;

/** The mandate and access parts of a document for a parsed soul. */
export function documentPartsFromSoul(data: SoulData): Pick<AgentDocumentInput, "mandate" | "access"> {
  return { mandate: { global: data.mandate ?? "", scoped: subMandatesOf(data) }, access: data };
}

/** An agent as its agent.yaml document (empty parts left out), for export and the console. */
export function agentDocument(i: AgentDocumentInput): Record<string, unknown> {
  const approvers = [
    ...i.access.approvers.map((a) => ({ user: slackUserRef(a.userId), scope: a.scope, catchall: a.catchall })),
    ...i.access.channelOverrides.flatMap((c) => c.approvers.map((a) => ({ user: slackUserRef(a.userId), scope: a.scope, catchall: a.catchall, channel: slackChannelRef(c.channel) }))),
  ];
  const access: Record<string, unknown> = {
    ...(i.access.manager.userId ? { manager: slackUserRef(i.access.manager.userId) } : {}),
    ...(i.access.backupManager.userId ? { backupManager: slackUserRef(i.access.backupManager.userId) } : {}),
    ...(approvers.length ? { approvers } : {}),
    ...(i.access.allowedChannels.length || i.access.trustedChannels.length
      ? { channels: { ...(i.access.allowedChannels.length ? { public: i.access.allowedChannels.map(slackChannelRef) } : {}), ...(i.access.trustedChannels.length ? { trusted: i.access.trustedChannels.map(slackChannelRef) } : {}) } }
      : {}),
    ...(i.access.dmAllowedUsers.length ? { dm: i.access.dmAllowedUsers.map(slackUserRef) } : {}),
    ...(i.access.blockedUsers.length ? { blocked: i.access.blockedUsers.map(slackUserRef) } : {}),
    ...(i.access.redactPatterns.length ? { redact: i.access.redactPatterns } : {}),
    ...(i.access.approvalTimeoutSeconds > 0 ? { approvalTimeoutSeconds: i.access.approvalTimeoutSeconds } : {}),
  };
  const scoped = i.mandate.scoped.map((s) => ({ boundary: s.boundary.startsWith("channel:") ? slackChannelRef(s.boundary.slice("channel:".length)) : s.boundary, mode: s.mode, text: s.text }));
  const mandate: Record<string, unknown> = {
    ...(i.mandate.global.trim() ? { global: i.mandate.global.trim() } : {}),
    ...(scoped.length ? { scoped } : {}),
  };
  const memory: Record<string, unknown> = {
    ...(i.kbSources != null ? { kbSources: i.kbSources } : {}),
    ...(i.background != null ? { background: i.background } : {}),
  };
  return {
    name: i.name,
    ...(i.description ? { description: i.description } : {}),
    ...(i.model ? { model: i.model } : {}),
    ...(i.slackUserId ? { slackUserId: slackUserRef(i.slackUserId) } : {}),
    ...(i.userToken ? { userToken: i.userToken } : {}),
    ...(i.provider != null ? { provider: i.provider } : {}),
    ...(i.runsOn ? { runsOn: i.runsOn } : {}),
    soul: i.soul,
    ...(nonEmpty(mandate) ? { mandate } : {}),
    ...(nonEmpty(access) ? { access } : {}),
    ...(i.mcp != null ? { mcp: i.mcp } : {}),
    ...(i.skills != null ? { skills: i.skills } : {}),
    ...(i.guardrails?.length ? { guardrails: i.guardrails } : {}),
    ...(nonEmpty(memory) ? { memory } : {}),
    ...(i.proactive && nonEmpty(i.proactive) ? { proactive: i.proactive } : {}),
    ...(i.channels && nonEmpty(i.channels) ? { channels: Object.fromEntries(Object.entries(i.channels).map(([k, v]) => [slackChannelRef(k), v])) } : {}),
  };
}
