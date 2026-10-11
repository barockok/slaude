import { describe, it, expect } from "bun:test";
import { mintJobToken } from "../../src/gateway/api/auth";
import { decodeClaims } from "../../src/node/worker";

describe("decodeClaims", () => {
  it("reads remote and fp from a job token", () => {
    process.env.SLAUDE_JOB_SECRET = "s";
    const t = mintJobToken({ tenant: "t", persona: "p", session: "S", team: "T", channel: "C", thread: "1", initiator: "U", scope: "turn", runAs: "user:U", remote: { addr: "tcA", dir: "/r" }, sessionConfigFp: "abc" } as any);
    const c = decodeClaims(t)!;
    expect(c.remote).toEqual({ addr: "tcA", dir: "/r" });
    expect(c.sessionConfigFp).toBe("abc");
  });
  it("returns null for garbage", () => {
    expect(decodeClaims("not.a.token")).toBeNull();
  });
});
