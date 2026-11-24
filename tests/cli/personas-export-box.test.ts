/**
 * `personas export` and the `box` key: a persona that names a box keeps the
 * name in its exported agent.yaml, and is refused in the files format, which
 * has no key for it. Exporting without the key would turn a boxed agent into
 * an unboxed one at the next deploy.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { exportAgentYaml, exportHome, renderDir } from "../../src/cli/personas";
import { SoulDataSchema } from "../../src/soul/data";

const meta = { revision: "r1", committedAt: "2026-11-24T10:00:00Z" };
const soul = "# Persona\n## Identity\n- Name: Ana\n";
const extracted = SoulDataSchema.parse({ identity: { name: "Ana", role: "Support", voice: "terse" } });
const extract = async () => extracted;

/** A $SLAUDE_HOME with one named persona; `cfg` is added to its config.json. */
function home(cfg: Record<string, unknown>, agentYaml?: string): string {
  const h = mkdtempSync(join(tmpdir(), "slaude-box-export-"));
  writeFileSync(join(h, "SOUL.md"), "default soul\n");
  mkdirSync(join(h, "personas", "ana"), { recursive: true });
  writeFileSync(join(h, "personas", "ana", "SOUL.md"), soul);
  writeFileSync(join(h, "personas", "ana", "config.json"), JSON.stringify({ slackUserId: "UTESTUSER1", ...cfg }));
  if (agentYaml !== undefined) writeFileSync(join(h, "personas", "ana", "agent.yaml"), agentYaml);
  return h;
}
const out = () => mkdtempSync(join(tmpdir(), "slaude-box-export-out-"));
async function exported(h: string): Promise<{ o: string; doc: Record<string, unknown> }> {
  const o = out();
  await exportAgentYaml(h, o, { extract });
  return { o, doc: parseYaml(readFileSync(join(o, "personas", "ana", "agent.yaml"), "utf8")) as Record<string, unknown> };
}
async function err(fn: () => unknown): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

describe("personas export carries the box key", () => {
  test("agent-yaml: a box named in config.json is written, and the file compiles with it", async () => {
    const { o, doc } = await exported(home({ box: "ruby-dev" }));
    expect(doc.box).toBe("ruby-dev");
    const ana = renderDir(o, meta).personas.find((p) => p.name === "ana")!;
    expect((ana as { definition?: { box?: string } }).definition!.box).toBe("ruby-dev");
  });

  test("agent-yaml: a box named in an agent.yaml beside the soul is carried too; config.json wins", async () => {
    expect((await exported(home({}, "name: ana\nbox: py-dev # the python box\n"))).doc.box).toBe("py-dev");
    expect((await exported(home({ box: "ruby-dev" }, 'name: ana\nbox: "py-dev"\n'))).doc.box).toBe("ruby-dev");
  });

  test("no box key: none is written", async () => {
    expect("box" in (await exported(home({}))).doc).toBe(false);
  });

  test("a value that is not a box name is refused, and never echoed", async () => {
    const e = await err(() => exportAgentYaml(home({ box: "Ruby Dev; not a name" }), out(), { extract }));
    expect(e.message).toBe("persona 'ana': its box key is not a valid box name");
    expect((await err(() => exportAgentYaml(home({ box: 7 }), out(), { extract }))).message).toContain("not a valid box name");
  });

  test("files format: persona.yaml has no box key, so a boxed persona is refused rather than exported unboxed", async () => {
    const e = await err(() => exportHome(home({ box: "ruby-dev" }), out()));
    expect(e.message).toBe("persona 'ana': has a box key, which persona.yaml cannot carry; export it with --format agent-yaml");
    expect(() => exportHome(home({}), out())).not.toThrow();
  });
});
