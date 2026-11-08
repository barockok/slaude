/**
 * The highest guardrail manifest version this deployment has seen, per
 * tenant. The manifest signs the set, but a signed older set (a rollback) and
 * a deleted set (no manifest, or the unsigned version 0) verify on their own;
 * the high-water mark is what makes them fail closed.
 *
 * It is kept outside the database the set lives in, in three places, and the
 * highest wins: this process's memory; a file beside the key
 * ($SLAUDE_HOME/guardrails/.high-water.json, refused to the file tools); and
 * Redis when the deployment has one (every replica and restart agrees).
 *
 * Residual risk, stated: on a cold start of a single process with no Redis,
 * the file is the only memory. Whoever can rewrite both the database and that
 * file (on that deployment, a session's shell) can roll the set back or delete
 * it without being detected. Postgres or nodes (the session cannot reach the
 * database) and Redis close that gap.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Redis } from "ioredis";
import { GUARDRAILS_DIR, GuardrailIntegrityError } from "./integrity";

export const HIGH_WATER_FILE = join(GUARDRAILS_DIR, ".high-water.json");

const memory = new Map<string, number>();
let redis: { client: Redis; key: (tenant: string) => string } | null = null;

/** Keep the mark in Redis too (the gateway calls this when it has one). */
export function setHighWaterRedis(client: Redis | null, prefix = "slaude"): void {
  redis = client ? { client, key: (t) => `${prefix}:guardrails:high-water:${t}` } : null;
}

function readFile(): Record<string, number> {
  if (!existsSync(HIGH_WATER_FILE)) return {};
  try {
    const v = JSON.parse(readFileSync(HIGH_WATER_FILE, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number" && Number.isSafeInteger(n))) as Record<string, number>;
  } catch {
    return {};
  }
}

/** The highest version seen for `tenant` (0 when none). */
export async function highWater(tenant: string): Promise<number> {
  let v = Math.max(memory.get(tenant) ?? 0, readFile()[tenant] ?? 0);
  if (redis) {
    try {
      const r = Number(await redis.client.get(redis.key(tenant)));
      if (Number.isSafeInteger(r)) v = Math.max(v, r);
    } catch (e) {
      console.warn(`[guardrails] high-water read from Redis failed: ${(e as Error).message}`);
    }
  }
  return v;
}

/** Raise the mark to `version` (never lowers it). The file and Redis are best effort. */
export async function raiseHighWater(tenant: string, version: number): Promise<void> {
  if (version <= 0) return;
  if ((memory.get(tenant) ?? 0) < version) memory.set(tenant, version);
  const file = readFile();
  if ((file[tenant] ?? 0) < version) {
    try {
      mkdirSync(dirname(HIGH_WATER_FILE), { recursive: true });
      const tmp = `${HIGH_WATER_FILE}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...file, [tenant]: version }), { mode: 0o600 });
      renameSync(tmp, HIGH_WATER_FILE);
    } catch (e) {
      console.warn(`[guardrails] high-water file not written: ${(e as Error).message}`);
    }
  }
  if (redis) {
    try {
      // Only ever raised: set when absent or lower, atomically.
      await redis.client.eval(
        `local c = tonumber(redis.call("get", KEYS[1]) or "0") if c < tonumber(ARGV[1]) then redis.call("set", KEYS[1], ARGV[1]) end return 1`,
        1,
        redis.key(tenant),
        String(version),
      );
    } catch (e) {
      console.warn(`[guardrails] high-water write to Redis failed: ${(e as Error).message}`);
    }
  }
}

/** TEST SEAM: forget the mark everywhere this process keeps it. */
export async function __resetHighWaterForTests(): Promise<void> {
  memory.clear();
  try {
    if (existsSync(HIGH_WATER_FILE)) writeFileSync(HIGH_WATER_FILE, "{}");
  } catch {
    /* read-only test home */
  }
  if (redis) {
    for (const t of ["default"]) await redis.client.del(redis.key(t)).catch(() => {});
  }
}

/** Fails closed when the stored version is below the highest one seen (rollback, or the set deleted). */
export async function checkHighWater(tenant: string, version: number): Promise<void> {
  const hw = await highWater(tenant);
  if (version >= hw) return;
  throw new GuardrailIntegrityError(
    version === 0
      ? `the guardrail set is gone, but version ${hw} was seen before (deleted)`
      : `the guardrail set is version ${version}, older than version ${hw} seen before (rolled back)`,
  );
}
