/**
 * The access helpers are async, so a missing `await` is a Promise (always truthy)
 * in a condition. This scans src with the type checker for a Promise used as a
 * value (see tests/helpers/promise-scan.ts) and fails on any hit that is not in
 * the reviewed allowlist, keyed by file, kind and normalised text (not line
 * number). Regenerate the allowlist only after reading every new hit:
 * `UPDATE_PROMISE_ALLOW=1 bun test tests/access/no-misused-promises.test.ts`.
 */
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { scanMisusedPromises } from "../helpers/promise-scan";

const ALLOW = "tests/access/promise-use.allow.json";

test("no Promise is used as a value outside the reviewed list", () => {
  const hits = scanMisusedPromises(process.cwd());
  if (process.env.UPDATE_PROMISE_ALLOW === "1") writeFileSync(ALLOW, JSON.stringify([...hits].sort(), null, 2) + "\n");
  const allow = new Map<string, number>();
  for (const k of JSON.parse(readFileSync(ALLOW, "utf8")) as string[]) allow.set(k, (allow.get(k) ?? 0) + 1);
  const fresh: string[] = [];
  for (const h of hits) {
    const n = allow.get(h) ?? 0;
    if (n > 0) allow.set(h, n - 1);
    else fresh.push(h);
  }
  expect(fresh).toEqual([]);
}, 60_000);
