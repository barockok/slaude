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
});
