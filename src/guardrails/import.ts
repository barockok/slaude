/**
 * `slaude guardrails import <dir>`: host GUARDRAIL.md files into the
 * guardrails table (source `file`), run by a person, audited. The files stay
 * authoring input: the runtime reads only the table.
 *
 * A guardrail whose only problems leave its rules intact (a name mismatch, a
 * trigger) is still imported and the console shows them; a rule that fails to
 * parse, a bad folder name or an oversized file refuses the whole import. `--prune` removes `file`
 * guardrails the folder no longer has; git and console guardrails are never
 * touched by an import.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyGuardrailChange, readGuardrails, type ChangeResult } from "../db/guardrails";
import { auditChange } from "./audit";
import { emitAudit } from "../audit/emit";
import { GuardrailFilesError, readGuardrailDir } from "./files";
import { parseGuardrail, reservedNameProblem } from "./format";

export interface ImportReport extends ChangeResult {
  dryRun: boolean;
  /** Per guardrail with problems: its validation errors. */
  invalid: Array<{ slug: string; errors: string[] }>;
  /** Slugs held by git or the console, left alone. */
  skipped: string[];
}

export async function importGuardrails(
  dir: string,
  opts: { by: string; prune?: boolean; dryRun?: boolean; tenant?: string; repair?: boolean },
): Promise<ImportReport> {
  const tenant = opts.tenant ?? "default";
  // A deploy repo checkout works as is: its guardrails/ folder is used.
  const root = existsSync(join(dir, "guardrails")) && !existsSync(join(dir, "GUARDRAIL.md")) ? join(dir, "guardrails") : dir;
  const files = readGuardrailDir(root);
  const parsed = files.map((f) => ({ slug: f.slug, p: parseGuardrail(f.slug, f.md) }));
  // A rule that fails to parse refuses the whole import: never stored silently dropped.
  const refused = parsed.filter((x) => x.p.blocking.length).map((x) => `${x.slug}: ${x.p.blocking.join("; ")}`);
  if (refused.length) throw new GuardrailFilesError(`guardrails refused (fix the rules, then import again): ${refused.join(" | ")}`);
  const invalid = parsed.map((x) => ({ slug: x.slug, errors: x.p.errors })).filter((x) => x.errors.length > 0);
  const stored = await readGuardrails(tenant);
  const owners = new Map(stored.rows.map((r) => [r.slug, r.source]));
  const reserved = files.map((f) => reservedNameProblem(f.slug, owners.has(f.slug))).filter((x): x is string => !!x);
  if (reserved.length) throw new GuardrailFilesError(`guardrails refused: ${reserved.join(" | ")}`);
  const skipped = files.filter((f) => owners.has(f.slug) && owners.get(f.slug) !== "file").map((f) => f.slug);
  const upsert = files.filter((f) => !skipped.includes(f.slug)).map((f) => ({ slug: f.slug, md: f.md, source: "file" as const }));
  const present = new Set(files.map((f) => f.slug));
  const remove = opts.prune ? stored.rows.filter((r) => r.source === "file" && !present.has(r.slug)).map((r) => r.slug) : [];
  if (opts.dryRun) {
    const bySlug = new Map(stored.rows.map((r) => [r.slug, r]));
    const created = upsert.filter((u) => !bySlug.has(u.slug)).map((u) => u.slug);
    const unchanged = upsert.filter((u) => bySlug.get(u.slug)?.md === u.md).map((u) => u.slug);
    const updated = upsert.filter((u) => bySlug.has(u.slug) && !unchanged.includes(u.slug)).map((u) => u.slug);
    return { version: stored.manifest?.version ?? 0, created, updated, unchanged, removed: remove, toggled: [], overrideSet: [], overrideCleared: [], dryRun: true, invalid, skipped };
  }
  const r = await applyGuardrailChange(tenant, { upsert, remove, by: opts.by, ...(opts.repair ? { repair: true } : {}) });
  auditChange(r, { tenantId: tenant, actorKind: "operator", actorId: opts.by, via: "cli" });
  if (opts.repair) {
    emitAudit({
      tenantId: tenant,
      consoleWide: true,
      actorKind: "operator",
      actorId: opts.by,
      action: "guardrail.repaired",
      targetKind: "guardrails",
      targetId: tenant,
      summary: `guardrail set re-signed by an owner repair at version ${r.version}`,
      details: { version: r.version, resigned: r.resigned ?? [] },
    });
  }
  return { ...r, dryRun: false, invalid, skipped };
}

export function formatImportReport(r: ImportReport): string {
  const lines = [
    `${r.dryRun ? "[dry run] " : ""}guardrails: ${r.created.length} created, ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.removed.length} removed (version ${r.version})`,
  ];
  for (const s of r.skipped) lines.push(`  skipped ${s}: it comes from the deploy repo or the console, not from files`);
  if (r.resigned?.length) lines.push(`  re-signed as stored (check them, then re-run /deploy for deploy repo guardrails): ${r.resigned.join(", ")}`);
  for (const i of r.invalid) {
    lines.push(`  ${i.slug} has problems (its valid rules and prose still apply):`);
    for (const e of i.errors) lines.push(`    - ${e}`);
  }
  return lines.join("\n");
}
