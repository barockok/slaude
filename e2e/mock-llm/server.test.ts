import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";

beforeAll(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "mock-llm-")), "main.mjs");
  const built = Bun.spawnSync(["bun", "build", "e2e/mock-llm/main.ts", "--target=node", "--outfile", out]);
  if (built.exitCode !== 0) throw new Error(`bundle failed: ${built.stderr.toString()}`);
  child = Bun.spawn(["node", out], { env: { ...process.env, PORT: "0" }, stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let seen = "";
  while (!/listening on (\d+)/.test(seen)) {
    const { value, done } = await reader.read();
    if (done) throw new Error("mock exited before listening");
    seen += new TextDecoder().decode(value);
  }
  base = `http://127.0.0.1:${/listening on (\d+)/.exec(seen)![1]}`;
}, 60_000);

afterAll(() => {
  child?.kill();
});

const TOOLS = [{ name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }];

function post(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-mock", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

function request(userText: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: "claude-sonnet-5-5", max_tokens: 256, stream: true, messages: [{ role: "user", content: userText }], ...extra };
}

async function events(res: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      let data: unknown = raw;
      try {
        data = JSON.parse(raw);
      } catch {}
      return { event, data };
    });
}

const textOf = (evs: Array<{ data: any }>): string =>
  evs.map((e) => (e.data?.delta?.type === "text_delta" ? e.data.delta.text : "")).join("");

describe("mock-llm server", () => {
  test("healthz and count_tokens", async () => {
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
    const r = await fetch(`${base}/v1/messages/count_tokens`, { method: "POST", body: "{}" });
    expect((await r.json()) as { input_tokens: number }).toEqual({ input_tokens: 1 });
  });

  test("echo streams the persona-labelled text as Anthropic SSE", async () => {
    const res = await post(request("[[mock:echo]] hello", { system: "Persona-ID: alpha" }));
    expect(res.status).toBe(200);
    const evs = await events(res);
    expect(evs[0]!.event).toBe("message_start");
    expect(textOf(evs)).toBe("[alpha] hello");
    expect(evs.at(-1)!.event).toBe("message_stop");
  });

  test("untagged requests still get a valid reply (CLI side calls)", async () => {
    const res = await post(request("suggest a title"));
    expect(res.status).toBe(200);
    expect(textOf(await events(res))).toBe("mock: untagged request");
  });

  test("tool loop: tool_use first, then the summary once the tool_result is in the history", async () => {
    const first = await events(await post(request("[[mock:multi-tool n=1]] go", { tools: TOOLS })));
    const start = first.find((e) => e.data?.content_block?.type === "tool_use");
    expect(start?.data.content_block.name).toBe("Bash");
    expect(start?.data.content_block.id).toBe("toolu_mock_1");

    const second = await events(
      await post(
        request("x", {
          tools: TOOLS,
          messages: [
            { role: "user", content: "[[mock:multi-tool n=1]] go" },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_mock_1", name: "Bash", input: { command: "echo step-1" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mock_1", content: "step-1" }] },
          ],
        }),
      ),
    );
    expect(textOf(second)).toBe("done after 1 tools");
  });

  test("echo answers through slaude's surface reply tool when the request offers it, and the journal shows it", async () => {
    await fetch(`${base}/__mock/journal`, { method: "DELETE" });
    const reply = { name: "mcp__slaude_surface__reply", description: "reply", input_schema: { type: "object", properties: { text: { type: "string" } } } };
    const tools = [...TOOLS, reply];
    const first = await events(await post(request("[[mock:echo]] via tool", { system: "Persona-ID: alpha", tools })));
    const start = first.find((e) => e.data?.content_block?.type === "tool_use");
    expect(start?.data.content_block.name).toBe("mcp__slaude_surface__reply");
    const input = first.map((e) => (e.data?.delta?.type === "input_json_delta" ? e.data.delta.partial_json : "")).join("");
    expect(JSON.parse(input)).toEqual({ text: "[alpha] via tool" });
    expect(textOf(first)).toBe("");

    const second = await events(
      await post(
        request("x", {
          system: "Persona-ID: alpha",
          tools,
          messages: [
            { role: "user", content: "[[mock:echo]] via tool" },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_mock_reply", name: reply.name, input: { text: "[alpha] via tool" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mock_reply", content: "{\"ref\":\"1.2\"}" }] },
          ],
        }),
      ),
    );
    expect(textOf(second)).toBe("replied");
    const rows = (await (await fetch(`${base}/__mock/journal`)).json()) as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.tag, r.persona, r.offersReply])).toEqual([
      ["echo", "alpha", true],
      ["echo", "alpha", true],
    ]);
  });

  test("the same request gets the same reply every time (stateless)", async () => {
    const a = textOf(await events(await post(request("[[mock:long-stream chunks=6]] go"))));
    const b = textOf(await events(await post(request("[[mock:long-stream chunks=6]] go"))));
    expect(a).toBe(b);
    expect(a.match(/chunk-\d+/g)).toHaveLength(6);
  });

  test("think reasoning arrives as a thinking block, not as answer text", async () => {
    const evs = await events(await post(request("[[mock:think]] q")));
    expect(evs.some((e) => e.data?.content_block?.type === "thinking")).toBe(true);
    expect(textOf(evs)).toBe("thought about it");
  });

  test("fail=529 errors on the first attempt and succeeds on the identical retry", async () => {
    const body = request("[[mock:echo fail=529]] x");
    const first = await post(body);
    expect(first.status).toBe(529);
    expect(((await first.json()) as { error: { type: string } }).error.type).toBe("overloaded_error");
    const retry = await post(body);
    expect(retry.status).toBe(200);
    await retry.text();
    // a different history has its own counter and still fails first time
    expect((await post(request("[[mock:echo fail=529]] y"))).status).toBe(529);
  });

  test("the attempt counter is per system prompt, so each persona fails its own first attempt", async () => {
    const msg = request("[[mock:echo fail=529]] shared text");
    const alpha = { ...msg, system: "Persona-ID: alpha" };
    const beta = { ...msg, system: "Persona-ID: beta" };
    expect((await post(alpha)).status).toBe(529);
    expect((await post(beta)).status).toBe(529);
    const again = await post(alpha);
    expect(again.status).toBe(200);
    await again.text();
  });

  test("the user message's tag governs content and faults, not one in the system prompt", async () => {
    const a = await post(request("[[mock:echo]] hi", { system: "Persona-ID: alpha [[mock:echo fail=529]]" }));
    expect(a.status).toBe(200);
    expect(textOf(await events(a))).toBe("[alpha] hi");
    const b = await post(request("[[mock:echo fail=529]] hi2", { system: "Persona-ID: alpha [[mock:echo]]" }));
    expect(b.status).toBe(529);
    await b.text();
  });

  test("with two tags in one user message the first governs both content and faults", async () => {
    const res = await post(request("[[mock:echo]] x [[mock:echo fail=529]]"));
    expect(res.status).toBe(200);
    expect(textOf(await events(res))).toBe("[unknown] x");
  });

  test("until-retry=2 keeps failing twice, then succeeds", async () => {
    const body = request("[[mock:echo fail=529 until-retry=2]] ur");
    expect((await post(body)).status).toBe(529);
    expect((await post(body)).status).toBe(529);
    const ok = await post(body);
    expect(ok.status).toBe(200);
    await ok.text();
  });

  test("a query string (?beta=true) is preserved and works like the bare path", async () => {
    const res = await fetch(`${base}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-mock" },
      body: JSON.stringify(request("[[mock:echo]] beta", { system: "Persona-ID: alpha" })),
    });
    expect(res.status).toBe(200);
    expect(textOf(await events(res))).toBe("[alpha] beta");
  });

  test("overflow returns a 400 prompt-too-long error", async () => {
    const res = await post(request("[[mock:echo overflow=1]] x"));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("prompt is too long");
  });

  test("malformed returns bad SSE", async () => {
    const res = await post(request("[[mock:echo malformed=1]] x"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("{not json");
  });

  test("drop=2 cuts the stream after two events", async () => {
    // Bun's fetch silently retries a request whose reused keep-alive connection dies; `keepalive:
    // false` keeps the test from seeing a second, concatenated stream.
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-mock" },
      body: JSON.stringify(request("[[mock:long-stream chunks=30 drop=2]] go")),
      keepalive: false,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {}
    const blocks = text.split("\n\n").filter(Boolean);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toStartWith("event: message_start");
    expect(text).not.toContain("message_stop");
  });

  test("ttft delays the first byte", async () => {
    const t0 = Date.now();
    await (await post(request("[[mock:echo ttft=300ms]] x"))).text();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
  });

  test("hang never answers, an abort releases it, and the server keeps serving", async () => {
    const ctl = new AbortController();
    const hung = post(request("[[mock:echo hang=1]] x"), {}, ctl.signal).catch((e: Error) => e.name);
    setTimeout(() => ctl.abort(), 200);
    expect(await hung).toBe("AbortError");
    expect((await post(request("[[mock:echo]] still up"))).status).toBe(200);
  });

  test("aborting mid-delay does not break later requests", async () => {
    const ctl = new AbortController();
    const slow = post(request("[[mock:echo ttft=5s]] x"), {}, ctl.signal).catch((e: Error) => e.name);
    setTimeout(() => ctl.abort(), 100);
    expect(await slow).toBe("AbortError");
    expect((await post(request("[[mock:echo]] fine"))).status).toBe(200);
  });

  test("hostile bodies never crash the server", async () => {
    for (const body of ["", "not json", "[[mock:echo]]", "{".repeat(50_000), JSON.stringify({ messages: "nope" })]) {
      const res = await post(body);
      expect(res.status).toBeLessThan(600);
      await res.text().catch(() => "");
    }
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  test("concurrent requests with different tags do not interfere", async () => {
    const texts = await Promise.all(
      ["one", "two", "three", "four"].map(async (w) => textOf(await events(await post(request(`[[mock:echo]] ${w}`))))),
    );
    expect(texts).toEqual(["[unknown] one", "[unknown] two", "[unknown] three", "[unknown] four"]);
  });

  test("the journal records tag, retry count, action and a history hash, and can be cleared", async () => {
    await fetch(`${base}/__mock/journal`, { method: "DELETE" });
    await post(request("[[mock:echo fail=529]] j"));
    await (await post(request("[[mock:echo fail=529]] j"))).text();
    const rows = (await (await fetch(`${base}/__mock/journal`)).json()) as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.tag, r.retryCount, r.action])).toEqual([
      ["echo", 0, "error"],
      ["echo", 1, "proxy"],
    ]);
    expect(rows.map((r) => r.clientRetryCount)).toEqual([0, 0]);
    expect(rows[0]!.historyHash).toBe(rows[1]!.historyHash);
    expect(rows[0]!.messages).toBe(1);
  });

  test("aimock's own journal is reachable through the passthrough", async () => {
    const res = await fetch(`${base}/__aimock/journal`);
    expect(res.status).toBe(200);
  });
});
