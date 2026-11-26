/**
 * buildBoxEnv (box spec, "What spawn does to the environment"): a box's
 * environment is built from nothing, never filtered from the node's. Whatever
 * the SDK hands the spawn hook, no credential value reaches the result.
 */
import { describe, expect, it } from "bun:test";
import {
  BOX_CREDENTIAL_PLACEHOLDER,
  BOX_EGRESS_PROXY_URL,
  BOX_HOME,
  BOX_PROVIDER_PROXY_URL,
  PROVIDER_FORM_ENV,
  buildBoxEnv,
  type ProviderForm,
} from "../../src/box/env";
import { defaultBoxPolicy } from "../../src/box/policy";
import { PROVIDER_ENV_KEYS } from "../../src/agent/provider-env";
import { GATEWAY_ONLY_ENV_NAMES, GATEWAY_ONLY_ENV_PREFIXES } from "../../src/config/gateway-only-env";

const FORMS: ProviderForm[] = ["api-key", "auth-token", "oauth-token"];

/** A node environment that holds a distinct real value under every sensitive name. */
function hostileEnv(): { env: Record<string, string>; secrets: string[] } {
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  let n = 0;
  const put = (name: string) => {
    const v = `real-value-${++n}-${name.toLowerCase()}`;
    env[name] = v;
    secrets.push(v);
  };
  for (const k of PROVIDER_ENV_KEYS) put(k);
  for (const k of GATEWAY_ONLY_ENV_NAMES) put(k);
  for (const p of GATEWAY_ONLY_ENV_PREFIXES) put(`${p}SOMETHING`);
  for (const k of [
    "SLAUDE_NODE_TOKEN",
    "SLAUDE_REDIS_URL",
    "SLAUDE_ENCRYPTION_KEY",
    "SLAUDE_S3_ENDPOINT",
    "SLAUDE_S3_BUCKET",
    "SLAUDE_S3_ACCESS_KEY_ID",
    "SLAUDE_S3_SECRET_ACCESS_KEY",
    "SLAUDE_BOX_REGISTRY_AUTH",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_CLIENT_KEY",
    "CLAUDE_CODE_CLIENT_CERT",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
    "CLAUDE_CODE_USE_BEDROCK",
    "HOME",
    "USER",
    "SSH_AUTH_SOCK",
  ]) put(k);
  return { env, secrets };
}

const base = (over: Partial<Parameters<typeof buildBoxEnv>[0]> = {}) => ({
  sdkEnv: {},
  imageEnv: { PATH: "/usr/local/bin:/usr/bin:/bin" },
  policy: defaultBoxPolicy(),
  scratchDir: "/data/scratch/s1",
  configDir: "/config-home/personas/p1",
  providerForm: "api-key" as ProviderForm,
  ...over,
});

describe("buildBoxEnv", () => {
  for (const form of FORMS) {
    it(`no real value of the node's environment reaches a box (${form})`, () => {
      const { env, secrets } = hostileEnv();
      const out = buildBoxEnv(base({ sdkEnv: env, providerForm: form }));
      const dump = JSON.stringify(out);
      for (const s of secrets) expect(dump.includes(s)).toBe(false);
    });

    it(`the credential variable of the form holds the placeholder and the other two are absent (${form})`, () => {
      const { env } = hostileEnv();
      const out = buildBoxEnv(base({ sdkEnv: env, providerForm: form }));
      for (const f of FORMS) {
        const name = PROVIDER_FORM_ENV[f];
        if (f === form) expect(out[name]).toBe(BOX_CREDENTIAL_PLACEHOLDER);
        else expect(Object.hasOwn(out, name)).toBe(false);
      }
      expect(out.ANTHROPIC_BASE_URL).toBe(BOX_PROVIDER_PROXY_URL);
    });
  }

  it("sets the proxy variables in both cases and keeps loopback off the proxy", () => {
    const out = buildBoxEnv(base());
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) expect(out[k]).toBe(BOX_EGRESS_PROXY_URL);
    expect(out.NODE_USE_ENV_PROXY).toBe("1");
    expect(out.NO_PROXY).toBe("127.0.0.1,localhost");
    expect(out.no_proxy).toBe("127.0.0.1,localhost");
  });

  it("sets the fixed variables from the session's own paths", () => {
    const out = buildBoxEnv(base());
    expect(out.HOME).toBe(BOX_HOME);
    expect(out.TMPDIR).toBe("/data/scratch/s1");
    expect(out.SLAUDE_SCRATCH).toBe("/data/scratch/s1");
    expect(out.CLAUDE_CONFIG_DIR).toBe("/config-home/personas/p1");
    expect(out.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(typeof out.LANG).toBe("string");
  });

  it("takes PATH from the image only, with a default when the image has none", () => {
    const out = buildBoxEnv(base({ imageEnv: {}, sdkEnv: { PATH: "/node/only/bin" } }));
    expect(out.PATH).not.toContain("/node/only/bin");
    expect(out.PATH).toContain("/usr/bin");
  });

  it("keeps the CLAUDE_* names the SDK set, the model names and the agent id", () => {
    const out = buildBoxEnv(
      base({
        sdkEnv: {
          CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
          CLAUDE_AGENT_SDK_VERSION: "0.3.173",
          ANTHROPIC_MODEL: "provider/model-a",
          ANTHROPIC_SMALL_FAST_MODEL: "provider/model-b",
          SLAUDE_AGENT_ID: "agent-1",
          ENABLE_TOOL_SEARCH: "true",
          CLAUDE_CONFIG_DIR: "/somewhere/else",
          UNRELATED: "x",
          SLAUDE_HOME: "/node/home",
        },
      }),
    );
    expect(out.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
    expect(out.CLAUDE_AGENT_SDK_VERSION).toBe("0.3.173");
    expect(out.ANTHROPIC_MODEL).toBe("provider/model-a");
    expect(out.ANTHROPIC_SMALL_FAST_MODEL).toBe("provider/model-b");
    expect(out.SLAUDE_AGENT_ID).toBe("agent-1");
    expect(out.ENABLE_TOOL_SEARCH).toBe("true");
    // The session's own config directory wins over whatever the SDK carried.
    expect(out.CLAUDE_CONFIG_DIR).toBe("/config-home/personas/p1");
    expect(Object.hasOwn(out, "UNRELATED")).toBe(false);
    expect(Object.hasOwn(out, "SLAUDE_HOME")).toBe(false);
  });

  it("switches off the CLI's own outbound traffic, which has no route in a box", () => {
    const out = buildBoxEnv(base());
    for (const k of ["DISABLE_TELEMETRY", "DISABLE_AUTOUPDATER", "DISABLE_BUG_COMMAND", "DISABLE_ERROR_REPORTING", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
      expect(out[k]).toBe("1");
    }
  });

  it("drops an SDK variable whose value is shaped like a credential, whatever its name", () => {
    const out = buildBoxEnv(
      base({ sdkEnv: { CLAUDE_CODE_EXTRA: "Bearer abcdefghijklmnop", ANTHROPIC_MODEL: "https://user:pass@llm.example.com/v1" } }),
    );
    expect(Object.hasOwn(out, "CLAUDE_CODE_EXTRA")).toBe(false);
    expect(Object.hasOwn(out, "ANTHROPIC_MODEL")).toBe(false);
  });

  it("adds the box's own env, which can never replace a variable the builder owns", () => {
    const policy = defaultBoxPolicy();
    policy.env = {
      BUNDLE_JOBS: "4",
      HTTPS_PROXY: "http://attacker.example.com",
      ANTHROPIC_BASE_URL: "https://attacker.example.com",
      ANTHROPIC_API_KEY: "from-box",
      ANTHROPIC_AUTH_TOKEN: "from-box",
      HOME: "/root",
      CLAUDE_CONFIG_DIR: "/elsewhere",
    };
    const out = buildBoxEnv(base({ policy, providerForm: "api-key" }));
    expect(out.BUNDLE_JOBS).toBe("4");
    expect(out.HTTPS_PROXY).toBe(BOX_EGRESS_PROXY_URL);
    expect(out.ANTHROPIC_BASE_URL).toBe(BOX_PROVIDER_PROXY_URL);
    expect(out.ANTHROPIC_API_KEY).toBe(BOX_CREDENTIAL_PLACEHOLDER);
    expect(Object.hasOwn(out, "ANTHROPIC_AUTH_TOKEN")).toBe(false);
    expect(out.HOME).toBe(BOX_HOME);
    expect(out.CLAUDE_CONFIG_DIR).toBe("/config-home/personas/p1");
  });

  it("returns only string values", () => {
    const out = buildBoxEnv(base({ sdkEnv: { CLAUDE_CODE_X: undefined, ANTHROPIC_MODEL: "m" } }));
    for (const v of Object.values(out)) expect(typeof v).toBe("string");
    expect(Object.hasOwn(out, "CLAUDE_CODE_X")).toBe(false);
  });

  // Property: random secret-looking values under random names, sensitive and
  // not; none of them is ever found in the output.
  it("property: random secret-looking values never appear in the result", () => {
    let seed = 0x5eed;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const word = (len: number) => Array.from({ length: len }, () => alphabet[rnd() % alphabet.length]).join("");
    const shapes = [
      () => `ghp_${word(36)}`,
      () => `xoxb-${word(12)}-${word(12)}`,
      () => `AKIA${word(16).toUpperCase()}`,
      () => `eyJ${word(40)}.${word(20)}`,
      () => `Bearer ${word(32)}`,
      () => `redis://user:${word(16)}@cache.example.com:6379`,
      () => word(48),
    ];
    const sensitive = [
      ...PROVIDER_ENV_KEYS,
      ...GATEWAY_ONLY_ENV_NAMES,
      "SLAUDE_NODE_TOKEN",
      "SLAUDE_REDIS_URL",
      "SLAUDE_S3_SECRET_ACCESS_KEY",
      "SLAUDE_S3_ACCESS_KEY_ID",
    ];
    const prefixes = ["CLAUDE_CODE_", "CLAUDE_", "ANTHROPIC_", "SLAUDE_", "PERSONA_", "AWS_", "MY_"];
    const suffixes = ["TOKEN", "API_KEY", "SECRET", "PASSWORD", "AUTH", "CREDENTIALS", "OAUTH_TOKEN", "HEADERS", "CERT"];
    for (let round = 0; round < 200; round++) {
      const env: Record<string, string> = {};
      const secrets: string[] = [];
      const add = (name: string) => {
        const v = shapes[rnd() % shapes.length]!();
        env[name] = v;
        secrets.push(v);
      };
      for (let i = 0; i < 8; i++) add(sensitive[rnd() % sensitive.length]!);
      for (let i = 0; i < 8; i++) add(`${prefixes[rnd() % prefixes.length]}${word(4).toUpperCase()}_${suffixes[rnd() % suffixes.length]}`);
      const form = FORMS[rnd() % FORMS.length]!;
      const dump = JSON.stringify(buildBoxEnv(base({ sdkEnv: env, providerForm: form })));
      for (const s of secrets) {
        if (dump.includes(s)) throw new Error(`a secret-looking value reached the box environment (round ${round}, form ${form})`);
      }
    }
  });
});
