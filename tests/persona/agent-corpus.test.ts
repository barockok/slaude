import { describe, expect, test } from "bun:test";
import { parseAgentYaml } from "../../src/persona/agent-def";
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
      try {
        parseAgentYaml(CORPUS_DIR, c.yaml);
      } catch (e) {
        thrown = e;
      }
      if (c.ok) {
        expect(thrown).toBeUndefined();
      } else {
        expect(thrown).toBeInstanceOf(Error);
      }
    });
  }

  test("no refusal echoes a value from the input", () => {
    const secret = "secret value 9f3";
    for (const yaml of [
      `name: ana\nsoul: x\naccess:\n  manager: ${secret}\n`,
      `name: ana\nsoul: x\n${secret}: 1\n`,
      `name: ana\nsoul: x\nchannels:\n  ${secret}: {}\n`,
      `name: ana\nsoul: x\nmandate:\n  scoped:\n    - { boundary: ${secret}, text: x }\n`,
      `name: ana\nsoul: x\nchannels:\n  C0EXAMPLE:\n    session: ${secret}\n`,
      `name: ana\nsoul: x\nskills: [${secret}]\n`,
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
