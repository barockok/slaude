/** Voice lint: flags replies that talk about the agent's own machinery. */
export type VoiceRule = "machinery-kb" | "skill-saved" | "skill-mention";

export function voiceLint(text: string, opts: { skillTurn?: boolean } = {}): VoiceRule[] {
  const hits: VoiceRule[] = [];
  if (/\b(my|the) (KB|brain|memory)\b/i.test(text)) hits.push("machinery-kb");
  const saved = text.includes("saved /");
  if (saved) hits.push("skill-saved");
  if (!saved && !opts.skillTurn && /\bskill\b/i.test(text)) hits.push("skill-mention");
  return hits;
}

/** First violation across reply cards, or undefined. Only `message` cards are agent prose. */
export function firstVoiceViolation(cards: { kind: string; text?: string }[]): { rule: VoiceRule; text: string } | undefined {
  for (const c of cards) {
    if (c.kind !== "message" || !c.text) continue;
    const hits = voiceLint(c.text);
    if (hits.length) return { rule: hits[0]!, text: c.text };
  }
  return undefined;
}
