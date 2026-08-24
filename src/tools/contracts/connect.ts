/**
 * Contract for the `slaude_connect` MCP server (natural-language front door to
 * MCP OAuth connect).
 */
import { z } from "zod";
import type { ServerContract } from "./types";

export const CONNECT_SERVER = "slaude_connect";

export const connectContract = {
  server: CONNECT_SERVER,
  tools: {
    connect_mcp: {
      name: "connect_mcp",
      description:
        "Connect an external MCP server's OAuth so its tools become available, when the user asks to connect / authorize / log in to a service (e.g. 'connect workbench'). Posts an authorization link into this thread out-of-band and captures the result automatically — you never see or relay the link, and the user does NOT paste anything back. Returns a short status; tell the user you've started it and the link is in the thread. Authorization is scope-gated (your own services in a 1on1, the shared identity is manager-only).",
      schema: { server: z.string().describe("Name of the MCP server to connect (as shown by /mcp).") },
    },
  },
} as const satisfies ServerContract;
