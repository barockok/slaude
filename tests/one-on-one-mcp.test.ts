import { describe, expect, test } from "bun:test";
import { oneOnOneTools, createOneOnOneMcp, ONE_ON_ONE_MCP_NAME } from "../src/gateway/slack/mcp-tools";

describe("set_one_on_one tool", () => {
  test("passes active through to deps.setOneOnOne and wraps the status as text", async () => {
    const seen: boolean[] = [];
    const def = oneOnOneTools({ setOneOnOne: async (a) => { seen.push(a); return a ? "locked" : "released"; } })[0]!;
    expect(def.name).toBe("set_one_on_one");
    const on: any = await def.handler({ active: true }, {} as any);
    expect(seen).toEqual([true]);
    expect(on.content[0].text).toBe("locked");
    const off: any = await def.handler({ active: false }, {} as any);
    expect(seen).toEqual([true, false]);
    expect(off.content[0].text).toBe("released");
  });

  test("createOneOnOneMcp mounts under the slaude_1on1 namespace", () => {
    expect(ONE_ON_ONE_MCP_NAME).toBe("slaude_1on1");
    expect(createOneOnOneMcp({ setOneOnOne: async () => "ok" })).toBeDefined();
  });
});
