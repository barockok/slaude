/**
 * One sync, in two phases. Phase one runs outside any transaction: parse,
 * resolve placeholders, and take each persona's structure from its agent.yaml
 * (a persona that has none is refused, unless its soul is unchanged from what
 * is stored). No model call runs. Phase two is the single transaction in
 * applySync. Any failure in phase one applies nothing. Messages name a variable, persona or revision, never a value.
 */
import { flag } from "../../config/security-switches";
import {
  parsePayload, resolvePlaceholders, unknownFieldPaths, capPaths, providerWarnings, kbSourceWarnings, definitionGuardrailWarnings, MAX_REPORTED_FIELDS,
  PROVIDER_FIELDS, SUPPORTED_PAYLOAD_VERSION, PayloadError, type GuardrailSpec, type SyncPayload,
} from "./payload";
import { applyGuardrailChange, readGuardrails } from "../../db/guardrails";
import { auditChange } from "../../guardrails/audit";
import { parseGuardrail, reservedNameProblem } from "../../guardrails/format";
import { emitAudit } from "../../audit/emit";
import {
  applySync, desiredPersonas, effectivePersonas, backgroundColumnPresent, definitionColumnPresent, kbSourcesColumnPresent, providerColumnPresent, syncState, StaleRevisionError,
  type ApplyResult,
} from "../../db/personas";
import { installedKbSourceIds } from "../../knowledge/persona-kb";
import { sameDesired, type DesiredPersona } from "../effective";
import { loadVaultConfig, parseRef, SecretResolutionError, type VaultConfig } from "../../secrets";
import { isAllowed, requestPathFor } from "../../secrets/allowlist";
import { assertNoProviderRefsInMono } from "../../gateway/core/provider-secrets";
import { internalHostsFrom } from "../provider-base-url";
import { dbDialect } from "../../db/client";
import { masterKey, MasterKeyError } from "../../db/crypto";
import { collectRefs, planRefs, RefRefusal, tenantWorkspaces, type RecordEntry, type RefUse } from "../../domain/sync-refs";
import { emitDomainEvents } from "../../audit/domain";
import { audit } from "../../audit/index";

function masterKeySet(): boolean {
  try {
    masterKey();
    return true;
  } catch (e) {
    if (e instanceof MasterKeyError) return false;
    throw e;
  }
}

export class SyncFailure extends Error {
  constructor(readonly status: 409 | 422 | 502 | 503, message: string) { super(message); }
}
/** What a sync did to the deploy repo's guardrails (absent: the payload carried none). */
export interface GuardrailSyncReport {
  created: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  /** Guardrails stored with validation problems that do not touch their rules (their rules and prose apply). */
  invalid: Array<{ slug: string; errors: string[] }>;
  /** Slugs held by the console, left alone. */
  skipped: string[];
  /** Slugs a host-file import held, now taken over by the deploy repo (reported as a warning). */
  takenOver: string[];
  /** Overrides kept although their source changed (shown behind source). */
  behindSource: string[];
}

/** More records than this in one sync also write one summary audit event. */
export const SYNC_SUMMARY_THRESHOLD = 20;
/** Most references a strict refusal lists. */
const STRICT_LIST_MAX = 20;

/** Declared records a sync created (or would create, in a dry run). */
export interface RecordsReport {
  created: RecordEntry[];
  wouldCreate: RecordEntry[];
}

export type SyncReport = Omit<ApplyResult, "records" | "domainEvents"> & {
  records: RecordsReport;
  revision: string; dryRun: boolean; ignoredFields: string[]; ignoredFieldsTotal: number;
  guardrails?: GuardrailSyncReport;
  /** Applied anyway, reported by persona name: provider/model pairing (WS-A
   *  §4) and a runsOn label no live node carries (node labels spec §4.5). */
  warnings: string[];
};

/**
 * The allowed-prefix rule at sync (WS-A §6.3), so a reference the gateway would
 * refuse fails the pipeline instead of every turn. The resolver checks again at
 * resolution. A vault:// reference on a gateway with no Vault configured is
 * refused too: it could never resolve. Messages name persona and field only.
 */
function checkVaultRefs(payload: SyncPayload, vault: VaultConfig | null): void {
  for (const p of payload.personas) {
    for (const field of PROVIDER_FIELDS) {
      const v = p.provider?.[field];
      if (!v || !v.startsWith("vault://")) continue;
      const label = `persona '${p.name}': provider.${field}`;
      const ref = parseRef(v, label);
      if (ref.scheme !== "vault") continue;
      if (!vault) throw new PayloadError(`${label} is a vault:// reference but this gateway has no Vault configured (SLAUDE_VAULT_ADDR)`);
      let path: string;
      try {
        path = requestPathFor(ref, vault.mounts);
      } catch (e) {
        if (e instanceof SecretResolutionError) throw new PayloadError(`${label} is under no configured Vault mount (SLAUDE_VAULT_MOUNTS)`);
        throw e;
      }
      if (!isAllowed(path, p.name, vault.prefixes)) {
        throw new PayloadError(`${label} is outside SLAUDE_VAULT_ALLOWED_PREFIXES for this persona`);
      }
    }
  }
}

/**
 * An env:// reference must name a variable that is set (non-empty) in the
 * gateway's environment, so a typo fails the sync like an unresolved
 * `${PERSONA_*}` placeholder (review R2-F5). Presence only: the value is never
 * read into the payload or echoed. vault:// is never resolved at sync.
 */
function checkEnvRefs(payload: SyncPayload, env: Record<string, string | undefined>): void {
  for (const p of payload.personas) {
    for (const field of PROVIDER_FIELDS) {
      const v = p.provider?.[field];
      if (!v || !v.startsWith("env://")) continue;
      const ref = parseRef(v, `persona '${p.name}': provider.${field}`);
      if (ref.scheme === "env" && !env[ref.name]) {
        throw new PayloadError(
          `persona '${p.name}': provider.${field} names ${ref.name}, which is unset or empty in the gateway's environment`,
        );
      }
    }
  }
}

/**
 * A persona whose `runsOn` no live node carries is a warning, not an error
 * (node labels spec §4.5): the nodes may simply not be up yet. Its turns wait
 * on the label queue until a node with the label starts.
 */
export function unservedLabelWarnings(rows: ReadonlyArray<{ name: string; runsOn?: string | null }>, live: ReadonlySet<string>): string[] {
  return rows
    .filter((r) => r.runsOn && !live.has(r.runsOn))
    .map((r) => `persona '${r.name}': no live node carries label '${r.runsOn}'; its turns wait until one does`);
}

/** What an agent.yaml stores beyond soul_json; null for the older layout. */
function storedDefinition(p: SyncPayload["personas"][number]): DesiredPersona["definition"] {
  if (!p.definition) return null;
  const { soulData: _compiled, ...rest } = p.definition;
  return rest;
}

export async function runSync(
  tenant: string,
  raw: unknown,
  opts: {
    dryRun: boolean; env: Record<string, string | undefined>; by: string;
    /** The labels live nodes carry (the registry's node-label view). Absent
     *  (no queue: a single process) = no label warnings. */
    liveLabels?: () => Promise<ReadonlySet<string>>;
    /** Default: loadVaultConfig(env). Null = no Vault on this gateway. */
    vault?: VaultConfig | null;
    /** The installed KB source ids, for the unknown-kbSources warning. Default: $SLAUDE_HOME/knowledge. */
    installedKbSources?: () => string[];
    /** Refuse a sync whose references would create a record (listing them). Default off. */
    strict?: boolean;
  },
): Promise<SyncReport> {
  let payload;
  const allIgnored = unknownFieldPaths(raw);
  const ignoredFields = allIgnored.slice(0, MAX_REPORTED_FIELDS);
  const ignoredFieldsTotal = allIgnored.length;
  try {
    // The version check comes first so a newer payload always gets the
    // upgrade message, not a complaint about its new fields.
    const v = raw && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
    if (typeof v === "number" && Number.isInteger(v) && v > SUPPORTED_PAYLOAD_VERSION) parsePayload(raw);
    // Stage two (the default since v0.45.0; SLAUDE_DEPLOY_STRICT=0 opts out):
    // a field this gateway does not know is an error, not a silent drop. An
    // unknown switch value refuses the gateway's boot; read here, it is strict.
    // Names only, never values.
    if (allIgnored.length && flag(opts.env.SLAUDE_DEPLOY_STRICT, true, true)) {
      throw new PayloadError(`unknown field(s) refused under SLAUDE_DEPLOY_STRICT: ${capPaths(allIgnored).join(", ")}`);
    }
    payload = parsePayload(raw, { internalHosts: internalHostsFrom(opts.env) });
    if (payload.personas.length === 0 && !payload.allowEmpty) {
      throw new PayloadError("refusing an empty persona set; set allowEmpty: true to retire every persona");
    }
    // A managed tenant reads the default persona's soul from its `default` row
    // and nowhere else, so a set that omits it would leave that persona with no
    // source at all.
    if (payload.personas.length > 0 && !payload.personas.some((p) => p.name === "default")) {
      throw new PayloadError("payload must include the default persona");
    }
    payload = { ...payload, personas: payload.personas.map((p) => resolvePlaceholders(p, opts.env)) };
    checkVaultRefs(payload, opts.vault !== undefined ? opts.vault : loadVaultConfig(opts.env));
    const rawRole = (opts.env.SLAUDE_ROLE ?? "mono").trim().toLowerCase();
    const role = rawRole === "gateway" || rawRole === "node" ? rawRole : "mono";
    try {
      assertNoProviderRefsInMono(role, payload.personas.filter((p) => p.provider).map((p) => p.name));
    } catch (e) {
      throw new PayloadError((e as Error).message);
    }
    checkEnvRefs(payload, opts.env);
  } catch (e) {
    if (e instanceof PayloadError) throw new SyncFailure(422, e.message);
    throw e;
  }
  // Every write lists provider_json, so an older schema would fail with raw SQL
  // mid-sync; refuse first, by name. A dry run checks too: it previews a write.
  if (!(await providerColumnPresent())) {
    throw new SyncFailure(503,
      "the database schema predates this gateway (personas.provider_json is missing): apply migration 0014 before syncing personas");
  }
  if (!(await kbSourcesColumnPresent())) {
    throw new SyncFailure(503,
      "the database schema predates this gateway (personas.kb_sources is missing): apply migration 0017 before syncing personas");
  }
  if (!(await backgroundColumnPresent())) {
    throw new SyncFailure(503,
      "the database schema predates this gateway (personas.background is missing): apply migration 0020 before syncing personas");
  }
  if (!(await definitionColumnPresent())) {
    throw new SyncFailure(503,
      "the database schema predates this gateway (personas.definition is missing): apply migration 0036 before syncing personas");
  }
  const warnings = [
    ...providerWarnings(payload),
    // An id that matches no installed KB is applied anyway: the installer and
    // the sync land independently (WS-C §4.1.5).
    ...kbSourceWarnings(payload, (opts.installedKbSources ?? installedKbSourceIds)()),
  ];

  // Fail a stale payload before spending any model call. applySync's
  // transactional compare-and-set remains the authority; this is a fast path.
  const live = await syncState(tenant);
  if (live && live.committedAt > Date.parse(payload.committedAt)) {
    throw new SyncFailure(409, `a newer revision is live (${live.revision})`);
  }

  // Both layers, read once each. Desired is what the merge compares against;
  // effective is only needed for which fields carry a live override.
  const desired = new Map((await desiredPersonas(tenant, { includeTombstoned: true })).map((p) => [p.name, p]));
  const effective = new Map((await effectivePersonas(tenant, { includeTombstoned: true })).map((p) => [p.name, p]));

  const rows: DesiredPersona[] = [];
  for (const p of payload.personas) {
    const prev = desired.get(p.name);
    let soulJson: unknown;
    if (p.definition) {
      soulJson = p.definition.soulData; // an agent.yaml: compiled, no model call
    } else if (prev && !prev.definition && prev.soulMd === p.soul && !effective.get(p.name)?.overridden.includes("soul")) {
      soulJson = prev.soulJson; // unchanged soul: no model call
    } else {
      // A soul with no agent.yaml has no structure: nothing reads access out of prose any more.
      throw new SyncFailure(422,
        `persona '${p.name}' has no agent.yaml: a persona is defined by one. Convert it with \`personas export --format agent-yaml\` (or \`personas migrate\` on its home) and sync the result`);
    }
    rows.push({
      name: p.name, slackUserId: p.slackUserId ?? null, userToken: p.userToken ?? null, model: p.model ?? null,
      soulMd: p.soul, soulJson, mcp: p.mcp ?? null, provider: p.provider ?? null, runsOn: p.runsOn ?? null, kbSources: p.kbSources ?? null,
      background: p.background ?? null,
      definition: storedDefinition(p),
      origin: "git", tombstonedAt: null,
    });
  }

  // A persona that drops `provider` silently returns to the provider_creds rows
  // and the node's own environment; say so by name (review re-check F3).
  for (const r of rows) {
    const prev = desired.get(r.name);
    if (prev && prev.tombstonedAt === null && prev.provider && !r.provider) {
      warnings.push(`persona '${r.name}' no longer declares provider; it now uses tenant/node credentials`);
    }
  }
  if (opts.liveLabels && rows.some((r) => r.runsOn)) {
    try {
      warnings.push(...unservedLabelWarnings(rows, await opts.liveLabels()));
    } catch (e) {
      // The check is advisory: a Redis hiccup must not fail a deploy.
      console.warn(`[persona-sync] could not read live node labels tenant=${tenant}: ${(e as Error).message}`);
    }
  }
  if (payload.personas.some((p) => p.definition?.guardrails?.length)) {
    // The slugs the deploy will have: the payload's set plus what it does not
    // manage (console and host-file guardrails), else everything stored.
    const stored = (await readGuardrails(tenant)).rows;
    const known = payload.guardrails
      ? [...payload.guardrails.map((g) => g.slug), ...stored.filter((r) => r.source !== "git").map((r) => r.slug)]
      : stored.map((r) => r.slug);
    warnings.push(...definitionGuardrailWarnings(payload, new Set(known)));
  }
  for (const w of warnings) console.warn(`[persona-sync] warning tenant=${tenant}: ${w}`);

  if (allIgnored.length) {
    console.warn(`[persona-sync] ignored unknown payload fields tenant=${tenant}: ${capPaths(allIgnored).join(", ")}`);
  }
  const meta = { revision: payload.revision, committedAt: Date.parse(payload.committedAt), by: opts.by };

  // References the personas carry: planned now (read only) so a refusal or a
  // strict failure applies nothing, created in applySync's transaction later.
  const refUses: RefUse[] = rows.flatMap((r, i) => {
    const d = payload.personas[i]?.definition;
    return d ? collectRefs(r.name, d.soulData as never, payload.personas[i]!.soul) : [];
  });
  let workspaces: string[] = [];
  let wouldCreate: RecordEntry[] = [];
  try {
    workspaces = refUses.length ? await tenantWorkspaces(tenant) : [];
    const bare = (u: RefUse) => u.ref.kind === "external" && u.ref.service === "slack" && !u.ref.workspace;
    if (refUses.length && workspaces.length === 0) {
      // No workspace to place a short Slack reference in: skip those records (non-Slack ones still create).
      const keep = refUses.filter((u) => !bare(u));
      if (keep.length < refUses.length) {
        warnings.push("no Slack workspace is connected, records for Slack references were not created");
        refUses.splice(0, refUses.length, ...keep);
      }
    } else if (workspaces.length > 1 && !opts.strict) {
      // Several workspaces: a bare id is ambiguous. Skip it and say which field; strict refuses at planRefs.
      const keep: RefUse[] = [];
      for (const u of refUses) {
        if (bare(u)) warnings.push(`persona '${u.persona}': workspace is ambiguous, no record created for ${u.field}`);
        else keep.push(u);
      }
      refUses.splice(0, refUses.length, ...keep);
    }
    wouldCreate = await planRefs(refUses, workspaces);
  } catch (e) {
    if (e instanceof RefRefusal) throw new SyncFailure(422, e.message);
    throw e;
  }
  if (opts.strict && wouldCreate.length) {
    const shown = wouldCreate.slice(0, STRICT_LIST_MAX).map((r) => `${r.ref} (${r.personas.join(", ")})`).join("; ");
    const more = wouldCreate.length > STRICT_LIST_MAX ? ` and ${wouldCreate.length - STRICT_LIST_MAX} more` : "";
    throw new SyncFailure(422, `strict: ${wouldCreate.length} reference(s) would create a record: ${shown}${more}. Fix the reference, or sync without strict to create declared records`);
  }
  if (wouldCreate.length) warnings.push(`${wouldCreate.length} reference(s) will create declared records (see records); a mistyped id creates an empty record that matches nobody`);

  const guardrailPlan = payload.guardrails ? await planGuardrails(tenant, payload.guardrails, rows.map((r) => r.name), warnings) : undefined;

  if (opts.dryRun) {
    const incoming = new Set(rows.map((r) => r.name));
    const report: SyncReport = { created: [], updated: [], unchanged: [], tombstoned: [], overridesWiped: 0, revision: meta.revision, dryRun: true, ignoredFields, ignoredFieldsTotal, warnings, records: { created: [], wouldCreate } };
    // Same rule as applySync.
    for (const r of rows) {
      const prev = desired.get(r.name);
      if (!prev) report.created.push(r.name);
      else if (prev.origin === "git" && sameDesired(prev, r)) report.unchanged.push(r.name);
      else report.updated.push(r.name);
    }
    for (const [name, prev] of desired) if (!incoming.has(name) && prev.tombstonedAt === null) report.tombstoned.push(name);
    // setOverride refuses names without a live persona, so no orphan rows exist
    // and this equals the count applySync's DELETE reports.
    report.overridesWiped = [...effective.values()].reduce((n, p) => n + p.overridden.length, 0);
    if (guardrailPlan) report.guardrails = guardrailPlan.report;
    return report;
  }

  try {
    const { records: createdRecords = [], domainEvents = [], recordsFailed = false, ...applied } = await applySync(tenant, rows, meta, { uses: refUses, workspaces });
    if (recordsFailed) warnings.push("records could not be created for this sync (the persona sync was applied); run `slaude domain reconcile` or sync again");
    auditPersonaSync(tenant, opts.by, meta.revision, applied);
    await auditRecords(tenant, opts.by, meta.revision, createdRecords, domainEvents);
    let guardrails: GuardrailSyncReport | undefined;
    if (guardrailPlan) {
      // Its own transaction, after the personas: the guardrail set carries its
      // own signed manifest. A failure here leaves the personas applied and
      // the previous guardrail set intact (the pipeline sees the 500 and retries).
      const r = await applyGuardrailChange(tenant, { upsert: guardrailPlan.upsert, remove: guardrailPlan.remove, by: opts.by });
      auditChange(r, { tenantId: tenant, actorKind: "system", actorId: opts.by, via: "deploy", revision: meta.revision });
      guardrails = { ...guardrailPlan.report, created: r.created, updated: r.updated, unchanged: r.unchanged, removed: r.removed };
    }
    return { ...applied, records: { created: createdRecords, wouldCreate: [] }, revision: meta.revision, dryRun: false, ignoredFields, ignoredFieldsTotal, warnings, ...(guardrails ? { guardrails } : {}) };
  } catch (e) {
    if (e instanceof StaleRevisionError) throw new SyncFailure(409, e.message);
    if (e instanceof RefRefusal) throw new SyncFailure(422, e.message);
    throw e;
  }
}

/** After commit: the domain events, and one summary event when a sync created many records. Never fails the sync. */
async function auditRecords(tenant: string, by: string, revision: string, created: RecordEntry[], events: Parameters<typeof emitDomainEvents>[0]): Promise<void> {
  try {
    await emitDomainEvents(events, { tenantId: tenant, actorId: by });
    if (created.length > SYNC_SUMMARY_THRESHOLD) {
      await audit({
        tenantId: tenant, persona: "default", actorKind: "system", actorId: by, action: "domain.sync_created",
        targetKind: "tenant", targetId: tenant,
        summary: `persona sync ${revision}: ${created.length} declared record(s) created`,
        details: { revision, count: created.length, users: created.filter((r) => r.type === "user").length, boundaries: created.filter((r) => r.type === "boundary").length },
      });
    }
  } catch (e) {
    console.warn(`[persona-sync] domain audit failed tenant=${tenant}: ${(e as Error).message}`);
  }
}

/**
 * The guardrail half of a sync: the payload's list is the deploy repo's whole
 * set (source `git`). A git guardrail it no longer lists is removed; a slug
 * held by the console is left alone, and one held by a host-file import is
 * taken over by the deploy repo; both are reported. A rule that fails to
 * parse refuses the whole sync (422) before anything is applied. Overrides
 * are kept (never wiped like soul overrides) and reported behind source when
 * the text they were written against changes. Names in `agents:` that match
 * no persona of the payload are warnings, not errors.
 */
async function planGuardrails(tenant: string, list: GuardrailSpec[], personaNames: string[], warnings: string[]) {
  const stored = await readGuardrails(tenant);
  const bySlug = new Map(stored.rows.map((r) => [r.slug, r]));
  const overridden = new Map(stored.overrides.map((o) => [o.slug, o]));
  const report: GuardrailSyncReport = { created: [], updated: [], unchanged: [], removed: [], invalid: [], skipped: [], takenOver: [], behindSource: [] };
  const refused: string[] = [];
  const upsert: Array<{ slug: string; md: string; source: "git" }> = [];
  const names = new Set(personaNames);
  for (const g of list) {
    const prev = bySlug.get(g.slug);
    if (prev && prev.source === "console") {
      report.skipped.push(g.slug);
      warnings.push(`guardrail '${g.slug}' exists in the console; the deploy repo's copy was not applied`);
      continue;
    }
    const reserved = reservedNameProblem(g.slug, !!prev);
    if (reserved) {
      refused.push(`guardrail ${reserved}`);
      continue;
    }
    const parsed = parseGuardrail(g.slug, g.md);
    if (parsed.blocking.length) {
      refused.push(`guardrail '${g.slug}': ${parsed.blocking.join("; ")}`);
      continue;
    }
    if (parsed.errors.length) report.invalid.push({ slug: g.slug, errors: parsed.errors });
    if (prev && prev.source === "file") {
      report.takenOver.push(g.slug);
      warnings.push(`guardrail '${g.slug}' was imported from host files; the deploy repo's copy now replaces it`);
    }
    for (const a of parsed.meta?.scope === "agents" ? parsed.meta.agents : []) {
      if (!names.has(a)) warnings.push(`guardrail '${g.slug}' names agent '${a}', which this deploy does not have`);
    }
    if (!prev) report.created.push(g.slug);
    else if (prev.md === g.md && prev.source === "git") report.unchanged.push(g.slug);
    else {
      report.updated.push(g.slug);
      if (overridden.has(g.slug)) report.behindSource.push(g.slug);
    }
    upsert.push({ slug: g.slug, md: g.md, source: "git" });
  }
  // A rule the owner wrote and the parser cannot read is never stored silently dropped.
  if (refused.length) throw new SyncFailure(422, `guardrails refused (fix the rules, then deploy again): ${refused.join(" | ")}`);
  const listed = new Set(list.map((g) => g.slug));
  const remove = stored.rows.filter((r) => r.source === "git" && !listed.has(r.slug)).map((r) => r.slug);
  report.removed = remove;
  // Postgres signs guardrails with the master key only. Refuse here, before
  // the personas are applied: failing inside the guardrail write would leave
  // the sync half applied and the pipeline retrying a 500.
  const changes = report.created.length + report.updated.length + remove.length;
  if (changes > 0 && dbDialect() === "pg" && !masterKeySet()) {
    throw new SyncFailure(422, "guardrails on Postgres need SLAUDE_MASTER_KEY");
  }
  for (const w of report.behindSource) warnings.push(`guardrail '${w}' has a console override written against the previous text; it is kept and shown behind source`);
  return { report, upsert, remove };
}

/** persona.sync: one row per applied (not dry-run) sync, with the revision and
 *  counts, never a value. The actor is the deploy caller's identity (`by`). */
export function auditPersonaSync(tenant: string, by: string, revision: string, r: ApplyResult): void {
  emitAudit({
    tenantId: tenant,
    persona: "default",
    actorKind: "system",
    actorId: by,
    action: "persona.sync",
    targetKind: "tenant",
    targetId: tenant,
    summary: `persona sync ${revision}: ${r.created.length} created, ${r.updated.length} updated, ${r.tombstoned.length} tombstoned`,
    details: {
      revision,
      created: r.created,
      updated: r.updated,
      tombstoned: r.tombstoned,
      counts: {
        created: r.created.length,
        updated: r.updated.length,
        unchanged: r.unchanged.length,
        tombstoned: r.tombstoned.length,
        overridesWiped: r.overridesWiped,
      },
    },
  });
}
