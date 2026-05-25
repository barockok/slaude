import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Presence } from "../src/gateway/slack/presence";

const mockSetCalls: any[] = [];
let shouldThrow: any = null;

beforeEach(() => {
  mockSetCalls.length = 0;
  shouldThrow = null;
  // Hijack require("@slack/web-api") to return a stub WebClient.
  const Module = require("node:module");
  const orig = Module.prototype.require;
  (Module.prototype as any)._origRequire = orig;
  Module.prototype.require = function (id: string) {
    if (id === "@slack/web-api") {
      return {
        WebClient: class {
          users = {
            profile: {
              set: async (a: any) => {
                mockSetCalls.push(a);
                if (shouldThrow) throw shouldThrow;
              },
            },
          };
          constructor(token: string) {
            (this as any).__token = token;
          }
        },
      };
    }
    return orig.call(this, id);
  };
});

afterEach(() => {
  const Module = require("node:module");
  if ((Module.prototype as any)._origRequire) {
    Module.prototype.require = (Module.prototype as any)._origRequire;
    delete (Module.prototype as any)._origRequire;
  }
  delete process.env.SLACK_USER_TOKEN;
});

describe("Presence", () => {
  test("disabled when SLACK_USER_TOKEN missing", async () => {
    delete process.env.SLACK_USER_TOKEN;
    const p = new Presence({} as any);
    p.enter("S", { text: "busy", emoji: ":robot:" });
    p.exit("S");
    expect(mockSetCalls.length).toBe(0);
  });

  test("enter / exit toggles status with user token", async () => {
    process.env.SLACK_USER_TOKEN = "xoxp-T";
    const p = new Presence({} as any);
    p.enter("S1", { text: "busy", emoji: ":robot:" });
    p.enter("S2", { text: "busy", emoji: ":robot:" }); // dedup → no extra call
    await new Promise((r) => setTimeout(r, 10));
    expect(mockSetCalls.length).toBe(1);
    expect(mockSetCalls[0].profile.status_text).toBe("busy");

    p.exit("S1");
    await new Promise((r) => setTimeout(r, 5));
    // still active S2 → no clear yet
    expect(mockSetCalls.length).toBe(1);
    p.exit("S2");
    await new Promise((r) => setTimeout(r, 10));
    expect(mockSetCalls.length).toBe(2);
    expect(mockSetCalls[1].profile.status_text).toBe("");
  });

  test("not_allowed_token_type auto-disables", async () => {
    process.env.SLACK_USER_TOKEN = "xoxp-bad";
    shouldThrow = Object.assign(new Error("nope"), { data: { error: "not_allowed_token_type" } });
    const p = new Presence({} as any);
    p.enter("S", { text: "x", emoji: ":robot:" });
    await new Promise((r) => setTimeout(r, 20));
    p.exit("S"); // should be no-op now (disabled)
  });

  test("missing_scope auto-disables", async () => {
    process.env.SLACK_USER_TOKEN = "xoxp-bad";
    shouldThrow = Object.assign(new Error("nope"), { data: { error: "missing_scope" } });
    const p = new Presence({} as any);
    p.enter("S", { text: "x", emoji: ":robot:" });
    await new Promise((r) => setTimeout(r, 20));
    p.exit("S"); // no-op because disabled
  });
});
