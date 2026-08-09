import { describe, expect, test } from "bun:test";
import { mdToMrkdwn, chunkText, SLACK_MAX_TEXT } from "../src/gateway/slack/format";

describe("mdToMrkdwn", () => {
  test("bold ** → *", () => {
    expect(mdToMrkdwn("**hi**")).toBe("*hi*");
  });
  test("bold __ → *", () => {
    expect(mdToMrkdwn("__hi__")).toBe("*hi*");
  });
  test("italic * → _", () => {
    expect(mdToMrkdwn("a *em* b")).toBe("a _em_ b");
  });
  test("strike ~~ → ~", () => {
    expect(mdToMrkdwn("~~old~~")).toBe("~old~");
  });
  test("link", () => {
    expect(mdToMrkdwn('[t](https://x.io)')).toBe("<https://x.io|t>");
    expect(mdToMrkdwn('[t](https://x.io "title")')).toBe("<https://x.io|t>");
  });
  test("heading", () => {
    expect(mdToMrkdwn("# Title")).toBe("*Title*");
    expect(mdToMrkdwn("### Sub")).toBe("*Sub*");
  });
  test("bullets", () => {
    expect(mdToMrkdwn("- a\n* b")).toBe("• a\n• b");
  });
  test("inline code preserved", () => {
    expect(mdToMrkdwn("use `**foo**` here")).toBe("use `**foo**` here");
  });
  test("fenced code preserved + language hint stripped from output", () => {
    const out = mdToMrkdwn("```ts\nconst x = **1**\n```");
    expect(out).toContain("const x = **1**");
    expect(out.startsWith("```")).toBe(true);
  });
  test("italic does not eat bold", () => {
    expect(mdToMrkdwn("**bold** *em*")).toBe("*bold* _em_");
  });
  test("bold+italic *** → _*x*_ (Slack has no triple-star)", () => {
    expect(mdToMrkdwn("***x***")).toBe("_*x*_");
    expect(mdToMrkdwn("a ***big*** b")).toBe("a _*big*_ b");
  });
  test("inner-padded bold → markers hug content (Slack won't bold ' x ')", () => {
    expect(mdToMrkdwn("** spaced **")).toBe("*spaced*");
    expect(mdToMrkdwn("a **  b  ** c")).toBe("a *b* c");
  });
  test("inner-padded italic → markers hug content", () => {
    expect(mdToMrkdwn("a * em * b")).toBe("a _em_ b");
  });
  test("bare URL → compact <url|host>, full url preserved + no emphasis mangling", () => {
    const url = "https://idp.example.com/authorize?code_challenge=aB_c__dE&state=x__y";
    expect(mdToMrkdwn(url)).toBe(`<${url}|idp.example.com>`);
  });
  test("bare URL with single underscores → labeled by host", () => {
    const url = "https://h.io/a_b_c?x=1&y=2";
    expect(mdToMrkdwn(url)).toBe(`<${url}|h.io>`);
  });
  test("URL inside prose → labeled link, surrounding markdown still works", () => {
    const out = mdToMrkdwn("see **here**: https://h.io/p__q for the link");
    expect(out).toContain("<https://h.io/p__q|h.io>");
    expect(out).toContain("*here*");
  });
  test("unparseable URL falls back to raw (no crash)", () => {
    expect(mdToMrkdwn("https://[")).toBe("https://[");
  });
  test("angle-bracket autolink preserved verbatim", () => {
    expect(mdToMrkdwn("<https://h.io/a__b>")).toBe("<https://h.io/a__b>");
  });
  test("markdown link [text](url) still converts, url part protected", () => {
    expect(mdToMrkdwn("[t](https://h.io/a__b)")).toBe("<https://h.io/a__b|t>");
  });
  test("bold link → *<url|label>*", () => {
    expect(mdToMrkdwn("**[link](https://x.io)**")).toBe("*<https://x.io|link>*");
  });
  test("bold link with trailing *** → no ** leak", () => {
    // *** close (mismatched triple-star) must not leave ** after the link
    expect(mdToMrkdwn("**[link](https://x.io)***")).toBe("*<https://x.io|link>*");
  });
  test("bold text + link with trailing *** → no ** leak", () => {
    expect(mdToMrkdwn("**see [docs](https://x.io)***")).toBe("*see <https://x.io|docs>*");
  });
  test("link followed by bold → no ** between them", () => {
    expect(mdToMrkdwn("[link](https://x.io)**bold**")).toBe("<https://x.io|link>*bold*");
  });
  test("bold in link label → *label* inside link, no trailing **", () => {
    expect(mdToMrkdwn("[**label**](https://x.io)")).toBe("<https://x.io|*label*>");
  });
  test("multiple bold links in one line", () => {
    const out = mdToMrkdwn("**[a](https://a.io)** and **[b](https://b.io)**");
    expect(out).toBe("*<https://a.io|a>* and *<https://b.io|b>*");
  });

  // -- bold bare URL (regression: URL carving was absorbing trailing ** into the URL sentinel,
  //    leaving no closing ** for the bold regex to match, so the bold was silently dropped) --

  test("bold bare URL → *<url|host>*, not literal **url**", () => {
    expect(mdToMrkdwn("**https://x.io**")).toBe("*<https://x.io|x.io>*");
  });
  test("bold bare URL in surrounding prose", () => {
    expect(mdToMrkdwn("See **https://x.io** for details")).toBe(
      "See *<https://x.io|x.io>* for details",
    );
  });
  test("bold bare URL on its own paragraph (real-world modal deploy case)", () => {
    const out = mdToMrkdwn("Same URL:\n\n**https://x.io**\n\nFirst load will be slow.");
    expect(out).toContain("*<https://x.io|x.io>*");
    expect(out).not.toContain("**https://");
    expect(out).not.toContain("**\n");
  });
  test("bold bare URL with hyphenated hostname", () => {
    // the original bug was triggered by https://barockok--personaplex-serve-dev.modal.run
    expect(mdToMrkdwn("**https://foo--bar-baz.modal.run**")).toBe(
      "*<https://foo--bar-baz.modal.run|foo--bar-baz.modal.run>*",
    );
  });
  test("bold bare URL with path", () => {
    expect(mdToMrkdwn("**https://x.io/path/to/page**")).toBe(
      "*<https://x.io/path/to/page|x.io>*",
    );
  });
  test("bold bare URL with query string", () => {
    expect(mdToMrkdwn("**https://x.io/?q=foo&bar=baz**")).toBe(
      "*<https://x.io/?q=foo&bar=baz|x.io>*",
    );
  });
  test("bold bare URL with fragment", () => {
    expect(mdToMrkdwn("**https://x.io/#section**")).toBe(
      "*<https://x.io/#section|x.io>*",
    );
  });
  test("multiple bold bare URLs on one line", () => {
    expect(mdToMrkdwn("**https://a.io** and **https://b.io**")).toBe(
      "*<https://a.io|a.io>* and *<https://b.io|b.io>*",
    );
  });
  test("bold bare URL followed by bold text → both render", () => {
    expect(mdToMrkdwn("**https://x.io** then **text**")).toBe(
      "*<https://x.io|x.io>* then *text*",
    );
  });
  test("bold text followed by bold bare URL → both render", () => {
    expect(mdToMrkdwn("**text** then **https://x.io**")).toBe(
      "*text* then *<https://x.io|x.io>*",
    );
  });
  test("non-bold bare URL unaffected", () => {
    expect(mdToMrkdwn("visit https://x.io today")).toBe(
      "visit <https://x.io|x.io> today",
    );
  });
  test("bare URL does not absorb trailing ** into the URL token", () => {
    // regression: before the fix, https://x.io** was carved as one token,
    // stripping ** from the bold context so bold never fired.
    const out = mdToMrkdwn("visit https://x.io** for info");
    expect(out).toContain("<https://x.io|x.io>");
    expect(out).not.toContain("https://x.io**");
  });
  test("bold bare URL at very start of string", () => {
    expect(mdToMrkdwn("**https://x.io** — click here")).toBe(
      "*<https://x.io|x.io>* — click here",
    );
  });
  test("bold bare URL at very end of string", () => {
    expect(mdToMrkdwn("Open this: **https://x.io**")).toBe(
      "Open this: *<https://x.io|x.io>*",
    );
  });
  test("italic bare URL → labeled italic link", () => {
    expect(mdToMrkdwn("*https://x.io*")).toBe("_<https://x.io|x.io>_");
  });
  test("bold bare URL inside a list item", () => {
    const out = mdToMrkdwn("- Open **https://x.io**\n- Done");
    expect(out).toContain("*<https://x.io|x.io>*");
    expect(out).toContain("• Open");
  });
  test("bold bare URL multiline — other lines unaffected", () => {
    const md = [
      "Step 1: go to",
      "**https://x.io**",
      "Step 2: click login",
    ].join("\n");
    const out = mdToMrkdwn(md);
    expect(out).toContain("*<https://x.io|x.io>*");
    expect(out).toContain("Step 1");
    expect(out).toContain("Step 2");
  });

  test("narrow table → monospace block", () => {
    const md = "| a | b |\n| - | - |\n| 1 | 2 |";
    const out = mdToMrkdwn(md);
    expect(out).toContain("```");
    expect(out).toContain("a");
    expect(out).toContain("1");
  });
  test("wide table → code block (always, regardless of width)", () => {
    const md = [
      "| name | description | extra |",
      "| - | - | - |",
      "| alpha | a long description that should push width past sixty | xx |",
      "| beta  | another long description well past the threshold      | yy |",
    ].join("\n");
    const out = mdToMrkdwn(md);
    expect(out).toContain("```");
    expect(out).toContain("alpha");
    expect(out).toContain("description");
    expect(out).not.toContain("*alpha*");
    expect(out).not.toContain("• description");
  });
  test("narrow table strips emphasis inside code block cells", () => {
    const md = [
      "| key | value |",
      "| - | - |",
      "| **a** | *b* |",
      "| _c_ | ~~d~~ |",
    ].join("\n");
    const out = mdToMrkdwn(md);
    expect(out).toContain("```");
    expect(out).not.toContain("**a**");
    expect(out).not.toContain("*b*");
    expect(out).not.toContain("_c_");
    expect(out).not.toContain("~~d~~");
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toContain("c");
    expect(out).toContain("d");
  });
  test("table with no separator returns block unchanged-ish", () => {
    // single row only — function bails (rows.length < 2 path)
    const md = "| a | b |";
    const out = mdToMrkdwn(md);
    expect(out).toBe("| a | b |");
  });
});

describe("chunkText", () => {
  test("under limit", () => {
    expect(chunkText("hi")).toEqual(["hi"]);
  });
  test("over limit splits", () => {
    const big = "x".repeat(SLACK_MAX_TEXT + 100);
    const out = chunkText(big);
    expect(out.length).toBe(2);
    expect(out.join("")).toBe(big);
  });
  test("custom max", () => {
    expect(chunkText("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
  });
});
