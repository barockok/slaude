import type { EnvironmentKind } from "../../src/remote/kinds";

/** A provisioned kind with a fake provisioner, for the lifecycle rules. */
export function fakeSandboxKind(log: string[] = []): EnvironmentKind {
  let n = 0;
  return {
    kind: "sandbox",
    label: "Test sandbox",
    trust: "provisioned",
    fields: [{ id: "image", label: "Image" }],
    parse: (i) => (i.image ? { ok: true, config: { image: i.image }, ...(i.token ? { secrets: { token: i.token } } : {}) } : { ok: false, error: "image required" }),
    setupGuide: () => "sandbox",
    status: async () => "running",
    provision: async (_env, key) => {
      n++;
      log.push(`provision:${key}:${n}`);
      return { transport: { kind: "tcp", host: "127.0.0.1", port: 1 }, privateKey: `SB-KEY-${n}`, ref: `sb-${n}` };
    },
    teardown: async (_env, ep) => { log.push(`teardown:${ep.ref}`); },
  };
}
