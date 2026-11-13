/**
 * An agent.yaml that sits on disk: `$SLAUDE_HOME/agent.yaml` for the default
 * persona and `personas/<name>/agent.yaml` for a named one.
 *
 * It compiles with the same `parseAgentYaml` a synced agent.yaml does, and
 * yields the same three things a database-backed persona carries: the soul text
 * (prose plus the generated blocks), the compiled structure, and the definition.
 * Every reader that asks "is this persona defined by an agent.yaml" then works
 * for a file on disk with no change.
 *
 * What a file on disk cannot set yet: `model`, `mcp`, `runsOn`, `provider`,
 * `kbSources`, `background` and `userToken`. They keep coming from
 * `config.json`, `mcp.json` and the environment, and the file is refused with a
 * message that says so, because ignoring a key the operator wrote is worse.
 *
 * Errors name the persona and the key, never a value.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_YAML, parseAgentYaml } from "./agent-def";
import { PayloadError, type PersonaDefinition } from "./sync/payload";
import type { SoulData } from "../soul/data";

export interface FileAgent {
  /** Prose plus the blocks generated from `proactive` and `channels`. */
  soulMd: string;
  /** The compiled structure: what a SOUL.md persona gets from extraction. */
  soulJson: SoulData;
  definition: PersonaDefinition;
  /** The file's own `slackUserId`, resolved to a bare id; `config.json` is the fallback. */
  slackUserId?: string;
  warnings: string[];
}

/** Where each refused key lives instead, for the message. */
const ELSEWHERE: Record<string, string> = {
  model: "SLAUDE_MODEL",
  mcp: "mcp.json beside it",
  runsOn: "config.json",
  provider: "the environment",
  kbSources: "the installed knowledge bases",
  background: "the environment",
  userToken: "config.json",
};

/** Files that hold the same things as agent.yaml and so cannot sit beside it. */
const COVERED = ["SOUL.md", "persona.yaml"] as const;

export function readFileAgent(dir: string, name: string): FileAgent | null {
  const file = join(dir, AGENT_YAML);
  if (!existsSync(file)) return null;
  const beside = COVERED.filter((f) => existsSync(join(dir, f)));
  if (beside.length) {
    throw new PayloadError(`persona '${name}': ${AGENT_YAML} cannot sit beside ${beside.join(", ")}; ${AGENT_YAML} replaces them, so move them away`);
  }
  const compiled = parseAgentYaml(name, readFileSync(file, "utf8"));
  const { spec } = compiled;
  const set: Record<string, unknown> = {
    model: spec.model,
    mcp: spec.mcp,
    runsOn: spec.runsOn,
    provider: spec.provider,
    kbSources: spec.kbSources,
    background: spec.background,
    userToken: spec.userToken,
  };
  for (const [key, value] of Object.entries(set)) {
    if (value !== undefined) {
      throw new PayloadError(
        `persona '${name}': agent.yaml ${key === "kbSources" || key === "background" ? `memory.${key}` : key} cannot be set in a file on disk yet; it comes from ${ELSEWHERE[key]}`,
      );
    }
  }
  const { soulData, ...definition } = spec.definition;
  return {
    soulMd: spec.soul,
    soulJson: soulData,
    definition,
    ...(spec.slackUserId ? { slackUserId: spec.slackUserId } : {}),
    warnings: compiled.warnings,
  };
}
