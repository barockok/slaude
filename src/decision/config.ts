import { z } from "zod";

export interface DecisionConfig {
  timeoutMs: number;
  gate: { mode: "off" | "shadow" | "on"; tAct: number; contextMessages: number };
  adapter: Record<string, unknown> | null;
}

const schema = z
  .object({
    timeoutMs: z.number().int().positive().default(800),
    gate: z
      .object({
        mode: z.enum(["off", "shadow", "on"]).default("off"),
        tAct: z.number().min(0).max(1).default(0.8),
        contextMessages: z.number().int().positive().default(8),
      })
      .strict()
      .default({}),
    adapter: z.record(z.unknown()).nullable().default(null),
  })
  .strict();

function defaults(): DecisionConfig {
  return { timeoutMs: 800, gate: { mode: "off", tAct: 0.8, contextMessages: 8 }, adapter: null };
}

/**
 * Parse SLAUDE_DECISION_CONFIG. On any problem returns the all-default config
 * (gate off, no adapter) and an error that names the field path only, never a value.
 */
export function parseDecisionConfig(raw: string | undefined): { config: DecisionConfig; error?: string } {
  if (raw === undefined || raw.trim() === "") return { config: defaults() };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { config: defaults(), error: "SLAUDE_DECISION_CONFIG is not valid JSON" };
  }
  const r = schema.safeParse(json);
  if (!r.success) {
    const paths = r.error.issues.map((i) => {
      const p = i.path.join(".");
      if (i.code === "unrecognized_keys") return `${p ? p + "." : ""}${i.keys.join(",")} (unknown key)`;
      return p || "(root)";
    });
    return { config: defaults(), error: `SLAUDE_DECISION_CONFIG invalid: ${[...new Set(paths)].join(", ")}` };
  }
  return { config: r.data as DecisionConfig };
}
