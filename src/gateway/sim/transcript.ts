import { parse as parseYaml } from "yaml";
import { SimSession, type SoulFixture } from "./engine";
import type { OutboundCard } from "./transport";

export interface Transcript {
  preset?: string;
  soul?: Partial<SoulFixture>;
  agent_behavior?: string;
  steps: any[];
}

export function parseTranscript(yamlText: string): Transcript {
  const doc = parseYaml(yamlText);
  if (!doc || !Array.isArray(doc.steps)) throw new Error("transcript: missing `steps` array");
  return { preset: doc.preset, soul: doc.soul, agent_behavior: doc.agent_behavior, steps: doc.steps };
}

function liveCards(cards: OutboundCard[]): OutboundCard[] { return cards.filter((c) => !c.resolved); }

function dump(cards: OutboundCard[]): string {
  return JSON.stringify(cards.map((c) => ({ kind: c.kind, channel: c.channel, text: c.text, resolved: c.resolved, actionIds: c.actionIds })), null, 2);
}

export async function runTranscript(t: Transcript, agent: "stub" | "real" = "stub"): Promise<void> {
  const s = await SimSession.create({
    preset: t.preset,
    soul: t.preset ? undefined : (t.soul as SoulFixture | undefined),
    behavior: t.agent_behavior,
    agent,
  });
  try {
    for (const step of t.steps) {
      if (step.send) { await s.send(step.send); continue; }
      if (step.click) { await s.click(step.click); continue; }
      if (step.expect_card) {
        const { kind, to, contains } = step.expect_card;
        const hit = liveCards(s.cards()).find((c) => c.kind === kind
          && (to ? JSON.stringify(c.blocks).includes(to) : true)
          && (contains ? (c.text ?? "").includes(contains) : true));
        if (!hit) throw new Error(`expect_card ${JSON.stringify(step.expect_card)} - no match. bus=${dump(s.cards())}`);
        continue;
      }
      if (step.expect_reply) {
        const hit = s.cards().some((c) => (c.text ?? "").includes(step.expect_reply.contains));
        if (!hit) throw new Error(`expect_reply contains ${JSON.stringify(step.expect_reply.contains)} - no match. bus=${dump(s.cards())}`);
        continue;
      }
      if (step.expect_drop) {
        if (!s.drops().some((d) => d.reason === step.expect_drop.reason)) throw new Error(`expect_drop ${step.expect_drop.reason} - drops=${JSON.stringify(s.drops())}`);
        continue;
      }
      if (step.expect_pending) {
        if (!liveCards(s.cards()).some((c) => c.kind === "approval")) throw new Error(`expect_pending - no unresolved approval card. bus=${dump(s.cards())}`);
        continue;
      }
      throw new Error(`unknown step: ${JSON.stringify(step)}`);
    }
  } finally {
    await s.dispose();
  }
}
