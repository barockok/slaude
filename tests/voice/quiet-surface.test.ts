import { describe, it, expect } from "bun:test";
import { quietForVoice, voiceTurns } from "../../src/voice/turn-flags";
import type { Surface } from "../../src/gateway/core/surface";

function fakeSurface(posted: string[]): Surface {
  return {
    id: "slack", capabilities: new Set(), getHistory: async () => [],
    requestApproval: async () => ({ approved: true, by: "U1" } as any),
    reply: async (i: any) => { posted.push(i.text); return { ref: "1.0" }; },
  } as unknown as Surface;
}

describe("quietForVoice", () => {
  it("voice turn suppresses reply; a normal turn posts", async () => {
    const posted: string[] = [];
    const s = quietForVoice(fakeSurface(posted), "s9");
    voiceTurns.enter("s9");
    await s.reply({ text: "during call" } as any);
    voiceTurns.exit("s9");
    await s.reply({ text: "summary" } as any);
    expect(posted).toEqual(["summary"]);
  });
});
