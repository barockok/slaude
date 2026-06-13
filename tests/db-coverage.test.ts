import { afterAll, describe, expect, test } from "bun:test";
import { db } from "../src/db/schema";
import { findById, findByPrefix } from "../src/db/cron-jobs";

// Covers the ambiguous-prefix guard in src/db/cron-jobs.ts.
//
// NOTE: the legacy-db schema-migration branches (src/db/schema.ts ADD COLUMN
// paths) are intentionally NOT exercised here. Hitting them requires presenting
// a db missing those columns, which on the process-shared singleton db means
// DROP COLUMN — destructive DDL that left other files' cron tests reading a
// schema with regenerated (default-stripped) columns under full-suite ordering.
// schema.ts hardcodes its `../config/home` import, so a query-string re-import
// can't be redirected to an isolated db. Not worth the suite fragility.

afterAll(() => {
  db.run("DELETE FROM cron_jobs WHERE id LIKE 'abcdef12%'");
});

describe("cron-jobs findByPrefix", () => {
  const insert = (id: string) =>
    db.run(
      `INSERT INTO cron_jobs (id, channel_id, created_by, cron_expr, prompt, next_run_at, active)
       VALUES (?, 'C1', 'U1', '* * * * *', 'p', 0, 1)`,
      [id],
    );

  test("throws on an ambiguous 8-char prefix instead of picking one", () => {
    insert("abcdef12-aaaa-aaaa");
    insert("abcdef12-bbbb-bbbb");
    expect(() => findByPrefix("abcdef12")).toThrow(/matches multiple jobs/);
  });

  test("unique 8-char prefix resolves; non-8-char falls back to findById", () => {
    db.run("DELETE FROM cron_jobs WHERE id = 'abcdef12-bbbb-bbbb'");
    expect(findByPrefix("abcdef12")?.id).toBe("abcdef12-aaaa-aaaa");
    expect(findByPrefix("abcdef12-aaaa-aaaa")?.id).toBe("abcdef12-aaaa-aaaa"); // full id path
    expect(findByPrefix("00000000")).toBeNull(); // 8 chars, no match
    expect(findById("nope")).toBeNull();
  });
});
