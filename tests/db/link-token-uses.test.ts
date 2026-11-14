import { beforeEach, describe, expect, test } from "bun:test";
import { claimLinkToken, countLinkTokenUses, purgeExpiredLinkTokens } from "../../src/db/link-token-uses";
import { db } from "../../src/db/schema";

const use = (jti: string, expiresAt: number) => ({ jti, teamId: "T0EXAMPLE", slackUserId: "U0EXAMPLE", expiresAt });

beforeEach(async () => {
  await db.run("DELETE FROM link_token_uses");
});

describe("link token ledger", () => {
  test("the first claim wins and a second is refused", async () => {
    expect(await claimLinkToken(use("j1", 10_000), db, 1)).toBe(true);
    expect(await claimLinkToken(use("j1", 10_000), db, 2)).toBe(false);
    expect(await claimLinkToken(use("j2", 10_000), db, 2)).toBe(true);
    expect(await countLinkTokenUses()).toBe(2);
  });

  test("concurrent claims of one jti have exactly one winner", async () => {
    const wins = await Promise.all(Array.from({ length: 5 }, () => db.transaction((tx) => claimLinkToken(use("race", 10_000), tx, 1))));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  test("purge removes only rows whose token has expired", async () => {
    await claimLinkToken(use("old", 1_000), db, 1);
    await claimLinkToken(use("edge", 2_000), db, 1);
    await claimLinkToken(use("live", 3_000), db, 1);
    expect(await purgeExpiredLinkTokens(db, 2_000)).toBe(2);
    expect(await countLinkTokenUses()).toBe(1);
    expect(await claimLinkToken(use("live", 3_000), db, 5)).toBe(false);
  });
});
