import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackSurface } from "../../../src/gateway/slack/surface";
import { surfaceTools } from "../../../src/gateway/core/surface-mcp";
import type { SessionBinding } from "../../../src/gateway/core/surface";

// The three Slack calls of a direct upload are separate surface methods, so
// upload_begin and upload_complete reuse them; files.uploadV2 stays for the
// co-located path, now with a lower size cap (it buffers the file in memory).

function fakeClient(calls: Array<{ name: string; args: any }>) {
  return {
    chat: { postMessage: async () => ({ ts: "1.1" }), update: async () => ({}) },
    files: {
      getUploadURLExternal: async (a: any) => { calls.push({ name: "begin", args: a }); return { ok: true, upload_url: "https://upload.example/x", file_id: "F9" }; },
      completeUploadExternal: async (a: any) => { calls.push({ name: "complete", args: a }); return { ok: true, files: [{ id: "F9" }] }; },
      uploadV2: async (a: any) => {
        if (a.file && typeof a.file.on === "function") for await (const _ of a.file) { /* consume */ }
        calls.push({ name: "uploadV2", args: a });
        return { files: [{ id: "F1" }] };
      },
    },
  } as any;
}

function binding(over: Partial<SessionBinding> = {}): SessionBinding {
  return {
    conversationId: "C1", threadRef: "1.0", inboundRef: "2.0",
    requestApproval: async () => ({ approved: true, by: "U1" }), reloadSession: () => true,
    ...over,
  };
}

process.env.SLAUDE_UPLOAD_ALLOWED_HOSTS = "upload.example";

describe("SlackSurface direct upload calls", () => {
  test("uploadBegin refuses an upload URL on a host that is not allowed, without echoing it", async () => {
    for (const url of ["https://evil.example/x", "http://other.example/x", "file:///etc/passwd"]) {
      const client = fakeClient([]);
      client.files.getUploadURLExternal = async () => ({ ok: true, upload_url: url, file_id: "F9" });
      const err: any = await new SlackSurface(client, binding()).uploadBegin({ filename: "a", size: 1 }).catch((e) => e);
      expect(err.message).toContain("unexpected");
      expect(err.message).not.toContain("evil");
    }
  });

  test("uploadBegin asks Slack for an upload URL with the name, length and alt text", async () => {
    const calls: any[] = [];
    const s = new SlackSurface(fakeClient(calls), binding());
    const r = await s.uploadBegin({ filename: "a.png", size: 42, altText: "alt" });
    expect(r).toEqual({ uploadUrl: "https://upload.example/x", fileId: "F9" });
    expect(calls).toEqual([{ name: "begin", args: { filename: "a.png", length: 42, alt_text: "alt" } }]);
  });

  test("uploadBegin omits alt_text when absent and fails when Slack returns no URL", async () => {
    const calls: any[] = [];
    const client = fakeClient(calls);
    await new SlackSurface(client, binding()).uploadBegin({ filename: "a", size: 1 });
    expect(calls[0].args).toEqual({ filename: "a", length: 1 });
    client.files.getUploadURLExternal = async () => ({ ok: true });
    await expect(new SlackSurface(client, binding()).uploadBegin({ filename: "a", size: 1 })).rejects.toThrow("upload URL");
  });

  test("uploadComplete finishes into the binding's channel and thread, with the title", async () => {
    const calls: any[] = [];
    await new SlackSurface(fakeClient(calls), binding()).uploadComplete({ fileId: "F9", filename: "a.png", title: "T" });
    expect(calls).toEqual([{ name: "complete", args: { files: [{ id: "F9", title: "T" }], channel_id: "C1", thread_ts: "1.0" } }]);
  });

  test("uploadComplete defaults the title to the file name and omits the thread at the channel root", async () => {
    const calls: any[] = [];
    await new SlackSurface(fakeClient(calls), binding({ threadRef: undefined })).uploadComplete({ fileId: "F9", filename: "a.png" });
    expect(calls[0].args).toEqual({ files: [{ id: "F9", title: "a.png" }], channel_id: "C1" });
  });

  test("a caption goes through the reply rules and is posted with the file", async () => {
    const calls: any[] = [];
    await new SlackSurface(fakeClient(calls), binding()).uploadComplete({ fileId: "F9", filename: "a", comment: "see **this**" });
    expect(calls[0].args.initial_comment).toContain("see");
    expect(calls[0].args.initial_comment).not.toContain("**");
  });

  test("the surface declares the methods with the upload capability", () => {
    const s = new SlackSurface(fakeClient([]), binding());
    expect(s.capabilities.has("upload")).toBe(true);
    expect(typeof s.uploadBegin).toBe("function");
    expect(typeof s.uploadComplete).toBe("function");
    // Neither is an agent-facing tool on the in-process server.
    expect(surfaceTools(s).map((d) => d.name)).not.toContain("upload_begin");
    expect(surfaceTools(s).map((d) => d.name)).not.toContain("upload_complete");
  });
});

describe("the co-located upload cap", () => {
  const saved = process.env.SLAUDE_UPLOAD_COLOCATED_MAX_BYTES;
  afterEach(() => {
    if (saved === undefined) delete process.env.SLAUDE_UPLOAD_COLOCATED_MAX_BYTES; else process.env.SLAUDE_UPLOAD_COLOCATED_MAX_BYTES = saved;
  });

  function folder() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "slaude-colo-")));
    writeFileSync(join(dir, "f.bin"), Buffer.alloc(100, 1));
    return dir;
  }

  test("a file over the cap is refused before anything is sent, and uploadV2 is used under it", async () => {
    const dir = folder();
    const calls: any[] = [];
    const s = new SlackSurface(fakeClient(calls), binding({ workingDir: async () => dir }));
    process.env.SLAUDE_UPLOAD_COLOCATED_MAX_BYTES = "99";
    await expect(s.upload({ path: join(dir, "f.bin") })).rejects.toThrow(/100 bytes.*99/);
    expect(calls).toHaveLength(0);
    process.env.SLAUDE_UPLOAD_COLOCATED_MAX_BYTES = "100";
    await s.upload({ path: join(dir, "f.bin") });
    expect(calls.map((c) => c.name)).toEqual(["uploadV2"]);
  });

  test("the default is 100 MB", async () => {
    delete process.env.SLAUDE_UPLOAD_COLOCATED_MAX_BYTES;
    const { env } = await import("../../../src/config/env");
    expect(env.uploadColocatedMaxBytes()).toBe(104_857_600);
    expect(env.uploadMaxBytes()).toBe(1_073_741_824);
  });

  test("the tool returns the cap refusal as an error for the agent", async () => {
    const dir = folder();
    process.env.SLAUDE_UPLOAD_COLOCATED_MAX_BYTES = "10";
    const defs = surfaceTools(new SlackSurface(fakeClient([]), binding({ workingDir: async () => dir })));
    const r: any = await defs.find((d) => d.name === "upload")!.handler({ path: join(dir, "f.bin") });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("over the limit");
    expect(r.content[0].text).not.toContain(dir);
  });
});
