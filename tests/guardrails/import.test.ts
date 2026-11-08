import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { __resetGuardrailSnapshotsForTests } from "../../src/guardrails/snapshot";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __clearGuardrailsForTests, applyGuardrailChange, readGuardrails } from "../../src/db/guardrails";
import { formatImportReport, importGuardrails } from "../../src/guardrails/import";
import { checkSlug, readGuardrailDir, GuardrailFilesError } from "../../src/guardrails/files";
import { main } from "../../src/cli/guardrails";
import { flushAudits } from "../../src/audit/emit";
import { db } from "../../src/db/client";
import { MAX_GUARDRAIL_BYTES } from "../../src/guardrails/format";

const gmd = (slug: string, body = "Prose.") => `---\nname: ${slug}\ndescription: d\n---\n${body}\n`;
function folder(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "gr-import-"));
  for (const [slug, md] of Object.entries(files)) {
    mkdirSync(join(d, slug), { recursive: true });
    writeFileSync(join(d, slug, "GUARDRAIL.md"), md);
  }
  return d;
}

beforeEach(() => __clearGuardrailsForTests());

describe("slaude guardrails import", () => {
  test("imports, reports invalid ones (still stored), is idempotent, audits each change", async () => {
    const d = folder({ alpha: gmd("alpha"), beta: "no frontmatter" });
    mkdirSync(join(d, "empty"));
    writeFileSync(join(d, "README.md"), "not a guardrail");
    const r = await importGuardrails(d, { by: "cli:tester" });
    expect(r.created).toEqual(["alpha", "beta"]);
    expect(r.invalid.map((i) => i.slug)).toEqual(["beta"]);
    expect(formatImportReport(r)).toContain("beta has problems");
    expect((await readGuardrails()).rows.map((x) => [x.slug, x.source])).toEqual([["alpha", "file"], ["beta", "file"]]);
    const again = await importGuardrails(d, { by: "cli:tester" });
    expect(again.unchanged).toEqual(["alpha", "beta"]);
    await flushAudits();
    const rows = await db.query<{ action: string; target_id: string; actor_id: string }>(
      `SELECT action, target_id, actor_id FROM audit_events WHERE action LIKE 'guardrail.%' AND actor_id = 'cli:tester' ORDER BY id`,
    );
    expect(rows.map((x) => `${x.action}:${x.target_id}`).sort()).toEqual(["guardrail.created:alpha", "guardrail.created:beta"]);
  });

  test("a deploy repo checkout: its guardrails/ folder is used", async () => {
    const repo = mkdtempSync(join(tmpdir(), "gr-repo-"));
    mkdirSync(join(repo, "guardrails", "one"), { recursive: true });
    writeFileSync(join(repo, "guardrails", "one", "GUARDRAIL.md"), gmd("one"));
    expect((await importGuardrails(repo, { by: "x" })).created).toEqual(["one"]);
  });

  test("--prune removes only file guardrails; git ones are never touched; --dry-run writes nothing", async () => {
    await applyGuardrailChange("default", { upsert: [{ slug: "from-git", md: gmd("from-git"), source: "git" }, { slug: "old-file", md: gmd("old-file"), source: "file" }], by: "p" });
    const d = folder({ "from-git": gmd("from-git", "host copy"), fresh: gmd("fresh") });
    const dry = await importGuardrails(d, { by: "x", prune: true, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, created: ["fresh"], removed: ["old-file"], skipped: ["from-git"] });
    expect((await readGuardrails()).rows.map((r) => r.slug)).toEqual(["from-git", "old-file"]);
    const r = await importGuardrails(d, { by: "x", prune: true });
    expect(r).toMatchObject({ created: ["fresh"], removed: ["old-file"], skipped: ["from-git"] });
    expect(formatImportReport(r)).toContain("skipped from-git");
    const rows = (await readGuardrails()).rows;
    expect(rows.map((x) => x.slug)).toEqual(["fresh", "from-git"]);
    expect(rows.find((x) => x.slug === "from-git")!.md).toBe(gmd("from-git"));
    const d2 = folder({ fresh: gmd("fresh", "edited") });
    expect((await importGuardrails(d2, { by: "x", dryRun: true })).updated).toEqual(["fresh"]);
  });

  test("bad folder names, reserved names, oversized files and a missing folder refuse the whole import", async () => {
    expect(() => readGuardrailDir("/nonexistent/dir")).toThrow(GuardrailFilesError);
    expect(() => readGuardrailDir(folder({ "Bad Name": gmd("x") }))).toThrow(/not a guardrail name/);
    expect(() => checkSlug("settings")).toThrow(/reserved/);
    expect(() => readGuardrailDir(folder({ big: "x".repeat(MAX_GUARDRAIL_BYTES + 1) }))).toThrow(/bytes; at most/);
    expect((await readGuardrails()).rows).toEqual([]);
  });

  test("the CLI entry: usage, node refusal, success and failure codes", async () => {
    const d = folder({ cli: gmd("cli") });
    expect(await main([])).toBe(2);
    expect(await main(["import"])).toBe(2);
    expect(await main(["import", d, "extra"])).toBe(2);
    expect(await main(["--bogus"])).toBe(2);
    const saved = process.env.SLAUDE_ROLE;
    process.env.SLAUDE_ROLE = "node";
    expect(await main(["import", d])).toBe(2);
    if (saved === undefined) delete process.env.SLAUDE_ROLE;
    else process.env.SLAUDE_ROLE = saved;
    expect(await main(["import", d, "--dry-run"])).toBe(0);
    expect(await main(["import", d])).toBe(0);
    expect((await readGuardrails()).rows.map((r) => r.slug)).toEqual(["cli"]);
    expect(await main(["import", "/nonexistent"])).toBe(1);
  });
});

// The database is shared by every test file of the run: leave no guardrail behind.
afterAll(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});
