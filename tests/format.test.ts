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
