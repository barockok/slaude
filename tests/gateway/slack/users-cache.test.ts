import { afterEach, describe, expect, test } from "bun:test";
import { __resetUserNameCache, resolveUserName } from "../../../src/gateway/slack/users";

afterEach(() => __resetUserNameCache());

describe("resolveUserName", () => {
  test("a name is looked up once", async () => {
    let n = 0;
    const client: any = { users: { info: async () => (n++, { user: { real_name: "Alice" } }) } };
    expect(await resolveUserName(client, "U0CACHE01")).toBe("Alice");
    expect(await resolveUserName(client, "U0CACHE01")).toBe("Alice");
    expect(n).toBe(1);
  });

  test("a failed lookup is not repeated for each message, and shows the id", async () => {
    let n = 0;
    const client: any = { users: { info: async () => { n++; throw new Error("ratelimited"); } } };
    expect(await resolveUserName(client, "U0CACHE02")).toBe("U0CACHE02");
    expect(await resolveUserName(client, "U0CACHE02")).toBe("U0CACHE02");
    expect(await resolveUserName(client, "U0CACHE02")).toBe("U0CACHE02");
    expect(n).toBe(1);
  });
});
