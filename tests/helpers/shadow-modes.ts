/**
 * Shared harness for the slice C wiring tests (tasks 14 to 18): every wired
 * site must return its legacy value under each SLAUDE_ACCESS_SOURCE mode and
 * when the resolver or the engine is broken or disagrees. A group's test file
 * supplies one scenario (what the site decided, as a plain value) and its
 * expected baseline; this runs it under the whole matrix.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as Authority from "../../src/access/authority";
import { __resetDecide } from "../../src/access/decide";
import { settleShadows } from "../../src/access/wired";
import * as Domain from "../../src/db/domain";
import { metrics } from "../../src/metrics";
import * as Actor from "../../src/refs/actor";

export const MODES = ["legacy", "shadow", "internal"] as const;
export type Break = "none" | "resolver_throws" | "engine_throws" | "engine_disagrees";
export const BREAKS: Break[] = ["none", "resolver_throws", "engine_throws", "engine_disagrees"];

export function breakIt(how: Break): void {
  if (how === "resolver_throws") {
    spyOn(Actor, "actingUser").mockRejectedValue(new Error("db down"));
    spyOn(Actor, "sameUser").mockRejectedValue(new Error("db down"));
    spyOn(Domain, "findBinding").mockRejectedValue(new Error("db down"));
  } else if (how === "engine_throws") {
    for (const f of ["admitInternal", "roleInternal", "usersWithRoleInternal", "isDeniedInternal"] as const) {
      spyOn(Authority, f).mockImplementation(() => {
        throw new Error("engine bug");
      });
    }
    spyOn(Actor, "sameUser").mockImplementation(() => {
      throw new Error("engine bug");
    });
  } else if (how === "engine_disagrees") {
    spyOn(Authority, "admitInternal").mockReturnValue({ ok: true });
    spyOn(Authority, "roleInternal").mockReturnValue("manager");
    spyOn(Authority, "isDeniedInternal").mockReturnValue(true);
    spyOn(Authority, "usersWithRoleInternal").mockReturnValue([]);
    spyOn(Actor, "sameUser").mockResolvedValue(true);
  }
}

function raw(text: string, name: string, labels: Record<string, string>): number {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  return text
    .split("\n")
    .filter((l) => l.startsWith(name + "{") && want.every((w) => l.includes(w)))
    .reduce((sum, l) => sum + Number(l.split(" ").pop()), 0);
}

let baseline = "";
/** A counter's increase since this test started. */
export const count = (name: string, labels: Record<string, string>): number => raw(metrics.render(), name, labels) - raw(baseline, name, labels);

/** Decisions the legacy path counted for a site, plus shadow outcomes that compared. */
export const decisions = (site: string): number => count("slaude_access_decision_total", { source: "legacy", site });
export const compared = (site: string): number =>
  ["match", "mismatch", "new_error"].reduce((n, outcome) => n + count("slaude_access_shadow_total", { site, outcome }), 0);

/** Register the per-test environment: a clean domain store, no source override, quiet logs. Call at describe or file level. */
export function useShadowEnv(extra?: { before?: () => void | Promise<void>; after?: () => void | Promise<void> }): void {
  let saved: string | undefined;
  beforeEach(async () => {
    await settleShadows();
    baseline = metrics.render();
    saved = process.env.SLAUDE_ACCESS_SOURCE;
    delete process.env.SLAUDE_ACCESS_SOURCE;
    await Domain._wipeForTests();
    Actor.invalidateActors();
    __resetDecide();
    spyOn(console, "warn").mockImplementation(() => {});
    await extra?.before?.();
  });
  afterEach(async () => {
    await settleShadows();
    await extra?.after?.();
    if (saved === undefined) delete process.env.SLAUDE_ACCESS_SOURCE;
    else process.env.SLAUDE_ACCESS_SOURCE = saved;
    mock.restore();
  });
}

/** One test per (mode, break): the scenario's decisions equal `expected`. Also run once with source=legacy as the baseline. */
export function legacyUnderEveryMode<T>(label: string, scenario: () => Promise<T>, expected: Awaited<T>): void {
  test(`${label}: the legacy baseline`, async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "legacy";
    expect(await scenario()).toEqual(expected);
  });
  for (const mode of MODES) {
    for (const how of BREAKS) {
      test(`${label}: ${mode} source, ${how}: same decisions as the baseline`, async () => {
        process.env.SLAUDE_ACCESS_SOURCE = mode;
        breakIt(how);
        expect(await scenario()).toEqual(expected);
        await settleShadows();
      });
    }
  }
}

/**
 * Like {@link legacyUnderEveryMode}, with the baseline taken by running the
 * scenario first under source=legacy (it must reset its own state, since it
 * runs again). For scenarios whose outcome is a transcript, not a few values.
 */
export function sameAsLegacyBaseline<T>(label: string, scenario: () => Promise<T>, sanity?: (baseline: T) => void): void {
  test(`${label}: the legacy baseline is sane`, async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "legacy";
    sanity?.(await scenario());
  });
  for (const mode of MODES) {
    for (const how of BREAKS) {
      test(`${label}: ${mode} source, ${how}: same as the legacy baseline`, async () => {
        process.env.SLAUDE_ACCESS_SOURCE = "legacy";
        const want = await scenario();
        await settleShadows();
        process.env.SLAUDE_ACCESS_SOURCE = mode;
        breakIt(how);
        expect(await scenario()).toEqual(want);
        await settleShadows();
      });
    }
  }
}
