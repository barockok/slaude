import { afterEach, describe, expect, test } from "bun:test";
import { checkUploadUrl } from "../../../src/gateway/upload/url";

const saved = process.env.SLAUDE_UPLOAD_ALLOWED_HOSTS;
afterEach(() => { if (saved === undefined) delete process.env.SLAUDE_UPLOAD_ALLOWED_HOSTS; else process.env.SLAUDE_UPLOAD_ALLOWED_HOSTS = saved; });

describe("the upload URL allow-list", () => {
  test("the default is https on files.slack.com only", () => {
    delete process.env.SLAUDE_UPLOAD_ALLOWED_HOSTS;
    expect(checkUploadUrl("https://files.slack.com/upload/v1/ABC?x=1")).toBe(true);
    expect(checkUploadUrl("https://FILES.slack.com/upload/v1/ABC")).toBe(true);
    for (const bad of [
      "http://files.slack.com/upload/v1/ABC", // not https
      "https://evilslack.com/x", "https://files.slack.com.evil.com/x", "https://evil.com/files.slack.com",
      "https://slack.com/x", "https://a.files.slack.com/x", // exact host, not a suffix
      "https://127.0.0.1/x", "https://169.254.169.254/x", "https://localhost/x", "https://[::1]/x",
      "file:///etc/passwd", "ftp://files.slack.com/x", "javascript:alert(1)", "not a url", "",
      "https://user:pw@files.slack.com/x", "https://files.slack.com:8443/x",
    ]) expect({ bad, ok: checkUploadUrl(bad) }).toEqual({ bad, ok: false });
  });

  test("SLAUDE_UPLOAD_ALLOWED_HOSTS replaces the list with exact hosts; http only for a host it names", () => {
    process.env.SLAUDE_UPLOAD_ALLOWED_HOSTS = " 127.0.0.1 , upload.example ";
    expect(checkUploadUrl("http://127.0.0.1:5555/upload/F1")).toBe(true);
    expect(checkUploadUrl("https://upload.example/x")).toBe(true);
    expect(checkUploadUrl("https://files.slack.com/x")).toBe(false);
    expect(checkUploadUrl("http://evil.upload.example/x")).toBe(false);
    expect(checkUploadUrl("file://127.0.0.1/x")).toBe(false);
  });
});
