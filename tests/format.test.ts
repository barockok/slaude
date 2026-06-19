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
  test("bare URL with base64url __ survives (no emphasis mangling)", () => {
    const url = "https://idp.example.com/authorize?code_challenge=aB_c__dE&state=x__y";
    expect(mdToMrkdwn(url)).toBe(url);
  });
  test("bare URL with single underscores untouched", () => {
    const url = "https://h.io/a_b_c?x=1&y=2";
    expect(mdToMrkdwn(url)).toBe(url);
  });
  test("URL inside prose keeps surrounding markdown working", () => {
    const out = mdToMrkdwn("see **here**: https://h.io/p__q for the link");
    expect(out).toContain("https://h.io/p__q");
    expect(out).toContain("*here*");
  });
  test("angle-bracket autolink preserved verbatim", () => {
    expect(mdToMrkdwn("<https://h.io/a__b>")).toBe("<https://h.io/a__b>");
  });
  test("markdown link [text](url) still converts, url part protected", () => {
    expect(mdToMrkdwn("[t](https://h.io/a__b)")).toBe("<https://h.io/a__b|t>");
  });
  test("narrow table → monospace block", () => {
    const md = "| a | b |\n| - | - |\n| 1 | 2 |";
    const out = mdToMrkdwn(md);
    expect(out).toContain("```");
    expect(out).toContain("a");
    expect(out).toContain("1");
  });
  test("wide table → definition list", () => {
    const md = [
      "| name | description | extra |",
      "| - | - | - |",
      "| alpha | a long description that should push width past sixty | xx |",
      "| beta  | another long description well past the threshold      | yy |",
    ].join("\n");
    const out = mdToMrkdwn(md);
    expect(out).toContain("*alpha*");
    expect(out).toContain("• description");
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
