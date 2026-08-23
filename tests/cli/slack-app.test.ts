import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { openDb, type DbClient } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import * as SlackApps from "../../src/db/slack-apps";
import { main } from "../../src/cli/slack-app";

let dbc: DbClient;
let prevKey: string | undefined;

beforeAll(async () => {
  prevKey = process.env.SLAUDE_MASTER_KEY;
  process.env.SLAUDE_MASTER_KEY = randomBytes(32).toString("base64");
  __resetMasterKeyCache();
  dbc = await openDb({ dialect: "pg", driver: "pglite" });
  await runMigrations(dbc, { log: () => {} });
});

afterAll(async () => {
  await dbc.close();
  if (prevKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = prevKey;
  __resetMasterKeyCache();
});

function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return main(argv, {
    dbc,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env,
  }).then((code) => ({ code, out, err }));
}

describe("slack-app CLI", () => {
  it("add → list → remove round-trip, secrets never echoed", async () => {
    const add = await run([
      "add",
      "--api-app-id",
      "A0CLI",
      "--team-id",
      "T0CLI",
      "--bot-token",
      "xoxb-cli-secret-token",
      "--signing-secret",
      "cli-signing-secret",
      "--persona",
      "maria",
      "--bot-user-id",
      "U0CLI",
    ]);
    expect(add.code).toBe(0);
    expect(add.out.join("\n")).toContain("A0CLI/T0CLI");
    expect(add.out.join("\n")).toContain("persona=maria");
    expect(add.out.join("\n")).not.toContain("xoxb-cli-secret-token");
    expect(add.out.join("\n")).not.toContain("cli-signing-secret");

    const row = await SlackApps.find("A0CLI", "T0CLI", dbc);
    expect(row).not.toBeNull();
    expect(SlackApps.decryptTokens(row!).botToken).toBe("xoxb-cli-secret-token");

    const list = await run(["list"]);
    expect(list.code).toBe(0);
    expect(list.out.join("\n")).toContain("A0CLI/T0CLI");
    expect(list.out.join("\n")).not.toContain("xoxb-cli-secret-token");

    const rm = await run(["remove", "--api-app-id", "A0CLI", "--team-id", "T0CLI"]);
    expect(rm.code).toBe(0);
    const rmAgain = await run(["remove", "--api-app-id", "A0CLI", "--team-id", "T0CLI"]);
    expect(rmAgain.code).toBe(1);
    expect(rmAgain.out.join("\n")).toContain("no row");
  });

  it("add falls back to SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET env", async () => {
    const r = await run(
      ["add", "--api-app-id", "A0ENVV", "--team-id", "T0ENVV"],
      { SLACK_BOT_TOKEN: "xoxb-from-env", SLACK_SIGNING_SECRET: "sec-from-env" },
    );
    expect(r.code).toBe(0);
    const row = await SlackApps.find("A0ENVV", "T0ENVV", dbc);
    expect(SlackApps.decryptTokens(row!).signingSecret).toBe("sec-from-env");
  });

  it("empty list prints a hint", async () => {
    // Fresh scratch db for this one.
    const fresh = await openDb({ dialect: "pg", driver: "pglite" });
    await runMigrations(fresh, { log: () => {} });
    try {
      const r = await main(["list"], { dbc: fresh, out: () => {}, err: () => {} });
      expect(r).toBe(0);
    } finally {
      await fresh.close();
    }
  });

  it("validates arguments", async () => {
    expect((await run(["add", "--team-id", "T1"])).code).toBe(1);
    expect(
      (await run(["add", "--api-app-id", "A1", "--team-id", "T1"], {})).code, // no secrets anywhere
    ).toBe(1);
    expect((await run(["remove", "--api-app-id", "A1"])).code).toBe(1);
    expect((await run(["wat"])).code).toBe(1);
    expect((await run([])).code).toBe(1);
    const bad = await run(["add", "positional"]);
    expect(bad.code).toBe(1);
    expect(bad.err.join("\n")).toContain("unexpected argument");
    const dangling = await run(["add", "--api-app-id"]);
    expect(dangling.code).toBe(1);
    expect(dangling.err.join("\n")).toContain("requires a value");
    const flagValueFlag = await run(["add", "--api-app-id", "--team-id"]);
    expect(flagValueFlag.code).toBe(1);
  });

  it("refuses to run against the sqlite facade", async () => {
    // No dbc injected and SLAUDE_DB unset (tests default to sqlite).
    const err: string[] = [];
    const code = await main(["list"], { out: () => {}, err: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("SLAUDE_DB=pg");
  });

  it("surfaces a missing master key as a friendly error", async () => {
    const saved = process.env.SLAUDE_MASTER_KEY;
    delete process.env.SLAUDE_MASTER_KEY;
    __resetMasterKeyCache();
    try {
      const r = await run([
        "add",
        "--api-app-id",
        "A0KEY",
        "--team-id",
        "T0KEY",
        "--bot-token",
        "xoxb-x",
        "--signing-secret",
        "s",
      ]);
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain("SLAUDE_MASTER_KEY");
    } finally {
      process.env.SLAUDE_MASTER_KEY = saved;
      __resetMasterKeyCache();
    }
  });
});
