import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SlackSurface } from "../src/gateway/slack/surface";
import { surfaceTools } from "../src/gateway/core/surface-mcp";
import type { SessionBinding } from "../src/gateway/core/surface";

// Uploads are confined to the session working directory: the realpath of the
// path must be a regular file inside the realpath of the session's folder.

function fakeClient(sent: any[]) {
  return {
    chat: { postMessage: async () => ({ ts: "1.1" }), update: async () => ({}) },
    files: {
      uploadV2: async (a: any) => {
        // The stream is consumed, as the real client does, so a bad descriptor fails here.
        if (a.file && typeof a.file.on === "function") {
          const chunks: Buffer[] = [];
          for await (const c of a.file) chunks.push(Buffer.from(c));
          sent.push({ ...a, bytes: Buffer.concat(chunks).toString() });
        } else sent.push(a);
        return { files: [{ id: "F1" }] };
      },
    },
  } as any;
}

function binding(workingDir: (() => Promise<string | undefined>) | undefined): SessionBinding {
  return {
    conversationId: "C1",
    threadRef: "1.0",
    inboundRef: "2.0",
    requestApproval: async () => ({ approved: true, by: "U1" }),
    reloadSession: () => true,
    ...(workingDir ? { workingDir } : {}),
  };
}

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "slaude-confine-")));
  const work = join(root, "work");
  const other = join(root, "other");
  mkdirSync(work);
  mkdirSync(other);
  writeFileSync(join(work, "report.txt"), "inside");
  writeFileSync(join(other, "secret.txt"), "outside");
  return { root, work, other };
}

const REFUSAL = (name: string) => `upload refused: ${name} is not a regular file under this session's working directory. Copy the file into your working directory and upload it from there.`;

async function refused(s: SlackSurface, path: string, name: string, sent: any[]) {
  let err: any;
  try { await s.upload({ path }); } catch (e) { err = e; }
  expect(err?.message).toBe(REFUSAL(name));
  expect(err.message).not.toContain(path === name ? "\u0000" : path);
  expect(sent).toHaveLength(0);
}

describe("SlackSurface.upload confinement", () => {
  test("a regular file inside the working dir uploads, with title, caption and alt text", async () => {
    const w = world();
    const sent: any[] = [];
    const s = new SlackSurface(fakeClient(sent), binding(async () => w.work));
    await s.upload({ path: join(w.work, "report.txt"), title: "T", comment: "see this", altText: "alt" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel_id: "C1", thread_ts: "1.0", filename: "report.txt", title: "T", alt_text: "alt", bytes: "inside" });
    expect(sent[0].initial_comment).toContain("see this");
  });

  test("a file in a subdirectory of the working dir uploads", async () => {
    const w = world();
    mkdirSync(join(w.work, "out"));
    writeFileSync(join(w.work, "out", "a.txt"), "nested");
    const sent: any[] = [];
    await new SlackSurface(fakeClient(sent), binding(async () => w.work)).upload({ path: join(w.work, "out", "a.txt") });
    expect(sent[0].bytes).toBe("nested");
  });

  test("a working dir reached through a symlink still confines by realpath", async () => {
    const w = world();
    const link = join(w.root, "worklink");
    symlinkSync(w.work, link);
    const sent: any[] = [];
    await new SlackSurface(fakeClient(sent), binding(async () => link)).upload({ path: join(w.work, "report.txt") });
    expect(sent).toHaveLength(1);
  });

  test("/proc/self/environ is refused", async () => {
    const w = world();
    const sent: any[] = [];
    await refused(new SlackSurface(fakeClient(sent), binding(async () => w.work)), "/proc/self/environ", "environ", sent);
  });

  test("a file under another directory is refused, and the full path is not in the message", async () => {
    const w = world();
    const sent: any[] = [];
    const p = join(w.other, "secret.txt");
    await refused(new SlackSurface(fakeClient(sent), binding(async () => w.work)), p, "secret.txt", sent);
  });

  test("a sibling whose name shares the working dir prefix is refused", async () => {
    const w = world();
    const sib = join(w.root, "work-evil");
    mkdirSync(sib);
    writeFileSync(join(sib, "x.txt"), "x");
    const sent: any[] = [];
    await refused(new SlackSurface(fakeClient(sent), binding(async () => w.work)), join(sib, "x.txt"), "x.txt", sent);
  });

  test("dot-dot traversal out of the working dir is refused", async () => {
    const w = world();
    const sent: any[] = [];
    await refused(new SlackSurface(fakeClient(sent), binding(async () => w.work)), join(w.work, "..", "other", "secret.txt"), "secret.txt", sent);
  });

  test("a symlink inside the working dir pointing outside is refused", async () => {
    const w = world();
    symlinkSync(join(w.other, "secret.txt"), join(w.work, "link.txt"));
    const sent: any[] = [];
    await refused(new SlackSurface(fakeClient(sent), binding(async () => w.work)), join(w.work, "link.txt"), "link.txt", sent);
  });

  test("a symlinked directory inside the working dir pointing outside is refused", async () => {
    const w = world();
    symlinkSync(w.other, join(w.work, "dirlink"));
    const sent: any[] = [];
    await refused(new SlackSurface(fakeClient(sent), binding(async () => w.work)), join(w.work, "dirlink", "secret.txt"), "secret.txt", sent);
  });

  test("a symlink inside the working dir pointing inside uploads", async () => {
    const w = world();
    symlinkSync(join(w.work, "report.txt"), join(w.work, "alias.txt"));
    const sent: any[] = [];
    await new SlackSurface(fakeClient(sent), binding(async () => w.work)).upload({ path: join(w.work, "alias.txt") });
    expect(sent).toHaveLength(1);
    expect(sent[0].bytes).toBe("inside");
  });

  test("a directory is refused", async () => {
    const w = world();
    mkdirSync(join(w.work, "sub"));
    const sent: any[] = [];
    await refused(new SlackSurface(fakeClient(sent), binding(async () => w.work)), join(w.work, "sub"), "sub", sent);
  });

  test("a FIFO is refused without blocking", async () => {
    const w = world();
    const fifo = join(w.work, "pipe");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const sent: any[] = [];
    await refused(new SlackSurface(fakeClient(sent), binding(async () => w.work)), fifo, "pipe", sent);
  });

  test("a device is refused (inside a working dir that is /dev)", async () => {
    const sent: any[] = [];
    await refused(new SlackSurface(fakeClient(sent), binding(async () => "/dev")), "/dev/null", "null", sent);
  });

  test("a relative path is refused", async () => {
    const w = world();
    const sent: any[] = [];
    await refused(new SlackSurface(fakeClient(sent), binding(async () => w.work)), "report.txt", "report.txt", sent);
  });

  test("a missing file is refused with the same message", async () => {
    const w = world();
    const sent: any[] = [];
    await refused(new SlackSurface(fakeClient(sent), binding(async () => w.work)), join(w.work, "nope.txt"), "nope.txt", sent);
  });

  test("an unknown working dir refuses (fail closed): none bound, undefined, or a throwing lookup", async () => {
    const w = world();
    const p = join(w.work, "report.txt");
    for (const wd of [undefined, async () => undefined, async () => { throw new Error("db down"); }, async () => join(w.root, "gone")]) {
      const sent: any[] = [];
      await refused(new SlackSurface(fakeClient(sent), binding(wd as any)), p, "report.txt", sent);
    }
  });

  test("the surface tool returns the refusal as a tool error with the exact text", async () => {
    const w = world();
    const sent: any[] = [];
    const defs = surfaceTools(new SlackSurface(fakeClient(sent), binding(async () => w.work)));
    const up = defs.find((d) => d.name === "upload")!;
    const bad = await up.handler({ path: join(w.other, "secret.txt") });
    expect((bad as any).isError).toBe(true);
    expect(bad.content[0]!.text).toBe(REFUSAL("secret.txt"));
    const good = await up.handler({ path: join(w.work, "report.txt") });
    expect((good as any).isError).toBeUndefined();
    expect(good.content[0]!.text).toBe("uploaded");
  });
});
