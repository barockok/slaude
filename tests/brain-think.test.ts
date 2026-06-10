import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdkThinkClient, brainThink } from "../src/knowledge/brain-think";
import { closeBrain, ensureSources, brainCall } from "../src/knowledge/brain";

const brainDir = mkdtempSync(join(tmpdir(), "slaude-brainthink-"));
process.env.SLAUDE_BRAIN_HOME = brainDir;

afterAll(async () => {
  await closeBrain();
  delete process.env.SLAUDE_BRAIN_HOME;
  rmSync(brainDir, { recursive: true, force: true });
});

describe("sdkThinkClient", () => {
  test("maps anthropic-shaped params onto a one-shot SDK query and back", async () => {
    let captured: { prompt?: unknown; options?: Record<string, unknown> } = {};
    const fakeRunner = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
      captured = args;
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "synthesized " }] } };
        yield { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } };
        yield { type: "result" };
      })();
    }) as never;
    const client = sdkThinkClient(fakeRunner);
    const msg = (await client.create({
      model: "claude-opus-4-1-20250805",
      max_tokens: 8000,
      system: "You are the brain.",
      messages: [{ role: "user", content: [{ type: "text", text: "Question: what ships thursdays?" }] }],
    } as never)) as { content: Array<{ type: string; text: string }> };
    expect(msg.content[0]!.text).toBe("synthesized answer");
    expect(captured.options!.systemPrompt).toBe("You are the brain.");
    expect(captured.options!.allowedTools).toEqual([]);
    // gbrain's model id is intentionally ignored — subscription default rules
    expect(captured.options!.model).toBeUndefined();
  });
});

describe("brainThink (integration, stubbed LLM)", () => {
  test("runs gbrain's gather+synthesize pipeline scoped, via injected client", async () => {
    await ensureSources();
    await brainCall("put_page", { slug: "notes/cadence", content: "Deploys ship every Thursday." }, {
      clientId: "agent", sourceId: "shared", allowedSources: ["shared"],
    });
    let sawPrompt = "";
    const fakeClient = {
      create: async (params: { messages: Array<{ content: unknown }> }) => {
        sawPrompt = JSON.stringify(params.messages);
        return {
          id: "x", type: "message", role: "assistant", model: "stub",
          content: [{ type: "text", text: "Thursdays. [Source: notes/cadence]" }],
          stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    };
    const r = (await brainThink("when do deploys ship?", {
      clientId: "U1", sourceId: "shared", allowedSources: ["shared"],
    }, { client: fakeClient as never })) as { answer?: string; response?: { answer?: string } };
    const answer = JSON.stringify(r);
    expect(answer).toContain("Thursdays");
    expect(sawPrompt).toContain("cadence"); // gather actually retrieved the page into the prompt
  }, 60_000);
});
