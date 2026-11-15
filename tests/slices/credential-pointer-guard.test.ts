/**
 * Slice F guard: the credential pointer (`mcp_credentials.user_id`) is
 * bookkeeping and no decision reads it. Two checks over all of `src`:
 *
 *  1. No source file other than the pointer module names the column next to the
 *     table (no allowlist of readers; the three sqlite bootstrap DDL lines
 *     that add the column and its index are matched by their exact text).
 *  2. Only a short, fixed list of bookkeeping modules imports the pointer
 *     module. A gateway, agent, access, knowledge or memory file importing it
 *     is a credential read path and fails here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sourceFiles } from "../helpers/string-authority-scan";

const POINTER_MODULE = "src/db/credential-pointers.ts";
/** The one schema statement outside the pointer module that names the column. */
const SCHEMA_LINES = [
  { file: "src/db/drivers/sqlite.ts", text: 'if (!credCols.some((c) => c.name === "user_id")) {' },
  { file: "src/db/drivers/sqlite.ts", text: "ALTER TABLE mcp_credentials ADD COLUMN user_id TEXT REFERENCES users (id) ON DELETE SET NULL" },
  { file: "src/db/drivers/sqlite.ts", text: "CREATE INDEX IF NOT EXISTS idx_mcp_credentials_user ON mcp_credentials (user_id)" },
];
/** Bookkeeping importers: dual write, projection, merge repoint, reconciler report. */
const IMPORTERS = new Set([
  "src/db/mcp-credentials.ts",
  "src/db/account-projection.ts",
  "src/domain/merge.ts",
  "src/domain/merge-undo.ts",
  "src/domain/reconcile.ts",
]);

const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);

export function pointerHits(file: string, text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (isComment(l) || !/\buser_id\b/.test(l)) return;
    const near = lines.slice(Math.max(0, i - 6), i + 7).join("\n");
    if (!/mcp_credentials/.test(near)) return;
    if (SCHEMA_LINES.some((s) => s.file === file && l.includes(s.text))) return;
    out.push(`${file}:${i + 1}: ${l.trim()}`);
  });
  return out;
}

describe("credential pointer is bookkeeping only", () => {
  test("no source file but the pointer module names mcp_credentials.user_id", () => {
    const hits = sourceFiles("src")
      .filter((f) => f !== POINTER_MODULE)
      .flatMap((f) => pointerHits(f, readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  test("only the bookkeeping modules import the pointer module", () => {
    const importers = sourceFiles("src")
      .filter((f) => f !== POINTER_MODULE)
      .filter((f) => /from\s+["'][^"']*credential-pointers["']|import\(["'][^"']*credential-pointers["']\)/.test(readFileSync(f, "utf8")));
    expect(importers.filter((f) => !IMPORTERS.has(f))).toEqual([]);
  });

  test("the scanner finds a pointer read in a decision file", () => {
    const sample = 'const r = await db.one("SELECT payload FROM mcp_credentials WHERE user_id = ?", [u]);';
    expect(pointerHits("src/gateway/core/new.ts", sample).length).toBe(1);
    expect(pointerHits("src/gateway/core/new.ts", "// mcp_credentials user_id note").length).toBe(0);
    expect(pointerHits("src/gateway/core/new.ts", "const a = 1; // nothing here\nconst user_id = 2;").length).toBe(0);
  });

  test("the pointer module's exports are not named in decision code", () => {
    const names = ["setCredentialPointer", "userForAccountId", "recordPointerForAccount", "recordPointerInTx", "repointForMerge", "scheduleRecordPointer", "restorePointersForUndo"];
    const bad = sourceFiles("src")
      .filter((f) => f !== POINTER_MODULE && !IMPORTERS.has(f))
      .filter((f) => names.some((n) => readFileSync(f, "utf8").includes(n)));
    expect(bad).toEqual([]);
  });
});
