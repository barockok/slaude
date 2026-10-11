/**
 * Opening a 1:1 nudges an unlinked person towards the portal.
 *
 * The two properties worth pinning: it never blocks the 1:1, and it never posts
 * a link anywhere but privately.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { nudgeOnboarding } from "../../../src/gateway/portal/onboarding-nudge";

const WHO = { teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" };
let said: string[];

const deps = (over: Parameters<typeof nudgeOnboarding>[1] = {}) => ({
  enabled: () => true,
  accountFor: async () => null,
  publicUrl: () => "https://slaude.example.com",
  mint: () => "signed-link-token",
  sayEphemeral: async (text: string) => {
    said.push(text);
  },
  ...over,
});

beforeEach(() => {
  said = [];
});

describe("the 1:1 entry check", () => {
  test("an unlinked person gets exactly one private message, with a link", async () => {
    expect(await nudgeOnboarding(WHO, deps())).toBe("posted");
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("https://slaude.example.com/portal/link?t=signed-link-token");
  });

  test("a linked person gets nothing", async () => {
    expect(await nudgeOnboarding(WHO, deps({ accountFor: async () => ({ id: "acct-1" }) }))).toBe("already-linked");
    expect(said).toEqual([]);
  });

  test("with the portal disabled nothing is posted, since there is nowhere to send them", async () => {
    expect(await nudgeOnboarding(WHO, deps({ enabled: () => false }))).toBe("portal-disabled");
    expect(said).toEqual([]);
  });

  // The link binds whoever redeems it. A channel-visible copy lets a bystander
  // bind the wrong Slack identity, so a surface that cannot whisper says nothing.
  test("a surface that cannot post privately posts nothing at all", async () => {
    expect(await nudgeOnboarding(WHO, { ...deps(), sayEphemeral: undefined })).toBe("no-private-surface");
    expect(said).toEqual([]);
  });

  test("the account lookup is the one the binding uses, team and user both", async () => {
    const seen: Array<[string, string]> = [];
    await nudgeOnboarding(WHO, deps({
      accountFor: async (t: string, u: string) => {
        seen.push([t, u]);
        return null;
      },
    }));
    expect(seen).toEqual([["TTESTTEAM1", "UTESTUSER1"]]);
  });
});
