import type { SoulData } from "./data";

export type ValidationResult = {
  ok: boolean;
  /** Required fields missing or empty. Blocks `ok`. */
  missing: string[];
  /** Soft issues — operator should review but boot continues. */
  warnings: string[];
};

/**
 * Pure validator over a parsed `SoulData`. Required fields are the minimum
 * set the runtime needs to behave correctly:
 *
 *   - identity.name      — agent display name (used in self-references, status)
 *   - manager.userId     — security boundary (DMs + non-whitelist channels accept manager only)
 *   - mandate            — agent purpose, drives every turn
 *
 * Everything else is optional but may emit a warning when the absence is
 * operationally suspicious (e.g. zero approvers means no one can approve
 * `request_approval` blocks).
 */
export function validateSoul(data: SoulData): ValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!data.identity?.name?.trim()) missing.push("identity.name");
  if (!data.manager?.userId?.trim()) missing.push("manager.userId");
  if (!data.mandate?.trim()) missing.push("mandate");

  if (data.approvers.length === 0) {
    warnings.push("approvers is empty — `request_approval` blocks will fall back to env or accept anyone");
  }
  if (data.allowedChannels.length === 0) {
    warnings.push("allowedChannels is empty — only manager can chat outside DMs");
  }

  return { ok: missing.length === 0, missing, warnings };
}
