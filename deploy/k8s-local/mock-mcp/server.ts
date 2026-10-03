// A throwaway OAuth-protected HTTP MCP server for exercising the portal's
// connect flow locally. It is the resource server and the authorization server
// in one: protected-resource metadata, authorization-server metadata, dynamic
// client registration, an authorize endpoint that approves instantly, and a
// token endpoint. Nothing is validated: this is a test double, never deploy it.
const ORIGIN = process.env.MOCK_MCP_ORIGIN ?? "http://localhost:9000";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Bun.serve({
  port: 9000,
  async fetch(req) {
    const url = new URL(req.url);
    console.log(req.method, url.pathname);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const body: any = await req.json().catch(() => ({}));
      return json({ ...body, client_id: `mock-${crypto.randomUUID()}`, client_secret: crypto.randomUUID() }, 201);
    }
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "mock-code");
      const state = url.searchParams.get("state");
      if (state) redirect.searchParams.set("state", state);
      return Response.redirect(redirect.toString(), 302);
    }
    if (url.pathname === "/token" && req.method === "POST") {
      return json({ access_token: `mock-at-${crypto.randomUUID()}`, refresh_token: `mock-rt-${crypto.randomUUID()}`, token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/mcp") {
      if (!(req.headers.get("authorization") ?? "").startsWith("Bearer ")) {
        return new Response("unauthorized", {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"` },
        });
      }
      return json({ jsonrpc: "2.0", id: 1, result: {} });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log("mock mcp listening on :9000, origin", ORIGIN);
