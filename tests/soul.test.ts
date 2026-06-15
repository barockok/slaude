import { describe, expect, test, beforeEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { paths } from "../src/config/home";
import {
  loadSoul,
  soulSystemBlock,
  loadApprovers,
  loadApproverEntries,
  selectApprovers,
} from "../src/soul/loader";

beforeEach(() => {
  if (existsSync(paths.soul)) unlinkSync(paths.soul);
});

describe("loadSoul", () => {
  test("seeds starter persona when missing", () => {
    const out = loadSoul();
    expect(out).toContain("# Persona");
    expect(existsSync(paths.soul)).toBe(true);
  });
  test("returns existing file unchanged", () => {
    writeFileSync(paths.soul, "# Custom Persona\n");
    expect(loadSoul()).toBe("# Custom Persona\n");
  });
});

describe("soulSystemBlock", () => {
  test("composes runtime baseline + persona", () => {
    const block = soulSystemBlock("# Hi");
    expect(block).toContain("<runtime-baseline>");
    expect(block).toContain("<persona>\n# Hi\n</persona>");
  });
  test("uses loadSoul fallback when no overlay", () => {
    writeFileSync(paths.soul, "# X");
    const block = soulSystemBlock();
    expect(block).toContain("<persona>\n# X\n</persona>");
  });
});

describe("loadApprovers (legacy)", () => {
  test("returns null when no approvers section", () => {
    writeFileSync(paths.soul, "# Persona\n\nNothing here.\n");
    expect(loadApprovers()).toBeNull();
  });
  test("parses 'category: ids'", () => {
    writeFileSync(
      paths.soul,
      [
        "# Persona",
        "## Approvers",
        "- code: <@U06ENBS6PV0> <@U06ENBS6PV1>  ; comment",
        "- database = U06DB00001, U06DB00002",
        "- bogus line",
      ].join("\n"),
    );
    const out = loadApprovers();
    expect(out).toEqual({
      code: ["U06ENBS6PV0", "U06ENBS6PV1"],
      database: ["U06DB00001", "U06DB00002"],
    });
  });
  test("parses fenced JSON form", () => {
    writeFileSync(
      paths.soul,
      ["# Persona", "```approvers", '{"code": ["U1"], "default": ["U2"], "drop": [1, "U3"]}', "```"].join("\n"),
    );
    const out = loadApprovers();
    expect(out).toEqual({ code: ["U1"], default: ["U2"], drop: ["U3"] });
  });
  test("malformed JSON falls through to markdown parser, returns null if no md", () => {
    writeFileSync(
      paths.soul,
      ["# Persona", "```approvers", "{not json", "```"].join("\n"),
    );
    expect(loadApprovers()).toBeNull();
  });
  test("markdown section terminated by next heading", () => {
    writeFileSync(
      paths.soul,
      [
        "# Persona",
        "## Approvers",
        "- code: U06ENBS6PV0",
        "## Notes",
        "- default: U06ENBS6PV9",
      ].join("\n"),
    );
    const out = loadApprovers();
    expect(out).toEqual({ code: ["U06ENBS6PV0"] });
  });
});

describe("loadApproverEntries + selectApprovers", () => {
  test("scope-described entries match by token overlap", () => {
    writeFileSync(
      paths.soul,
      [
        "# Persona",
        "## Approvers",
        "- <@U001>: anything ; catchall",
        "- <@U002>: database migrations, schema changes, SQL",
        "- <@U003>: production deploys, infra, kubernetes",
      ].join("\n"),
    );
    const entries = loadApproverEntries();
    expect(entries?.length).toBe(3);
    expect(entries?.[0]?.catchall).toBe(true);

    const dbHit = selectApprovers("Run a schema migration on prod", "database");
    expect(dbHit).toContain("U001"); // catchall
    expect(dbHit).toContain("U002");
    expect(dbHit).not.toContain("U003");

    const deployHit = selectApprovers("Deploy a new kubernetes ingress");
    expect(deployHit).toContain("U001");
    expect(deployHit).toContain("U003");
    expect(deployHit).not.toContain("U002");
  });

  test("no match returns all entries (better than blocking)", () => {
    writeFileSync(
      paths.soul,
      [
        "# Persona",
        "## Approvers",
        "- <@U002>: database migrations only",
      ].join("\n"),
    );
    const out = selectApprovers("send a tweet about lunch");
    expect(out).toEqual(["U002"]);
  });

  test("empty section / no entries → null", () => {
    writeFileSync(paths.soul, "# Persona\n## Other\n");
    expect(loadApproverEntries()).toBeNull();
    expect(selectApprovers("anything")).toEqual([]);
  });

  test("section terminated by next heading", () => {
    writeFileSync(
      paths.soul,
      [
        "# Persona",
        "## Approvers",
        "- <@U001>: anything",
        "## Notes",
        "- <@U999>: ignored",
      ].join("\n"),
    );
    const entries = loadApproverEntries();
    expect(entries?.length).toBe(1);
    expect(entries?.[0]?.userId).toBe("U001");
  });

  test("raw user IDs (no <@>) supported", () => {
    writeFileSync(
      paths.soul,
      ["# Persona", "## Approvers", "- U06ENBS6PV0: anything"].join("\n"),
    );
    const out = selectApprovers("anything");
    expect(out).toEqual(["U06ENBS6PV0"]);
  });

  test("baseline names kb_memoize as the one write path, not the raw//ingest flow", () => {
    const block = soulSystemBlock();
    expect(block).toMatch(/kb_memoize/);
    expect(block).toMatch(/ONE write path/);
    // the pre-gbrain raw/→/ingest write path is dormant — the baseline must not
    // STEER the agent to it (the corrective text may still name it to forbid it).
    expect(block).not.toMatch(/owned by the ingest workflow/);
    expect(block).not.toMatch(/To synthesise/);
    expect(block).not.toMatch(/dropping new `raw\//);
  });

  test("baseline forbids papering over a failed brain write", () => {
    const block = soulSystemBlock();
    expect(block).toMatch(/failed brain write is a failure/i);
    expect(block).toMatch(/did not land/i);
  });

  test("line without colon skipped", () => {
    writeFileSync(
      paths.soul,
      ["# Persona", "## Approvers", "- U06ENBS6PV0", "- <@U002>: anything"].join("\n"),
    );
    const entries = loadApproverEntries();
    expect(entries?.map((e) => e.userId)).toEqual(["U002"]);
  });
});
