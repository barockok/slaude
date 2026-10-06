/**
 * H31, as it was. BrainMemoryProvider.prefetch/syncTurn (the in-process path)
 * take no persona: they scope by the PROCESS identity. A node process never
 * resolves one (no SLAUDE_AGENT_ID, no auth.test), so before memory moved to
 * the gateway every persona's transcripts on a node, 1:1s included, landed in
 * one `agent-default` slice. This pins that behaviour of the unscoped path, so
 * nothing may route node memory back through it; nodes use the gateway's
 * routes (tests/agent/node-memory.test.ts, tests/gateway/api/memory-gateway.test.ts).
 * mono no longer uses it either: createGateway installs a provider scoped by
 * each turn's own context (tests/gateway/core/mono-memory-scope.test.ts).
 */
import { afterEach, expect, test } from "bun:test";
import { BrainMemoryProvider } from "../../src/memory/brain-provider";
import { resetAgentId } from "../../src/knowledge/agent-identity";
import { agentSourceId } from "../../src/knowledge/scope";
import { fakeBrain } from "./fake-brain";

const saved = process.env.SLAUDE_AGENT_ID;
afterEach(() => {
  if (saved === undefined) delete process.env.SLAUDE_AGENT_ID;
  else process.env.SLAUDE_AGENT_ID = saved;
  resetAgentId();
});

test("the unscoped provider path writes every session into the process slice (agent-default on a node)", async () => {
  delete process.env.SLAUDE_AGENT_ID;
  resetAgentId();
  const fb = fakeBrain();
  const p = new BrainMemoryProvider({ call: fb.call, ready: async () => {} });
  // Two sessions that belong to two different named personas.
  await p.syncTurn({ sessionId: "S-finance", user: "u", assistant: "a" });
  await p.syncTurn({ sessionId: "S-engineering", user: "u", assistant: "a" });
  expect(fb.sourcesOf("S-finance")).toEqual([agentSourceId("default")]);
  expect(fb.sourcesOf("S-engineering")).toEqual([agentSourceId("default")]);
});
