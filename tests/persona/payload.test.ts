import { describe, expect, test } from "bun:test";
import { parsePayload, resolvePlaceholders, UnresolvedVarError, PayloadError } from "../../src/persona/sync/payload";

const base = (personas: unknown[]) => ({ revision: "abc123", committedAt: "2026-10-01T10:00:00Z", personas });
const ana = { name: "ana", slackUserId: "UTESTUSER1", soul: "You are Ana.", userToken: "${ANA_XOXP}" };

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
    const spec = { ...ana, mcp: { mcpServers: { wb: { headers: { authorization: "Bearer ${WB_TOKEN}" } } } } };
    const out = resolvePlaceholders(spec, { ANA_XOXP: "tok-1", WB_TOKEN: "wb-1" });
    expect(out.userToken).toBe("tok-1");
    expect((out.mcp as any).mcpServers.wb.headers.authorization).toBe("Bearer wb-1");
  });

  test("an unset variable throws, naming the variable and never a value", () => {
    const err = (() => { try { resolvePlaceholders(ana, {}); } catch (e) { return e; } })() as UnresolvedVarError;
    expect(err).toBeInstanceOf(UnresolvedVarError);
    expect(err.variable).toBe("ANA_XOXP");
  });

  // Review Focus 1.
  test("a variable set to the empty string counts as unresolved", () => {
    expect(() => resolvePlaceholders(ana, { ANA_XOXP: "" })).toThrow(UnresolvedVarError);
  });

  // Review Focus 2: soul text is content, not configuration.
  test("soul text is never resolved, even when it contains ${...}", () => {
    const soul = "Explain templating: write ${NAME} and it is substituted.";
    expect(resolvePlaceholders({ ...ana, soul }, { ANA_XOXP: "t" }).soul).toBe(soul);
  });
});
