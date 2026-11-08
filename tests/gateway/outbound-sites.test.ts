/**
 * Every Slack write in src/ is classified in OUTBOUND_SITES: agent-authored
 * text goes through the outbound choke point, runtime UI is listed as not
 * covered. A new posting call (or one moved between files) fails this test
 * until it is classified, and a file that carries agent text must use the
 * choke point.
 */
import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { OUTBOUND_SITES } from "../../src/gateway/slack/outbound";

const WRITE = /\.(?:chat\.(?:postMessage|update|postEphemeral|scheduleMessage|meMessage)|files\.(?:uploadV2|upload)|canvases\.(?:create|edit)|conversations\.(?:setTopic|setPurpose))\s*\(/g;
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

async function scan(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for await (const f of new Glob("src/**/*.{ts,tsx}").scan(".")) {
    const n = code(await Bun.file(f).text()).match(WRITE)?.length ?? 0;
    if (n) out[f] = n;
  }
  return out;
}

describe("outbound coverage", () => {
  it("every Slack write in src/ is a classified site, with the count on record", async () => {
    const found = await scan();
    const listed = Object.fromEntries(OUTBOUND_SITES.filter((s) => s.calls > 0).map((s) => [s.file, s.calls]));
    expect(found).toEqual(listed);
  });

  it("a file that carries agent text calls the choke point", async () => {
    for (const s of OUTBOUND_SITES) {
      if (s.carries === "runtime" || s.file.endsWith("/outbound.ts")) continue;
      const src = await Bun.file(s.file).text();
      expect({ file: s.file, uses: /\b(deliver|outbound|outboundSync|formatOutbound)\(/.test(src) }).toEqual({ file: s.file, uses: true });
    }
  });

  it("the proactive post path and the wake tool go through it", async () => {
    expect(await Bun.file("src/proactive/heartbeat.ts").text()).toMatch(/await outbound\(raw, \{ kind: "proactive_post"/);
  });
});
