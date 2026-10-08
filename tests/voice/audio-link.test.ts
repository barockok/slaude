import { describe, it, expect, afterEach } from "bun:test";
import { AudioLink } from "../../src/voice/audio-link";
import { pcmToBase64 } from "../../src/voice/provider/types";
import { until } from "./fakes";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function fakeWorkbench(opts: { getStatus?: number; postStatus?: number; dropFirstSse?: boolean } = {}) {
  const st: any = { gets: 0, auth: [] as string[], route: [] as string[], uplinkBytes: 0, clears: 0, sseCtl: null as any };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      st.auth.push(req.headers.get("authorization") ?? "");
      st.route.push(req.headers.get("x-browser-session") ?? "");
      if (url.pathname.endsWith("/audio/clear")) {
        st.clears++;
        return Response.json({ played_ms: 1500, cleared_ms: 900 });
      }
      if (req.method === "GET") {
        st.gets++;
        if (opts.getStatus) return new Response("", { status: opts.getStatus });
        const first = st.gets === 1;
        return new Response(new ReadableStream({
          start(c) {
            st.sseCtl = c;
            c.enqueue(new TextEncoder().encode(": ping\n\n"));
            c.enqueue(new TextEncoder().encode(sse("audio", { seq: 1, pcm: pcmToBase64(new Int16Array([5, 6, 7])) })));
            if (first && opts.dropFirstSse) c.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (req.method === "POST") {
        if (opts.postStatus) return new Response("", { status: opts.postStatus });
        for await (const chunk of req.body as any) st.uplinkBytes += chunk.byteLength;
        return Response.json({ played_ms: 0 });
      }
      return new Response("", { status: 404 });
    },
  });
  st.base = `http://localhost:${server.port}`;
  st.stop = () => void server.stop();
  return st;
}
const endpoints = { streamUrl: "/api/browser/tabs/t1/audio/stream", clearUrl: "/api/browser/tabs/t1/audio/clear", headers: { "X-Browser-Session": "rk" }, sampleRate: 24000 };
let wb: any = null;
afterEach(() => wb?.stop());

describe("AudioLink", () => {
  it("streams audio frames, sends auth + routing headers, and uplinks PCM", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "stok" });
    const got: number[][] = [];
    await link.start({ onAudio: (p) => got.push([...p]), onEnded: () => {} });
    await until(() => got.length === 1);
    expect(got[0]).toEqual([5, 6, 7]);
    link.write(new Int16Array(10));
    await link.close();
    await until(() => wb.uplinkBytes === 20);
    expect(wb.auth.every((a: string) => a === "Bearer stok")).toBe(true);
    expect(wb.route.every((r: string) => r === "rk")).toBe(true);
  });

  it("maps the ended event to workbench:<reason>", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s" });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => wb.sseCtl !== null);
    wb.sseCtl.enqueue(new TextEncoder().encode(sse("ended", { reason: "tab_closed" })));
    await until(() => reason !== "");
    expect(reason).toBe("workbench:tab_closed");
    await link.close();
  });

  it("sanitizes the workbench end reason", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s" });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => wb.sseCtl !== null);
    wb.sseCtl.enqueue(new TextEncoder().encode(sse("ended", { reason: "Tab-Closed" })));
    await until(() => reason !== "");
    expect(reason).toBe("workbench:tab_closed");
    await link.close();
  });

  it("caps the sanitized reason at 64 chars", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s" });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => wb.sseCtl !== null);
    wb.sseCtl.enqueue(new TextEncoder().encode(sse("ended", { reason: "x".repeat(200) })));
    await until(() => reason !== "");
    expect(reason).toBe(`workbench:${"x".repeat(64)}`);
    await link.close();
  });

  it("re-GETs the stream after a blip", async () => {
    wb = fakeWorkbench({ dropFirstSse: true });
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s", retryDelayMs: 10 });
    let n = 0;
    await link.start({ onAudio: () => n++, onEnded: () => {} });
    await until(() => wb.gets === 2 && n === 2);
    expect(wb.gets).toBe(2);
    await link.close();
  });

  it("gives up with audio_lost after the retry budget", async () => {
    wb = fakeWorkbench({ getStatus: 500 });
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s", retryDelayMs: 5, maxSseRetries: 3 });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => reason !== "");
    expect(reason).toBe("audio_lost");
    expect(wb.gets).toBe(4);
  });

  it("ends audio_lost when the uplink is refused with 404", async () => {
    wb = fakeWorkbench({ postStatus: 404 });
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s" });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => reason !== "");
    expect(reason).toBe("audio_lost");
    await link.close();
  });

  it("clear returns played and cleared ms", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints, streamToken: "s" });
    await link.start({ onAudio: () => {}, onEnded: () => {} });
    expect(await link.clear()).toEqual({ playedMs: 1500, clearedMs: 900 });
    await link.close();
  });
});
