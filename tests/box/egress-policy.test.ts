import { describe, expect, test } from "bun:test";
import { egressRefusalText, egressVerdict, normalizeHost, parseEgressRule } from "../../src/box/egress/policy";

const rules = (allow: string[], deny: string[] = []) => ({ allow, deny });

describe("egress policy matcher", () => {
  const table: Array<[string, { allow: string[]; deny?: string[] }, string, number, boolean]> = [
    ["refuse by default", { allow: [] }, "example.com", 443, false],
    ["an exact host on 443", { allow: ["example.com"] }, "example.com", 443, true],
    ["an exact host on 80", { allow: ["example.com"] }, "example.com", 80, true],
    ["an exact host on another port is refused", { allow: ["example.com"] }, "example.com", 8443, false],
    ["a port entry covers only that port", { allow: ["example.com:8443"] }, "example.com", 8443, true],
    ["a port entry does not cover 443", { allow: ["example.com:8443"] }, "example.com", 443, false],
    ["any port", { allow: ["example.com:*"] }, "example.com", 2222, true],
    ["a wildcard covers a name below", { allow: ["*.example.com"] }, "files.example.com", 443, true],
    ["a wildcard covers a deeper name", { allow: ["*.example.com"] }, "a.b.example.com", 443, true],
    ["a wildcard does not cover the bare name", { allow: ["*.example.com"] }, "example.com", 443, false],
    ["a wildcard does not cover a suffix look-alike", { allow: ["*.example.com"] }, "notexample.com", 443, false],
    ["a look-alike with the name inside is refused", { allow: ["example.com"] }, "example.com.attacker.test", 443, false],
    ["deny wins over allow", { allow: ["*.example.com"], deny: ["uploads.example.com"] }, "uploads.example.com", 443, false],
    ["deny of a wildcard wins over an exact allow", { allow: ["a.example.com"], deny: ["*.example.com"] }, "a.example.com", 443, false],
    ["deny leaves the rest allowed", { allow: ["*.example.com"], deny: ["uploads.example.com"] }, "files.example.com", 443, true],
    ["case is ignored", { allow: ["Example.COM"] }, "EXAMPLE.com", 443, true],
    ["a trailing dot is ignored", { allow: ["example.com"] }, "example.com.", 443, true],
    ["an IP literal is refused unless spelled", { allow: ["example.com"] }, "93.184.216.34", 443, false],
    ["an IP literal that is spelled is allowed", { allow: ["93.184.216.34"] }, "93.184.216.34", 443, true],
    ["an IPv6 literal in brackets with a port", { allow: ["[2001:db8::1]:443"] }, "[2001:db8::1]", 443, true],
    ["an empty host is refused", { allow: ["*.example.com"] }, "", 443, false],
    ["a host with a slash is refused", { allow: ["example.com"] }, "example.com/x", 443, false],
    ["port 0 is refused", { allow: ["example.com:*"] }, "example.com", 0, false],
  ];
  for (const [name, r, host, port, want] of table) {
    test(name, () => {
      expect(egressVerdict(rules(r.allow, r.deny ?? []), host, port).allow).toBe(want);
    });
  }

  test("the reason says which rule decided", () => {
    expect(egressVerdict(rules([]), "example.com", 443)).toEqual({ allow: false, reason: "not-allowlisted" });
    expect(egressVerdict(rules(["example.com"], ["example.com"]), "example.com", 443)).toEqual({ allow: false, reason: "denied" });
    expect(egressVerdict(rules(["example.com"]), "exa mple.com", 443)).toEqual({ allow: false, reason: "invalid-host" });
  });

  test("an entry that is not a rule matches nothing", () => {
    for (const bad of ["", "*", "*.", "http://example.com", "example.com:0", "example.com:99999", "exa mple.com", "*.*.example.com"]) expect(parseEgressRule(bad)).toBeNull();
    expect(egressVerdict(rules(["http://example.com", "*"]), "example.com", 443).allow).toBe(false);
  });

  test("normalizeHost", () => {
    expect(normalizeHost(" Example.COM. ")).toBe("example.com");
    expect(normalizeHost("[2001:DB8::1]")).toBe("2001:db8::1");
  });

  test("the refusal is one line that names the host and who changes the list", () => {
    const t = egressRefusalText("Example.com");
    expect(t.split("\n")).toHaveLength(1);
    expect(t).toContain("example.com");
    expect(t).toContain("allowlist");
  });
});
