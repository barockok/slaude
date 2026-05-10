import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAttachments } from "../src/gateway/slack/attachments";

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("downloadAttachments", () => {
  test("empty list short-circuits", async () => {
    const out = await downloadAttachments({
      files: [],
      botToken: "x",
      workingDir: "/tmp",
      inboundTs: "1.0",
    });
    expect(out).toEqual([]);
  });

  test("downloads + sanitizes filenames", async () => {
    const work = mkdtempSync(join(tmpdir(), "attach-"));
    try {
      globalThis.fetch = (async (url: any, opts: any) => {
        expect(opts.headers.Authorization).toBe("Bearer T");
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("hello"));
            c.close();
          },
        });
        return new Response(stream, { status: 200 });
      }) as any;

      const out = await downloadAttachments({
        files: [
          {
            id: "F1",
            name: "weird name with spaces.txt",
            mimetype: "text/plain",
            size: 5,
            url_private_download: "https://files.slack.com/x",
          },
        ],
        botToken: "T",
        workingDir: work,
        inboundTs: "TS1",
      });

      expect(out.length).toBe(1);
      expect(out[0]?.name).toBe("weird_name_with_spaces.txt");
      expect(existsSync(out[0]!.path)).toBe(true);
      expect(readFileSync(out[0]!.path, "utf8")).toBe("hello");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("no url → skipped", async () => {
    const work = mkdtempSync(join(tmpdir(), "attach-"));
    const out = await downloadAttachments({
      files: [{ id: "F2" }],
      botToken: "T",
      workingDir: work,
      inboundTs: "TS",
    });
    expect(out).toEqual([]);
  });

  test("non-OK response logged + skipped", async () => {
    const work = mkdtempSync(join(tmpdir(), "attach-"));
    globalThis.fetch = (async () =>
      new Response("nope", { status: 403 })) as any;
    const out = await downloadAttachments({
      files: [{ id: "F3", url_private: "https://x" }],
      botToken: "T",
      workingDir: work,
      inboundTs: "TS",
    });
    expect(out).toEqual([]);
  });

  test("fetch throws → caught, no result", async () => {
    const work = mkdtempSync(join(tmpdir(), "attach-"));
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as any;
    const out = await downloadAttachments({
      files: [{ id: "F4", url_private: "https://x" }],
      botToken: "T",
      workingDir: work,
      inboundTs: "TS",
    });
    expect(out).toEqual([]);
  });

  test("fallback names — id + filetype", async () => {
    const work = mkdtempSync(join(tmpdir(), "attach-"));
    globalThis.fetch = (async () => {
      const s = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("x"));
          c.close();
        },
      });
      return new Response(s, { status: 200 });
    }) as any;
    const out = await downloadAttachments({
      files: [{ id: "F5", filetype: "png", url_private: "https://x" }],
      botToken: "T",
      workingDir: work,
      inboundTs: "TS",
    });
    expect(out[0]?.name).toBe("F5.png");
  });
});
