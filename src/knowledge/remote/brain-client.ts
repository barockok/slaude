// RemoteBackend: an OAuth'd MCP client to the separate brain server. Slaude proxies
// already-scoped calls here (SLAUDE_BRAIN_MODE=remote). Registers itself as the
// remote factory on import so backend.getBackend() can resolve it without a static
// import cycle.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BrainBackend } from "../backend";
import { registerRemoteBackend } from "../backend";
import type { BrainScope } from "../scope";
import { brainBearerEnv } from "../brain-config";
import { agentConfigDir } from "../../agent/oauth-home";
import { readEntry } from "../../agent/mcp-oauth/store";

const BRAIN_SERVER_NAME = "slaude_brain";

function decodeToolResult(res: any): unknown {
  if (res?.isError) {
    let message = "remote brain error";
    try {
      message = JSON.parse(res.content?.[0]?.text ?? "{}").error ?? message;
    } catch {
      /* fall through */
    }
    throw new Error(message);
  }
  const text = res?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class RemoteBackend implements BrainBackend {
  #url: string;
  #clientPromise: Promise<Client> | undefined;

  constructor(url: string) {
    this.#url = url;
  }

  /** Resolve the bearer token: env first (bootstrap/testing), then the store. */
  #bearer(): string | undefined {
    const env = brainBearerEnv();
    if (env) return env;
    const entry = readEntry(agentConfigDir(), BRAIN_SERVER_NAME, { type: "http", url: this.#url });
    return entry?.accessToken;
  }

  async #client(): Promise<Client> {
    if (this.#clientPromise) return this.#clientPromise;
    this.#clientPromise = (async () => {
      const bearer = this.#bearer();
      const headers: Record<string, string> = {};
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      const transport = new StreamableHTTPClientTransport(new URL(this.#url), {
        requestInit: { headers },
      });
      const client = new Client({ name: "slaude", version: "0.2.0" });
      try {
        await client.connect(transport);
      } catch (e) {
        this.#clientPromise = undefined; // allow retry after a transient failure
        const msg = e instanceof Error ? e.message : String(e);
        // No bearer means an authenticated server will 401 the connect (the MCP
        // client masks the status), so the actionable cause is missing auth.
        if (!bearer) {
          throw new Error(
            "brain remote not authenticated — run `slaude brain connect` (or set SLAUDE_BRAIN_TOKEN)",
          );
        }
        throw new Error(`brain remote unreachable: ${msg}`);
      }
      return client;
    })();
    return this.#clientPromise;
  }

  async call(name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown> {
    const client = await this.#client();
    const res = await client.callTool({
      name: "brain_op",
      arguments: {
        op: name,
        params,
        clientId: scope.clientId,
        sourceId: scope.sourceId,
        allowedSources: scope.allowedSources,
      },
    });
    return decodeToolResult(res);
  }

  async adminCall(name: string, params: Record<string, unknown>, sourceId: string): Promise<unknown> {
    const client = await this.#client();
    const res = await client.callTool({
      name: "brain_admin_op",
      arguments: { op: name, params, sourceId },
    });
    return decodeToolResult(res);
  }
}

registerRemoteBackend((url) => new RemoteBackend(url));
