// A credential-free stdio MCP server with one tool, `echo`. Newline-delimited JSON-RPC 2.0, no dependencies.
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
    if (m.method === "initialize") reply({ protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stdiospike", version: "1.0.0" } });
    else if (m.method === "tools/list") reply({ tools: [{ name: "echo", description: "echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
    else if (m.method === "tools/call") reply({ content: [{ type: "text", text: "echo:" + (m.params?.arguments?.text ?? "") + " pid:" + process.pid }] });
    else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n");
  }
});
