import { describe, it, expect } from "bun:test";
import { startLoopback } from "../../../src/agent/mcp-oauth/loopback";

describe("startLoopback", () => {
  it("resolves the code when state matches", async () => {
    const lb = await startLoopback({ host: "127.0.0.1", expectedState: "S1", timeoutMs: 2000 });
    const url = `http://127.0.0.1:${lb.port}${lb.callbackPath}?code=THE_CODE&state=S1`;
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    expect(await lb.waitForCode()).toBe("THE_CODE");
  });

  it("rejects on state mismatch (CSRF guard)", async () => {
    const lb = await startLoopback({ host: "127.0.0.1", expectedState: "GOOD", timeoutMs: 2000 });
    await fetch(`http://127.0.0.1:${lb.port}${lb.callbackPath}?code=x&state=BAD`);
    await expect(lb.waitForCode()).rejects.toThrow(/state/i);
  });

  it("rejects on timeout", async () => {
    const lb = await startLoopback({ host: "127.0.0.1", expectedState: "S", timeoutMs: 50 });
    await expect(lb.waitForCode()).rejects.toThrow(/timeout/i);
  });

  it("rejects with missing code error and returns 400 when state matches but code is absent", async () => {
    const lb = await startLoopback({ host: "127.0.0.1", expectedState: "S2", timeoutMs: 2000 });
    const url = `http://127.0.0.1:${lb.port}${lb.callbackPath}?state=S2`;
    const resp = await fetch(url);
    expect(resp.status).toBe(400);
    await expect(lb.waitForCode()).rejects.toThrow(/missing code/i);
  });
});
