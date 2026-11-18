import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadInboundFiles, stageForNodes } from "../../src/gateway/slack/attachments-remote";
import { LocalObjectStore, drainInbox, listAll, putInbox, resetObjectStore, wsUnitId, type ObjectStore } from "../../src/storage";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(join(tmpdir(), `slaude-att-${n}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const downloaded = (stage: string, ts: string, name: string, text: string) => {
  const dir = join(stage, "attachments", ts);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return { id: `F-${name}`, name, path, mimetype: "text/plain", size: text.length };
};

describe("attachments for a node that owns the working directory", () => {
  test("files are staged under their working-directory path and reported there", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const stage = tmp("stage");
    const workingDir = "/data/workspaces/T1-C1-1700000000.000100";
    const f = downloaded(stage, "1700000001.000200", "report.txt", "hello");
    const out = await stageForNodes({ store, files: [f], stageDir: stage, workingDir });
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe(`${workingDir}/attachments/1700000001.000200/report.txt`);
    expect(out[0]!.name).toBe("report.txt");

    // The node that takes the session writes it where the agent was told it is.
    const nodeDir = tmp("nodews");
    expect(await drainInbox(store, wsUnitId(workingDir), nodeDir)).toBe(1);
    expect(readFileSync(join(nodeDir, "attachments", "1700000001.000200", "report.txt"), "utf8")).toBe("hello");
  });

  test("a file that cannot be staged is left out, so the agent is never pointed at a missing path", async () => {
    const good = new LocalObjectStore(tmp("store"));
    const failing: ObjectStore = {
      get: (k, o) => good.get(k, o),
      head: (k) => good.head(k),
      list: (p, o) => good.list(p, o),
      delete: (k) => good.delete(k),
      put: async (k, b) => {
        if (k.endsWith("bad.txt")) throw new Error("store refused it");
        return good.put(k, b);
      },
    };
    const stage = tmp("stage");
    const workingDir = "/data/workspaces/T1-C1-1";
    const files = [downloaded(stage, "1.1", "ok.txt", "a"), downloaded(stage, "1.1", "bad.txt", "b")];
    const out = await stageForNodes({ store: failing, files, stageDir: stage, workingDir });
    expect(out.map((f) => f.name)).toEqual(["ok.txt"]);
    expect((await listAll(good, "inbox/")).map((o) => o.key.split("/").pop())).toEqual(["ok.txt"]);
  });

  describe("downloadInboundFiles", () => {
    const realFetch = globalThis.fetch;
    const saved = { role: process.env.SLAUDE_ROLE, storage: process.env.SLAUDE_STORAGE, local: process.env.SLAUDE_STORAGE_LOCAL_DIR };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    afterAll(() => {
      globalThis.fetch = realFetch;
      restore("SLAUDE_ROLE", saved.role);
      restore("SLAUDE_STORAGE", saved.storage);
      restore("SLAUDE_STORAGE_LOCAL_DIR", saved.local);
      resetObjectStore();
    });
    const slackFile = { id: "F1", name: "notes.txt", url_private_download: "https://files.example/notes.txt", mimetype: "text/plain", size: 5 };
    const fakeFetch = () => {
      globalThis.fetch = (async () => new Response("hello")) as unknown as typeof fetch;
    };

    test("without remote storage the file is written into the working directory, as before", async () => {
      fakeFetch();
      delete process.env.SLAUDE_STORAGE;
      resetObjectStore();
      const wd = tmp("wd");
      const got = await downloadInboundFiles({ files: [slackFile], botToken: "t", workingDir: wd, inboundTs: "1.1" });
      expect(got.map((f) => f.path)).toEqual([join(wd, "attachments", "1.1", "notes.txt")]);
      expect(readFileSync(got[0]!.path, "utf8")).toBe("hello");
    });

    test("on a gateway with remote storage the working directory is untouched and the file waits in the inbox", async () => {
      fakeFetch();
      const bucket = tmp("bucket");
      process.env.SLAUDE_ROLE = "gateway";
      process.env.SLAUDE_STORAGE = "s3";
      process.env.SLAUDE_STORAGE_LOCAL_DIR = bucket;
      resetObjectStore();
      const wd = join(tmp("wd-root"), "T1-C1-1700000000.000100"); // never created: the node owns it
      const got = await downloadInboundFiles({ files: [slackFile], botToken: "t", workingDir: wd, inboundTs: "1.1" });
      expect(got.map((f) => f.path)).toEqual([join(wd, "attachments", "1.1", "notes.txt")]);
      expect(existsSync(wd)).toBe(false);
      const store = new LocalObjectStore(bucket);
      expect(await drainInbox(store, wsUnitId(wd), tmp("node"))).toBe(1);
    });
  });

  test("an empty list stages nothing", async () => {
    const store = new LocalObjectStore(tmp("store"));
    expect(await stageForNodes({ store, files: [], stageDir: tmp("stage"), workingDir: "/data/workspaces/x" })).toEqual([]);
  });

  test("putInbox takes an explicit path for a file saved elsewhere, and still refuses an unsafe one", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const elsewhere = tmp("elsewhere");
    writeFileSync(join(elsewhere, "a.bin"), "bytes");
    await putInbox(store, "/data/workspaces/w", join(elsewhere, "a.bin"), "attachments/1.1/a.bin");
    expect((await listAll(store, "inbox/")).map((o) => o.key.split("/").slice(2).join("/"))).toEqual(["attachments/1.1/a.bin"]);
    await expect(putInbox(store, "/data/workspaces/w", join(elsewhere, "a.bin"), "../escape")).rejects.toThrow(/not a safe relative path/);
  });
});
