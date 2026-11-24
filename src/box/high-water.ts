/**
 * The highest box set version this deployment has seen, per tenant.
 *
 * The manifest signs the set (src/box/integrity.ts), but a whole signed set
 * replaced by an OLDER signed set (a rollback), and a deleted set, verify on
 * their own. The digest in a box decides which image a session runs and the
 * policy decides where it may connect, so an older set is an older allowlist
 * and an older image: it must fail closed.
 *
 * The mark is kept the way the guardrail mark is, and in the same three
 * places outside the database (this process's memory, a file beside the
 * guardrail key, Redis when the gateway has one), under a key of its own so
 * the two sets never compare versions with each other. The residual risk is
 * the one src/guardrails/high-water.ts states: a single process with no Redis
 * has only the file.
 *
 * After a database restored from a backup the stored set is older than the
 * mark on purpose, and every read fails closed until an operator has looked:
 * the next deploy does not repair it by itself.
 */
import { __resetHighWaterForTests, highWater, raiseHighWater } from "../guardrails/high-water";
import { BoxIntegrityError } from "./integrity";

/** The key of a tenant's box mark in the shared high-water store. */
export const boxHighWaterKey = (tenant: string): string => `box-set:${tenant}`;

/** The highest box set version seen for `tenant` (0 when none). */
export const boxHighWater = (tenant: string): Promise<number> => highWater(boxHighWaterKey(tenant));

/** Raise the mark (never lowers it). Call only for a version that is committed. */
export const raiseBoxHighWater = (tenant: string, version: number): Promise<void> => raiseHighWater(boxHighWaterKey(tenant), version);

/** Fails closed when the stored set is older than one seen before (rolled back, or deleted). */
export async function checkBoxHighWater(tenant: string, version: number): Promise<void> {
  const hw = await boxHighWater(tenant);
  if (version >= hw) return;
  throw new BoxIntegrityError(
    version === 0
      ? `the box set is gone, but version ${hw} was seen before (deleted)`
      : `the box set is version ${version}, older than version ${hw} seen before (rolled back)`,
  );
}

/** TEST SEAM: forget the mark of these tenants (and, as the shared store does, every mark in memory and in the file). */
export const __resetBoxHighWaterForTests = (tenants: readonly string[] = ["default"]): Promise<void> =>
  __resetHighWaterForTests(tenants.map(boxHighWaterKey));
