import { describe, expect, it } from "bun:test";
import { describeRejection } from "../../src/node/rejection-guard";
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
    expect(line).toContain("invalid job token: expired");
    // A message naming the session is enough too.
    expect(describeRejection(new Error("write failed session=s-456: boom"))).toContain("session=s-456");
    expect(describeRejection("plain")).toContain("session=unknown");
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

  it("without the guard the same rejection ends the process (what the guard is for)", async () => {
    const r = await runBun('setTimeout(() => void Promise.reject(new Error("x")), 10); setTimeout(() => console.log("still alive"), 200);');
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("still alive");
  });
});
