import { describe, test, expect, beforeEach, mock } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths, SLAUDE_HOME } from "../src/config/home";
import { db } from "../src/db/schema";
import * as ingest from "../src/knowledge/ingest";

beforeEach(() => {
  db.run("DELETE FROM kb_ingest_jobs");
  if (existsSync(paths.knowledge)) rmSync(paths.knowledge, { recursive: true, force: true });
  mkdirSync(paths.knowledge, { recursive: true });
});

describe("ingest", () => {
  test("rejects when no slaude_knowledge declared in manifest", async () => {
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify({ plugins: [], skills: [], knowledge: [] }));
    const r = await ingest.run({ triggeredBy: "U123" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/slaude_knowledge/i);
  });

  test("rejects when another ingest is running", async () => {
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify({
      slaude_knowledge: { label: "wiki", git: "x", ref: "main" },
    }));
    mkdirSync(join(paths.knowledge, "wiki"), { recursive: true });
    db.run("INSERT INTO kb_ingest_jobs VALUES ('existing', 'wiki', 'running', 'U999', ?, ?)", [Date.now(), Date.now()]);
    const r = await ingest.run({ triggeredBy: "U123" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already running/i);
  });

  test("happy path: acquires lock, runs sub-query, releases lock", async () => {
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify({
      slaude_knowledge: { label: "wiki", git: "https://example.com/wiki.git", ref: "main" },
    }));
    const kbDir = join(paths.knowledge, "wiki");
    mkdirSync(join(kbDir, "raw"), { recursive: true });
    writeFileSync(join(kbDir, "README.md"), "# wiki schema\nIngest workflow: read raw/, write to wiki/.\n");
    writeFileSync(join(kbDir, "raw", "note-1.md"), "captured note\n");

    const subqueryMock = mock(async () => ({ turns: 3, pages_changed: 2 }));
    const pushMock = mock(async () => ({ sha: "f".repeat(40) }));
    const r = await ingest.run({
      triggeredBy: "U123",
      _runSubQuery: subqueryMock,
      _pushWiki: pushMock,
    });
    expect(r.ok).toBe(true);
    expect(subqueryMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);

    const remaining = db.query("SELECT status FROM kb_ingest_jobs WHERE status='running'").all();
    expect(remaining.length).toBe(0);
  });

  test("rejects with invalid slaude.json", async () => {
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), "{not-json");
    const r = await ingest.run({ triggeredBy: "U123" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid slaude\.json/);
  });

  test("rejects when KB dir does not exist", async () => {
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify({
      slaude_knowledge: { label: "missing", git: "x", ref: "main" },
    }));
    const r = await ingest.run({ triggeredBy: "U123" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not exist/);
  });

  test("releases lock and returns error on sub-query failure", async () => {
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify({
      slaude_knowledge: { label: "wiki", git: "x", ref: "main" },
    }));
    const kbDir = join(paths.knowledge, "wiki");
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "README.md"), "# wiki\n");

    const r = await ingest.run({
      triggeredBy: "U123",
      _runSubQuery: mock(async () => { throw new Error("subq failed"); }),
      _pushWiki: mock(async () => ({ sha: "f".repeat(40) })),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/subq failed/);
    const remaining = db.query("SELECT status FROM kb_ingest_jobs WHERE status='running'").all();
    expect(remaining.length).toBe(0);
  });

  test("defaultPushWiki pushes raw/ and wiki/ to git", async () => {
    const { execSync } = await import("node:child_process");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const bareDir = mkdtempSync(join(tmpdir(), "slaude-ingest-bare-"));
    try {
      execSync(`git init --bare -b main "${bareDir}"`, { stdio: "pipe" });
      writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify({
        slaude_knowledge: { label: "wiki", git: bareDir, ref: "main" },
      }));
      const kbDir = join(paths.knowledge, "wiki");
      mkdirSync(join(kbDir, "raw"), { recursive: true });
      mkdirSync(join(kbDir, "wiki"), { recursive: true });
      writeFileSync(join(kbDir, "README.md"), "# wiki\n");
      writeFileSync(join(kbDir, "raw", "note.md"), "raw note\n");
      writeFileSync(join(kbDir, "wiki", "page.md"), "wiki page\n");

      const r = await ingest.run({
        triggeredBy: "U123",
        _runSubQuery: mock(async () => ({ turns: 1, pages_changed: 1 })),
      });
      expect(r.ok).toBe(true);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  test("invalid lockfile is silently reset during ingest", async () => {
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify({
      slaude_knowledge: { label: "wiki", git: "https://example.com/wiki.git", ref: "main" },
    }));
    writeFileSync(join(SLAUDE_HOME, "slaude.lock"), "{not-json");
    const kbDir = join(paths.knowledge, "wiki");
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "README.md"), "# wiki\n");

    const r = await ingest.run({
      triggeredBy: "U123",
      _runSubQuery: mock(async () => ({ turns: 1, pages_changed: 1 })),
      _pushWiki: mock(async () => ({ sha: "f".repeat(40) })),
    });
    expect(r.ok).toBe(true);
    const lock = JSON.parse(readFileSync(join(SLAUDE_HOME, "slaude.lock"), "utf8"));
    expect(lock.version).toBe(1);
  });

  test("defaultRunSubQuery counts turns and page changes", async () => {
    const { defaultRunSubQuery } = await import("../src/knowledge/ingest");
    const kbDir = join(paths.knowledge, "wiki");
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "README.md"), "# schema\n");
    const mockQuery = () =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 1));
        yield { type: "result" };
        await new Promise((r) => setTimeout(r, 1));
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Write", input: {} },
              { type: "tool_use", name: "Edit", input: {} },
            ],
          },
        };
        await new Promise((r) => setTimeout(r, 1));
        yield { type: "result" };
      })() as any;
    const result = await defaultRunSubQuery({ kbDir, readme: "# schema", rawFiles: ["a.md"] }, mockQuery);
    expect(result.turns).toBe(2);
    expect(result.pages_changed).toBe(2);
  });

  test("defaultRunSubQuery with passthrough query covers inner generator", async () => {
    const { mock: bunMock } = await import("bun:test");
    bunMock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: ({ prompt }: any) => prompt,
    }));
    const { defaultRunSubQuery } = await import("../src/knowledge/ingest");
    const kbDir = join(paths.knowledge, "wiki");
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "README.md"), "# schema\n");
    const result = await defaultRunSubQuery({ kbDir, readme: "# schema", rawFiles: ["a.md"] });
    expect(result.turns).toBe(0);
    expect(result.pages_changed).toBe(0);
  });
});
