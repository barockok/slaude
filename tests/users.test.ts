import { describe, expect, test } from "bun:test";
import { resolveUserName } from "../src/gateway/slack/users";

function fakeClient(impl: (id: string) => any) {
  let calls = 0;
  return {
    calls: () => calls,
    users: {
      info: async ({ user }: any) => {
        calls++;
        return impl(user);
      },
    },
  } as any;
}

describe("resolveUserName", () => {
  test("display_name preferred", async () => {
    const c = fakeClient(() => ({
      user: { profile: { display_name_normalized: "alice" } },
    }));
    expect(await resolveUserName(c, "U1A")).toBe("alice");
  });

  test("falls through real_name → name → id", async () => {
    const c = fakeClient(() => ({ user: { name: "bob" } }));
    expect(await resolveUserName(c, "U1B")).toBe("bob");
    const c2 = fakeClient(() => ({ user: {} }));
    expect(await resolveUserName(c2, "U1C")).toBe("U1C");
  });

  test("caches on second call", async () => {
    const c = fakeClient(() => ({ user: { name: "carol" } }));
    expect(await resolveUserName(c, "U1D")).toBe("carol");
    expect(await resolveUserName(c, "U1D")).toBe("carol");
    expect(c.calls()).toBe(1);
  });

  test("error → returns id", async () => {
    const c = fakeClient(() => {
      throw new Error("nope");
    });
    expect(await resolveUserName(c, "U1E")).toBe("U1E");
  });
});
