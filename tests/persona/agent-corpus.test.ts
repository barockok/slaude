import { describe, expect, test } from "bun:test";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { PayloadError } from "../../src/persona/sync/payload";
import { CORPUS, CORPUS_DIR } from "./agent-corpus";

/**
 * Pins what the agent.yaml validator accepts and refuses. A refused input that
 * becomes accepted fails here, whatever the validator is built on.
 */
describe("agent.yaml corpus", () => {
  test("the corpus covers every nesting level and kind of mistake", () => {
    expect(CORPUS.length).toBeGreaterThan(200);
    expect(CORPUS.filter((c) => !c.ok).length).toBeGreaterThan(120);
  });

  for (const c of CORPUS) {
    test(`${c.ok ? "accepts" : "refuses"}: ${c.id}`, () => {
      let thrown: unknown;
      let compiled: ReturnType<typeof parseAgentYaml> | undefined;
      try {
        compiled = parseAgentYaml(CORPUS_DIR, c.yaml);
      } catch (e) {
        thrown = e;
      }
      if (c.ok) {
        expect(thrown).toBeUndefined();
        if (c.warns) {
          const ws = compiled!.warnings.filter((w) => !w.includes("soul has a"));
          expect(ws).toHaveLength(c.warns.length);
          c.warns.forEach((p) => expect(ws.filter((w) => w.includes(` ${p} `))).toHaveLength(1));
          // A warning names the field, never the value (a channels key is its own path).
          for (const w of ws) if (!w.includes(" channels.")) expect(w).not.toMatch(/[CUWG]0EXAMPLE/);
        }
      } else {
        expect(thrown).toBeInstanceOf(PayloadError);
        for (const m of c.msgs ?? []) expect((thrown as Error).message).toContain(m);
      }
    });
  }

  test("a channels key that is not a Slack channel id or reference is never named in a path or warning", () => {
    const secret = "grp-secret-9f3";
    for (const key of [`whatsapp:group:${secret}`, `boundary:${secret}`, `${secret}`]) {
      let msg = "";
      try {
        parseAgentYaml(CORPUS_DIR, `name: ana\nsoul: x\nchannels:\n  "${key}": {}\n`);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toBe("");
      expect(msg).not.toContain(secret);
    }
  });

  test("no refusal echoes a value from the input", () => {
    const secret = "secret value 9f3";
    for (const yaml of [
      `name: ana\nsoul: x\naccess:\n  manager: ${secret}\n`,
      `name: ana\nsoul: x\n${secret}: 1\n`,
      `name: ana\nsoul: x\nchannels:\n  ${secret}: {}\n`,
      `name: ana\nsoul: x\nmandate:\n  scoped:\n    - { boundary: ${secret}, text: x }\n`,
      `name: ana\nsoul: x\nchannels:\n  C0EXAMPLE:\n    session: ${secret}\n`,
      `name: ana\nsoul: x\nskills: [${secret}]\n`,
      `name: ana\nsoul: x\naccess:\n  manager: slack:user:${secret}\n`,
      `name: ana\nsoul: x\naccess:\n  dm: [email:${secret}@nodot]\n`,
      `name: ana\nsoul: x\nslackUserId: email:${secret}@example.com\n`,
      `name: ana\nsoul: x\nmandate:\n  scoped:\n    - { boundary: "slack:channel:${secret}", text: x }\n`,
      `name: ana\nsoul: x\nchannels:\n  "slack:channel:${secret}": {}\n`,
      `name: ana\nsoul: ${secret}\naccess:\n  approvalTimeoutSeconds: ${secret}\n`,
    ]) {
      let msg = "";
      try {
        parseAgentYaml(CORPUS_DIR, yaml);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toBe("");
      expect(msg).not.toContain(secret);
    }
  });
});
