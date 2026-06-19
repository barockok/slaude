import { afterEach, describe, expect, test } from "bun:test";
import { SharedLoopback, sharedLoopback } from "../../src/agent/mcp-oauth/shared-loopback";

let lb: SharedLoopback | undefined;
afterEach(async () => { await lb?.stop(); lb = undefined; });

async function newStarted() {
  const x = new SharedLoopback({ port: 0 }); // ephemeral for tests
  await x.start();
  return x;
}

function hit(lb: SharedLoopback, qs: string) {
  return fetch(`http://127.0.0.1:${lb.port}${lb.callbackPath}?${qs}`);
}

describe("SharedLoopback", () => {
  test("start binds a port; redirect_uri is fixed across flows", async () => {
    lb = await newStarted();
    expect(lb.port).toBeGreaterThan(0);
    const a = lb.register("state-a", 5000);
    const b = lb.register("state-b", 5000);
    expect(a.redirectUri).toBe(b.redirectUri); // shared, state-independent
    expect(a.redirectUri).toContain(`:${lb.port}/callback`);
  });

  test("routes the callback to the matching state", async () => {
    lb = await newStarted();
    const flow = lb.register("state-xyz", 5000);
    await hit(lb, "code=THECODE&state=state-xyz");
    expect(await flow.waitForCode()).toBe("THECODE");
  });

  test("concurrent flows resolve independently, any order", async () => {
    lb = await newStarted();
    const f1 = lb.register("s1", 5000);
    const f2 = lb.register("s2", 5000);
    await hit(lb, "code=code2&state=s2");
    await hit(lb, "code=code1&state=s1");
    expect(await f1.waitForCode()).toBe("code1");
    expect(await f2.waitForCode()).toBe("code2");
  });

  test("unknown state → 400 and no flow resolves", async () => {
    lb = await newStarted();
    const flow = lb.register("known", 5000);
    const res = await hit(lb, "code=x&state=unknown");
    expect(res.status).toBe(400);
    let settled = false;
    flow.waitForCode().then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
  });

  test("missing code → flow rejects", async () => {
    lb = await newStarted();
    const flow = lb.register("nc", 5000);
    await hit(lb, "state=nc");
    expect(flow.waitForCode()).rejects.toThrow(/code/i);
  });

  test("timeout rejects and drops the pending flow", async () => {
    lb = await newStarted();
    const flow = lb.register("slow", 30);
    expect(flow.waitForCode()).rejects.toThrow(/timeout/i);
    await new Promise((r) => setTimeout(r, 60));
    // late callback for a timed-out state is unknown now → 400
    const res = await hit(lb, "code=late&state=slow");
    expect(res.status).toBe(400);
  });

  test("non-callback path → 404", async () => {
    lb = await newStarted();
    const res = await fetch(`http://127.0.0.1:${lb.port}/nope?code=x&state=y`);
    expect(res.status).toBe(404);
  });

  test("start() is idempotent — second call keeps the same port", async () => {
    lb = await newStarted();
    const p = lb.port;
    await lb.start();
    expect(lb.port).toBe(p);
  });

  test("sharedLoopback() returns a process-wide singleton", () => {
    expect(sharedLoopback()).toBe(sharedLoopback());
  });

  test("verify gates routing even for a registered state (MAC checked first)", async () => {
    // verify rejects everything → even an exact registry hit must not route.
    lb = new SharedLoopback({ port: 0, verify: () => false });
    await lb.start();
    const flow = lb.register("good-1", 5000);
    const res = await hit(lb, "code=x&state=good-1");
    expect(res.status).toBe(400);
    let settled = false;
    flow.waitForCode().then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
  });

  test("with verify: a state passing the check routes normally", async () => {
    lb = new SharedLoopback({ port: 0, verify: (s) => s.startsWith("good-") });
    await lb.start();
    const flow = lb.register("good-1", 5000);
    await hit(lb, "code=OK&state=good-1");
    expect(await flow.waitForCode()).toBe("OK");
  });

  test("stop() rejects outstanding flows", async () => {
    lb = await newStarted();
    const flow = lb.register("pending", 5000);
    const rejected = flow.waitForCode().then(() => "resolved", () => "rejected");
    await lb.stop();
    lb = undefined;
    expect(await rejected).toBe("rejected");
  });
});
