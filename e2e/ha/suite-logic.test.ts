import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallRecord } from "../fake-slack/core/call-log";
import {
  adoptedCredentials,
  appsToAdopt,
  parseRegisteredApps,
  slackAppAddCommand,
  bootAnnotations,
  bootFingerprint,
  configEntries,
  dmChannelId,
  caseJournalRows,
  lastJournalSeq,
  lastSeq,
  maskSecrets,
  personaReplies,
  podUrls,
  registeredApps,
  restartDecision,
  seedCommand,
  soulBootProblems,
  stableCredentials,
  STARTUP_FILES_SCRIPT,
  unknownMethods,
  type MockJournalRow,
} from "./suite-logic";

const SEED = {
  personaId: "alpha",
  apiAppId: "A0APP",
  teamId: "T0TEAM",
  botToken: "tok-1",
  signingSecret: "sec-1",
  botUserId: "U0BOT",
};

test("the seed command sets the guard through env and passes every value as its own argv entry", () => {
  expect(seedCommand(SEED)).toEqual([
    "env", "SLAUDE_E2E_SEED=1", "bun", "/tmp/seed-persona.ts",
    "--persona-id", "alpha",
    "--api-app-id", "A0APP",
    "--team-id", "T0TEAM",
    "--bot-token", "tok-1",
    "--signing-secret", "sec-1",
    "--bot-user-id", "U0BOT",
  ]);
  expect(seedCommand(SEED, "/x/seed.ts")[3]).toBe("/x/seed.ts");
  expect(() => seedCommand({ ...SEED, signingSecret: "" })).toThrow(/signingSecret is empty/);
});

test("secrets are masked wherever they appear, and empty secrets are ignored", () => {
  expect(maskSecrets("a tok-1 b sec-1 c tok-1", ["tok-1", "sec-1", ""])).toBe("a (masked) b (masked) c (masked)");
});

test("stable credentials depend only on the app id and persona, and differ between apps", () => {
  const a = stableCredentials("A0ONE", "alpha");
  expect(stableCredentials("A0ONE", "alpha")).toEqual(a);
  expect(a.botUserId).toBe("U0BALPHA");
  expect(a.botToken).toMatch(new RegExp(`^${"xoxb"}-fake-[0-9a-f]{24}$`));
  expect(a.signingSecret).toMatch(/^[0-9a-f]{32}$/);
  const b = stableCredentials("A0TWO", "alpha");
  expect(b.botToken).not.toBe(a.botToken);
  expect(b.signingSecret).not.toBe(a.signingSecret);
  expect(() => stableCredentials("A0ONE", "Alpha-1")).toThrow(/lowercase/);
});

test("DM channel ids are Slack-shaped and unique per call", () => {
  expect(dmChannelId(() => Buffer.from([0, 1, 2, 25, 26, 31, 32, 63]))).toBe("D0E2EABCZ27A7");
  const ids = new Set(Array.from({ length: 200 }, () => dmChannelId()));
  expect(ids.size).toBe(200);
  for (const id of ids) expect(id).toMatch(/^D0E2E[A-Z2-7]{8}$/);
});

test("gateway pod URLs are sorted by pod name and skip pods without an IP", () => {
  expect(podUrls({ "gw-b": "10.0.0.2", "gw-a": "10.0.0.1", "gw-c": "" })).toEqual(["http://10.0.0.1:8080", "http://10.0.0.2:8080"]);
  expect(podUrls({ x: "10.0.0.9" }, 9000)).toEqual(["http://10.0.0.9:9000"]);
});

test("persona replies are bot messages carrying the bracketed persona label", () => {
  const msgs = [
    { user: "U0MGR", text: "[alpha] from a human" },
    { user: "U0BOT", text: "[alpha] hello" },
    { user: "U0BOT", text: "alpha without brackets" },
    { user: "U0BOT", text: "[beta] other persona" },
  ];
  expect(personaReplies(msgs, "U0BOT", "alpha")).toEqual([{ user: "U0BOT", text: "[alpha] hello" }]);
  expect(personaReplies([...msgs, { user: "U0OTHER", text: "[alpha] other bot" }], ["U0BOT", "U0OTHER"], "alpha")).toHaveLength(2);
  expect(personaReplies(msgs, [], "alpha")).toEqual([]);
});

const call = (seq: number, method: string, unknown?: boolean): CallRecord => ({ seq, at: 0, kind: "api", method, ok: !unknown, status: 200, unknown });

test("call-log marks and unknown-method extraction", () => {
  expect(lastSeq([])).toBe(0);
  expect(lastSeq([call(3, "a"), call(7, "b"), call(5, "c")])).toBe(7);
  expect(unknownMethods([call(1, "chat.postMessage"), call(2, "views.publish", true), call(3, "x.y", true)])).toEqual(["views.publish", "x.y"]);
});

test("journal marks come from the mock's seq, and a case's rows are those after the mark with its case param, in order", () => {
  const row = (seq: number, tag: string | null, params: Record<string, string> | null): MockJournalRow => ({
    seq, ts: 0, method: "POST", path: "/v1/messages", retryCount: 0, tag, tagParams: params, action: "proxy", messages: 1, historyHash: "h", persona: "alpha", offersReply: true,
  });
  expect(lastJournalSeq([])).toBe(0);
  const rows = [row(7, "echo", { case: "D1" }), row(5, "echo", { case: "D1" }), row(9, "echo", { case: "D1" }), row(8, null, null), row(10, "echo", { case: "D2" }), row(11, "think", { case: "D1" })];
  expect(lastJournalSeq(rows)).toBe(11);
  expect(caseJournalRows(rows, 5, "echo", "D1").map((r) => r.seq)).toEqual([7, 9]);
  expect(caseJournalRows(rows, 11, "echo", "D1")).toEqual([]);
});

const LIST = [
  "$ bun src/cli/slack-app.ts list",
  "A0TWO/T0TEAM  tenant=default persona=alpha bot_user=U0BALPHA updated=2026-10-01T07:39:33.976Z",
  "A0ONE/T0TEAM  tenant=default persona=alpha bot_user=U0B0003 updated=2026-10-01T07:34:49.564Z",
  "",
].join("\n");
const SUMS = (soul: string) =>
  [`${soul.repeat(64)}  /data/SOUL.md`, `${"b".repeat(64)}  /data/cache/soul.0123456789abcdef.json`, ""].join("\n");

test("registered apps drop the update stamp and the npm-style command echo, sorted", () => {
  expect(registeredApps(LIST)).toEqual([
    "A0ONE/T0TEAM tenant=default persona=alpha bot_user=U0B0003",
    "A0TWO/T0TEAM tenant=default persona=alpha bot_user=U0BALPHA",
  ]);
  expect(registeredApps("$ bun src/cli/slack-app.ts list\n(no apps)\n")).toEqual([]);
});

test("the boot fingerprint ignores order, paths and update stamps, and moves with content", () => {
  const base = bootFingerprint(SUMS("a"), LIST);
  expect(base).toMatch(/^[0-9a-f]{32}$/);
  const reordered = SUMS("a").split("\n").reverse().join("\n").replaceAll("/data/", "/other/");
  expect(bootFingerprint(reordered, LIST.replaceAll("2026-10-01", "2027-01-01"))).toBe(base);
  expect(bootFingerprint(SUMS("c"), LIST)).not.toBe(base);
  expect(bootFingerprint(SUMS("a"), LIST.replace("U0BALPHA", "U0B0004"))).not.toBe(base);
  expect(bootFingerprint(SUMS("a"), "")).not.toBe(base);
  expect(() => bootFingerprint(`${"b".repeat(64)}  /data/cache/x.json`, LIST)).toThrow(/no SOUL.md/);
});

test("the boot fingerprint moves with the env ConfigMap's data but not its metadata", () => {
  const cm = (data: Record<string, string>, rv: string) => JSON.stringify({ metadata: { resourceVersion: rv }, data });
  const base = bootFingerprint(SUMS("a"), LIST, cm({ A: "1", B: "2" }, "1"));
  expect(bootFingerprint(SUMS("a"), LIST, cm({ B: "2", A: "1" }, "99"))).toBe(base);
  expect(bootFingerprint(SUMS("a"), LIST, cm({ A: "1", B: "2", C: "3" }, "1"))).not.toBe(base);
  expect(bootFingerprint(SUMS("a"), LIST, cm({ A: "1", B: "changed" }, "1"))).not.toBe(base);
  expect(configEntries(cm({ b: "2", a: "1" }, "1"))).toEqual(["a=1", "b=2"]);
  expect(configEntries("{}")).toEqual([]);
});

test("registered apps parse into id, team, persona and bot user", () => {
  expect(parseRegisteredApps(LIST)).toEqual([
    { apiAppId: "A0TWO", teamId: "T0TEAM", personaId: "alpha", botUserId: "U0BALPHA" },
    { apiAppId: "A0ONE", teamId: "T0TEAM", personaId: "alpha", botUserId: "U0B0003" },
  ]);
  expect(parseRegisteredApps("$ bun src/cli/slack-app.ts list\n")).toEqual([]);
});

test("apps to adopt are the other apps in the fake's team", () => {
  const rows = [
    { apiAppId: "A0SUITE", teamId: "T0TEAM", personaId: "alpha", botUserId: "U0BALPHA" },
    { apiAppId: "A0OLD", teamId: "T0TEAM", personaId: "alpha", botUserId: "U0B0003" },
    { apiAppId: "A0ELSE", teamId: "T0OTHER", personaId: "default", botUserId: "U0X" },
  ];
  expect(appsToAdopt(rows, "A0SUITE", "T0TEAM").map((r) => r.apiAppId)).toEqual(["A0OLD"]);
});

test("adopted credentials are fixed per app, differ from the persona credentials, and keep a distinct bot user", () => {
  const a = adoptedCredentials("A0OLD");
  expect(adoptedCredentials("A0OLD")).toEqual(a);
  expect(a.botUserId).toMatch(/^U0B[A-Z2-7]{5}0$/);
  expect(a.botUserId).not.toBe(stableCredentials("A0OLD", "alpha").botUserId);
  expect(adoptedCredentials("A0OTHER").botToken).not.toBe(a.botToken);
  expect(a.signingSecret).toBe(stableCredentials("A0OLD", "x").signingSecret);
});

test("slack-app add for an adopted app passes every value as its own argv entry", () => {
  const cmd = slackAppAddCommand({ apiAppId: "A0OLD", teamId: "T0TEAM", personaId: "alpha", botUserId: "U0B0003" }, { botUserId: "U0BNEW", botToken: "tok", signingSecret: "sec" });
  expect(cmd.slice(0, 4)).toEqual(["sh", "-c", 'cd /app && exec bun src/cli/slack-app.ts "$@"', "slack-app"]);
  expect(cmd.slice(4)).toEqual(["add", "--api-app-id", "A0OLD", "--team-id", "T0TEAM", "--bot-token", "tok", "--signing-secret", "sec", "--bot-user-id", "U0BNEW", "--persona", "alpha"]);
});

test("boot annotations come back in the requested order, empty when absent", () => {
  const json = JSON.stringify({
    items: [
      { metadata: { name: "slaude-node", annotations: { "slaude-e2e/boot-fingerprint": "f9", other: "x" } } },
      { metadata: { name: "slaude-gateway" } },
    ],
  });
  expect(bootAnnotations(json, ["slaude-gateway", "slaude-node", "missing"])).toEqual(["", "f9", ""]);
  expect(bootAnnotations("{}", ["a"])).toEqual([""]);
});

test("a missing SOUL.md is a defined 'absent' state for the before-seed reading, and still an error after", () => {
  const noSoul = `${"b".repeat(64)}  /data/cache/soul.0123456789abcdef.json\n`;
  const absent = bootFingerprint(noSoul, LIST, "{}", { requireSoul: false });
  expect(absent).toMatch(/^[0-9a-f]{32}$/);
  expect(bootFingerprint("", LIST, "{}", { requireSoul: false })).not.toBe(absent);
  expect(absent).not.toBe(bootFingerprint(SUMS("a"), LIST, "{}", { requireSoul: false }));
  expect(bootFingerprint(SUMS("a"), LIST, "{}", { requireSoul: false })).toBe(bootFingerprint(SUMS("a"), LIST));
  expect(() => bootFingerprint(noSoul, LIST, "{}", { requireSoul: true })).toThrow(/no SOUL.md/);
  // absent before, written by the seed after: the seed changed the boot state, so the pods restart
  expect(restartDecision({ before: absent, after: bootFingerprint(SUMS("a"), LIST), booted: [absent, absent] }).restart).toBe(true);
});

test("restart when the seed changed something, or the pods booted with other state; otherwise not", () => {
  expect(restartDecision({ before: "f1", after: "f2", booted: ["f2", "f2"] }).restart).toBe(true);
  expect(restartDecision({ before: "f1", after: "f1", booted: ["", ""] })).toEqual({ restart: true, reason: expect.stringContaining("booted before") });
  expect(restartDecision({ before: "f1", after: "f1", booted: ["f1", "f0"] }).restart).toBe(true);
  expect(restartDecision({ before: "f1", after: "f1", booted: [] }).restart).toBe(true);
  expect(restartDecision({ before: "f1", after: "f1", booted: ["f1", "f1"] })).toEqual({ restart: false, reason: expect.stringContaining("nothing") });
});

describe("a gateway that booted without the seeded soul is named, with the cause", () => {
  // The two lines src/soul/extract.ts logs, in the shape it logs them.
  const invalid = "[soul] cache invalid at /data/cache/soul.0123456789abcdef.json, re-extracting: unsigned entry";
  const fallback = "[soul] LLM extraction failed, falling back to regex parser: Error: extractor http 500";
  const clean = "[db] pg (bun-sql) ready\n[persona] multi-persona mode: alpha\n";

  test("clean boots report nothing", () => {
    expect(soulBootProblems({ "slaude-gateway-a": clean, "slaude-gateway-b": clean })).toEqual([]);
    expect(soulBootProblems({})).toEqual([]);
  });

  test("a rejected entry and the fallback are each named, per pod, with the log line", () => {
    const got = soulBootProblems({ "slaude-gateway-b": `${clean}${invalid}\n${fallback}\n`, "slaude-gateway-a": clean });
    expect(got).toHaveLength(2);
    expect(got[0]).toStartWith("slaude-gateway-b: the seeded soul cache entry was rejected");
    expect(got[0]).toContain("unsigned entry");
    expect(got[1]).toStartWith("slaude-gateway-b: the soul cache missed");
    expect(got[1]).toContain("no manager");
  });

  test("pods come out in name order and long lines are cut", () => {
    const got = soulBootProblems({ z: fallback, a: `${invalid}${"x".repeat(1000)}` });
    expect(got.map((l) => l.split(":")[0])).toEqual(["a", "z"]);
    expect(got[0]!.length).toBeLessThan(450);
  });

  test("the markers are what src/soul/extract.ts logs", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/soul/extract.ts"), "utf8");
    expect(src).toContain("[soul] cache invalid at ${cp}, re-extracting: ${hit.why}");
    expect(src).toContain("[soul] LLM extraction failed, falling back to regex parser:");
  });
});

describe("the startup-files command reads the soul cache where extraction does", () => {
  let tmp = "";
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "startup-files-"));
    for (const d of ["home/cache", "pod-cache"]) mkdirSync(join(tmp, d), { recursive: true });
    writeFileSync(join(tmp, "home/SOUL.md"), "soul");
    writeFileSync(join(tmp, "home/cache/soul.aaaaaaaaaaaaaaaa.json"), "in home");
    writeFileSync(join(tmp, "pod-cache/soul.bbbbbbbbbbbbbbbb.json"), "in the override");
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const run = (env: Record<string, string>) => {
    const r = Bun.spawnSync(["/bin/sh", "-c", STARTUP_FILES_SCRIPT], {
      env: { PATH: process.env.PATH!, SLAUDE_HOME: join(tmp, "home"), ...env },
    });
    expect(r.exitCode).toBe(0);
    return r.stdout.toString();
  };
  const names = (out: string) =>
    out.trim().split("\n").filter(Boolean).map((l) => l.slice(l.lastIndexOf("/") + 1)).sort();

  test("SLAUDE_SOUL_CACHE_DIR set: that directory, not $SLAUDE_HOME/cache", () => {
    expect(names(run({ SLAUDE_SOUL_CACHE_DIR: join(tmp, "pod-cache") }))).toEqual(["SOUL.md", "soul.bbbbbbbbbbbbbbbb.json"]);
  });

  test("unset or empty: $SLAUDE_HOME/cache", () => {
    expect(names(run({}))).toEqual(["SOUL.md", "soul.aaaaaaaaaaaaaaaa.json"]);
    expect(names(run({ SLAUDE_SOUL_CACHE_DIR: "" }))).toEqual(["SOUL.md", "soul.aaaaaaaaaaaaaaaa.json"]);
  });

  test("its output is what bootFingerprint takes, and a different cache entry moves the fingerprint", () => {
    const home = bootFingerprint(run({}), LIST);
    const pod = bootFingerprint(run({ SLAUDE_SOUL_CACHE_DIR: join(tmp, "pod-cache") }), LIST);
    expect(home).toMatch(/^[0-9a-f]{32}$/);
    expect(pod).not.toBe(home);
  });

  test("missing files are not an error", () => {
    expect(run({ SLAUDE_HOME: join(tmp, "nowhere") })).toBe("");
  });
});
