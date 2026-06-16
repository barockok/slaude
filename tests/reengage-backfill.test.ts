import { describe, expect, test } from "bun:test";
import {
  selectGapMessages,
  renderBackfillPreamble,
  type GapMessage,
} from "../src/gateway/core/reengage-backfill";

const base = { botId: "BOT", selfBotId: "SELF", reengageTs: "200", threadTs: "100", maxMsgs: 50 };

describe("selectGapMessages", () => {
  test("keeps real user gap messages, excludes root, trigger, bot, and empties", () => {
    const msgs: GapMessage[] = [
      { ts: "100", user: "U1", text: "root" }, // thread root → excluded
      { ts: "150", user: "U1", text: "hello" }, // kept
      { ts: "160", user: "BOT", text: "agent reply" }, // bot user → excluded
      { ts: "165", bot_id: "SELF", text: "agent bot post" }, // own bot post → excluded
      { ts: "170", user: "U2", subtype: "channel_join", text: "joined" }, // subtype → excluded
      { ts: "180", user: "U2", text: "   " }, // empty → excluded
      { ts: "190", user: "U2", text: "world" }, // kept
      { ts: "200", user: "U1", text: "re-mention" }, // trigger → excluded
    ];
    const sel = selectGapMessages(msgs, base);
    expect(sel.kept.map((m) => m.text)).toEqual(["hello", "world"]);
    expect(sel.omitted).toBe(0);
    expect(sel.total).toBe(2);
  });

  test("recency-prioritized: keeps the most recent N, drops oldest, chronological order", () => {
    const msgs: GapMessage[] = Array.from({ length: 60 }, (_, i) => ({
      ts: `${110 + i}`,
      user: "U1",
      text: `m${i}`,
    }));
    const sel = selectGapMessages(msgs, { ...base, maxMsgs: 50 });
    expect(sel.total).toBe(60);
    expect(sel.omitted).toBe(10);
    expect(sel.kept.length).toBe(50);
    expect(sel.kept[0]!.text).toBe("m10"); // oldest 10 dropped
    expect(sel.kept[49]!.text).toBe("m59"); // newest retained, chronological
  });

  test("empty / no-gap → nothing kept", () => {
    expect(selectGapMessages([], base).kept).toEqual([]);
    expect(selectGapMessages([{ ts: "200", user: "U1", text: "only trigger" }], base).kept).toEqual([]);
  });
});

describe("renderBackfillPreamble", () => {
  const nameOf = (m: GapMessage) => (m.user === "U1" ? "Alice" : "Bob");

  test("renders header + chronological lines, no truncation note when nothing omitted", () => {
    const sel = { kept: [{ user: "U1", text: "hi" }, { user: "U2", text: "yo" }], omitted: 0, total: 2 };
    const out = renderBackfillPreamble(sel, nameOf)!;
    expect(out).toContain("these messages were posted");
    expect(out).toContain("  Alice: hi");
    expect(out).toContain("  Bob: yo");
    expect(out).toContain("now re-engaged");
    expect(out).not.toContain("omitted");
  });

  test("includes a truncation note when messages were omitted", () => {
    const sel = { kept: [{ user: "U1", text: "recent" }], omitted: 23, total: 24 };
    const out = renderBackfillPreamble(sel, nameOf)!;
    expect(out).toContain("24 messages were posted");
    expect(out).toContain("showing the latest 1");
    expect(out).toContain("23 earlier omitted");
  });

  test("collapses whitespace and caps line length", () => {
    const sel = { kept: [{ user: "U1", text: "a\n\n  b   c\t\td" }], omitted: 0, total: 1 };
    expect(renderBackfillPreamble(sel, nameOf)).toContain("  Alice: a b c d");
    const long = { kept: [{ user: "U1", text: "x".repeat(500) }], omitted: 0, total: 1 };
    const line = renderBackfillPreamble(long, nameOf, 300)!.split("\n").find((l) => l.startsWith("  Alice:"))!;
    expect(line.length).toBeLessThanOrEqual("  Alice: ".length + 300);
  });

  test("empty selection → undefined", () => {
    expect(renderBackfillPreamble({ kept: [], omitted: 0, total: 0 }, nameOf)).toBeUndefined();
  });
});
