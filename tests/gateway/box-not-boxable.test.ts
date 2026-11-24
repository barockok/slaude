/**
 * A persona that names a box and cannot be boxed (box spec, "The provider
 * proxy is a hard requirement"): its provider credential is of a form the
 * provider proxy cannot serve. Where the deployment runs such a persona
 * unboxed (SLAUDE_BOX_UNBOXED=allow, the default) it stays unboxed; where it
 * does not (refuse), the turn is refused with its own notice. The credential
 * is never put into a box.
 *
 * Which forms are boxable is one constant, BOX_SUPPORTED_PROVIDER_FORMS. Today
 * it holds all three (the assumption before the provider spike), so these
 * tests take a form out of it and put it back.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { boxUnboxedFallbackValue, env } from "../../src/config/env";
import { withoutForm } from "../helpers/box-forms";
import { BOX_SUPPORTED_PROVIDER_FORMS, unboxableProviderForms } from "../../src/box/provider-forms";
import { defaultBoxPolicy } from "../../src/box/policy";
import { BoxNotBoxableError, BoxUnavailableError, __resetBoxPinForTests, defaultBoxPinDeps, sessionBoxPin, type BoxPinDeps } from "../../src/gateway/core/box-pin";
import type { BoxVersion } from "../../src/gateway/core/box-registry";
import { makeQueueDispatch } from "../../src/gateway/core/dispatch";
import { failureText, isFailureCode } from "../../src/gateway/core/failure-codes";
import { bundleFetchFailure, NodeApiError } from "../../src/node/client";
import type { SessionRow } from "../../src/db/schema";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const CUR: BoxVersion = { name: "ruby-dev", version: 1, image: `ghcr.io/example/boxes/ruby-dev@${digest("a")}`, digest: digest("a"), policy: defaultBoxPolicy(), forced: false };
const CTX = { tenant: "default", persona: "ana", sessionId: "S-box" };

/** Pin deps over the REAL form check, with a persona whose provider declares `provider`. */
function deps(o: { provider: Record<string, unknown>; unboxedAllowed: boolean }) {
  const pins = new Map<string, { name: string; digest: string }>();
  const audits: unknown[] = [];
  const d: BoxPinDeps = {
    enabled: () => true,
    boxNameFor: () => "ruby-dev",
    unboxableForms: () => unboxableProviderForms(o.provider),
    unboxedAllowed: () => o.unboxedAllowed,
    current: async () => CUR,
    pinned: async () => CUR,
    read: async (id) => pins.get(id) ?? null,
    pin: async (id, box) => {
      const had = pins.get(id);
      if (!had) pins.set(id, box);
      return { ...(had ?? box), pinned: !had };
    },
    audit: (e) => void audits.push(e),
  };
  return { d, pins, audits };
}

describe("SLAUDE_BOX_UNBOXED", () => {
  const saved = process.env.SLAUDE_BOX_UNBOXED;
  afterEach(() => {
    if (saved === undefined) delete process.env.SLAUDE_BOX_UNBOXED;
    else process.env.SLAUDE_BOX_UNBOXED = saved;
  });

  test("allow is the default; refuse is the only other value; anything else is an error, never read as allow", () => {
    expect(boxUnboxedFallbackValue(undefined)).toBe(true);
    expect(boxUnboxedFallbackValue("")).toBe(true);
    expect(boxUnboxedFallbackValue(" Allow ")).toBe(true);
    expect(boxUnboxedFallbackValue("refuse")).toBe(false);
    expect(() => boxUnboxedFallbackValue("no")).toThrow("SLAUDE_BOX_UNBOXED must be allow or refuse");
    delete process.env.SLAUDE_BOX_UNBOXED;
    expect(env.box.unboxedFallback()).toBe(true);
    expect(defaultBoxPinDeps.unboxedAllowed()).toBe(true);
    process.env.SLAUDE_BOX_UNBOXED = "refuse";
    expect(env.box.unboxedFallback()).toBe(false);
    expect(defaultBoxPinDeps.unboxedAllowed()).toBe(false);
  });
});

describe("sessionBoxPin and a form no box can serve", () => {
  beforeEach(() => __resetBoxPinForTests());

  test("with every form supported (today's constant) an OAuth-token persona is boxed, whatever the switch says", async () => {
    for (const unboxedAllowed of [true, false]) {
      const s = deps({ provider: { oauthToken: "env://PERSONA_ANA_OAUTH" }, unboxedAllowed });
      expect(await sessionBoxPin(CTX, s.d)).toEqual({ name: "ruby-dev", digest: digest("a"), tier: "gvisor" });
    }
  });

  test("the form taken out of the constant, unboxed runs allowed: unboxed, never pinned", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withoutForm("oauth-token", async () => {
        const s = deps({ provider: { oauthToken: "env://PERSONA_ANA_OAUTH" }, unboxedAllowed: true });
        expect(await sessionBoxPin(CTX, s.d)).toBeNull();
        expect(s.pins.size).toBe(0);
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("the form taken out of the constant, unboxed runs refused: the pin throws, names the form, pins nothing", async () => {
    await withoutForm("oauth-token", async () => {
      const s = deps({ provider: { oauthToken: "env://PERSONA_ANA_OAUTH" }, unboxedAllowed: false });
      const e = await sessionBoxPin(CTX, s.d).catch((x) => x);
      expect(e).toBeInstanceOf(BoxNotBoxableError);
      expect(e).toBeInstanceOf(BoxUnavailableError);
      expect((e as BoxNotBoxableError).forms).toEqual(["oauth-token"]);
      expect((e as BoxNotBoxableError).box).toBe("ruby-dev");
      // The reference to the credential is not in the message, only the form's name.
      expect((e as Error).message).not.toContain("PERSONA_ANA_OAUTH");
      expect(s.pins.size).toBe(0);
      expect(s.audits).toHaveLength(0);
    });
  });

  test("a persona on a supported form is boxed in refuse mode, and one that names no box is untouched", async () => {
    await withoutForm("oauth-token", async () => {
      const ok = deps({ provider: { apiKey: "env://PERSONA_ANA_KEY" }, unboxedAllowed: false });
      expect((await sessionBoxPin(CTX, ok.d))!.digest).toBe(digest("a"));
      const none = deps({ provider: { oauthToken: "env://PERSONA_ANA_OAUTH" }, unboxedAllowed: false });
      none.d.boxNameFor = () => null;
      expect(await sessionBoxPin(CTX, none.d)).toBeNull();
    });
  });

  test("the constant is back as it was after each of these", () => {
    expect([...BOX_SUPPORTED_PROVIDER_FORMS].sort()).toEqual(["api-key", "auth-token", "oauth-token"]);
  });
});

describe("dispatch and a persona that cannot be boxed", () => {
  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
    __resetBoxPinForTests();
  });

  function harness(box: (ctx: { tenant: string; persona: string; sessionId: string }) => Promise<{ name: string; digest: string; tier: "none" | "bwrap" | "gvisor" } | null>) {
    const enqueued: unknown[] = [];
    const events: any[] = [];
    const dispatch = makeQueueDispatch({ emit: (_n: string, e: any) => (events.push(e), true), resolveEffectiveIdentity: async () => undefined } as any, {
      needsGuardrails: async () => false,
      box,
      guardrailWaitMs: 40,
      guardrailPollMs: 5,
      infra: {
        turns: {
          enqueueTurn: async (job: any, target: any) => {
            enqueued.push({ job, target });
            return { queue: "turns", jobId: "J1", coalesced: false };
          },
          queue: () => ({ getJob: async () => ({ getState: async () => "active" }) }),
          movedTo: async () => null,
          close: async () => {},
        } as any,
        registry: { lookup: async () => null, nodeCarries: async () => true, nodeCaps: async () => new Set<string>(), liveNodesWithCap: async () => [], close: async () => {} } as any,
        pubsub: { consumeAbortFlag: async () => null, lastEventId: async () => null, appendEvent: async () => {}, readEvents: async () => [], close: async () => {} } as any,
      },
    });
    return { enqueued, events, dispatch };
  }
  const META = { teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "U1", personaId: "ana" };
  const S = { id: "S-box" } as unknown as SessionRow;

  test("refuse: nothing is enqueued and the thread gets the not-boxable notice, not the broken-box one", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await withoutForm("oauth-token", async () => {
        const s = deps({ provider: { oauthToken: "env://PERSONA_ANA_OAUTH" }, unboxedAllowed: false });
        const h = harness((ctx) => sessionBoxPin(ctx, s.d));
        await h.dispatch.dispatch(S, "hi", META);
        expect(h.enqueued).toHaveLength(0);
        expect(h.events).toEqual([{ type: "error", sessionId: "S-box", error: "the agent cannot be boxed and unboxed runs are refused", code: "BOX_NOT_BOXABLE" }]);
      });
    } finally {
      err.mockRestore();
    }
  });

  test("allow: the turn is dispatched unboxed, with no box capability required", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withoutForm("oauth-token", async () => {
        const s = deps({ provider: { oauthToken: "env://PERSONA_ANA_OAUTH" }, unboxedAllowed: true });
        const h = harness((ctx) => sessionBoxPin(ctx, s.d));
        await h.dispatch.dispatch(S, "hi", META);
        expect(h.enqueued).toHaveLength(1);
        expect((h.enqueued[0] as any).job.requiresCaps).toBeUndefined();
        expect(h.events).toEqual([]);
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("the notice says what an operator can do, and names no credential", () => {
    expect(isFailureCode("BOX_NOT_BOXABLE")).toBe(true);
    const text = failureText("BOX_NOT_BOXABLE");
    expect(text).toContain("sandbox");
    expect(text).toContain("API key or an auth token");
  });

  test("a node that is refused the bundle for this reason fails the boot with the same code, not as a credential outage", () => {
    const f = bundleFetchFailure(new NodeApiError(503, JSON.stringify({ error: "agent cannot be boxed", code: "BOX_NOT_BOXABLE", transient: false })));
    expect(f.code).toBe("BOX_NOT_BOXABLE");
    expect(f.transient).toBe(false);
    expect(bundleFetchFailure(new NodeApiError(503, JSON.stringify({ code: "BOX_UNAVAILABLE", transient: false }))).code).toBe("BOX_UNAVAILABLE");
  });
});
