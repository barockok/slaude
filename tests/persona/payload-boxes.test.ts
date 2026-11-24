/**
 * Payload version 8: a top-level `boxes` list and `definition.box`. A payload
 * that carries neither stays at its old version and deploys to an older gateway.
 */
import { describe, expect, test } from "bun:test";
import { BOX_PAYLOAD_VERSION, PayloadError, SUPPORTED_PAYLOAD_VERSION, parsePayload, payloadVersionFor } from "../../src/persona/sync/payload";
import { parseAgentYaml } from "../../src/persona/agent-def";
import { defaultBoxPolicy } from "../../src/box/policy";

const DIGEST = "sha256:" + "a".repeat(64);
const REF = `ghcr.io/example/boxes/ruby-dev@${DIGEST}`;
const box = (over: Record<string, unknown> = {}) => ({ name: "ruby-dev", image: REF, ...over });

const compile = (extra: string) => parseAgentYaml("ana", `name: ana\nslackUserId: slack:user:UTESTUSER1\nsoul: You are Ana.\n${extra}`);
const plain = compile("").spec;
const boxed = compile("box: ruby-dev\n").spec;
const body = (version: number, personas: object[], extra: object = {}) => ({ version, revision: "r1", committedAt: "2026-11-24T10:00:00Z", personas, ...extra });

describe("agent.yaml box key", () => {
  test("a box name is carried in the definition; without the key nothing is", () => {
    expect(boxed.definition.box).toBe("ruby-dev");
    expect(Object.hasOwn(plain.definition, "box")).toBe(false);
    expect(Object.hasOwn(compile("box:\n").spec.definition, "box")).toBe(false);
  });

  test("anything that is not a plain box name is refused, naming the key", () => {
    for (const bad of ["box: Ruby_Dev\n", "box: env:ruby-dev\n", "box: [ruby-dev]\n", "box:\n  image: x\n", "box: 3\n"]) {
      let msg = "";
      try {
        compile(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(PayloadError);
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/persona 'ana': agent\.yaml box must be a box name/);
    }
  });
});

describe("payload version 8", () => {
  test("this gateway supports version 8", () => {
    expect(SUPPORTED_PAYLOAD_VERSION).toBe(8);
    expect(BOX_PAYLOAD_VERSION).toBe(8);
  });

  test("the version rises to 8 only when boxes are present", () => {
    expect(payloadVersionFor([plain])).toBe(6);
    expect(payloadVersionFor([plain], [], undefined, undefined)).toBe(6);
    expect(payloadVersionFor([plain], [], [])).toBe(7);
    expect(payloadVersionFor([boxed])).toBe(8);
    expect(payloadVersionFor([plain], [], undefined, [box()])).toBe(8);
    // An empty list is the whole set too: it removes every box.
    expect(payloadVersionFor([plain], [], undefined, [])).toBe(8);
  });

  test("a payload without boxes still parses at its old version, with no boxes field", () => {
    const p = parsePayload(body(6, [plain]));
    expect(p.version).toBe(6);
    expect(Object.hasOwn(p, "boxes")).toBe(false);
  });

  test("boxes are parsed into validated definitions with their defaults", () => {
    const p = parsePayload(body(8, [boxed], { boxes: [box({ egress: { allow: ["pypi.org", "github.com"] } })] }));
    expect(p.boxes).toHaveLength(1);
    const b = p.boxes![0]!;
    expect(b.name).toBe("ruby-dev");
    expect(b.digest).toBe(DIGEST);
    expect(b.policy).toEqual({ ...defaultBoxPolicy(), egress: { allow: ["github.com", "pypi.org"], deny: [] } });
    expect(p.personas[0]!.definition!.box).toBe("ruby-dev");
    expect(parsePayload(body(8, [plain], { boxes: [] })).boxes).toEqual([]);
  });

  test("boxes and definition.box need version 8", () => {
    expect(() => parsePayload(body(7, [plain], { boxes: [] }))).toThrow(/boxes need payload version 8 \(this payload says 7\)/);
    expect(() => parsePayload(body(7, [boxed]))).toThrow(/boxes need payload version 8/);
    expect(() => parsePayload({ revision: "r1", committedAt: "2026-11-24T10:00:00Z", personas: [boxed] })).toThrow(/boxes need payload version 8 \(this payload says 1\)/);
  });

  test("a gateway one version behind refuses a version 8 payload instead of dropping its boxes", () => {
    expect(() => parsePayload(body(8, [boxed], { boxes: [box()] }), { supportedVersion: 7 })).toThrow(/payload version 8 is newer than this gateway supports \(7\)/);
  });

  test("a bad entry, a duplicate and too many are refused; a value is never echoed", () => {
    expect(() => parsePayload(body(8, [plain], { boxes: [box(), box()] }))).toThrow(/duplicate box 'ruby-dev'/);
    expect(() => parsePayload(body(8, [plain], { boxes: [box({ image: "ghcr.io/example/boxes/ruby-dev:latest" })] }))).toThrow(/box 'ruby-dev': image must be/);
    expect(() => parsePayload(body(8, [plain], { boxes: ["ruby-dev"] }))).toThrow(/box '<invalid-name>': must be a mapping/);
    expect(() => parsePayload(body(8, [plain], { boxes: Array.from({ length: 65 }, (_, i) => box({ name: `b${i}` })) }))).toThrow(/at most 64 boxes/);
    const value = "Bearer abcdefghijklmnopqrstuvwx";
    let msg = "";
    try {
      parsePayload(body(8, [plain], { boxes: [box({ env: { SETTING: value } })] }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/box 'ruby-dev': env\.SETTING looks like a credential/);
    expect(msg).not.toContain(value);
    expect(() => parsePayload(body(8, [plain], { boxes: [box({ env: { A: "${PERSONA_X}" } })] }))).toThrow(/env\.A contains \$\{/);
    expect(() => parsePayload(body(8, [{ ...boxed, definition: { ...boxed.definition, box: "Bad Name" } }]))).toThrow(PayloadError);
  });
});
