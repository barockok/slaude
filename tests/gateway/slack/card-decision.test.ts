import { describe, expect, it } from "bun:test";
import { decidedBlocks, respondClosed, respondDecided } from "../../../src/gateway/slack/card-decision";
import { redactSecrets } from "../../../src/redact";

const card = [
  { type: "section", text: { type: "mrkdwn", text: ":lock: *Approval needed*" } },
  { type: "section", text: { type: "mrkdwn", text: "```\nls -la\n```" } },
  { type: "actions", elements: [{ type: "button", action_id: "slaude_perm:allow:x", text: { type: "plain_text", text: "Allow once" } }] },
];

describe("decidedBlocks", () => {
  it("keeps every block and swaps the buttons for the decision line", () => {
    const out = decidedBlocks(card, "Allowed once by <@U1>")!;
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(card[0]);
    expect(out[1]).toEqual(card[1]);
    expect(out[2]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "Allowed once by <@U1>" }] });
    expect(JSON.stringify(out)).not.toContain("slaude_perm");
  });
  it("is null when there is nothing to keep", () => {
    expect(decidedBlocks(undefined, "x")).toBeNull();
    expect(decidedBlocks([{ type: "section" }], "x")).toBeNull();
  });
});

describe("respondDecided", () => {
  const body = { message: { blocks: card } };
  it("replaces the card with the kept blocks", async () => {
    const sent: any[] = [];
    await respondDecided(async (m: any) => void sent.push(m), body, "t", "line");
    expect(sent).toHaveLength(1);
    expect(sent[0].replace_original).toBe(true);
    expect(sent[0].blocks).toHaveLength(3);
  });
  it("falls back to the one-line card when Slack refuses the rich update", async () => {
    const sent: any[] = [];
    let n = 0;
    await respondDecided(async (m: any) => { if (n++ === 0) throw new Error("invalid_blocks"); sent.push(m); }, body, "t", "line");
    expect(sent).toEqual([{ replace_original: true, text: "t", blocks: [] }]);
  });
  it("uses the one-line card when the click carried no blocks", async () => {
    const sent: any[] = [];
    await respondDecided(async (m: any) => void sent.push(m), {}, "t", "line");
    expect(sent).toEqual([{ replace_original: true, text: "t", blocks: [] }]);
  });
});

describe("secret shapes a decided card must not keep", () => {
  const masked = (s: string) => redactSecrets(s);
  it("URL passwords", () => expect(masked("psql postgres://app:hunter2@db.internal/x")).not.toContain("hunter2"));
  it("command line passwords", () => {
    expect(masked("mysql --password hunter2 -h db")).not.toContain("hunter2");
    expect(masked("tool --token=abc123def456")).not.toContain("abc123def456");
  });
  it("basic auth flags", () => expect(masked("curl -u admin:s3cretpw https://x")).not.toContain("s3cretpw"));
  it("signed URL parameters", () => expect(masked("https://b.s3.example/o?X-Amz-Signature=deadbeef01&x=1")).not.toContain("deadbeef01"));
  it("private key blocks", () => expect(masked("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----")).not.toContain("MIIabc"));
  it("cookies", () => expect(masked("Cookie: session=abcdef123456; other=1")).not.toContain("abcdef123456"));
  it("leaves ordinary text alone", () => expect(masked("ls -la /tmp && echo done")).toBe("ls -la /tmp && echo done"));
});

describe("respondClosed", () => {
  const body = { message: { blocks: card } };
  it("closes the card in place and says so", async () => {
    const sent: any[] = [];
    expect(await respondClosed(async (m: any) => void sent.push(m), body, "t", "line")).toBe(true);
    expect(sent[0].replace_original).toBe(true);
    expect(sent[0].blocks.some((b: any) => b.type === "actions")).toBe(false);
  });
  it("returns false, sending nothing, when the click carried no blocks", async () => {
    const sent: any[] = [];
    expect(await respondClosed(async (m: any) => void sent.push(m), {}, "t", "line")).toBe(false);
    expect(sent).toEqual([]);
  });
  it("returns false when Slack refuses, so the caller can answer privately", async () => {
    expect(await respondClosed(async () => { throw new Error("invalid_blocks"); }, body, "t", "line")).toBe(false);
  });
});

