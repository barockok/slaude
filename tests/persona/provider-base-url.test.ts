import { describe, expect, test } from "bun:test";
import { baseUrlProblem, internalHostsFrom } from "../../src/persona/provider-base-url";

describe("provider baseUrl policy (M-1)", () => {
  test("a public https URL with a path is fine", () => {
    expect(baseUrlProblem("https://llm.example.com/v1", [])).toBeNull();
  });

  test("http is refused unless the exact host is an internal host", () => {
    expect(baseUrlProblem("http://llm.example.com", [])).toMatch(/https/);
    expect(baseUrlProblem("http://llm.internal.example", ["llm.internal.example"])).toBeNull();
    expect(baseUrlProblem("http://sub.llm.internal.example", ["llm.internal.example"])).toMatch(/https/);
  });

  test("private IP literals only for an internal host; loopback, link-local and metadata never", () => {
    expect(baseUrlProblem("https://10.0.0.5", [])).toMatch(/private/);
    expect(baseUrlProblem("https://10.0.0.5", ["10.0.0.5"])).toBeNull();
    for (const u of ["https://127.0.0.1", "https://[::1]", "http://169.254.169.254/latest", "https://100.100.100.200", "https://0.0.0.0"]) {
      const host = new URL(u).hostname.replace(/^\[|\]$/g, "");
      expect(baseUrlProblem(u, [host])).not.toBeNull();
    }
  });

  test("loopback and metadata host names are refused even when listed", () => {
    for (const u of ["https://localhost", "https://api.localhost", "https://metadata.google.internal"]) {
      expect(baseUrlProblem(u, [new URL(u).hostname])).not.toBeNull();
    }
  });

  // Re-check F1: a fully qualified name with its trailing dot is the same host.
  test("a trailing dot (literal or percent-encoded) does not get past the never-list", () => {
    for (const u of [
      "https://localhost./", "https://metadata.google.internal./", "https://foo.localhost./",
      "https://localhost%2e/", "https://localhost%2E/", "https://metadata.%2e/",
    ]) {
      expect(baseUrlProblem(u, [])).not.toBeNull();
    }
    expect(baseUrlProblem("http://llm.internal.example./", ["llm.internal.example"])).toBeNull();
    expect(baseUrlProblem("https://llm.example.com./v1", [])).toBeNull();
  });

  test("other schemes, userinfo and query strings are refused without echoing the URL", () => {
    for (const u of ["file:///etc/passwd", "ftp://llm.example.com", "https://user:hunter2@llm.example.com", "https://llm.example.com/?key=abc", "not a url"]) {
      const p = baseUrlProblem(u, []);
      expect(p).not.toBeNull();
      expect(p!).not.toContain("hunter2");
      expect(p!).not.toContain("passwd");
    }
  });

  test("internal hosts come from SLAUDE_OUTBOUND_INTERNAL_HOSTS, trimmed and lower-cased", () => {
    expect(internalHostsFrom({ SLAUDE_OUTBOUND_INTERNAL_HOSTS: " LLM.Internal.example , ,b.example" })).toEqual(["llm.internal.example", "b.example"]);
    expect(internalHostsFrom({})).toEqual([]);
  });
});
