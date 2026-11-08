/**
 * On Postgres owner guardrails need SLAUDE_MASTER_KEY (no key-file fallback).
 * Test files that write guardrails call this once so the Postgres leg runs
 * with a key; sqlite runs keep whatever the environment has.
 */
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { __resetGuardrailKeyForTests } from "../../src/guardrails/integrity";

export function ensureGuardrailKeyForPg(): void {
  if (process.env.SLAUDE_DB !== "pg" || process.env.SLAUDE_MASTER_KEY) return;
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
  __resetMasterKeyCache();
  __resetGuardrailKeyForTests();
}
