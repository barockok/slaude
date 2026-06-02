import { createHash } from "node:crypto";

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce((acc, k) => {
        acc[k] = canonicalize((v as Record<string, unknown>)[k]);
        return acc;
      }, {} as Record<string, unknown>);
  }
  return v;
}

/** Deterministic SHA-256 over (service, tool, normalized args). */
export function canonicalArgsHash(service: string, tool: string, args: unknown): string {
  const payload = JSON.stringify([service, tool, canonicalize(args ?? {})]);
  return createHash("sha256").update(payload).digest("hex");
}
