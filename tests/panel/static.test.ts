import { describe, it, expect } from "bun:test";
import { servePanelStatic } from "../../src/gateway/panel/static";

describe("panel static serving", () => {
  it("serves index.html for the /panel root", async () => {
    const res = await servePanelStatic("/panel");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.text();
    expect(body.toLowerCase()).toContain("<!doctype html");
  });

  it("serves index.html for /panel/ (trailing slash)", async () => {
    const res = await servePanelStatic("/panel/");
    expect(res!.status).toBe(200);
  });

  it("SPA fallback: an extension-less client route falls back to index.html", async () => {
    const res = await servePanelStatic("/panel/sessions/abc123");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect((await res!.text()).toLowerCase()).toContain("<!doctype html");
  });

  it("returns null for a missing asset with a real extension (caller 404s)", async () => {
    const res = await servePanelStatic("/panel/does-not-exist.js");
    expect(res).toBeNull();
  });

  it("refuses path traversal out of the web root with 403", async () => {
    const res = await servePanelStatic("/panel/../../../../etc/passwd");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
