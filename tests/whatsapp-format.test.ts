import { describe, it, expect } from "bun:test";
import { mdToWhatsApp, chunkText, WA_MAX_TEXT } from "../src/gateway/whatsapp/format";

describe("mdToWhatsApp", () => {
  it("converts bold **text** to *text*", () => {
    expect(mdToWhatsApp("**hello**")).toBe("*hello*");
  });

  it("converts italic _text_ to _text_", () => {
    expect(mdToWhatsApp("_hello_")).toBe("_hello_");
  });

  it("converts italic *text* to _text_", () => {
    expect(mdToWhatsApp("*hello*")).toBe("_hello_");
  });

  it("preserves code spans", () => {
    expect(mdToWhatsApp("`code`")).toBe("`code`");
  });

  it("preserves code blocks", () => {
    expect(mdToWhatsApp("```\ncode\n```")).toBe("```code```");
  });

  it("converts strike ~~text~~ to ~text~", () => {
    expect(mdToWhatsApp("~~hello~~")).toBe("~hello~");
  });

  it("converts links [text](url) to text (url)", () => {
    expect(mdToWhatsApp("[click](https://x.com)")).toBe("click (https://x.com)");
  });

  it("converts headings to bold", () => {
    expect(mdToWhatsApp("# Hello")).toBe("*Hello*");
    expect(mdToWhatsApp("## Hello")).toBe("*Hello*");
  });

  it("converts bullet markers", () => {
    expect(mdToWhatsApp("- item")).toBe("• item");
    expect(mdToWhatsApp("* item")).toBe("• item");
  });

  it("handles mixed markdown", () => {
    const md = "**bold** and _italic_ and `code`";
    expect(mdToWhatsApp(md)).toBe("*bold* and _italic_ and `code`");
  });
});

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
  });

  it("splits at max length", () => {
    const long = "a".repeat(WA_MAX_TEXT + 10);
    const chunks = chunkText(long);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(WA_MAX_TEXT);
    expect(chunks[1]!.length).toBe(10);
  });
});
