import { afterEach, describe, expect, test } from "bun:test";
import { startBrainServer, type StartedBrainServer } from "../src/knowledge/server/brain-server";
import type { BrainServerDeps } from "../src/knowledge/server/tools";
import { RemoteBackend } from "../src/knowledge/remote/brain-client";
import type { BrainScope } from "../src/knowledge/scope";

let started: StartedBrainServer | undefined;
afterEach(async () => {
  await started?.stop();
  started = undefined;
  delete process.env.SLAUDE_BRAIN_TOKEN;
});

const scope: BrainScope = { clientId: "agent", sourceId: "agent", allowedSources: ["agent", "shared"] };

function recordingDeps(): { deps: BrainServerDeps; calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    deps: {
      runScoped: async (name, params, s) => {
        calls.push({ kind: "scoped", name, params, scope: s });
        return { ok: true, name };
      },
      runAdmin: async (name, params, sourceId) => {
        calls.push({ kind: "admin", name, params, sourceId });
        return { sources: [] };
      },
    },
  };
}

describe("RemoteBackend over OAuth'd MCP client", () => {
  test("call() forwards op + scope and round-trips the result", async () => {
    const { deps, calls } = recordingDeps();
    started = await startBrainServer({ port: 0, host: "127.0.0.1", authDisabled: true }, deps);
    process.env.SLAUDE_BRAIN_TOKEN = "test-token";
    const backend = new RemoteBackend(started.url);
    const result = await backend.call("think", { q: "hi" }, scope);
    expect(result).toEqual({ ok: true, name: "think" });
    expect(calls[0]).toEqual({ kind: "scoped", name: "think", params: { q: "hi" }, scope });
  });

  test("adminCall() forwards op + sourceId", async () => {
    const { deps, calls } = recordingDeps();
    started = await startBrainServer({ port: 0, host: "127.0.0.1", authDisabled: true }, deps);
    process.env.SLAUDE_BRAIN_TOKEN = "test-token";
    const backend = new RemoteBackend(started.url);
    const result = await backend.adminCall("sources_list", {}, "default");
    expect(result).toEqual({ sources: [] });
    expect(calls[0]).toEqual({ kind: "admin", name: "sources_list", params: {}, sourceId: "default" });
  });

  test("engine errors propagate as thrown errors", async () => {
    const deps: BrainServerDeps = {
      runScoped: async () => {
        throw new Error("scope denied");
      },
      runAdmin: async () => ({}),
    };
    started = await startBrainServer({ port: 0, host: "127.0.0.1", authDisabled: true }, deps);
    process.env.SLAUDE_BRAIN_TOKEN = "test-token";
    const backend = new RemoteBackend(started.url);
    await expect(backend.call("think", {}, scope)).rejects.toThrow("scope denied");
  });

  test("no token + auth required → clear connect hint", async () => {
    const { deps } = recordingDeps();
    started = await startBrainServer(
      { port: 0, host: "127.0.0.1", authDisabled: false, publicUrl: "https://brain.example", issuer: "https://kc.example/realms/r", audience: "a" },
      deps,
    );
    // No SLAUDE_BRAIN_TOKEN and no stored entry (test $SLAUDE_HOME is fresh).
    const backend = new RemoteBackend(started.url);
    await expect(backend.call("think", {}, scope)).rejects.toThrow(/slaude brain connect/);
  });
});
