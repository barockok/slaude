import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SlackSurface } from "../src/gateway/slack/surface";
import type { SessionBinding } from "../src/gateway/core/surface";

// Complements tests/slack-surface.test.ts — covers edit/unreact/upload and the
// react default-ref path over the same fake-WebClient harness.

type Captured = Record<string, any[]>;

function fakeClient(captured: Captured = {}) {
  const record = (name: string, args: any) => {
    (captured[name] ??= []).push(args);
  };
  return {
    chat: {
      postMessage: async (a: any) => { record("postMessage", a); return { ts: "100.0" }; },
      update: async (a: any) => { record("update", a); return {}; },
    },
    reactions: {
      add: async (a: any) => { record("reactionsAdd", a); return {}; },
      remove: async (a: any) => { record("reactionsRemove", a); return {}; },
    },
    files: {
      uploadV2: async (a: any) => { record("uploadV2", a); return { files: [{ id: "F1" }] }; },
    },
    conversations: {
      replies: async (a: any) => { record("replies", a); return { messages: [], has_more: false }; },
    },
  } as any;
}

function binding(over: Partial<SessionBinding> = {}): SessionBinding {
  return {
    conversationId: "C1",
    threadRef: "123.456",
    inboundRef: "789.012",
    requestApproval: async () => ({ approved: true, by: "U1" }),
    reloadSession: () => true,
    ...over,
  };
}

describe("SlackSurface edit/unreact/upload", () => {
  test("edit updates the bound conversation at the given ref with formatted text", async () => {
    const captured: Captured = {};
    const s = new SlackSurface(fakeClient(captured), binding());
    await s.edit({ ref: "55.5", text: "**bold** fix" });
    expect(captured.update).toHaveLength(1);
    expect(captured.update![0]).toMatchObject({ channel: "C1", ts: "55.5" });
    expect(captured.update![0].text).toContain("bold");
  });

  test("react defaults the timestamp to the inbound ref", async () => {
    const captured: Captured = {};
    const s = new SlackSurface(fakeClient(captured), binding());
    await s.react({ name: "eyes" });
    expect(captured.reactionsAdd![0]).toMatchObject({ channel: "C1", timestamp: "789.012", name: "eyes" });
  });

  test("react rethrows non-already_reacted errors (awaited)", async () => {
    const client = fakeClient();
    client.reactions.add = async () => { throw new Error("channel_not_found"); };
    const s = new SlackSurface(client, binding());
    await expect(s.react({ name: "x", ref: "1.0" })).rejects.toThrow("channel_not_found");
  });

  test("unreact removes a reaction at an explicit ref", async () => {
    const captured: Captured = {};
    const s = new SlackSurface(fakeClient(captured), binding());
    await s.unreact({ name: "eyes", ref: "42.0" });
    expect(captured.reactionsRemove![0]).toMatchObject({ channel: "C1", timestamp: "42.0", name: "eyes" });
  });

  test("unreact defaults to the inbound ref", async () => {
    const captured: Captured = {};
    const s = new SlackSurface(fakeClient(captured), binding());
    await s.unreact({ name: "eyes" });
    expect(captured.reactionsRemove![0]).toMatchObject({ timestamp: "789.012" });
  });

  test("upload sends the file with filename defaults (no comment / alt text)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slaude-upload-"));
    const file = join(dir, "report.txt");
    writeFileSync(file, "hello");
    const captured: Captured = {};
    const s = new SlackSurface(fakeClient(captured), binding());
    await s.upload({ path: file });
    const a = captured.uploadV2![0];
    expect(a).toMatchObject({ channel_id: "C1", thread_ts: "123.456", filename: basename(file), title: basename(file) });
    expect(a.initial_comment).toBeUndefined();
    expect(a.alt_text).toBeUndefined();
  });

  test("upload honors title, initial comment (formatted) and alt text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slaude-upload-"));
    const file = join(dir, "chart.png");
    writeFileSync(file, "png-bytes");
    const captured: Captured = {};
    const s = new SlackSurface(fakeClient(captured), binding());
    await s.upload({ path: file, title: "Q2 chart", comment: "see **trend**", altText: "trend chart" });
    const a = captured.uploadV2![0];
    expect(a.title).toBe("Q2 chart");
    expect(a.initial_comment).toContain("trend");
    expect(a.alt_text).toBe("trend chart");
  });

  test("upload throws when the local file is missing (statSync gate)", async () => {
    const s = new SlackSurface(fakeClient(), binding());
    await expect(s.upload({ path: "/nonexistent/slaude-missing.bin" })).rejects.toThrow();
  });
});
