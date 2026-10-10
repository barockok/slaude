import { describe, it, expect, afterEach } from "bun:test";
import { AudioLink, redactCapabilityUrls } from "../../src/voice/audio-link";
import { pcmToBase64 } from "../../src/voice/provider/types";
import { until } from "./fakes";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function fakeWorkbench(opts: { getStatus?: number; postStatus?: number; dropFirstSse?: boolean; clearStatus?: number; clearHang?: boolean; postHang?: boolean; postEarly?: boolean; redirectTo?: string } = {}) {
  const st: any = { gets: 0, auth: [] as string[], cookie: [] as string[], route: [] as string[], uplinkBytes: 0, clears: 0, sseCtl: null as any };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (opts.redirectTo) return new Response("", { status: 307, headers: { location: opts.redirectTo + url.pathname } });
      st.auth.push(req.headers.get("authorization") ?? "");
      st.cookie.push(req.headers.get("cookie") ?? "");
      st.route.push(req.headers.get("x-browser-session") ?? "");
      if (url.pathname.endsWith("/audio/clear")) {
        st.clears++;
        if (opts.clearHang) return new Promise<Response>(() => {});
        if (opts.clearStatus) return new Response("", { status: opts.clearStatus });
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
        if (opts.postHang) return new Promise<Response>(() => {});
        if (opts.postEarly) return Response.json({ ok: true });
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
// Capability URLs: the per-audio-session secret lives in the path.
const CAP = "cap-5e1b0a77";
const endpoints = { streamUrl: `/api/browser/audio/${CAP}/audio/stream`, clearUrl: `/api/browser/audio/${CAP}/audio/clear`, headers: { "X-Browser-Session": "rk" }, sampleRate: 24000 };
let wb: any = null;
afterEach(() => wb?.stop());

describe("AudioLink", () => {
  it("streams audio frames, sends routing headers but no authorization, and uplinks PCM", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints });
    const got: number[][] = [];
    await link.start({ onAudio: (p) => got.push([...p]), onEnded: () => {} });
    await until(() => got.length === 1);
    expect(got[0]).toEqual([5, 6, 7]);
    link.write(new Int16Array(10));
    await link.close();
    await until(() => wb.uplinkBytes === 20);
    expect(wb.auth.length).toBeGreaterThan(0);
    expect(wb.auth.every((a: string) => a === "")).toBe(true);
    expect(wb.route.every((r: string) => r === "rk")).toBe(true);
  });

  it("maps the ended event to workbench:<reason>", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints });
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
    const link = new AudioLink({ baseUrl: wb.base, endpoints });
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
    const link = new AudioLink({ baseUrl: wb.base, endpoints });
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
    const link = new AudioLink({ baseUrl: wb.base, endpoints, retryDelayMs: 10 });
    let n = 0;
    await link.start({ onAudio: () => n++, onEnded: () => {} });
    await until(() => wb.gets === 2 && n === 2);
    expect(wb.gets).toBe(2);
    await link.close();
  });

  it("gives up with audio_lost after the retry budget", async () => {
    wb = fakeWorkbench({ getStatus: 500 });
    const link = new AudioLink({ baseUrl: wb.base, endpoints, retryDelayMs: 5, maxSseRetries: 3 });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => reason !== "");
    expect(reason).toBe("audio_lost");
    expect(wb.gets).toBe(4);
  });

  it("ends audio_lost when the uplink is refused with 404", async () => {
    wb = fakeWorkbench({ postStatus: 404 });
    const link = new AudioLink({ baseUrl: wb.base, endpoints });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => reason !== "");
    expect(reason).toBe("audio_lost");
    await link.close();
  });

  it("ends audio_lost when the uplink fails with a 5xx", async () => {
    wb = fakeWorkbench({ postStatus: 503 });
    const link = new AudioLink({ baseUrl: wb.base, endpoints });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => reason !== "");
    expect(reason).toBe("audio_lost");
    await link.close();
  });

  it("ends audio_lost when the uplink is answered (200) while the call is open", async () => {
    wb = fakeWorkbench({ postEarly: true });
    const link = new AudioLink({ baseUrl: wb.base, endpoints });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => reason !== "");
    expect(reason).toBe("audio_lost");
    await link.close();
  });

  it("close is bounded when the uplink never settles", async () => {
    wb = fakeWorkbench({ postHang: true });
    const link = new AudioLink({ baseUrl: wb.base, endpoints, closeTimeoutMs: 100 });
    await link.start({ onAudio: () => {}, onEnded: () => {} });
    const t0 = Date.now();
    await link.close();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("does not follow redirects (the bearer never leaves the pinned origin)", async () => {
    const hits: string[] = [];
    const evil = Bun.serve({ port: 0, fetch(req) { hits.push(req.headers.get("authorization") ?? ""); return new Response("x"); } });
    try {
      wb = fakeWorkbench({ redirectTo: `http://localhost:${evil.port}` });
      const link = new AudioLink({ baseUrl: wb.base, endpoints, maxSseRetries: 0, retryDelayMs: 1 });
      let reason = "";
      await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
      await until(() => reason !== "");
      expect(reason).toBe("audio_lost");
      expect(await link.clear()).toBeNull();
      await link.close();
      expect(hits).toEqual([]);
    } finally {
      void evil.stop();
    }
  });

  it("clear returns played and cleared ms", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints });
    await link.start({ onAudio: () => {}, onEnded: () => {} });
    expect(await link.clear()).toEqual({ playedMs: 1500, clearedMs: 900 });
    await link.close();
  });

  it("clear returns null on a non-OK answer (no fake 0 ms)", async () => {
    wb = fakeWorkbench({ clearStatus: 500 });
    const link = new AudioLink({ baseUrl: wb.base, endpoints });
    await link.start({ onAudio: () => {}, onEnded: () => {} });
    expect(await link.clear()).toBeNull();
    await link.close();
  });

  it("clear returns null when the workbench cannot be reached", async () => {
    const link = new AudioLink({ baseUrl: "http://127.0.0.1:1", endpoints });
    expect(await link.clear()).toBeNull();
  });

  it("a hung clear gives up after its timeout and returns null", async () => {
    wb = fakeWorkbench({ clearHang: true });
    const link = new AudioLink({ baseUrl: wb.base, endpoints, clearTimeoutMs: 100 });
    await link.start({ onAudio: () => {}, onEnded: () => {} });
    const t0 = Date.now();
    expect(await link.clear()).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    await link.close();
  });

  it("rejects endpoints that leave the configured origin", () => {
    const mk = (e: Partial<typeof endpoints>) => () => new AudioLink({ baseUrl: "http://localhost:1234", endpoints: { ...endpoints, ...e } });
    expect(mk({ streamUrl: "http://evil.example/x" })).toThrow("workbench endpoint origin mismatch");
    expect(mk({ clearUrl: "//other.example/x" })).toThrow("workbench endpoint origin mismatch");
    expect(mk({ streamUrl: "http://user:pw@localhost:1234/x" })).toThrow("workbench endpoint origin mismatch");
    expect(mk({ clearUrl: "http://user@localhost:1234/x" })).toThrow("workbench endpoint origin mismatch");
    expect(mk({})).not.toThrow();
    expect(mk({ streamUrl: "http://localhost:1234/abs/stream" })).not.toThrow();
    let msg = "";
    try { mk({ streamUrl: `http://evil.example/${CAP}/x` })(); } catch (e) { msg = String(e); }
    expect(msg).toContain("origin mismatch");
    expect(msg).not.toContain(CAP);
    expect(msg).not.toContain("evil.example");
  });

  it("drops authorization and cookie route headers; sends no authorization at all", async () => {
    wb = fakeWorkbench();
    const link = new AudioLink({ baseUrl: wb.base, endpoints: { ...endpoints, headers: { ...endpoints.headers, Authorization: "x", Cookie: "c" } } });
    await link.start({ onAudio: () => {}, onEnded: () => {} });
    await link.clear();
    await link.close();
    expect(wb.auth.length).toBeGreaterThan(0);
    expect(wb.auth.every((a: string) => a === "")).toBe(true);
    expect(wb.cookie.every((c: string) => c === "")).toBe(true);
    expect(wb.route.every((r: string) => r === "rk")).toBe(true);
  });

  it("write after uplink loss does not throw", async () => {
    wb = fakeWorkbench({ postStatus: 404 });
    const link = new AudioLink({ baseUrl: wb.base, endpoints });
    let reason = "";
    await link.start({ onAudio: () => {}, onEnded: (r) => (reason = r) });
    await until(() => reason === "audio_lost");
    expect(() => link.write(new Int16Array(4))).not.toThrow();
    await link.close();
  });
});

describe("redactCapabilityUrls", () => {
  const base = "https://wb.example.com";
  const eps = { streamUrl: `/api/browser/audio/${CAP}/stream`, clearUrl: `https://wb.example.com/api/browser/audio/${CAP}/clear?x=1` };
  it("replaces the absolute, resolved and path forms with the origin only", () => {
    const text = [
      `GET https://wb.example.com/api/browser/audio/${CAP}/stream failed`,
      `path /api/browser/audio/${CAP}/stream`,
      `clear https://wb.example.com/api/browser/audio/${CAP}/clear?x=1`,
      `clear path /api/browser/audio/${CAP}/clear`,
    ].join("\n");
    const out = redactCapabilityUrls(text, eps, base);
    expect(out).not.toContain(CAP);
    expect(out).toContain("https://wb.example.com/…");
  });
  it("leaves unrelated text alone", () => {
    expect(redactCapabilityUrls("provider: socket closed", eps, base)).toBe("provider: socket closed");
  });
  it("redacts even when the url cannot be resolved", () => {
    const out = redactCapabilityUrls(`bad http://[x/${CAP}`, { streamUrl: `http://[x/${CAP}`, clearUrl: "" }, base);
    expect(out).not.toContain(CAP);
  });
});

describe("redactCapabilityUrls: every form of the secret", () => {
  const base = "https://wb.example.com";
  const SIG = "Zq81xYvP0aLm";
  const abs = `https://wb.example.com/api/browser/audio/${CAP}/stream`;
  const eps = { streamUrl: `/api/browser/audio/${CAP}/stream`, clearUrl: `/api/browser/audio/${CAP}/clear?sig=${SIG}` };
  const r = (t: string) => redactCapabilityUrls(t, eps, base);
  const clean = (out: string) => {
    expect(out).not.toContain(CAP);
    expect(out).not.toContain(SIG);
    expect(out).not.toContain(encodeURIComponent(CAP));
    expect(out).not.toMatch(/https:\/\/wb\.example\.com(https|\/\/)/);
  };
  it("the URL-encoded full URL", () => {
    const out = r(`redirect to ?next=${encodeURIComponent(abs)}`);
    clean(out);
  });
  it("a bare query with the signature", () => {
    const out = r(`retrying ?sig=${SIG}`);
    clean(out);
    expect(out).toContain("sig=");
  });
  it("the secret as a lone path segment", () => {
    clean(r(`session ${CAP} expired`));
  });
  it("a URL with an extra query is masked whole, nothing trails", () => {
    const out = r(`${abs}?extra=1&b=2 failed`);
    clean(out);
    expect(out).toBe("https://wb.example.com/… failed");
  });
  it("embedded in JSON", () => {
    const out = r(JSON.stringify({ streamUrl: abs, clearUrl: eps.clearUrl, nested: JSON.stringify({ u: abs }) }));
    clean(out);
  });
  it("several URLs in one line", () => {
    const out = r(`a ${abs} b https://wb.example.com${eps.clearUrl} c https://docs.example/ok`);
    clean(out);
    expect(out).toBe("a https://wb.example.com/… b https://wb.example.com/… c https://docs.example/ok");
  });
  it("scheme-less and protocol-relative forms", () => {
    clean(r(`wb.example.com/api/browser/audio/${CAP}/stream`));
    clean(r(`//wb.example.com/api/browser/audio/${CAP}/stream`));
  });
  it("a scheme-less host form is masked once, never doubled", () => {
    for (const path of [eps.streamUrl, eps.clearUrl]) {
      const out = r(`wb.example.com${path}`);
      clean(out);
      expect(out).not.toContain("comhttps");
      expect(out).not.toContain("[redacted]");
      expect(out).toStartWith("wb.example.com/api/browser/audio/");
    }
  });

  it("the URL-encoded secret segment alone", () => {
    const eps2 = { streamUrl: "/a/s3cr3t+v@lue==/stream", clearUrl: "/a/s3cr3t+v@lue==/clear" };
    const out = redactCapabilityUrls(`seg ${encodeURIComponent("s3cr3t+v@lue==")}`, eps2, base);
    expect(out).not.toContain(encodeURIComponent("s3cr3t+v@lue=="));
  });
  it("a full URL is masked once, never doubled", () => {
    expect(r(`GET ${abs}`)).toBe("GET https://wb.example.com/…");
    expect(r(`path ${eps.streamUrl}`)).toBe("path https://wb.example.com/…");
  });
  it("without a base, relative forms mask to [redacted]", () => {
    const out = redactCapabilityUrls(`x ${eps.streamUrl}`, eps, "");
    expect(out).toBe("x [redacted]");
  });
  it("route words and short values are left alone", () => {
    expect(r("audio stream clear api browser attempt 1")).toBe("audio stream clear api browser attempt 1");
  });
});

describe("redactCapabilityUrls: exact match, whatever the secret's shape", () => {
  const base = "https://wb.example.com";
  it("a short secret segment is masked in every form", () => {
    const eps = { streamUrl: "/api/browser/audio/ab12/stream", clearUrl: "/api/browser/audio/ab12/clear" };
    for (const t of ["GET https://wb.example.com/api/browser/audio/ab12/stream", "path /api/browser/audio/ab12/clear", "key ab12 rejected", `enc ${encodeURIComponent("/api/browser/audio/ab12/stream")}`]) {
      expect(redactCapabilityUrls(t, eps, base)).not.toContain("ab12");
    }
  });
  it("an all-letter 8-character secret is masked, alone in an unrelated log line too", () => {
    const eps = { streamUrl: "/api/browser/audio/qwertyui/stream", clearUrl: "/api/browser/audio/qwertyui/clear" };
    expect(redactCapabilityUrls("provider said: token qwertyui is not valid", eps, base)).toBe("provider said: token … is not valid");
    expect(redactCapabilityUrls("wb.example.com/api/browser/audio/qwertyui/clear", eps, base)).not.toContain("qwertyui");
  });
  it("a short query value is masked wherever it appears", () => {
    const eps = { streamUrl: "/api/browser/audio/stream?sig=k9Zp", clearUrl: "/api/browser/audio/clear?sig=k9Zp" };
    expect(redactCapabilityUrls("bad signature k9Zp", eps, base)).not.toContain("k9Zp");
    expect(redactCapabilityUrls("q ?sig=k9Zp", eps, base)).not.toContain("k9Zp");
  });
  it("the encodeURI form of a secret is masked", () => {
    const eps = { streamUrl: "/api/browser/audio/s3c%20r3t/stream", clearUrl: "/api/browser/audio/s3c%20r3t/clear" };
    for (const t of ["raw s3c r3t", "enc s3c%20r3t", `full ${encodeURI("https://wb.example.com/api/browser/audio/s3c r3t/stream")}`]) {
      const out = redactCapabilityUrls(t, eps, base);
      expect(out).not.toContain("s3c r3t");
      expect(out).not.toContain("s3c%20r3t");
    }
  });
  it("route words stay readable", () => {
    const eps = { streamUrl: "/api/browser/tabs/audio/ab12/stream", clearUrl: "/api/browser/tabs/audio/ab12/clear" };
    expect(redactCapabilityUrls("api browser tabs audio stream clear: audio stream restarted", eps, base)).toBe("api browser tabs audio stream clear: audio stream restarted");
  });
  it("a one-letter test path does not eat letters inside words", () => {
    const eps = { streamUrl: "/s", clearUrl: "/c" };
    expect(redactCapabilityUrls("session=s1 closed cleanly", eps, base)).toBe("session=s1 closed cleanly");
  });
});
