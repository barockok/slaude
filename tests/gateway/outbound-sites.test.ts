/**
 * Every Slack write in src/ is classified on its own line: `// outbound:` for
 * agent-authored text, which goes through the outbound choke point, or
 * `// runtime-ui:` for the runtime's own UI, which is not covered. A new
 * write (chat.*, files.* writes, canvases, topic and purpose, views.*,
 * apiCall to those, an interaction's respond()) fails this test until it is
 * marked, and a file with an outbound call must use the choke point.
 */
import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { SLACK_WRITE } from "../../src/gateway/slack/outbound";

const comment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);

async function writes(): Promise<Array<{ file: string; line: number; text: string }>> {
  const out: Array<{ file: string; line: number; text: string }> = [];
  for await (const f of new Glob("src/**/*.{ts,tsx}").scan(".")) {
    (await Bun.file(f).text()).split("\n").forEach((l, i) => {
      if (!comment(l) && SLACK_WRITE.test(l)) out.push({ file: f, line: i + 1, text: l });
    });
  }
  return out;
}

describe("outbound coverage", () => {
  it("every Slack write in src/ is marked outbound or runtime-ui on its line", async () => {
    const all = await writes();
    expect(all.length).toBeGreaterThan(40);
    const unmarked = all.filter((w) => !/\/\/ (outbound|runtime-ui): \S/.test(w.text)).map((w) => `${w.file}:${w.line}`);
    expect(unmarked).toEqual([]);
  });

  it("a file with an outbound call uses the choke point", async () => {
    const files = new Set((await writes()).filter((w) => w.text.includes("// outbound:")).map((w) => w.file));
    expect([...files].sort()).toEqual(["src/background/proposal-cards.ts", "src/gateway/slack/mcp-tools.ts", "src/gateway/slack/surface.ts"]);
    for (const f of files) expect({ f, uses: /\b(deliver|outbound|outboundSync)\(/.test(await Bun.file(f).text()) }).toEqual({ f, uses: true });
  });

  it("the patterns catch every kind of write, and only writes", () => {
    for (const l of ["await client.chat.postMessage({", "x.chat.update(", "c.files.uploadV2({", "c.views.open({", 'client.apiCall("chat.postMessage", {', "await respond({ text })", "c.canvases.edit({", "c.conversations.setTopic({"]) expect({ l, w: SLACK_WRITE.test(l) }).toEqual({ l, w: true });
    for (const l of ["c.files.info({", "d.files.map((f) =>", "this.io.provider.respond();", 'log("respond() dropped")', "c.conversations.replies({"]) expect({ l, w: SLACK_WRITE.test(l) }).toEqual({ l, w: false });
  });

  it("proactive posts go through it before cardPoster", async () => {
    expect(await Bun.file("src/proactive/heartbeat.ts").text()).toMatch(/await outbound\(raw, \{ kind: "proactive_post"/);
  });
});
