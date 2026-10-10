import { describe, it, expect } from "bun:test";
import {
  parseAudioOrigins, matchAudioOrigin, buildAudioPolicy, audioHeadersProblem,
} from "../../src/voice/audio-acl";

const rules = (raw: string) => parseAudioOrigins(raw);

describe("parseAudioOrigins: valid entries", () => {
  it("normalises exact origins (case, default port, a lone trailing slash)", () => {
    expect(rules("https://Audio.Example.com, http://localhost:8080, https://audio.example.com:443/").map((r) => r.entry))
      .toEqual(["https://audio.example.com", "http://localhost:8080", "https://audio.example.com"]);
  });
  it("normalises wildcard entries", () => {
    expect(rules("https://*.Example.com:8443").map((r) => r.entry)).toEqual(["https://*.example.com:8443"]);
  });
  it("accepts an array of entries and skips empty items", () => {
    expect(parseAudioOrigins(["https://a.example.com", " "]).map((r) => r.entry)).toEqual(["https://a.example.com"]);
    expect(rules("https://a.example.com,,").length).toBe(1);
  });
  it("converts IDN hosts to punycode", () => {
    expect(rules("https://audio.bücher.example").map((r) => r.entry)).toEqual(["https://audio.xn--bcher-kva.example"]);
    expect(rules("https://*.bücher.example").map((r) => r.entry)).toEqual(["https://*.xn--bcher-kva.example"]);
  });
});

describe("parseAudioOrigins: malformed entries", () => {
  for (const bad of [
    "*", "https://*", "*.example.com", "audio.example.com", "https://audio.example.com/path",
    "https://audio.example.com/?q=1", "https://audio.example.com?q=1", "https://audio.example.com#f",
    "https://user:pw@audio.example.com", "https://user@audio.example.com", "ftp://audio.example.com",
    "wss://audio.example.com", "https:audio.example.com", "https://a*.example.com", "https://*.*.example.com",
    "https://audio.*.example.com", "https://*.com", "https://*.1.2.3", "https://audio.example.com.",
    "https://audio.example.com:99999", "https://audio.example.com:abc", "https://", "https://exa mple.com",
    "https://audio.example.com\\x",
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(() => rules(bad)).toThrow(/SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS/);
    });
  }
  it("one bad entry invalidates the whole list", () => {
    expect(() => rules("https://ok.example.com, https://bad.example.com/p")).toThrow();
  });
});

describe("matchAudioOrigin", () => {
  const exact = rules("https://audio.example.com");
  it("matches an exact origin and returns the URL's origin", () => {
    expect(matchAudioOrigin("https://audio.example.com/api/x/cap-1/stream", exact)).toBe("https://audio.example.com");
  });
  it("normalises the default port on both sides", () => {
    expect(matchAudioOrigin("https://audio.example.com:443/x", exact)).toBe("https://audio.example.com");
  });
  it("requires an exact port", () => {
    expect(matchAudioOrigin("https://audio.example.com:8443/x", exact)).toBeNull();
    const ported = rules("https://audio.example.com:8443");
    expect(matchAudioOrigin("https://audio.example.com:8443/x", ported)).toBe("https://audio.example.com:8443");
    expect(matchAudioOrigin("https://audio.example.com/x", ported)).toBeNull();
  });
  it("requires the same scheme", () => {
    expect(matchAudioOrigin("http://audio.example.com/x", exact)).toBeNull();
  });
  it("matches an uppercase host", () => {
    expect(matchAudioOrigin("https://AUDIO.EXAMPLE.COM/x", exact)).toBe("https://audio.example.com");
  });
  it("does not match a trailing-dot host", () => {
    expect(matchAudioOrigin("https://audio.example.com./x", exact)).toBeNull();
    expect(matchAudioOrigin("https://a.example.com./x", rules("https://*.example.com"))).toBeNull();
  });
  it("refuses relative URLs, userinfo, and other schemes", () => {
    expect(matchAudioOrigin("/api/x/stream", exact)).toBeNull();
    expect(matchAudioOrigin("//audio.example.com/x", exact)).toBeNull();
    expect(matchAudioOrigin("https://u:p@audio.example.com/x", exact)).toBeNull();
    expect(matchAudioOrigin("https://u@audio.example.com/x", exact)).toBeNull();
    expect(matchAudioOrigin("not a url", exact)).toBeNull();
    expect(matchAudioOrigin("ws://audio.example.com/x", rules("http://audio.example.com"))).toBeNull();
  });
  it("matches IDN hosts in either form", () => {
    const idn = rules("https://audio.bücher.example");
    expect(matchAudioOrigin("https://audio.xn--bcher-kva.example/x", idn)).toBe("https://audio.xn--bcher-kva.example");
    expect(matchAudioOrigin("https://audio.bücher.example/x", idn)).toBe("https://audio.xn--bcher-kva.example");
    expect(matchAudioOrigin("https://audio.bucher.example/x", idn)).toBeNull();
  });

  describe("wildcard", () => {
    const wild = rules("https://*.example.com");
    it("matches one or more labels under the suffix", () => {
      expect(matchAudioOrigin("https://audio.example.com/x", wild)).toBe("https://audio.example.com");
      expect(matchAudioOrigin("https://a.b.example.com/x", wild)).toBe("https://a.b.example.com");
      expect(matchAudioOrigin("https://A.EXAMPLE.com/x", wild)).toBe("https://a.example.com");
    });
    it("never matches the bare apex", () => {
      expect(matchAudioOrigin("https://example.com/x", wild)).toBeNull();
    });
    it("never matches a lookalike suffix", () => {
      expect(matchAudioOrigin("https://evilexample.com/x", wild)).toBeNull();
      expect(matchAudioOrigin("https://audio.evilexample.com/x", wild)).toBeNull();
      expect(matchAudioOrigin("https://example.com.evil.net/x", wild)).toBeNull();
      expect(matchAudioOrigin("https://audio.example.co/x", wild)).toBeNull();
    });
    it("requires the scheme and port to match", () => {
      expect(matchAudioOrigin("http://audio.example.com/x", wild)).toBeNull();
      expect(matchAudioOrigin("https://audio.example.com:8443/x", wild)).toBeNull();
      const ported = rules("https://*.example.com:8443");
      expect(matchAudioOrigin("https://audio.example.com:8443/x", ported)).toBe("https://audio.example.com:8443");
      expect(matchAudioOrigin("https://audio.example.com/x", ported)).toBeNull();
    });
  });

  it("an empty rule list matches nothing", () => {
    expect(matchAudioOrigin("https://audio.example.com/x", [])).toBeNull();
  });
});

describe("buildAudioPolicy", () => {
  it("defaults the allowed and required headers to X-Browser-Session", () => {
    const p = buildAudioPolicy({ origins: "https://audio.example.com" });
    expect(p.allowedHeaders).toEqual(["x-browser-session"]);
    expect(p.requiredHeaders).toEqual(["x-browser-session"]);
    expect(p.origins.map((r) => r.entry)).toEqual(["https://audio.example.com"]);
  });
  it("parses header lists case-insensitively", () => {
    const p = buildAudioPolicy({ origins: "https://a.example.com", allowedHeaders: "X-Browser-Session, X-Route-Hint", requiredHeaders: "x-route-hint" });
    expect(p.allowedHeaders).toEqual(["x-browser-session", "x-route-hint"]);
    expect(p.requiredHeaders).toEqual(["x-route-hint"]);
  });
  it("allows no required headers", () => {
    expect(buildAudioPolicy({ origins: "https://a.example.com", requiredHeaders: "" }).requiredHeaders).toEqual([]);
  });
  it("refuses an empty origin list", () => {
    expect(() => buildAudioPolicy({ origins: "" })).toThrow(/SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS/);
  });
  for (const forbidden of ["Authorization", "cookie", "HOST"]) {
    it(`refuses ${forbidden} in the allowed headers`, () => {
      expect(() => buildAudioPolicy({ origins: "https://a.example.com", allowedHeaders: `X-Browser-Session, ${forbidden}` }))
        .toThrow(/SLAUDE_VOICE_AUDIO_ALLOWED_HEADERS.*never be allowed/);
    });
  }
  it("refuses an invalid header name", () => {
    expect(() => buildAudioPolicy({ origins: "https://a.example.com", allowedHeaders: "X Bad" })).toThrow(/SLAUDE_VOICE_AUDIO_ALLOWED_HEADERS/);
  });
  it("refuses required headers that are not allowed", () => {
    expect(() => buildAudioPolicy({ origins: "https://a.example.com", allowedHeaders: "X-Route-Hint" }))
      .toThrow(/SLAUDE_VOICE_AUDIO_REQUIRED_HEADERS.*subset/);
  });
});

describe("audioHeadersProblem", () => {
  const p = buildAudioPolicy({ origins: "https://a.example.com", allowedHeaders: "X-Browser-Session, X-Route-Hint" });
  it("accepts allowed headers in any case", () => {
    expect(audioHeadersProblem({ "x-BROWSER-session": "s" }, p)).toBeNull();
    expect(audioHeadersProblem({ "X-Browser-Session": "s", "x-route-hint": "r" }, p)).toBeNull();
  });
  it("refuses a header not on the allowlist", () => {
    expect(audioHeadersProblem({ "X-Browser-Session": "s", "X-Other": "o" }, p)).toMatch(/X-Other.*not allowed/);
  });
  it("refuses a missing or empty required header", () => {
    expect(audioHeadersProblem({}, p)).toMatch(/x-browser-session.*required/);
    expect(audioHeadersProblem({ "X-Browser-Session": "" }, p)).toMatch(/required/);
  });
});
