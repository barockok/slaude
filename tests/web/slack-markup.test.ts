import { describe, expect, test } from "bun:test";
import { parseSlackMarkup, plainSlackText, unescapeSlack } from "../../src/web/console/lib/slack-markup";

describe("Slack markup in console text", () => {
  test("links with and without a label", () => {
    expect(parseSlackMarkup("see <https://example.com/a?b=1&amp;c=2|the docs> now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", href: "https://example.com/a?b=1&c=2", text: "the docs" },
      { kind: "text", text: " now" },
    ]);
    expect(parseSlackMarkup("<https://example.com>")).toEqual([{ kind: "link", href: "https://example.com", text: "https://example.com" }]);
    expect(parseSlackMarkup("<mailto:jane@example.com|Jane>")).toEqual([{ kind: "link", href: "mailto:jane@example.com", text: "Jane" }]);
  });

  test("a non-web scheme is never a link", () => {
    expect(plainSlackText("<javascript:alert(1)|click>")).toBe("<javascript:alert(1)|click>");
    expect(parseSlackMarkup("<javascript:alert(1)|click>").every((s) => s.kind === "text")).toBe(true);
  });

  test("user mentions: the known name, the label, else the id", () => {
    expect(parseSlackMarkup("hi <@UALICE>", { UALICE: "Jane Doe" })).toEqual([
      { kind: "text", text: "hi " },
      { kind: "user", id: "UALICE", text: "@Jane Doe" },
    ]);
    expect(plainSlackText("<@UBOB|bob>")).toBe("@bob");
    expect(plainSlackText("<@UBOB>")).toBe("@UBOB");
  });

  test("channels and specials", () => {
    expect(parseSlackMarkup("in <#CTEAM|team>")[1]).toEqual({ kind: "channel", id: "CTEAM", text: "#team" });
    expect(plainSlackText("in <#CTEAM>")).toBe("in #CTEAM");
    expect(plainSlackText("<!here> and <!channel>")).toBe("@here and @channel");
    expect(plainSlackText("<!subteam^S123|@oncall> please")).toBe("@oncall please");
    expect(plainSlackText("<!date^1762506060^{date}|Nov 7>")).toBe("Nov 7");
  });

  test("escapes are undone once; a literal &amp;lt; stays one level escaped", () => {
    expect(unescapeSlack("a &lt;b&gt; &amp; c")).toBe("a <b> & c");
    expect(plainSlackText("x &amp;lt; y")).toBe("x &lt; y");
    expect(plainSlackText("if a &lt; b &amp;&amp; c &gt; d")).toBe("if a < b && c > d");
  });

  test("plain text and stray angle brackets pass through", () => {
    expect(parseSlackMarkup("no markup here")).toEqual([{ kind: "text", text: "no markup here" }]);
    expect(plainSlackText("a <b> c")).toBe("a <b> c");
    expect(parseSlackMarkup("")).toEqual([]);
  });
});

import { slackToMarkdown } from "../../src/web/console/lib/slack-markup";
import { parseInline } from "../../src/web/ui/md-parse";

describe("agent text as markdown", () => {
  test("Slack links become markdown links, mentions their names", () => {
    expect(slackToMarkdown("see <https://example.com/a_(b)|the [docs]> <@U1>", { U1: "Jane Doe" })).toBe(
      "see [the \\[docs\\]](<https://example.com/a_(b)>) @Jane Doe",
    );
    expect(parseInline(slackToMarkdown("<https://example.com/a_(b)|the [docs]>"))).toEqual([
      { t: "link", href: "https://example.com/a_(b)", c: [{ t: "text", v: "the [docs]" }] },
    ]);
  });

  test("a Slack link to a non-web scheme stays text", () => {
    expect(slackToMarkdown("<javascript:alert(1)|x>")).toBe("<javascript:alert(1)|x>");
  });
});
