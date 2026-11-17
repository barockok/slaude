import { describe, expect, test } from "bun:test";
import { suppressibleSurface, UPLOAD_SUPPRESSED } from "../../../src/gateway/panel/suppress";
import type { Surface } from "../../../src/gateway/core/surface";

// An operator driving a session from the console must not echo to Slack. The
// direct upload's two halves follow the same rule: begin has no visible
// effect (it only obtains a URL), complete is the write.
function inner(log: string[]): Surface {
  return {
    id: "x", capabilities: new Set(["upload"]),
    reply: async () => ({ ref: "r" }), getHistory: async () => ({ messages: [], hasMore: false }), requestApproval: async () => ({ approved: true, by: "U" }),
    uploadBegin: async () => { log.push("begin"); return { uploadUrl: "u", fileId: "F" }; },
    uploadComplete: async () => { log.push("complete"); },
  } as Surface;
}

describe("suppressibleSurface forwards the direct upload calls", () => {
  test("not held: both pass through", async () => {
    const log: string[] = [];
    const s = suppressibleSurface(inner(log), "S", async () => false);
    expect(await s.uploadBegin!({ filename: "a", size: 1 })).toEqual({ uploadUrl: "u", fileId: "F" });
    await s.uploadComplete!({ fileId: "F", filename: "a" });
    expect(await s.uploadHeld!()).toBe(false);
    expect(log).toEqual(["begin", "complete"]);
  });

  test("held: neither is sent, and both say so with the sentinel", async () => {
    const log: string[] = [];
    const s = suppressibleSurface(inner(log), "S", async () => true);
    expect(await s.uploadHeld!()).toBe(true);
    expect(await s.uploadBegin!({ filename: "a", size: 1 })).toBe(UPLOAD_SUPPRESSED);
    expect(await s.uploadComplete!({ fileId: "F", filename: "a" })).toBe(UPLOAD_SUPPRESSED);
    expect(log).toEqual([]);
  });

  test("a surface without the methods stays without them", () => {
    const bare = { id: "x", capabilities: new Set(), reply: async () => ({ ref: "r" }), getHistory: async () => ({ messages: [], hasMore: false }), requestApproval: async () => ({ approved: true, by: "U" }) } as Surface;
    const s = suppressibleSurface(bare, "S", async () => false);
    expect(s.uploadBegin).toBeUndefined();
    expect(s.uploadComplete).toBeUndefined();
  });
});
