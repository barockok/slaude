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

  // Gateway-generated notices (not the model's text) are private to the person they are for. A public
  // chat.postMessage under a runtime-ui marker must name one of these reasons, each a deliberate decision:
  // the shared gate cards, and the few lines that concern the whole thread or have no user to tell.
  // A new notice is therefore private by default: to post publicly, add a reason here and say why.
  const PUBLIC_REASONS = [
    "approval card", // shared: several people must see and act on it
    "permission card", // shared: the requester and approvers
    "a held text to an approver's DM", // a DM to an approver, already judged by deliver()
    "public promise line", // a timer posts it, no user is present
    "public /remote and /env state", // the thread must know where tools run
    "public state change line", // /mode, /ignore, cron edits: others must know
    "public ops panel hold notice", // concerns the whole thread
    "public proactive feedback reply", // answers a visible post
    "unattended turn failure", // a wake or cron job has no user to tell
    "authorize link in the person's own DM", // a DM already is private
    "private notice delivery", // sendPrivate itself: an ephemeral or a DM
  ];

  it("a public gateway post names a reason a person decided on (private is the default)", async () => {
    const bad: string[] = [];
    for (const w of (await writes()).filter((x) => /\.chat\.postMessage\(/.test(x.text) && x.text.includes("// runtime-ui:"))) {
      const reason = w.text.split("// runtime-ui:")[1]!.trim();
      if (!PUBLIC_REASONS.some((r) => reason.startsWith(r))) bad.push(`${w.file}:${w.line}: ${reason}`);
    }
    expect(bad).toEqual([]);
  });

  it("the generic reason that hid public notices is gone", async () => {
    const hits = (await writes()).filter((w) => w.text.includes("runtime-ui: gateway notice, card or command reply")).map((w) => `${w.file}:${w.line}`);
    expect(hits).toEqual([]);
  });

  it("a write split across lines (client.chat then .update({) is marked on the call line too", async () => {
    const bare: string[] = [];
    for await (const f of new Glob("src/**/*.{ts,tsx}").scan(".")) {
      const lines = (await Bun.file(f).text()).split("\n");
      lines.forEach((l, i) => {
        if (comment(l)) return;
        if (/^\s*\.(postMessage|update|postEphemeral|delete|scheduleMessage|meMessage)\s*\(/.test(l) && /\.chat\s*$/.test(lines[i - 1] ?? "") && !/\/\/ (outbound|runtime-ui|private-ui): \S/.test(l)) bare.push(`${f}:${i + 1}`);
      });
    }
    expect(bare).toEqual([]);
  });

  it("the old public surface.reply for runtime text is only the private notice's own fallback", async () => {
    const src = await Bun.file("src/gateway/core/gateway.ts").text();
    const publicReplies = src.split("\n").filter((l) => !comment(l) && /\.reply\(\{[^}]*runtime: true/.test(l));
    expect(publicReplies).toHaveLength(1);
    expect(publicReplies[0]).toContain("publicPost");
  });

  it("proactive posts go through it before cardPoster", async () => {
    expect(await Bun.file("src/proactive/heartbeat.ts").text()).toMatch(/await outbound\(raw, \{ kind: "proactive_post"/);
  });
});
