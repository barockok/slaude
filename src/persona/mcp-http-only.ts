/**
 * Runtime (panel) persona changes may only describe remote HTTP MCP servers.
 * A stdio server (`command`/`args`) is a command to execute on the host: git is
 * the trusted path for that, a panel session is not.
 */
export class McpNotHttpOnlyError extends Error {}

/** Throws McpNotHttpOnlyError, naming the offending server only (never its values). */
export function assertHttpOnlyMcp(value: unknown): void {
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObj(value) || !isObj(value.mcpServers)) {
    throw new McpNotHttpOnlyError("mcp must be { mcpServers: { <name>: { type: \"http\", url } } }");
  }
  for (const [name, srv] of Object.entries(value.mcpServers)) {
    if (!isObj(srv) || srv.type !== "http" || typeof srv.url !== "string" || "command" in srv || "args" in srv) {
      throw new McpNotHttpOnlyError(`mcp server '${name}' must be type "http" with a url; stdio servers are not allowed at runtime`);
    }
    if (srv.headers !== undefined) {
      const h = srv.headers;
      if (!isObj(h) || Object.values(h).some((x) => typeof x !== "string")) {
        throw new McpNotHttpOnlyError(`mcp server '${name}' headers must be string values`);
      }
    }
  }
}
