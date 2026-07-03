import { describe, expect, test } from "bun:test";
import { resolveNavigator } from "../src/voice/navigators";
import { meetNavigator } from "../src/voice/navigators/meet";
import { jitsiNavigator } from "../src/voice/navigators/jitsi";
import { genericNavigator } from "../src/voice/navigators/navigator";

describe("resolveNavigator", () => {
  test("meet.google.com → meet navigator", () => {
    expect(resolveNavigator("https://meet.google.com/abc-defg-hij")).toBe(meetNavigator);
  });

  test("jitsi hosts → jitsi navigator", () => {
    expect(resolveNavigator("https://meet.jit.si/some-room")).toBe(jitsiNavigator);
    expect(resolveNavigator("https://8x8.vc/team/room")).toBe(jitsiNavigator);
  });

  test("unknown platform → generic open-the-page fallback", () => {
    expect(resolveNavigator("https://example.com/call/123")).toBe(genericNavigator);
    expect(resolveNavigator("https://zoom.us/j/123")).toBe(genericNavigator);
  });

  test("lookalike hosts do not fool the matchers", () => {
    expect(resolveNavigator("https://meet-google.com.evil.io/x")).toBe(genericNavigator);
    expect(resolveNavigator("https://notjit.similar.org/x")).toBe(genericNavigator);
  });
});

describe("genericNavigator", () => {
  test("join opens the URL and hands the page back; leave closes it", async () => {
    const calls: string[] = [];
    const page = {
      goto: async (u: string) => {
        calls.push(`goto:${u}`);
      },
      close: async () => {
        calls.push("close");
      },
    };
    const ctx = { newPage: async () => page } as any;

    const joined = await genericNavigator.join(ctx, {
      url: "https://example.com/call",
      displayName: "Trevor",
    });
    expect(joined).toBe(page as any);
    await genericNavigator.leave(joined);
    expect(calls).toEqual(["goto:https://example.com/call", "close"]);
  });

  test("leave survives a page that throws on close", async () => {
    const page = {
      close: async () => {
        throw new Error("already gone");
      },
    } as any;
    await genericNavigator.leave(page); // must not throw
  });
});
