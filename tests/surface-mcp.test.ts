import { describe, expect, test } from "bun:test";
import { surfaceTools } from "../src/gateway/core/surface-mcp";
import type { Surface, SurfaceCapability } from "../src/gateway/core/surface";

function fakeSurface(caps: SurfaceCapability[], calls: string[] = []): Surface {
  const cap = new Set<SurfaceCapability>(caps);
  const s: any = {
    id: "fake",
    capabilities: cap,
    reply: async (i: { text: string }) => { calls.push(`reply:${i.text}`); return { ref: "R1" }; },
    getHistory: async () => ({ messages: [], hasMore: false }),
    requestApproval: async () => ({ approved: true, by: "U1" }),
  };
  if (cap.has("edit")) s.edit = async () => { calls.push("edit"); };
  if (cap.has("react")) { s.react = async () => { calls.push("react"); }; s.unreact = async () => { calls.push("unreact"); }; }
  if (cap.has("upload")) s.upload = async () => { calls.push("upload"); };
  if (cap.has("typing")) s.typing = async () => { calls.push("typing"); };
  return s as Surface;
}

describe("surfaceTools — capability gating", () => {
  test("core-only surface mounts exactly the three core tools", () => {
    const names = surfaceTools(fakeSurface([])).map((t) => t.name).sort();
    expect(names).toEqual(["get_history", "reply", "request_approval"]);
  });

  test("full-capability surface mounts core + optional tools", () => {
    const names = surfaceTools(fakeSurface(["edit", "react", "upload", "typing"])).map((t) => t.name).sort();
    expect(names).toEqual(
      ["edit", "get_history", "react", "reply", "request_approval", "typing", "unreact", "upload"].sort(),
    );
  });

  test("set_one_on_one mounts only when the opt is provided + handler calls the engine", async () => {
    expect(surfaceTools(fakeSurface([])).map((t) => t.name)).not.toContain("set_one_on_one");
    const seen: boolean[] = [];
    const defs = surfaceTools(fakeSurface([]), { setOneOnOne: async (a) => { seen.push(a); return a ? "locked" : "released"; } });
    const def = defs.find((t) => t.name === "set_one_on_one")!;
    expect(def).toBeDefined();
    const r: any = await def.handler({ active: true });
    expect(seen).toEqual([true]);
    expect(r.content[0].text).toBe("locked");
  });

  test("set_mention_only mounts only when the opt is provided + handler calls the engine", async () => {
    expect(surfaceTools(fakeSurface([])).map((t) => t.name)).not.toContain("set_mention_only");
    const seen: boolean[] = [];
    const defs = surfaceTools(fakeSurface([]), { setMentionOnly: async (a) => { seen.push(a); return a ? "on" : "off"; } });
    const def = defs.find((t) => t.name === "set_mention_only")!;
    expect(def).toBeDefined();
    const r: any = await def.handler({ active: true });
    expect(seen).toEqual([true]);
    expect(r.content[0].text).toBe("on");
  });

  test("unreact rides on the react capability", () => {
    const reactNames = surfaceTools(fakeSurface(["react"])).map((t) => t.name);
    expect(reactNames).toContain("react");
    expect(reactNames).toContain("unreact");
    const noReact = surfaceTools(fakeSurface(["edit"])).map((t) => t.name);
    expect(noReact).not.toContain("unreact");
  });

  test("reply tool invokes surface.reply and returns the ref", async () => {
    const calls: string[] = [];
    const tools = surfaceTools(fakeSurface([], calls));
    const reply = tools.find((t) => t.name === "reply")!;
    const res = await reply.handler({ text: "hello" });
    expect(calls).toContain("reply:hello");
    expect(res.content[0]!.text).toContain("R1");
  });
});
