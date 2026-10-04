import { describe, expect, test } from "bun:test";
import { SUPPORTED_PAYLOAD_VERSION, unknownFieldPaths, parsePayload, resolvePlaceholders, UnresolvedVarError, PayloadError } from "../../src/persona/sync/payload";

const base = (personas: unknown[]) => ({ revision: "abc123", committedAt: "2026-10-01T10:00:00Z", personas });
const ana = { name: "ana", slackUserId: "UTESTUSER1", soul: "You are Ana.", userToken: "${PERSONA_ANA_XOXP}" };

describe("parsePayload", () => {
  test("accepts a well-formed set and defaults allowEmpty to false", () => {
    expect(parsePayload(base([ana])).allowEmpty).toBe(false);
  });

  test("rejects a name that could escape a directory, or differs only in case", () => {
    for (const name of ["../etc", "Ana", "a/b", "", "-x"]) {
      expect(() => parsePayload(base([{ ...ana, name }]))).toThrow(PayloadError);
    }
  });

  // Review Focus 3: two agents claiming one identity.
  test("rejects duplicate names and duplicate Slack user ids in one payload", () => {
    expect(() => parsePayload(base([ana, { ...ana, slackUserId: "UTESTUSER2" }]))).toThrow(/duplicate persona name/);
    expect(() => parsePayload(base([ana, { ...ana, name: "bea" }]))).toThrow(/duplicate slackUserId/);
  });

  test("only the default persona may omit slackUserId", () => {
    expect(() => parsePayload(base([{ name: "default", soul: "x" }]))).not.toThrow();
    expect(() => parsePayload(base([{ name: "ana", soul: "x" }]))).toThrow(/slackUserId/);
  });

  test("rejects an unparseable committedAt", () => {
    expect(() => parsePayload({ ...base([ana]), committedAt: "yesterday" })).toThrow(PayloadError);
  });
});

describe("resolvePlaceholders", () => {
  test("resolves userToken and nested mcp values from env", () => {
    const spec = { ...ana, mcp: { mcpServers: { wb: { headers: { authorization: "Bearer ${PERSONA_ANA_WB_TOKEN}" } } } } };
    const out = resolvePlaceholders(spec, { PERSONA_ANA_XOXP: "tok-1", PERSONA_ANA_WB_TOKEN: "wb-1" });
    expect(out.userToken).toBe("tok-1");
    expect((out.mcp as any).mcpServers.wb.headers.authorization).toBe("Bearer wb-1");
  });

  test("an unset variable throws, naming the variable and never a value", () => {
    const err = (() => { try { resolvePlaceholders(ana, {}); } catch (e) { return e; } })() as UnresolvedVarError;
    expect(err).toBeInstanceOf(UnresolvedVarError);
    expect(err.variable).toBe("PERSONA_ANA_XOXP");
  });

  // Review Focus 1.
  test("a variable set to the empty string counts as unresolved", () => {
    expect(() => resolvePlaceholders(ana, { PERSONA_ANA_XOXP: "" })).toThrow(UnresolvedVarError);
  });

  // Review Focus 2: soul text is content, not configuration.
  test("soul text is never resolved, even when it contains ${...}", () => {
    const soul = "Explain templating: write ${NAME} and it is substituted.";
    expect(resolvePlaceholders({ ...ana, soul }, { PERSONA_ANA_XOXP: "t" }).soul).toBe(soul);
  });

  test("userToken with lowercase placeholder throws PayloadError, not UnresolvedVarError", () => {
    const spec = { name: "test", slackUserId: "UTESTUSER2", soul: "x", userToken: "${ana_token}" };
    const err = (() => { try { resolvePlaceholders(spec, {}); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(PayloadError);
    expect(err).not.toBeInstanceOf(UnresolvedVarError);
  });

  test("an mcp header with lowercase placeholder throws PayloadError", () => {
    const spec = { name: "test", slackUserId: "UTESTUSER2", soul: "x", userToken: "${PERSONA_TEST_TOKEN}", mcp: { headers: { auth: "Bearer ${foo}" } } };
    expect(() => resolvePlaceholders(spec, { PERSONA_TEST_TOKEN: "tok" })).toThrow(PayloadError);
  });

  test("a partially resolved string throws UnresolvedVarError for the missing variable, not containing resolved values in the message", () => {
    const spec = { name: "test", slackUserId: "UTESTUSER2", soul: "x", userToken: "${PERSONA_A}-${PERSONA_B}" };
    const err = (() => { try { resolvePlaceholders(spec, { PERSONA_A: "resolved-part-value" }); } catch (e) { return e; } })() as UnresolvedVarError;
    expect(err).toBeInstanceOf(UnresolvedVarError);
    expect(err.variable).toBe("PERSONA_B");
    expect(String(err.message)).not.toContain("resolved-part-value");
  });

  test("soul text containing lowercase placeholder passes through unchanged", () => {
    const soul = "Use ${lowercase} or ${Uppercase} in your soul.";
    expect(resolvePlaceholders({ ...ana, soul }, { PERSONA_ANA_XOXP: "t" }).soul).toBe(soul);
  });

  // R40-I3: only PERSONA_* names resolve, so a persona repo cannot copy a
  // gateway secret (master key, job secret, node token, provider key) into a
  // stored persona and on to nodes.
  test("a variable outside PERSONA_* is refused, naming the variable and never a value, even when set", () => {
    const spec = { ...ana, mcp: { mcpServers: { x: { type: "http", url: "https://x.test", headers: { a: "${SLAUDE_MASTER_KEY}" } } } } };
    const env = { PERSONA_ANA_XOXP: "t", SLAUDE_MASTER_KEY: "master-key-secret-value" };
    const err = (() => { try { resolvePlaceholders(spec, env); } catch (e) { return e; } })() as Error;
    expect(err).toBeInstanceOf(PayloadError);
    expect(err).not.toBeInstanceOf(UnresolvedVarError);
    expect(err.message).toContain("SLAUDE_MASTER_KEY");
    expect(err.message).toContain("PERSONA_");
    expect(err.message).not.toContain("master-key-secret-value");
  });

  test("a userToken outside PERSONA_* is refused too", () => {
    expect(() => resolvePlaceholders({ ...ana, userToken: "${ANA_XOXP}" }, { ANA_XOXP: "t" })).toThrow(/ANA_XOXP.*PERSONA_/);
  });

  test("the prefix must be exact: PERSONA alone or a lookalike does not count", () => {
    for (const v of ["PERSONA", "PERSONAX_A", "XPERSONA_A", "PERSONA_"]) {
      expect(() => resolvePlaceholders({ ...ana, userToken: `\${${v}}` }, { [v]: "t" })).toThrow(PayloadError);
    }
  });
});

describe("payload version and unknown fields", () => {
  test("an absent version is version 1; a supported one passes", () => {
    expect(parsePayload(base([ana])).version).toBe(1);
    expect(parsePayload({ ...base([ana]), version: SUPPORTED_PAYLOAD_VERSION }).version).toBe(SUPPORTED_PAYLOAD_VERSION);
  });
  test("a newer version is refused with a clear message", () => {
    const err = (() => { try { parsePayload({ ...base([ana]), version: SUPPORTED_PAYLOAD_VERSION + 1 }); } catch (e) { return e as PayloadError; } })();
    expect(err).toBeInstanceOf(PayloadError);
    expect(err!.message).toMatch(/newer than this gateway supports/);
  });
  test("a non-integer or zero version is a schema error", () => {
    for (const version of [0, 1.5, "1"]) expect(() => parsePayload({ ...base([ana]), version })).toThrow(PayloadError);
  });
  test("unknown keys are listed by path, names only, and stripped from the parse", () => {
    const raw = { ...base([{ ...ana, visibility: "secret-value" }]), futureKnob: "secret-value" };
    expect(unknownFieldPaths(raw)).toEqual(["futureKnob", "persona.ana.visibility"]);
    expect(JSON.stringify(parsePayload(raw))).not.toContain("secret-value");
  });
  test("a known-field payload has no unknown fields", () => {
    expect(unknownFieldPaths({ ...base([ana]), version: 1 })).toEqual([]);
  });
  test("a hostile key name is never echoed", () => {
    expect(unknownFieldPaths({ ...base([ana]), "sk-abc def!": 1 })).toEqual(["<invalid-key>"]);
  });
});
