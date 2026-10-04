import { describe, expect, test } from "bun:test";
import { capPaths, MAX_REPORTED_FIELDS, SUPPORTED_PAYLOAD_VERSION, PERSONA_FIELD_VERSION, KB_SOURCES_MAX, kbSourceWarnings, payloadVersionFor, unknownFieldPaths, parsePayload, resolvePlaceholders, UnresolvedVarError, PayloadError, providerWarnings } from "../../src/persona/sync/payload";

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
  test("secret-shaped key names are never echoed", () => {
    const raw = { ...base([ana]), ["AKIA" + "ABCDEFGHIJKLMNOP"]: 1, ["xox" + "b-1234567890-abcdef"]: 1, "sk-abcdefghijkl": 1 };
    expect(unknownFieldPaths(raw)).toEqual(["<invalid-key>", "<invalid-key>", "<invalid-key>"]);
  });
  test("a dotted top-level key cannot pose as a persona path", () => {
    expect(unknownFieldPaths({ ...base([ana]), "persona.default.soul": 1 })).toEqual(["<invalid-key>"]);
  });
  test("capPaths bounds a long list", () => {
    const many = Array.from({ length: 1000 }, (_, i) => `k${i}`);
    const c = capPaths(many);
    expect(c).toHaveLength(MAX_REPORTED_FIELDS + 1);
    expect(c.at(-1)).toBe("…and 950 more");
    expect(capPaths(["a"])).toEqual(["a"]);
  });
});

describe("provider (WS-A §4)", () => {
  const withProvider = (provider: unknown, extra: object = {}) => base([{ ...ana, model: "m-1", provider, ...extra }]);
  const err = (raw: unknown) => { try { parsePayload(raw); } catch (e) { return e as Error; } throw new Error("no error"); };

  test("references and a literal baseUrl parse and are kept", () => {
    const provider = {
      apiKey: "vault://secret/slaude/personas/ana#api_key",
      authToken: "env://PERSONA_ANA_AUTH",
      oauthToken: "vault://team/kv/ana#oauth",
      baseUrl: "https://llm.example.com",
    };
    expect(parsePayload(withProvider(provider)).personas[0]!.provider).toEqual(provider);
  });

  test("baseUrl may itself be a reference", () => {
    const p = parsePayload(withProvider({ baseUrl: "env://PERSONA_ANA_URL", apiKey: "env://PERSONA_ANA_KEY" })).personas[0]!;
    expect(p.provider!.baseUrl).toBe("env://PERSONA_ANA_URL");
  });

  // M-1: provider is an atomic set; a host without its own key would be paired with another's.
  test("a baseUrl with no credential reference beside it is refused, naming persona and field", () => {
    for (const baseUrl of ["https://llm.example.com", "env://PERSONA_ANA_URL"]) {
      const e = err(withProvider({ baseUrl }));
      expect(e.message).toContain("persona 'ana': provider.baseUrl");
      expect(e.message).toContain("credential");
    }
  });

  test("http, private and link-local base URLs are refused; an internal host may opt in", () => {
    for (const baseUrl of ["http://llm.example.com", "https://10.1.2.3", "https://169.254.169.254/latest", "https://localhost"]) {
      expect(err(withProvider({ baseUrl, apiKey: "env://PERSONA_ANA_KEY" })).message).toContain("provider.baseUrl");
    }
    const raw = withProvider({ baseUrl: "http://llm.internal.example", apiKey: "env://PERSONA_ANA_KEY" });
    expect(parsePayload(raw, { internalHosts: ["llm.internal.example"] }).personas[0]!.provider!.baseUrl).toBe("http://llm.internal.example");
    expect(() => parsePayload(withProvider({ baseUrl: "http://169.254.169.254", apiKey: "env://PERSONA_ANA_KEY" }), { internalHosts: ["169.254.169.254"] })).toThrow(PayloadError);
  });

  test("a literal secret, a placeholder or another scheme is refused, naming persona and field, never the value", () => {
    for (const apiKey of ["sk-literal-secret-value", "${PERSONA_ANA_KEY}", "https://x.example.com/k", "env://ANTHROPIC_API_KEY"]) {
      const e = err(withProvider({ apiKey }));
      expect(e).toBeInstanceOf(PayloadError);
      expect(e.message).toContain("persona 'ana': provider.apiKey");
      expect(e.message).not.toContain(apiKey);
    }
  });

  test("a traversal or encoded separator is refused", () => {
    for (const authToken of ["vault://secret/../x#f", "vault://secret/a%2fb#f", "vault://secret/a#"]) {
      expect(err(withProvider({ authToken })).message).toContain("provider.authToken");
    }
  });

  test("a literal baseUrl must be an https URL; userinfo is refused without echoing it", () => {
    for (const baseUrl of ["ftp://llm.example.com", "not a url", "https://user:hunter2@llm.example.com"]) {
      const e = err(withProvider({ baseUrl, apiKey: "env://PERSONA_ANA_KEY" }));
      expect(e.message).toContain("persona 'ana': provider.baseUrl");
      expect(e.message).not.toContain("hunter2");
    }
  });

  test("an unknown key inside provider is refused, not silently dropped", () => {
    expect(err(withProvider({ apikey: "vault://secret/a/b#f" })).message).toContain("provider");
  });

  test("an empty provider object counts as absent", () => {
    expect(parsePayload(withProvider({})).personas[0]!.provider).toBeUndefined();
  });

  test("provider is a known field, so it is never reported as ignored", () => {
    expect(unknownFieldPaths(withProvider({ apiKey: "env://PERSONA_ANA_KEY" }))).toEqual([]);
  });
});

describe("providerWarnings", () => {
  test("baseUrl without model, and a persona with no model at all, are named", () => {
    const p = parsePayload(base([
      { name: "default", soul: "d", model: "m" },
      { ...ana, provider: { baseUrl: "https://llm.example.com", apiKey: "env://PERSONA_ANA_KEY" } },
      { name: "bea", slackUserId: "UTESTUSER2", soul: "b" },
    ]));
    const w = providerWarnings(p);
    expect(w.some((s) => s.includes("'ana'") && s.includes("provider.baseUrl"))).toBe(true);
    expect(w.some((s) => s.includes("'bea'") && s.includes("no model"))).toBe(true);
    expect(w.some((s) => s.includes("'default'"))).toBe(false);
  });
});

describe("kbSources (WS-C §4.1)", () => {
  const withKb = (kbSources: unknown) => base([{ ...ana, kbSources }]);
  test("absent stays absent (all installed KBs); [] and a list are kept as written", () => {
    expect(parsePayload(base([ana])).personas[0]!.kbSources).toBeUndefined();
    expect(parsePayload(withKb([])).personas[0]!.kbSources).toEqual([]);
    expect(parsePayload(withKb(["kb-runbook", "kb-finance-2"])).personas[0]!.kbSources).toEqual(["kb-runbook", "kb-finance-2"]);
  });

  test("a malformed id is a PayloadError naming the persona and field, never echoing the value", () => {
    for (const bad of ["runbook", "kb-", "KB-runbook", "kb-Run", "kb-a_b", "kb-x.y", "shared", "agent-u1", "", 7]) {
      const e = (() => { try { parsePayload(withKb([bad])); } catch (x) { return x as PayloadError; } })();
      expect({ bad, err: e instanceof PayloadError }).toEqual({ bad, err: true });
      expect(e!.message).toContain("persona 'ana': kbSources");
      if (typeof bad === "string" && bad.length > 3) expect(e!.message).not.toContain(bad);
    }
    expect(() => parsePayload(withKb("kb-runbook"))).toThrow(PayloadError);
  });

  test("a duplicate id is refused", () => {
    expect(() => parsePayload(withKb(["kb-a", "kb-a"]))).toThrow(/kbSources/);
  });

  test("one version table: the payload needs the highest version of any field a persona sets", () => {
    expect(PERSONA_FIELD_VERSION).toEqual({ provider: 2, kbSources: 3 });
    expect(SUPPORTED_PAYLOAD_VERSION).toBe(3);
    expect(payloadVersionFor([])).toBe(1);
    expect(payloadVersionFor([{}])).toBe(1);
    expect(payloadVersionFor([{ provider: {} }])).toBe(2);
    expect(payloadVersionFor([{ kbSources: [] }])).toBe(3);
    expect(payloadVersionFor([{ provider: {}, kbSources: ["kb-a"] }])).toBe(3);
    expect(payloadVersionFor([{ provider: {} }, { kbSources: ["kb-a"] }])).toBe(3);
  });

  test("an id longer than 32 characters (kbSourceId never makes one) is refused", () => {
    expect(() => parsePayload(withKb(["kb-" + "a".repeat(29)]))).not.toThrow();
    expect(() => parsePayload(withKb(["kb-" + "a".repeat(30)]))).toThrow(/kbSources\[0\]/);
  });

  test("the list is capped", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `kb-k${i}`);
    expect(() => parsePayload(withKb(ids(KB_SOURCES_MAX)))).not.toThrow();
    expect(() => parsePayload(withKb(ids(KB_SOURCES_MAX + 1)))).toThrow(/at most/);
  });

  test("an id that several installed KBs normalise to is a warning", () => {
    const p = parsePayload(withKb(["kb-my-wiki", "kb-runbook"]));
    const w = kbSourceWarnings(p, ["kb-my-wiki", "kb-my-wiki", "kb-runbook"]);
    expect(w).toEqual([expect.stringContaining("'ana'")]);
    expect(w[0]).toContain("kb-my-wiki");
    expect(w[0]).toContain("more than one");
  });

  test("kbSources is a known field, so it is never reported as ignored", () => {
    expect(unknownFieldPaths(withKb(["kb-a"]))).toEqual([]);
  });
});
