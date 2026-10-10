import { describe, expect, it } from "bun:test";
import { describeRejection, makeRejectionHandler } from "../../src/node/rejection-guard";
import { NodeApiError } from "../../src/node/client";

async function runBun(script: string) {
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe("node worker unhandled-rejection guard", () => {
  it("names the session when the error carries one, and the status and stack", () => {
    const e = Object.assign(new NodeApiError(401, '{"error":"invalid job token: expired"}'), { sessionId: "s-123" });
    const line = describeRejection(e);
    expect(line).toContain("session=s-123");
    expect(line).toContain("status=401");
    expect(line).toContain("invalid job");
    // A message naming the session is enough too.
    expect(describeRejection(new Error("write failed session=s-456: boom"))).toContain("session=s-456");
    expect(describeRejection("plain")).toContain("session=unknown");
  });

  it("redacts secret-shaped strings in the message, body and stack", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uIjoicyJ9.c2lnbmF0dXJlLXZhbHVl";
    const e = new NodeApiError(401, `{"presented":"${jwt}"}`, `refused bearer ${jwt}`);
    const line = describeRejection(e);
    expect(line).not.toContain(jwt);
    expect(line).not.toContain("c2lnbmF0dXJlLXZhbHVl");
    expect(line).toContain("status=401");
  });

  it("circuit breaker: the Nth rejection inside the window exits non-zero, spaced-out ones do not", () => {
    let now = 0;
    const exits: number[] = [];
    const logged: string[] = [];
    const handle = makeRejectionHandler({ log: (l) => logged.push(l), exit: (c) => exits.push(c), now: () => now, max: 5, windowMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      handle(new Error(`r${i}`));
      now += 1_000;
    }
    expect(exits).toEqual([]);
    // Spaced out past the window: the oldest fall off, still no exit.
    now += 120_000;
    for (let i = 0; i < 4; i++) handle(new Error(`late${i}`));
    expect(exits).toEqual([]);
    handle(new Error("fifth in the window"));
    expect(exits).toEqual([1]);
    expect(logged.at(-1)).toContain("5 unhandled rejections");
  });

  // Child processes: bun test fails on any unhandled rejection in its own
  // process, whatever handlers are installed.
  it("logs a rejection loudly and keeps the process alive", async () => {
    const guard = new URL("../../src/node/rejection-guard.ts", import.meta.url).pathname;
    const r = await runBun(
      [
        `const { installRejectionGuard } = await import(${JSON.stringify(guard)});`,
        "installRejectionGuard();",
        // From a timer, like a session's background work (a rejection at top
        // level behaves differently under bun -e).
        'setTimeout(() => void Promise.reject(Object.assign(new Error("background work failed"), { sessionId: "s-789" })), 10);',
        'setTimeout(() => console.log("still alive"), 200);',
      ].join("\n"),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("still alive");
    expect(r.err).toContain("UNHANDLED REJECTION");
    expect(r.err).toContain("session=s-789");
    expect(r.err).toContain("background work failed");
  });

  it("a burst past the breaker's limit ends the process non-zero (the pod restarts)", async () => {
    const guard = new URL("../../src/node/rejection-guard.ts", import.meta.url).pathname;
    const r = await runBun(
      [
        `const { installRejectionGuard } = await import(${JSON.stringify(guard)});`,
        "installRejectionGuard({ max: 3, windowMs: 60_000 });",
        "for (let i = 0; i < 3; i++) setTimeout(() => void Promise.reject(new Error('loop ' + i)), 10 + i);",
        'setTimeout(() => console.log("still alive"), 200);',
      ].join("\n"),
    );
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("still alive");
    expect(r.err).toContain("3 unhandled rejections");
  });

  it("without the guard the same rejection ends the process (what the guard is for)", async () => {
    const r = await runBun('setTimeout(() => void Promise.reject(new Error("x")), 10); setTimeout(() => console.log("still alive"), 200);');
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("still alive");
  });
});
