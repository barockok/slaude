import { describe, expect, test } from "bun:test";
import { formatRef, parseRef, refScheme } from "../../src/refs/parse";

const good = (s: string) => {
  const r = parseRef(s);
  if (!r.ok) throw new Error(`expected ${JSON.stringify(s)} to parse: ${r.reason}`);
  return r.ref;
};
const bad = (s: string, accept?: Parameters<typeof parseRef>[1]) => {
  const r = parseRef(s, accept);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.reason;
};

const ACCEPT: [string, string][] = [
  ["slack:user:U0EXAMPLE", "slack:user:U0EXAMPLE"],
  ["slack:user:W0EXAMPLE", "slack:user:W0EXAMPLE"],
  ["slack:channel:C0EXAMPLE", "slack:channel:C0EXAMPLE"],
  ["slack:channel:G0EXAMPLE", "slack:channel:G0EXAMPLE"],
  ["slack:channel:D0EXAMPLE", "slack:channel:D0EXAMPLE"],
  ["slack:user:T0EXAMPLE/U0EXAMPLE", "slack:user:T0EXAMPLE/U0EXAMPLE"],
  ["slack:channel:T0EXAMPLE/C0EXAMPLE", "slack:channel:T0EXAMPLE/C0EXAMPLE"],
  ["whatsapp:phone:+620000000000", "whatsapp:phone:+620000000000"],
  ["whatsapp:group:120363000000", "whatsapp:group:120363000000"],
  ["whatsapp:group:a:b-c.d@g", "whatsapp:group:a:b-c.d@g"],
  ["telegram:user:12345", "telegram:user:12345"],
  ["email:a@example.com", "email:a@example.com"],
  ["user:abc_1.2-3", "user:abc_1.2-3"],
  ["boundary:room-1", "boundary:room-1"],
  ["agent:ana", "agent:ana"],
  ["env:team-sandbox", "env:team-sandbox"],
  ["node:n1", "node:n1"],
  ["trust:public", "trust:public"],
  ["trust:trusted", "trust:trusted"],
  ["dm", "dm"],
];

describe("parseRef accepts every scheme and kind", () => {
  for (const [input, canonical] of ACCEPT) {
    test(input, () => {
      const ref = good(input);
      expect(formatRef(ref)).toBe(canonical);
      expect(refScheme(ref).length).toBeGreaterThan(0);
    });
  }

  test("shapes", () => {
    expect(good("slack:user:T0EXAMPLE/U0EXAMPLE")).toEqual({ kind: "external", service: "slack", type: "user", id: "U0EXAMPLE", workspace: "T0EXAMPLE" });
    expect(good("slack:channel:C0EXAMPLE")).toEqual({ kind: "external", service: "slack", type: "channel", id: "C0EXAMPLE" });
    expect(good("user:abc")).toEqual({ kind: "internal", type: "user", id: "abc" });
    expect(good("email:a@example.com")).toEqual({ kind: "email", address: "a@example.com" });
    expect(good("dm")).toEqual({ kind: "selector", name: "dm" });
  });
});

describe("parseRef refuses", () => {
  const REFUSED = [
    "", "x", "slack", "slack:", "slack:user", "slack:user:", "slack::U0EXAMPLE", "slack:user:U", "slack:user:C0EXAMPLE", "slack:channel:U0EXAMPLE",
    "slack:team:T0EXAMPLE", "slack:user:U0EXAMPLE:x", "slack:user:U0-EXAMPLE", "slack:user:/U0EXAMPLE", "slack:user:T0EXAMPLE/", "slack:user:X0EXAMPLE/U0EXAMPLE",
    "slack:user:T0EXAMPLE/T0EXAMPLE/U0EXAMPLE", "slack:user:t0/U0EXAMPLE ", "whatsapp:phone:620000000000", "whatsapp:phone:+0620000000000", "whatsapp:phone:+62",
    "whatsapp:phone:+6200000000000000", "whatsapp:phone:+62 000000000", "whatsapp:phone:+62-0000-000", "whatsapp:group:", "whatsapp:user:1", "whatsapp:group:a/b",
    "telegram:user:", "telegram:user:abc", "telegram:user:012", "telegram:group:1", "telegram:user:-1", "user:", "user:a b", "user:a:b", "user:a/b", "boundary:", "agent:" + "a".repeat(65),
    "trust:other", "trust:", "trust:public:x", "DM", "Dm", "dm:x", "Trust:public", "sms:+620000000000", "mailto:a@example.com", "http://example.com",
    "email:", "email:a", "email:@example.com", "email:a@", "email:a@@example.com", "email:a@b@example.com", "email:a@example", "email:Name <a@example.com>", "email:<a@example.com>",
    "email:a b@example.com", "email:a@exa mple.com", "email:\"a\"@example.com", "email:a@.example.com", "email:a@example..com", "email:.a@example.com", "email:a.@example.com",
    "email:a..b@example.com", "email:a@-example.com", "email:a@example.123", "email:a%40b@example.com", "email:a@example.com%", "email:" + "a".repeat(250) + "@example.com",
    "email:a@" + "b".repeat(64) + ".com", "email:\u00FC@example.com", "email:a@exa\u200Bmple.com",
  ];
  for (const s of REFUSED) {
    test(JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}...` : s), () => void bad(s));
  }

  test("whitespace, NUL, newline, percent and lookalike colons", () => {
    for (const s of [" slack:user:U0EXAMPLE", "slack:user:U0EXAMPLE ", "slack:user:U0EXAMPLE\n", "slack:user:U0\u0000EXAMPLE", "slack:user:U0%45XAMPLE", "slack\uFF1Auser:U0EXAMPLE", "slack:user\uFF1AU0EXAMPLE", "slack\uA789user:U0EXAMPLE", "slack\u2236user:U0EXAMPLE", "user:a\u00A0b", "slack:user:U0\u200BEXAMPLE", "slack:user:U0\tEXAMPLE", "\uFEFFslack:user:U0EXAMPLE"]) {
      bad(s);
    }
  });

  test("a non-string is refused, not thrown on", () => {
    for (const v of [undefined, null, 5, {}, []]) expect(parseRef(v as never).ok).toBe(false);
  });

  test("the length cap is 256", () => {
    expect(parseRef("user:" + "a".repeat(64)).ok).toBe(true);
    bad("whatsapp:group:" + "a".repeat(200) + "b".repeat(100));
    bad("x".repeat(257));
  });

  test("lookalike letters do not fold into Slack ids", () => {
    bad("slack:user:\u0131D0EXAMPLE"); // dotless i upper-cases to I
    bad("slack:user:U0EXAMPL\u00DF"); // sharp s upper-cases to SS
  });
});

describe("normalisation", () => {
  test("scheme and kind are lower-cased, Slack ids upper-cased", () => {
    expect(formatRef(good("SLACK:User:u0example"))).toBe("slack:user:U0EXAMPLE");
    expect(formatRef(good("Slack:Channel:t0example/c0example"))).toBe("slack:channel:T0EXAMPLE/C0EXAMPLE");
    expect(formatRef(good("WhatsApp:Phone:+620000000000"))).toBe("whatsapp:phone:+620000000000");
    expect(formatRef(good("USER:Mixed-Case"))).toBe("user:Mixed-Case");
  });

  test("email: trim, NFKC, lower-case, plus-addressing and dots kept, IDNA domain", () => {
    expect(formatRef(good("email:  A.B+Tag@Example.COM  "))).toBe("email:a.b+tag@example.com");
    expect(formatRef(good("email:\uFF21@example.com"))).toBe("email:a@example.com"); // fullwidth A
    expect(formatRef(good("email:a@B\u00FCcher.example"))).toBe("email:a@xn--bcher-kva.example");
    expect(good("email:a+x@example.com")).not.toEqual(good("email:a@example.com"));
    expect(good("email:a.b@example.com")).not.toEqual(good("email:ab@example.com"));
    expect(formatRef(good("EMAIL:a@example.com"))).toBe("email:a@example.com");
    expect(formatRef(good("email:a@example.com\n"))).toBe("email:a@example.com"); // trim covers the address only
  });

  test("a workspace qualifier is kept and is part of the identity", () => {
    expect(good("slack:user:T0EXAMPLE/U0EXAMPLE")).not.toEqual(good("slack:user:U0EXAMPLE"));
  });

  test("a colon in the last segment needs no escaping", () => {
    expect(good("whatsapp:group:a:b:c")).toEqual({ kind: "external", service: "whatsapp", type: "group", id: "a:b:c" });
  });
});

describe("canonical round trip", () => {
  const inputs = [...ACCEPT.map(([i]) => i), "SLACK:USER:u0example", "email: A@Example.COM", "slack:user:t0example/u0example", "Telegram:User:9"];
  for (const i of inputs) {
    test(i, () => {
      const ref = good(i);
      const text = formatRef(ref);
      expect(good(text)).toEqual(ref);
      expect(formatRef(good(text))).toBe(text);
    });
  }
});

describe("accept roles", () => {
  test("user and channel fields refuse the other role", () => {
    expect(parseRef("slack:user:U0EXAMPLE", ["user"]).ok).toBe(true);
    expect(parseRef("email:a@example.com", ["user"]).ok).toBe(true);
    expect(parseRef("slack:channel:C0EXAMPLE", ["channel"]).ok).toBe(true);
    expect(parseRef("whatsapp:group:g1", ["channel", "selector"]).ok).toBe(true);
    expect(parseRef("dm", ["channel", "selector"]).ok).toBe(true);
    bad("slack:channel:C0EXAMPLE", ["user"]);
    bad("slack:user:U0EXAMPLE", ["channel"]);
    bad("dm", ["user"]);
    bad("agent:ana", ["user", "channel"]);
    bad("trust:public", ["channel"]);
  });
});

describe("no echo", () => {
  test("a secret-looking input never appears in a reason", () => {
    const secret = "s3cr3t-9f3a";
    const inputs = [secret, `slack:${secret}`, `slack:user:${secret}`, `slack:channel:${secret}/C0EXAMPLE`, `email:${secret}`, `email:${secret}@nodot`, `email:a@${secret}`, `whatsapp:phone:${secret}`,
      `whatsapp:${secret}:1`, `telegram:user:${secret}`, `user:${secret} x`, `${secret}:x`, `trust:${secret}`, `email:${secret}@a b.com`, `user:${secret}%41`];
    for (const i of inputs) {
      for (const accept of [undefined, ["user"] as const, ["channel"] as const]) {
        const r = parseRef(i, accept as never);
        if (!r.ok) {
          expect(r.reason).not.toContain(secret);
          expect(r.reason).not.toContain(secret.slice(0, 5));
        }
      }
    }
  });
});

describe("hostile input", () => {
  test("a 1 MB string of repeated colons and a@ finishes quickly without throwing", () => {
    const t0 = Date.now();
    for (const unit of [":", "a@", "slack:user:", "email:a@", "\u0000", "\uFF1A", ".", "a@a.", "\u200B"]) {
      const s = unit.repeat(Math.ceil(1_000_000 / unit.length));
      expect(parseRef(s).ok).toBe(false);
      expect(parseRef("email:" + s).ok).toBe(false);
      expect(parseRef("slack:user:" + s, ["user"]).ok).toBe(false);
    }
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("near-cap hostile addresses are fast", () => {
    const t0 = Date.now();
    for (const body of ["a@" + ".".repeat(240), "a@" + "a.".repeat(120), "@".repeat(250), "a.".repeat(125) + "@x.com", "a@" + "xn--".repeat(60) + ".com"]) parseRef("email:" + body);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
