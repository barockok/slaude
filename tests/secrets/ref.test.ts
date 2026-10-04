import { describe, expect, test } from "bun:test";
import { PayloadError } from "../../src/persona/sync/payload";
import { canonicalRef, parseRef, SecretRefError } from "../../src/secrets/ref";

describe("parseRef — valid references", () => {
  test("vault ref with a single-segment mount", () => {
    const r = parseRef("vault://secret/slaude/personas/support-bot#api_key");
    expect(r).toEqual({ scheme: "vault", path: "secret/slaude/personas/support-bot", field: "api_key" });
    expect(canonicalRef(r)).toBe("vault://secret/slaude/personas/support-bot#api_key");
  });

  test("vault ref with a multi-segment mount parses (the split is the resolver's job)", () => {
    const r = parseRef("vault://team/kv/slaude/personas/a#token");
    expect(r).toEqual({ scheme: "vault", path: "team/kv/slaude/personas/a", field: "token" });
  });

  test("env ref with a PERSONA_ name", () => {
    expect(parseRef("env://PERSONA_SUPPORT_KEY")).toEqual({ scheme: "env", name: "PERSONA_SUPPORT_KEY" });
    expect(canonicalRef({ scheme: "env", name: "PERSONA_X" })).toBe("env://PERSONA_X");
  });
});

describe("parseRef — rejects", () => {
  const cases: Array<[string, string]> = [
    ["wrong scheme", "https://secret/a#b"],
    ["file scheme", "file:///etc/passwd"],
    ["upper-case scheme", "VAULT://secret/a/b#f"],
    ["no scheme", "secret/a/b#f"],
    ["missing #field", "vault://secret/a/b"],
    ["empty field", "vault://secret/a/b#"],
    ["two fields", "vault://secret/a/b#f#g"],
    ["mount only, no path", "vault://secret#f"],
    ["empty ref body", "vault://#f"],
    ["dot-dot segment", "vault://secret/a/../b#f"],
    ["dot segment", "vault://secret/./a#f"],
    ["leading dot-dot", "vault://../secret/a#f"],
    ["empty segment", "vault://secret//a#f"],
    ["leading slash", "vault:///secret/a#f"],
    ["trailing slash", "vault://secret/a/#f"],
    ["encoded slash lower", "vault://secret/a%2fb#f"],
    ["encoded slash upper", "vault://secret/a%2Fb#f"],
    ["encoded dot", "vault://secret/%2e%2e/a#f"],
    ["encoded dot upper", "vault://secret/%2E%2E/a#f"],
    ["encoded backslash", "vault://secret/a%5cb#f"],
    ["double encoding", "vault://secret/a%252fb#f"],
    ["percent in field", "vault://secret/a/b#f%2f"],
    ["backslash", "vault://secret/a\\b#f"],
    ["query string", "vault://secret/a/b?version=1#f"],
    ["query after field", "vault://secret/a/b#f?x=1"],
    ["userinfo", "vault://user@secret/a#f"],
    ["userinfo with password", "vault://u:p@secret/a#f"],
    ["port-like colon", "vault://secret:8200/a#f"],
    ["space", "vault://secret/a b#f"],
    ["leading whitespace", " vault://secret/a/b#f"],
    ["trailing newline", "vault://secret/a/b#f\n"],
    ["tab", "vault://secret/a\tb#f"],
    ["NUL", "vault://secret/a\u0000b#f"],
    ["DEL", "vault://secret/a\u007fb#f"],
    ["non-ASCII letter", "vault://secret/pérsona#f"],
    ["unicode slash look-alike", "vault://secret/a∕b#f"],
    ["fullwidth dot", "vault://secret/．．/a#f"],
    ["template token", "vault://secret/{persona}/a#f"],
    ["env outside PERSONA_", "env://ANTHROPIC_API_KEY"],
    ["env master key", "env://SLAUDE_MASTER_KEY"],
    ["env bare prefix", "env://PERSONA_"],
    ["env lower case", "env://persona_x"],
    ["env with field", "env://PERSONA_X#f"],
    ["env with path", "env://PERSONA_X/y"],
    ["empty string", ""],
  ];
  for (const [name, input] of cases) {
    test(name, () => {
      expect(() => parseRef(input)).toThrow(SecretRefError);
    });
  }

  test("the error is a PayloadError (422) naming the label and never echoing the input", () => {
    let err: unknown;
    try {
      parseRef("vault://secret/a/../b#f", "persona 'support-bot' provider.apiKey");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PayloadError);
    expect((err as PayloadError).status).toBe(422);
    const msg = (err as Error).message;
    expect(msg).toContain("persona 'support-bot' provider.apiKey");
    expect(msg).not.toContain("secret/a");
  });

  test("a non-string is refused", () => {
    expect(() => parseRef(42 as unknown as string)).toThrow(SecretRefError);
  });
});
