/**
 * The bridge's SSRF policy (WS-C §4.2.7): every upstream request goes through
 * the outbound policy (src/net/outbound-policy.ts) pinned to the configured
 * origin. Private, loopback, link-local and metadata addresses are refused
 * after DNS (a public-looking name that resolves inside is refused too), only
 * https is allowed, and a redirect is never followed — so the credential is
 * never carried anywhere the policy did not check.
 */
import { describe, expect, test } from "bun:test";
import { createMcpBridge, unavailableText } from "../../../src/gateway/core/mcp-bridge";
import type { JobClaims } from "../../../src/gateway/api/auth";
import type { Resolver } from "../../../src/net/outbound-policy";
import { startUpstream } from "./upstream";

const claims: JobClaims = {
  tenant: "t1", persona: "default", session: "S1", team: "TTEAM", channel: "CCHAN", thread: "1.1",
  initiator: "UUSER1", scope: "turn", runAs: "agent", exp: 0,
};

const resolver: Resolver = async (host) => {
  const table: Record<string, string> = {
    "rebind.example.com": "10.0.0.5",
    "meta.example.com": "169.254.169.254",
    "public.example.com": "93.184.216.34",
  };
  const a = table[host];
  if (!a) throw new Error("ENOTFOUND");
  return [{ address: a, family: 4 }];
};

function bridgeAt(url: string, policy: Record<string, unknown> = {}) {
  return createMcpBridge({
    servers: () => ({ servers: { s: { type: "http", url, headers: { authorization: "Bearer static-secret" } } as never }, privateServices: [] }),
    accountFor: async () => null,
    credentialsFor: async () => ({}),
    policy: { resolver, allowLoopback: false, allowedHosts: [], internalHosts: [], ...policy },
    limits: () => ({ timeoutMs: 3000, ownerConcurrency: 4, maxRequestBytes: 1 << 20, maxResultBytes: 1 << 20 }),
  });
}

async function callText(url: string, policy?: Record<string, unknown>): Promise<string> {
  const b = bridgeAt(url, policy);
  try {
    const r = await b.call(claims, "s", "echo", { text: "x" });
    expect(r.isError).toBe(true);
    return (r.content as { text: string }[])[0]!.text;
  } finally {
    await b.close();
  }
}

describe("the bridge's outbound policy", () => {
  test("a name that resolves to a private address is refused (DNS rebinding)", async () => {
    expect(await callText("https://rebind.example.com/mcp")).toBe("s: outbound request refused: rebind.example.com resolves to a private address");
  });

  test("metadata, link-local, loopback and private literals are refused", async () => {
    expect(await callText("https://meta.example.com/mcp")).toContain("resolves to a link-local address");
    expect(await callText("https://169.254.169.254/latest")).toContain("refused");
    expect(await callText("https://[fd00:ec2::254]/mcp")).toContain("metadata");
    expect(await callText("https://10.1.2.3/mcp")).toContain("private");
  });

  test("only https", async () => {
    expect(await callText("http://public.example.com/mcp")).toContain("only https is allowed");
  });

  test("a real loopback upstream is refused without the development flag, and nothing reaches it", async () => {
    const up = startUpstream();
    try {
      expect(await callText(up.url)).toContain("refused");
      expect(up.paths).toHaveLength(0);
    } finally {
      up.stop();
    }
  });

  test("a redirect is not followed: the credential never reaches the target", async () => {
    const target = startUpstream();
    const up = startUpstream({ redirectTo: `${target.url}?stolen=1` });
    try {
      expect(await callText(up.url, { allowLoopback: true })).toBe(unavailableText("s"));
      expect(up.paths).toEqual(["/mcp"]);
      expect(target.paths).toHaveLength(0);
    } finally {
      up.stop();
      target.stop();
    }
  });
});
