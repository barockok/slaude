import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __setDecisionDepsForTests, remoteDecision, turnKindOf, type DecisionInput } from "../../../src/remote/definitions/decision";
import { activeRemoteTarget } from "../../../src/remote/active";
import { bindShared, insertPersonal, insertShared, reset } from "./helpers";
import * as Envs from "../../../src/db/environments";
import * as OneOnOne from "../../../src/db/one-on-one";

const base: DecisionInput = { tenant: "default", persona: "agent-a", channel: "C0EXAMPLE", thread: "1.1", turnKind: "interactive" };
const allow = (map: Record<string, string[]>) => async (_t: string, p: string) => map[p] ?? [];
const on = () => true;

beforeEach(async () => {
  await reset();
});
afterEach(() => __setDecisionDepsForTests(null));

describe("remoteDecision: shared environments", () => {
  test("the allowing agent gets the target, with the provisioned trust class and no owner lock", async () => {
    await bindShared(await insertShared());
    const d = await remoteDecision(base, { allowed: allow({ "agent-a": ["team-sandbox"] }), remoteEnabled: on });
    expect("target" in d && d.target.env).toMatchObject({ kind: "ssh", trust: "provisioned", name: "team-sandbox" });
  });

  test("finding 1: agent B in the same thread, bound by A, is refused (never 'run locally')", async () => {
    await bindShared(await insertShared());
    const deps = { allowed: allow({ "agent-a": ["team-sandbox"] }), remoteEnabled: on };
    const b = await remoteDecision({ ...base, persona: "agent-b" }, deps);
    expect("refused" in b).toBe(true);
    expect("none" in b).toBe(false);
  });

  test("a persona with no environment key (empty policy) is refused; an undefined persona is refused", async () => {
    await bindShared(await insertShared());
    expect("refused" in (await remoteDecision(base, { allowed: allow({}), remoteEnabled: on }))).toBe(true);
    expect("refused" in (await remoteDecision({ ...base, persona: undefined }, { allowed: allow({ "agent-a": ["team-sandbox"] }), remoteEnabled: on }))).toBe(true);
  });

  test("an allow entry for another name does not allow this one", async () => {
    await bindShared(await insertShared());
    expect("refused" in (await remoteDecision(base, { allowed: allow({ "agent-a": ["other"] }), remoteEnabled: on }))).toBe(true);
  });

  test("a retired row is refused", async () => {
    await bindShared(await insertShared({ retired: true }));
    expect("refused" in (await remoteDecision(base, { allowed: allow({ "agent-a": ["team-sandbox"] }), remoteEnabled: on }))).toBe(true);
  });

  test("another tenant's row is refused even when the name is allowed", async () => {
    await bindShared(await insertShared({ tenant: "default" }));
    const d = await remoteDecision({ ...base, tenant: "other-tenant" }, { allowed: allow({ "agent-a": ["team-sandbox"] }), remoteEnabled: on });
    expect("refused" in d).toBe(true);
  });

  test("scheduled, background and unknown turns are refused with their own wording", async () => {
    await bindShared(await insertShared());
    const deps = { allowed: allow({ "agent-a": ["team-sandbox"] }), remoteEnabled: on };
    for (const k of ["scheduled", "background", "other"] as const) {
      const d = await remoteDecision({ ...base, turnKind: k }, deps);
      expect("refused" in d && d.refused.message).toContain("scheduled and background turns do not run on shared environments");
    }
  });

  test("turnKindOf: only slack and panel origins are interactive; wake and background runs never are", () => {
    expect(turnKindOf({ origin: "slack" })).toBe("interactive");
    expect(turnKindOf({ origin: "panel" })).toBe("interactive");
    expect(turnKindOf({ origin: "cron" })).toBe("scheduled");
    expect(turnKindOf({})).toBe("other");
    expect(turnKindOf({ origin: "slack", wake: { maxTurns: 1 } })).toBe("background");
    expect(turnKindOf({ origin: "slack", backgroundRunId: "run1" })).toBe("background");
  });

  test("remote mode off refuses a shared row", async () => {
    await bindShared(await insertShared());
    expect("refused" in (await remoteDecision(base, { allowed: allow({ "agent-a": ["team-sandbox"] }), remoteEnabled: () => false }))).toBe(true);
  });

  test("a policy lookup that throws is a refusal", async () => {
    await bindShared(await insertShared());
    const d = await remoteDecision(base, { allowed: async () => { throw new Error("db down"); }, remoteEnabled: on });
    expect("refused" in d).toBe(true);
  });

  test("a row whose config lacks the explicit opt-ins is refused, and trusts as a user machine", async () => {
    const id = await insertShared({ config: { host: "build-box.example.com", user: "dev", port: "22" } });
    await bindShared(id);
    expect("refused" in (await remoteDecision(base, { allowed: allow({ "agent-a": ["team-sandbox"] }), remoteEnabled: on }))).toBe(true);
    // And through the raw target: the lock rule makes it null, which the decision turns into a refusal above.
    expect(await activeRemoteTarget("C0EXAMPLE", "1.1")).toBeNull();
  });

  test("a bound shared row that yields no target is a refusal", async () => {
    await bindShared(await insertShared());
    const d = await remoteDecision(base, { allowed: allow({ "agent-a": ["team-sandbox"] }), remoteEnabled: on, lookup: async () => null });
    expect("refused" in d).toBe(true);
  });
});

describe("remoteDecision: personal environments and unbound threads are untouched", () => {
  test("no binding is none", async () => {
    expect(await remoteDecision(base)).toEqual({ none: true });
  });

  test("a personal row gives exactly what activeRemoteTarget gives, whoever asks and whatever the turn kind", async () => {
    const id = await insertPersonal();
    await Envs.bind({ channelId: "C0EXAMPLE", threadTs: "1.1", envId: id, dir: "/home/dev", lockByEnv: false });
    // No lock: a user-machine environment yields no target, and the decision says the same.
    expect(await remoteDecision({ ...base, persona: undefined, turnKind: "other" })).toEqual({ none: true });
    await OneOnOne.lock({ channelId: "C0EXAMPLE", threadTs: "1.1", lockedUser: "U0EXAMPLE", createdBy: "U0EXAMPLE", teamId: "T0EXAMPLE" } as never).catch(() => {});
    const raw = await activeRemoteTarget("C0EXAMPLE", "1.1");
    const d = await remoteDecision({ ...base, persona: "agent-z", turnKind: "scheduled" });
    expect(d).toEqual(raw ? { target: raw } : { none: true });
  });
});
