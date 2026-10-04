/**
 * The token a claimed job runs on (src/node/worker.ts tokenAtClaim): a fresh
 * token is used as is; an aging one is refreshed; a refresh refused with 401
 * (the job waited past the refresh grace) falls back to token-reissue with the
 * queue the job was claimed from; any other failure keeps the original.
 */
import { describe, expect, test } from "bun:test";
import { tokenAtClaim } from "../../src/node/worker";
import { NodeApiError } from "../../src/node/client";
import { mintJobToken } from "../../src/gateway/api/auth";

const NOW = 1_800_000_000_000;
const claims = {
  tenant: "default", persona: "default", session: "S", team: "T", channel: "C", thread: "1", initiator: "U", scope: "turn", job: "J1",
};
const tokenIssued = (agoMs: number) => mintJobToken(claims, { secret: "s", now: NOW - agoMs });

function fakeClient(refresh: () => Promise<string>, reissue: () => Promise<string> = async () => "reissued") {
  const calls: string[] = [];
  return {
    calls,
    client: {
      refreshJobToken: async (jobId: string) => {
        calls.push(`refresh:${jobId}`);
        return refresh();
      },
      reissueJobToken: async (jobId: string, queue: string) => {
        calls.push(`reissue:${jobId}:${queue}`);
        return reissue();
      },
    },
  };
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = orig;
  }
};

describe("tokenAtClaim", () => {
  test("a fresh token is used as is", async () => {
    const f = fakeClient(async () => "refreshed");
    const t = tokenIssued(10_000);
    expect(await tokenAtClaim(f.client, "J1", "turns", t, NOW)).toBe(t);
    expect(f.calls).toEqual([]);
  });

  test("an aging token is refreshed", async () => {
    const f = fakeClient(async () => "refreshed");
    expect(await tokenAtClaim(f.client, "J1", "turns", tokenIssued(10 * 60_000), NOW)).toBe("refreshed");
    expect(f.calls).toEqual(["refresh:J1"]);
  });

  test("a 401 on refresh falls back to reissue on the claimed queue", async () => {
    const f = fakeClient(async () => {
      throw new NodeApiError(401, "{}");
    });
    expect(await tokenAtClaim(f.client, "J1", "turns.node-a", tokenIssued(3 * 3600_000), NOW)).toBe("reissued");
    expect(f.calls).toEqual(["refresh:J1", "reissue:J1:turns.node-a"]);
  });

  test("other refresh failures, and a failed reissue, keep the original token", async () => {
    const old = tokenIssued(3 * 3600_000);
    const net = fakeClient(async () => {
      throw new Error("connection refused");
    });
    expect(await quiet(() => tokenAtClaim(net.client, "J1", "turns", old, NOW))).toBe(old);
    expect(net.calls).toEqual(["refresh:J1"]);
    const both = fakeClient(
      async () => {
        throw new NodeApiError(401, "{}");
      },
      async () => {
        throw new NodeApiError(410, "{}");
      },
    );
    expect(await quiet(() => tokenAtClaim(both.client, "J1", "turns", old, NOW))).toBe(old);
  });

  // Node labels spec §4.3, §4.8: the live label is re-checked at refresh.
  test("a refresh refused because the agent was relabelled, or by the gate, is a LABEL_MISMATCH failure", async () => {
    const { BootFailure } = await import("../../src/gateway/core/failure-codes");
    const { GateDenied } = await import("../../src/node/client");
    const old = tokenIssued(10 * 60_000);
    const relabelled = fakeClient(async () => {
      throw new NodeApiError(409, JSON.stringify({ error: "the agent's node label changed", code: "LABEL_MISMATCH" }));
    });
    const e = await tokenAtClaim(relabelled.client, "J1", "turns", old, NOW).catch((x) => x);
    expect(e).toBeInstanceOf(BootFailure);
    expect(e.code).toBe("LABEL_MISMATCH");
    expect(relabelled.calls).toEqual(["refresh:J1"]); // no reissue
    const gated = fakeClient(async () => {
      throw new GateDenied(JSON.stringify({ code: "GATE_DENIED" }));
    });
    expect((await tokenAtClaim(gated.client, "J1", "turns", old, NOW).catch((x) => x)).code).toBe("LABEL_MISMATCH");
    // Another 409 is not a label change: the original token stands.
    const other = fakeClient(async () => {
      throw new NodeApiError(409, "{}");
    });
    expect(await quiet(() => tokenAtClaim(other.client, "J1", "turns", old, NOW))).toBe(old);
  });
});
