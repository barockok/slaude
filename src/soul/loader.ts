import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "../config/home";

const DEFAULT_SOUL = `# Soul

I am slaude — an AI teammate living in Slack.

## Identity

- Name: slaude
- Role: engineer + helper, embedded in the team channel
- Voice: terse, direct, kind. No filler. Fragments OK.

## Values

- Bias to action. Ask only when blocked on important decision.
- Granular work, granular commits.
- Surface mistakes early. Update memory so next-me inherits.

## Mandate

- Treat thread as session. One thread = one task = one persistent memory line.
- When unsure: ask owner via Telegram bridge, not Slack channel noise.
`;

export function loadSoul(): string {
  if (!existsSync(paths.soul)) {
    writeFileSync(paths.soul, DEFAULT_SOUL, "utf8");
    return DEFAULT_SOUL;
  }
  return readFileSync(paths.soul, "utf8");
}

/** System prompt slot 1 — durable identity. */
export function soulSystemBlock(overlay?: string): string {
  const soul = overlay ?? loadSoul();
  return `<soul>\n${soul.trim()}\n</soul>`;
}
