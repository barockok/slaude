/**
 * What a filesystem tenant's $SLAUDE_HOME must look like before it boots.
 *
 * A persona's structure (who manages it, who may approve, which channels it
 * trusts, its mandates) comes from its agent.yaml and from nowhere else. A
 * SOUL.md with no agent.yaml beside it would start with an empty access list
 * and look healthy, so the process stops instead, and says which command
 * converts it. A fresh home gets a starter agent.yaml for the default persona.
 *
 * Runs for the gateway and mono on a tenant that reads the filesystem, never
 * for a managed tenant (its personas come from the database) and never on a node.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { AGENT_YAML } from "./agent-def";
import { AGENT_YAML_MODELINE } from "./agent-schema";

export const STARTER_AGENT_YAML = `${AGENT_YAML_MODELINE}
# The default persona. Fill in who manages it before going live: without a
# manager and approvers nobody can approve a tool call or change its settings.
name: default
description: "<one line, what this agent is for>"
soul: |
  # Persona

  ## Identity
  - Name: <agent display name>
  - Voice: <for example terse, direct, no filler>
# access:
#   manager: slack:user:U0EXAMPLE
#   approvers:
#     - { user: slack:user:U0EXAMPLE, scope: anything }
#   channels:
#     trusted: [slack:channel:C0EXAMPLE]
# mandate:
#   global: "<what this agent is meant to accomplish>"
`;

/** The personas on disk that still have a SOUL.md and no agent.yaml. */
export function soulOnlyPersonas(home: string = paths.home, personasDir: string = join(home, "personas")): string[] {
  const out: string[] = [];
  if (existsSync(join(home, "SOUL.md")) && !existsSync(join(home, AGENT_YAML))) out.push("default");
  if (existsSync(personasDir)) {
    for (const name of readdirSync(personasDir).sort()) {
      const d = join(personasDir, name);
      try {
        if (!statSync(d).isDirectory()) continue;
      } catch {
        continue;
      }
      if (existsSync(join(d, "SOUL.md")) && !existsSync(join(d, AGENT_YAML))) out.push(name);
    }
  }
  return out;
}

/**
 * Stop on a SOUL.md-only persona; seed the starter for a home with no default
 * definition at all. Returns what it seeded, for the boot log.
 */
export function checkDiskPersonas(home: string = paths.home, personasDir: string = join(home, "personas")): { seeded?: string } {
  const legacy = soulOnlyPersonas(home, personasDir);
  if (legacy.length) {
    throw new Error(
      `persona(s) ${legacy.map((n) => `'${n}'`).join(", ")} have a SOUL.md and no agent.yaml. A persona's access and mandates are read from agent.yaml only. ` +
        `Convert each with: bun run personas migrate <name|default> (then review the file and restart).`,
    );
  }
  const file = join(home, AGENT_YAML);
  if (!existsSync(join(home, "SOUL.md")) && !existsSync(file)) {
    writeFileSync(file, STARTER_AGENT_YAML, "utf8");
    return { seeded: file };
  }
  return {};
}
