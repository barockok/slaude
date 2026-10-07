import { describe, expect, test } from "bun:test";
import { agentSourceForPersona, isAgentLike, remapSource, validateMap } from "../../src/brain-migrate/remap";

const AGENT = agentSourceForPersona("UTESTUSER1"); // agent-utestuser1

describe("remapSource", () => {
  test("agent-like sources go to the persona's agent slice", () => {
    for (const s of ["agent", "agent-default", "agent-u0old"]) {
      expect(remapSource(s, { agentSource: AGENT })).toEqual({ ok: true, target: AGENT });
    }
  });
  test("target equals the slice the gateway reads (sanitised id)", () => {
    expect(agentSourceForPersona("UANA-1x")).toBe("agent-uana1x");
  });
  test("user, shared and public are unchanged", () => {
    for (const s of ["user-ualice", "shared", "public"]) {
      expect(remapSource(s, { agentSource: AGENT })).toEqual({ ok: true, target: s });
    }
  });
  test("kb-* is out of scope, anything else has no mapping", () => {
    expect(remapSource("kb-bulk-corpus", { agentSource: AGENT })).toEqual({ ok: false, code: "kb_out_of_scope", source: "kb-bulk-corpus" });
    expect(remapSource("scratch", { agentSource: AGENT })).toEqual({ ok: false, code: "no_mapping", source: "scratch" });
  });
  test("a map entry wins over the table for the source it names", () => {
    expect(remapSource("scratch", { agentSource: AGENT, map: { scratch: "shared" } })).toEqual({ ok: true, target: "shared" });
    expect(remapSource("shared", { agentSource: AGENT, map: { shared: "public" } })).toEqual({ ok: true, target: "public" });
  });
  test("a kb-* source is refused even when the map names it", () => {
    expect(remapSource("kb-bulk-corpus", { agentSource: AGENT, map: { "kb-bulk-corpus": "shared" } })).toEqual({ ok: false, code: "kb_out_of_scope", source: "kb-bulk-corpus" });
  });
  test("the map is read by own property only", () => {
    for (const s of ["constructor", "toString", "__proto__"]) {
      expect(remapSource(s, { agentSource: AGENT, map: {} })).toEqual({ ok: false, code: "no_mapping", source: s });
    }
  });
  test("a map into kb-* or another persona's agent slice is forbidden", () => {
    expect(remapSource("scratch", { agentSource: AGENT, map: { scratch: "kb-x" } })).toMatchObject({ ok: false, code: "forbidden_target" });
    expect(remapSource("scratch", { agentSource: AGENT, map: { scratch: "agent-uother" } })).toMatchObject({ ok: false, code: "forbidden_target" });
  });
});

describe("validateMap / isAgentLike", () => {
  test("validateMap names the bad entry and never anything else", () => {
    expect(validateMap({ a: "shared" }, AGENT)).toBeNull();
    expect(validateMap({ a: "kb-x" }, AGENT)).toMatch(/kb-x/);
    expect(validateMap({ a: "agent-uother" }, AGENT)).toMatch(/agent-uother/);
  });
  test("isAgentLike", () => {
    expect(isAgentLike("agent")).toBe(true);
    expect(isAgentLike("agent-x")).toBe(true);
    expect(isAgentLike("agents")).toBe(false);
    expect(isAgentLike("user-agent")).toBe(false);
  });
});
