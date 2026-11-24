/**
 * Review focus, items 1 and 3 (box plan, "Review Focus"), from angles the
 * phase suites do not take:
 *
 *   - a boxed spawn's environment, one sensitive name at a time, by NAME as
 *     well as by value, and through the box's own `env` as well as the SDK's;
 *   - the provider proxy on every redirect status, on a redirect that answers
 *     the retry, and in what it logs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_ENV_KEYS } from "../../src/agent/provider-env";
import { startProviderProxy, type ProviderProxy } from "../../src/box/egress/llm";
import { BOX_CREDENTIAL_PLACEHOLDER, BOX_PROVIDER_PROXY_URL, PROVIDER_FORM_ENV, buildBoxEnv, type ProviderForm } from "../../src/box/env";
import { defaultBoxPolicy } from "../../src/box/policy";
import { GATEWAY_ONLY_ENV_NAMES, GATEWAY_ONLY_ENV_PREFIXES } from "../../src/config/gateway-only-env";

const FORMS: ProviderForm[] = ["api-key", "auth-token", "oauth-token"];

/** Every name the review item lists: provider keys, gateway-only names and prefixes, the node token, Redis, the object store. */
const SENSITIVE: string[] = [
  ...PROVIDER_ENV_KEYS,
  ...GATEWAY_ONLY_ENV_NAMES,
  ...GATEWAY_ONLY_ENV_PREFIXES.map((p) => `${p}ANYTHING`),
  "SLAUDE_NODE_TOKEN",
  "SLAUDE_REDIS_URL",
  "SLAUDE_S3_ENDPOINT",
  "SLAUDE_S3_BUCKET",
  "SLAUDE_S3_REGION",
  "SLAUDE_S3_PREFIX",
  "SLAUDE_S3_ACCESS_KEY_ID",
  "SLAUDE_S3_SECRET_ACCESS_KEY",
  "SLAUDE_S3_SESSION_TOKEN",
  "SLAUDE_S3_FORCE_PATH_STYLE",
];

const valueOf = (name: string): string => `node-value-of-${name.toLowerCase()}`;

const input = (over: Partial<Parameters<typeof buildBoxEnv>[0]> = {}) => ({
  sdkEnv: {},
  imageEnv: { PATH: "/usr/bin:/bin" },
  policy: defaultBoxPolicy(),
  scratchDir: "/data/scratch/s1",
  configDir: "/config/s1",
  providerForm: "api-key" as ProviderForm,
  ...over,
});

/** The names a box has when the SDK's environment holds nothing a rule copies. */
const builtNames = (form: ProviderForm): string[] => Object.keys(buildBoxEnv(input({ providerForm: form }))).sort();

describe("review focus 1: a boxed spawn's environment", () => {
  test("the list under test is the plan's: every provider key, every gateway-only name, the node token, Redis and the object store", () => {
    for (const k of PROVIDER_ENV_KEYS) expect(SENSITIVE).toContain(k);
    for (const k of GATEWAY_ONLY_ENV_NAMES) expect(SENSITIVE).toContain(k);
    expect(SENSITIVE.filter((k) => k.startsWith("SLAUDE_S3_")).length).toBeGreaterThanOrEqual(4);
    expect(new Set(SENSITIVE).size).toBe(SENSITIVE.length);
  });

  for (const form of FORMS) {
    test(`one name at a time, the node's value never arrives and the name adds nothing (${form})`, () => {
      const base = builtNames(form);
      for (const name of SENSITIVE) {
        const out = buildBoxEnv(input({ sdkEnv: { [name]: valueOf(name) }, providerForm: form }));
        expect(JSON.stringify(out)).not.toContain(valueOf(name));
        // No name appears because the node held it: the box has exactly what it has with an empty SDK environment.
        expect(Object.keys(out).sort()).toEqual(base);
      }
    });

    test(`all at once: of the provider keys only the relay and the form's placeholder exist (${form})`, () => {
      const sdkEnv = Object.fromEntries(SENSITIVE.map((n) => [n, valueOf(n)]));
      const out = buildBoxEnv(input({ sdkEnv, providerForm: form }));
      expect(Object.keys(out).sort()).toEqual(builtNames(form));
      for (const k of PROVIDER_ENV_KEYS) {
        if (k === "ANTHROPIC_BASE_URL") expect(out[k]).toBe(BOX_PROVIDER_PROXY_URL);
        else if (k === PROVIDER_FORM_ENV[form]) expect(out[k]).toBe(BOX_CREDENTIAL_PLACEHOLDER);
        else expect(Object.hasOwn(out, k)).toBe(false);
      }
      for (const n of SENSITIVE) expect(JSON.stringify(out)).not.toContain(valueOf(n));
    });

    test(`the same names in the box's own env (a stored policy that got past the schema) are ignored too (${form})`, () => {
      const policy = { ...defaultBoxPolicy(), env: Object.fromEntries(SENSITIVE.map((n) => [n, valueOf(n)])) };
      const out = buildBoxEnv(input({ policy, providerForm: form }));
      expect(Object.keys(out).sort()).toEqual(builtNames(form));
      for (const n of SENSITIVE) expect(JSON.stringify(out)).not.toContain(valueOf(n));
    });
  }

  test("an undefined or empty value in the SDK's environment is never turned into a variable", () => {
    const out = buildBoxEnv(input({ sdkEnv: { ANTHROPIC_API_KEY: undefined, SLAUDE_NODE_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: undefined } }));
    expect(Object.keys(out).sort()).toEqual(builtNames("api-key"));
    for (const v of Object.values(out)) expect(typeof v).toBe("string");
  });
});

// ---------------------------------------------------------------------------

const REAL = "real-provider-credential-fedcba9876543210";
const UPSTREAM = "https://provider.example";
let dir: string;
let proxy: ProviderProxy | null = null;
let n = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "slaude-rf-llm-"));
});
afterEach(async () => {
  await proxy?.close();
  proxy = null;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Call = { url: string; method: string; headers: Record<string, string>; redirect: unknown };
const via = (p: ProviderProxy, path: string, init: RequestInit = {}) => fetch(`http://box.invalid${path}`, { ...init, unix: p.socketPath } as RequestInit);

/** A proxy whose upstream is a function: every send is recorded, nothing leaves the process. */
async function start(answer: (call: Call, nth: number) => Response | Promise<Response>, form: ProviderForm = "api-key") {
  const calls: Call[] = [];
  const lines: string[] = [];
  proxy = await startProviderProxy({
    socketPath: join(dir, `p${n++}.sock`),
    upstream: UPSTREAM,
    credential: () => ({ form, value: REAL }),
    log: (l) => lines.push(l),
    fetch: (async (url: string, init: RequestInit) => {
      const call: Call = { url: String(url), method: String(init.method), headers: Object.fromEntries(new Headers(init.headers as Headers)), redirect: init.redirect };
      calls.push(call);
      return answer(call, calls.length);
    }) as unknown as typeof fetch,
  });
  return { proxy, calls, lines };
}

describe("review focus 3: the provider proxy", () => {
  for (const status of [300, 301, 302, 303, 304, 307, 308]) {
    test(`a ${status} from the provider is refused: one send, never followed, its target never told to the box`, async () => {
      const s = await start(() => new Response(null, { status, headers: { location: `https://elsewhere.example/steal?k=${REAL}`, "x-echo": REAL } }));
      const r = await via(s.proxy, "/v1/messages", { method: "POST", headers: { "x-api-key": BOX_CREDENTIAL_PLACEHOLDER }, body: "{}" });
      const text = await r.text();
      expect(r.status).toBe(502);
      expect(r.headers.get("location")).toBeNull();
      expect(JSON.stringify([...r.headers])).not.toContain(REAL);
      expect(text).not.toContain("elsewhere.example");
      expect(text).not.toContain(REAL);
      // The proxy itself asked for the redirect not to be followed, and sent the request to the one upstream only.
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0]!.redirect).toBe("manual");
      expect(new URL(s.calls[0]!.url).origin).toBe(UPSTREAM);
    });
  }

  test("a redirect that answers the retry is refused the same way, and the retry went to the same host with the same rule", async () => {
    const s = await start((_c, nth) => {
      if (nth === 1) throw new Error(`connection reset while sending ${REAL}`);
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
    });
    const r = await via(s.proxy, "/v1/messages", { method: "POST", body: '{"model":"m"}' });
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("elsewhere.example");
    expect(s.calls).toHaveLength(2);
    for (const c of s.calls) {
      expect(new URL(c.url).origin).toBe(UPSTREAM);
      expect(c.redirect).toBe("manual");
      expect(c.headers["x-api-key"]).toBe(REAL);
    }
  });

  test("whatever the box names (another host, a scheme, userinfo, dot segments), every send goes to the one upstream origin", async () => {
    const s = await start(() => new Response("ok"));
    for (const path of ["/v1/messages", "//elsewhere.example/v1/messages", "/@elsewhere.example/x", "/..%2f..%2f/elsewhere.example", "/v1/x?next=https://elsewhere.example/"]) {
      await (await via(s.proxy, path, { method: "POST", body: "{}" })).text();
    }
    expect(s.calls.length).toBe(5);
    for (const c of s.calls) {
      const u = new URL(c.url);
      expect(u.origin).toBe(UPSTREAM);
      expect(u.username).toBe("");
    }
  });

  for (const form of FORMS) {
    test(`an answer that echoes the credential as the provider received it comes back without it (${form})`, async () => {
      const s = await start((c) => {
        const sent = c.headers["x-api-key"] ?? c.headers.authorization ?? "";
        return new Response(JSON.stringify({ error: { message: `invalid credential ${sent}` } }), { status: 401, headers: { "www-authenticate": sent, "x-request-id": "req_1" } });
      }, form);
      const r = await via(s.proxy, "/v1/messages", { method: "POST", body: "{}" });
      const text = await r.text();
      expect(r.status).toBe(401);
      expect(text).not.toContain(REAL);
      expect(text).toContain("[redacted]");
      expect(JSON.stringify([...r.headers])).not.toContain(REAL);
      expect(r.headers.get("x-request-id")).toBe("req_1");
    });
  }

  test("nothing the proxy logs holds the credential or a header value: success, redirect, retry, unreachable", async () => {
    const s = await start((_c, nth) => {
      if (nth === 1) return new Response(`echo ${REAL}`);
      if (nth === 2) return new Response(null, { status: 307, headers: { location: `https://elsewhere.example/${REAL}` } });
      throw new Error(`failed with ${REAL}`);
    });
    expect((await via(s.proxy, "/v1/messages", { method: "POST", headers: { "x-custom": "box-header-value" }, body: "{}" })).status).toBe(200);
    expect((await via(s.proxy, "/v1/messages", { method: "POST", body: "{}" })).status).toBe(502);
    const down = await via(s.proxy, "/v1/messages", { method: "POST", body: "{}" });
    expect(down.status).toBe(502);
    expect(await down.text()).not.toContain(REAL);
    expect(s.lines.length).toBeGreaterThanOrEqual(4);
    const all = s.lines.join("\n");
    expect(all).not.toContain(REAL);
    expect(all).not.toContain("box-header-value");
    expect(all).not.toContain("elsewhere.example");
  });
});
