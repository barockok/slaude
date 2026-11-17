/**
 * The shape of `environments/<name>.yaml`, defined once.
 *
 * A definition declares one SHARED ssh machine in the deploy repository.
 * `parseEnvironmentYaml` (parse.ts) parses a file with this schema, and
 * `scripts/gen-agent-schema.ts` turns the same schema into
 * `docs/site/schemas/environment.schema.json` for editors.
 *
 * Shape lives here (keys, types, patterns). Rules that need more than one value
 * (the name matching its file, the address classes, secrets) live in parse.ts.
 * Messages never carry a value; a key is echoed only through `safeKey`.
 */
import { z } from "zod";
import { FP_RE, USER_RE } from "../kinds/ssh";
import { isRemoteDir } from "../shell";
import { ENV_DEF_NAME_RE } from "./name";

/** Where the docs site serves the generated JSON Schema. */
export const ENVIRONMENT_SCHEMA_URL = "https://barockok.github.io/slaude/schemas/environment.schema.json";
/** First line of an environment definition: editors running yaml-language-server read the schema from it. */
export const ENVIRONMENT_YAML_MODELINE = `# yaml-language-server: $schema=${ENVIRONMENT_SCHEMA_URL}`;

export { ENV_DEF_NAME_RE };
export const ENV_DEF_DESCRIPTION_MAX = 500;
export const ENV_DEF_DIR_MAX = 1024;
export const ENV_DEF_HOST_MAX = 253;

const typeMessage = (m: { other: string; missing?: string }): z.RawCreateParams => ({
  errorMap: (issue, ctx) => {
    if (issue.code !== z.ZodIssueCode.invalid_type) return { message: ctx.defaultError };
    if ((ctx.data === undefined || ctx.data === null) && m.missing) return { message: m.missing };
    return { message: m.other };
  },
});

const sshSchema = z
  .object(
    {
      host: z
        .string(typeMessage({ other: "must be a host name or IP address", missing: "is required" }))
        .min(1, "must be a host name or IP address")
        .max(ENV_DEF_HOST_MAX, "must be a host name or IP address")
        .describe("Host name of the machine, or an IP address. It is stored on the gateway and never shown in a thread. Required. Example: build-box.example.com"),
      user: z
        .string(typeMessage({ other: "must be a plain account name", missing: "is required" }))
        .regex(USER_RE, "must be a plain account name")
        .describe("The account slaude logs in as. Required. Example: dev"),
      port: z
        .number(typeMessage({ other: "must be a number from 1 to 65535" }))
        .int("must be a number from 1 to 65535")
        .min(1, "must be a number from 1 to 65535")
        .max(65535, "must be a number from 1 to 65535")
        .describe("The ssh port. Leave out for 22. Example: 22")
        .optional(),
      hostKey: z
        .string(typeMessage({ other: "must look like SHA256: followed by 43 characters", missing: "is required: a shared machine is never trusted on first use, so give its host key fingerprint" }))
        .regex(FP_RE, "must look like SHA256: followed by 43 characters")
        .describe("The machine's host key fingerprint, from `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`. Required: there is no trust on first use for a shared machine. Example: SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      allowPrivateAddress: z
        .boolean(typeMessage({ other: "must be true or false" }))
        .describe("true lets host be a private, loopback or link-local address literal (a LAN box). The gateway's own outbound rules still apply when it connects. Leave out for false.")
        .optional(),
    },
    typeMessage({ other: "must be a mapping with host, user, port and hostKey", missing: "is required" }),
  )
  .strict();

export const EnvironmentDefinitionSchema = z
  .object(
    {
      name: z
        .string(typeMessage({ other: "must be a name", missing: "is required" }))
        .regex(ENV_DEF_NAME_RE, `must match ${ENV_DEF_NAME_RE.source}`)
        .describe("The environment's name. Must equal the file name (environments/<name>.yaml) and is the reference env:<name> an agent allows. Required. Example: team-sandbox"),
      description: z
        .string(typeMessage({ other: "must be text" }))
        .max(ENV_DEF_DESCRIPTION_MAX, `is longer than ${ENV_DEF_DESCRIPTION_MAX} characters`)
        .describe(`What the machine is for, shown to operators. At most ${ENV_DEF_DESCRIPTION_MAX} characters. Never put a secret here. Example: Shared build box for the platform team.`)
        .optional(),
      kind: z
        .literal("ssh", { errorMap: () => ({ message: "must be ssh (the only kind a shared environment supports yet)" }) })
        .describe("The kind of machine. Only ssh is supported for a shared environment. Required."),
      shared: z
        .literal(true, { errorMap: () => ({ message: "must be true: a definition is a shared machine that many people drive, and a file must say so" }) })
        .describe("Must be true. A definition is a shared machine: anyone in a thread can steer it through the agent. Required."),
      trust: z
        .literal("unlocked", { errorMap: () => ({ message: 'must be "unlocked": a definition is a shared machine that needs no /1on1 lock, and a file must say so' }) })
        .describe('Must be "unlocked". Threads using a shared machine need no /1on1 lock. Required.'),
      defaultDir: z
        .string(typeMessage({ other: "must be an absolute path or start with ~/", missing: "is required" }))
        .max(ENV_DEF_DIR_MAX, "is too long")
        .refine(isRemoteDir, "must be an absolute path or start with ~/")
        .describe("The directory a thread starts in. An absolute path or one starting with ~/. Required. Example: /srv/work"),
      ssh: sshSchema.describe("How to reach the machine. slaude generates the key pair; only the public key is ever shown. There is no key for a private key, password or token."),
    },
    typeMessage({ other: "must be a mapping of the environment's fields" }),
  )
  .strict()
  .describe("A shared environment: one ssh machine, declared once at environments/<name>.yaml and referred to by agents as env:<name>. Unknown keys are refused at every level.");

export type EnvironmentDefinitionFile = z.infer<typeof EnvironmentDefinitionSchema>;
