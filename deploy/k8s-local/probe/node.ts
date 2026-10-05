#!/usr/bin/env bun
// Node-side probe for verify-ha.sh and verify-turns.sh. Runs INSIDE a node pod,
// as that node: the node's own credential (SLAUDE_NODE_TOKEN) and the gateway
// URL from its environment, through the node's own client (NodeClient). It
// never prints a credential or a secret value; a provider key is reported as a
// sha256 prefix only.
//
//   whoami                  JSON: { status, id, labels, legacy }
//   runtime <persona>       JSON: { status, gate, keySha, mcpServers }
//                           (job token on stdin; tenant default)
//   mcpx <server> list      JSON: { status, gate, tools, unavailable?, reason? } (job token on stdin)
//   mcpx <server> call <text>
//                           JSON: { status, gate, isError, text } (calls `echo`)
//
// `status` is the HTTP status (200 on success); `gate` is true when the
// gateway's label gate refused this node (403).
import { createHash } from "node:crypto";
import { GateDenied, NodeApiError, NodeClient } from "/app/src/node/client.ts";

const [cmd, a1, a2, a3] = process.argv.slice(2);
// One attempt, no retries: a refusal must be reported, not retried away.
const client = new NodeClient({ attempts: 1 });
const sha = (v: string | undefined) => (v ? createHash("sha256").update(v).digest("hex").slice(0, 12) : null);
const out = (o: Record<string, unknown>) => {
  console.log(JSON.stringify(o));
  process.exit(0);
};
const failure = (e: unknown) => {
  if (e instanceof NodeApiError) out({ status: e.status, gate: e instanceof GateDenied });
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
};
const token = async () => {
  const t = (await Bun.stdin.text()).trim();
  if (!t) {
    console.error("no job token on stdin");
    process.exit(2);
  }
  return t;
};

try {
  if (cmd === "whoami") {
    const id = await client.whoami();
    out({ status: 200, id: id.id, labels: id.labels, legacy: id.legacy });
  } else if (cmd === "runtime" && a1) {
    const b = await client.getRuntime("default", a1, await token());
    const c = b.providerCreds ?? {};
    out({ status: 200, gate: false, keySha: sha(c.apiKey ?? c.authToken ?? c.oauthToken), mcpServers: b.mcpServers ?? [] });
  } else if (cmd === "mcpx" && a1 && a2 === "list") {
    const r = (await client.postMcpx(a1, "list", {}, await token())) as {
      tools?: Array<{ name: string }>;
      unavailable?: boolean;
      instructions?: string;
    };
    // When the upstream could not be listed the gateway answers no tools and a
    // fixed reason (never the upstream's own text).
    out({
      status: 200,
      gate: false,
      tools: (r.tools ?? []).map((t) => t.name),
      ...(r.unavailable ? { unavailable: true, reason: String(r.instructions ?? "").slice(0, 200) } : {}),
    });
  } else if (cmd === "mcpx" && a1 && a2 === "call") {
    const r = (await client.postMcpx(a1, "call", { name: "echo", arguments: { text: a3 ?? "" } }, await token())) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    out({ status: 200, gate: false, isError: !!r.isError, text: (r.content ?? []).map((c) => c.text ?? "").join("") });
  } else {
    console.error("usage: node.ts whoami | runtime <persona> | mcpx <server> list | mcpx <server> call <text>");
    process.exit(2);
  }
} catch (e) {
  failure(e);
}
