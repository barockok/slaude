/**
 * The box definition: `boxes/<name>/box.yaml` in the deploy repo (box spec,
 * "Box definition format").
 *
 * One Zod schema is the whole definition of the file; the JSON schema under
 * docs/site/schemas/ is generated from it and a drift test keeps them equal.
 * Unknown and duplicate keys fail, and every message names the box and the
 * field, never a value.
 *
 * A box holds no secret, so the format has no place for one:
 *   - there is no `secrets` key and no placeholder syntax. `${` anywhere in
 *     the file fails: nothing is expanded, so nothing can be smuggled through
 *     an expansion;
 *   - `env` values and `mcp.stdio` commands and arguments are checked against
 *     the repository's secret shapes, and an `env` name that reads like a
 *     credential is refused whatever it holds.
 *
 * Two forms are validated here by the same field rules: the file (whose image
 * is `build` or `ref`) and the deploy payload entry the CLI compiles it to
 * (whose image is always `<repository>@sha256:<digest>`). The gateway parses
 * the payload entry again; it never trusts what a pipeline says it checked.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z, type ZodIssue } from "zod";
import { STDIO_SERVER_NAME_RE, validateStdioServer } from "../config/stdio-server";
import { PayloadError } from "../persona/sync/errors";
import { redactSecrets } from "../redact";
import { looksLikeCredential } from "../secrets/token-shape";
import { isBoxEnvNameAllowed } from "./env";
import { BOX_TIERS, DEFAULT_BOX_RESOURCES, defaultMemoryReserveMb, type BoxPolicy, type BoxTier } from "./policy";

export const BOX_SCHEMA_URL = "https://barockok.github.io/slaude/schemas/box.schema.json";
export const BOX_YAML_MODELINE = `# yaml-language-server: $schema=${BOX_SCHEMA_URL}`;

export const BOX_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** `<registry>/<path>@sha256:<64 hex>`. No tag, no scheme, no user info. */
export const BOX_IMAGE_REF_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;
/** A host name with an optional leading `*.` and an optional port. */
export const BOX_EGRESS_HOST_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?$/;
export const BOX_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** A stdio server's name: the pattern the node manifest uses, from the one shared definition. */
export const BOX_MCP_NAME_RE = STDIO_SERVER_NAME_RE;
/** A relative path under the context or the home: no leading slash, no `..` segment, no backslash. */
const RELATIVE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/;

export const BOX_LIMITS = {
  description: 500,
  note: 500,
  egress: 256,
  env: 64,
  envValue: 4096,
  stdio: 32,
  args: 64,
  arg: 1024,
  exclude: 64,
  path: 255,
  /** Most boxes one deploy may carry. */
  boxes: 64,
  /** A box.yaml is at most this many characters. */
  yaml: 32 * 1024,
} as const;

/** An `env` name that reads like it holds a credential. */
const CREDENTIAL_ENV_NAME_RE = /(?:^|_)(?:token|secret|password|passwd|passphrase|credentials?|api_?key|private_?key|access_?key|auth|authorization|cookie)(?:_|$)/i;

/** True when a value is shaped like a secret (the redaction masks, or a token shape). */
export function isSecretShaped(value: string): boolean {
  return redactSecrets(value) !== value || looksLikeCredential(value);
}

const NOT_SECRET = "looks like a credential; a box holds no secret (anything that authenticates is a gateway-side MCP server)";

const typeMessage = (m: { other: string; missing?: string }): z.RawCreateParams => ({
  errorMap: (issue, ctx) => {
    if (issue.code !== z.ZodIssueCode.invalid_type) return { message: ctx.defaultError };
    if (ctx.data === undefined && m.missing) return { message: m.missing };
    return { message: m.other };
  },
});
const text = (what: string, max: number) => z.string(typeMessage({ other: `must be ${what}` })).max(max, `must be at most ${max} characters`);
const int = (min: number, max: number) =>
  z
    .number(typeMessage({ other: `must be a whole number from ${min} to ${max}` }))
    .int(`must be a whole number from ${min} to ${max}`)
    .min(min, `must be a whole number from ${min} to ${max}`)
    .max(max, `must be a whole number from ${min} to ${max}`);
const mapOf = (msg = "must be a mapping") => typeMessage({ other: msg });

function egressProblem(v: string): string | undefined {
  const host = v.replace(/^\*\./, "").replace(/:[0-9]+$/, "");
  if (isIP(host) || /^[0-9.]+$/.test(host)) return "must be a host name, not an address";
  const port = /:([0-9]+)$/.exec(v)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return "has a port outside 1 to 65535";
  return undefined;
}
const EGRESS_MSG = "must be a lower-case host name with an optional leading *. and an optional :port";
const egressHost = z
  .string(typeMessage({ other: EGRESS_MSG }))
  .regex(BOX_EGRESS_HOST_RE, EGRESS_MSG)
  .superRefine((v, ctx) => {
    const why = egressProblem(v);
    if (why) ctx.addIssue({ code: z.ZodIssueCode.custom, message: why });
  });
const egressList = (what: string) =>
  z
    .array(egressHost, typeMessage({ other: "must be a list of host names" }))
    .max(BOX_LIMITS.egress, `lists more than ${BOX_LIMITS.egress} hosts`)
    .superRefine((list, ctx) => noRepeats(list, ctx))
    .describe(what);

function noRepeats(list: readonly string[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  list.forEach((x, i) => {
    if (seen.has(x)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: "repeats an earlier entry" });
    seen.add(x);
  });
}

const resourcesSchema = z
  .object(
    {
      cpu: z
        .number(typeMessage({ other: "must be a number of cores from 0.25 to 64" }))
        .min(0.25, "must be a number of cores from 0.25 to 64")
        .max(64, "must be a number of cores from 0.25 to 64")
        .describe(`Cores the sandbox may use, a ceiling. Default ${DEFAULT_BOX_RESOURCES.cpu}. Example: 2`)
        .optional(),
      memoryMb: int(256, 262144).describe(`Memory ceiling in MB; the sandbox is killed above it. Default ${DEFAULT_BOX_RESOURCES.memoryMb}. Example: 3072`).optional(),
      memoryReserveMb: int(64, 262144)
        .describe("Memory in MB a node sets aside to admit this box. At most memoryMb. Default: a third of memoryMb. Example: 1024")
        .optional(),
      pids: int(16, 32768).describe(`Most processes in the sandbox. Default ${DEFAULT_BOX_RESOURCES.pids}. Example: 512`).optional(),
      homeMb: int(64, 1048576).describe(`Size limit of the durable home in MB. Default ${DEFAULT_BOX_RESOURCES.homeMb}. Example: 4096`).optional(),
      workspaceExtrasMb: int(64, 1048576)
        .describe(`Size limit in MB of the workspace trees the sync ignore list skips (node_modules, .venv and the like). Default ${DEFAULT_BOX_RESOURCES.workspaceExtrasMb}. Example: 4096`)
        .optional(),
      rootOverlayMb: int(64, 1048576)
        .describe(`Size limit in MB of system-level writes, which are thrown away when the sandbox stops. Default ${DEFAULT_BOX_RESOURCES.rootOverlayMb}. Example: 2048`)
        .optional(),
    },
    mapOf(),
  )
  .strict();

const egressSchema = z
  .object(
    {
      allow: egressList("Hosts the box may reach, port 443 unless stated. Everything else is refused. A leading *. matches every subdomain. Example: [registry.npmjs.org, \"*.githubusercontent.com\"]").optional(),
      deny: egressList("Hosts refused even when allow matches them. Example: [uploads.github.com]").optional(),
    },
    mapOf(),
  )
  .strict();

const envSchema = z
  .record(
    z.string(),
    z.string(typeMessage({ other: "must be text (quote numbers)" })).max(BOX_LIMITS.envValue, `must be at most ${BOX_LIMITS.envValue} characters`),
    mapOf("must be a mapping of names to text"),
  )
  .superRefine((env, ctx) => {
    const names = Object.keys(env);
    if (names.length > BOX_LIMITS.env) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `sets more than ${BOX_LIMITS.env} variables` });
    for (const name of names) {
      // firstIssue echoes a path segment only when it is a plain key.
      const path = [name];
      if (!BOX_ENV_NAME_RE.test(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "is not a valid variable name" });
      else if (!isBoxEnvNameAllowed(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "is a variable the runtime sets itself; a box cannot set it" });
      else if (CREDENTIAL_ENV_NAME_RE.test(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `is named like a credential; a box holds no secret` });
      else if (isSecretShaped(env[name]!)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: NOT_SECRET });
    }
  });

const STDIO_NO_PLACEHOLDER = "contains ${, and a box has no placeholders: nothing is expanded, and a box holds no secret";

const stdioServer = z
  .object(
    {
      command: z
        .string(typeMessage({ other: "must be an absolute path to a program in the image", missing: "is required" }))
        .regex(/^\/[^\0]{0,1023}$/, "must be an absolute path to a program in the image")
        .refine((v) => !isSecretShaped(v), NOT_SECRET)
        .describe("The program to run, as an absolute path inside the image. Required. Example: /usr/local/bin/ruby-lsp-mcp"),
      args: z
        .array(
          z
            .string(typeMessage({ other: "must be text" }))
            .max(BOX_LIMITS.arg, `must be at most ${BOX_LIMITS.arg} characters`)
            .refine((v) => !isSecretShaped(v), NOT_SECRET),
          typeMessage({ other: "must be a list of text arguments" }),
        )
        .max(BOX_LIMITS.args, `lists more than ${BOX_LIMITS.args} arguments`)
        .describe("Arguments for the program. No credential: the server runs inside the box. Example: [--stdio]")
        .optional(),
    },
    mapOf("must be a mapping with command and args"),
  )
  .strict();

const mcpSchema = z
  .object(
    {
      stdio: z
        .record(z.string(), stdioServer, mapOf("must be a mapping of server names to programs"))
        .superRefine((servers, ctx) => {
          const names = Object.keys(servers);
          if (names.length > BOX_LIMITS.stdio) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `declares more than ${BOX_LIMITS.stdio} servers` });
          for (const n of names) {
            // The checks shared with the node manifest, in the stricter box form: the
            // name pattern, and no `${` anywhere (the CLI would expand one). The
            // whole-document placeholder check runs first and names the field; this
            // is the same rule stated where the servers are declared, and the one a
            // node applies again to what it receives.
            for (const issue of validateStdioServer(n, servers[n], "box")) {
              if (issue.code === "name") ctx.addIssue({ code: z.ZodIssueCode.custom, path: [n], message: `is not a valid server name (${BOX_MCP_NAME_RE.source})` });
              else if (issue.code === "box-ref") ctx.addIssue({ code: z.ZodIssueCode.custom, path: [n, ...issue.field.split(".").map((p) => (/^[0-9]+$/.test(p) ? Number(p) : p))], message: STDIO_NO_PLACEHOLDER });
            }
          }
        })
        .describe("Stdio MCP servers that are programs in the image. They get no credential. Example: { ruby-lsp: { command: /usr/local/bin/ruby-lsp-mcp, args: [--stdio] } }")
        .optional(),
    },
    mapOf(),
  )
  .strict();

const relativePath = (what: string) =>
  z
    .string(typeMessage({ other: `must be ${what}` }))
    .min(1, `must be ${what}`)
    .max(BOX_LIMITS.path, `must be at most ${BOX_LIMITS.path} characters`)
    .regex(RELATIVE_PATH_RE, `must be ${what}`);

const durableSchema = z
  .object(
    {
      exclude: z
        .array(relativePath("a path relative to the home, with no .. segment"), typeMessage({ other: "must be a list of paths" }))
        .max(BOX_LIMITS.exclude, `lists more than ${BOX_LIMITS.exclude} paths`)
        .superRefine((list, ctx) => noRepeats(list, ctx))
        .describe("Home paths that are never kept between sessions' nodes. Example: [.cache/huggingface]")
        .optional(),
    },
    mapOf(),
  )
  .strict();

const refreshSchema = z
  .object(
    {
      force: z
        .boolean(typeMessage({ other: "must be true or false" }))
        .describe("true: sessions on an older image of this box move to this one at their next turn. Default false.")
        .optional(),
      note: text("text", BOX_LIMITS.note).describe("Shown to users when force is true. At most 500 characters. Example: Ruby moved to 3.4; reinstall gems.").optional(),
    },
    mapOf(),
  )
  .strict();

const IMAGE_REF_MSG = "must be <registry>/<repository>@sha256:<digest> in lower case (a tag is refused)";
const imageRef = z.string(typeMessage({ other: IMAGE_REF_MSG, missing: "is required" })).regex(BOX_IMAGE_REF_RE, IMAGE_REF_MSG);

const tierSchema = z.enum(BOX_TIERS as unknown as [BoxTier, ...BoxTier[]], {
  errorMap: () => ({ message: `must be one of ${BOX_TIERS.join(", ")}` }),
});

/** The fields a box.yaml and a payload entry share, beside `name`, `description` and `image`. */
const policyFields = {
  tier: tierSchema.describe("The weakest sandbox tier this box may run on: gvisor, bwrap or none. Default gvisor. Example: gvisor").optional(),
  resources: resourcesSchema.describe("Limits of one sandbox of this box.").optional(),
  egress: egressSchema.describe("Where the box may connect. Refuse by default; changed only through the deploy repo.").optional(),
  env: envSchema.describe("Environment variables for the box. Not secret: a value that looks like a credential fails the sync. Example: { BUNDLE_JOBS: \"4\" }").optional(),
  mcp: mcpSchema.describe("Tool servers that run inside the box.").optional(),
  durable: durableSchema.describe("What is kept of the home.").optional(),
  refresh: refreshSchema.describe("Whether sessions on an older image are moved.").optional(),
};

const nameField = z
  .string(typeMessage({ other: `must match ${BOX_NAME_RE.source}`, missing: "is required" }))
  .regex(BOX_NAME_RE, `must match ${BOX_NAME_RE.source}`);
const descriptionField = text("text", BOX_LIMITS.description);

/** `boxes/<name>/box.yaml`. */
export const BoxFileSchema = z
  .object(
    {
      version: z
        .literal(1, { errorMap: () => ({ message: "must be 1" }) })
        .describe("The format version. Required. Always 1."),
      name: nameField.describe("The box's name. Must equal the directory name (boxes/<name>/) and is what an agent.yaml writes under box. Required. Example: ruby-dev"),
      description: descriptionField.describe("What the box is for, shown to operators. At most 500 characters. Example: Ruby 3.3 and Node 22 for the storefront repositories").optional(),
      image: z
        .object(
          {
            build: z
              .object(
                {
                  dockerfile: relativePath("a path relative to the box directory, with no .. segment").describe("The Dockerfile, relative to the box directory. Default Dockerfile.").optional(),
                  context: relativePath("a path relative to the box directory, with no .. segment").describe("The build context, relative to the box directory. Default: the box directory.").optional(),
                },
                mapOf(),
              )
              .strict()
              .describe("Build the image in CI from a Dockerfile in the box directory. Rebuilt only when a file of the context changes.")
              .optional(),
            ref: imageRef.describe("An image that already exists, by digest. Example: ghcr.io/example/boxes/ruby-dev@sha256:<64 hex characters>").optional(),
          },
          typeMessage({ other: "must be a mapping with build or ref", missing: "is required" }),
        )
        .strict()
        .superRefine((img, ctx) => {
          const n = (img.build !== undefined ? 1 : 0) + (img.ref !== undefined ? 1 : 0);
          if (n !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must have exactly one of build or ref" });
        })
        .describe("The box's image: exactly one of build or ref. Required."),
      ...policyFields,
    },
    typeMessage({ other: "must be a mapping of the box's fields" }),
  )
  .strict()
  .describe("A slaude box: one reviewed image plus a policy, at boxes/<name>/box.yaml. Unknown keys are refused at every level, and so is ${ anywhere in the file.");
export type BoxFile = z.infer<typeof BoxFileSchema>;

/** One entry of the deploy payload's `boxes` list, as `slaude personas sync` compiles a box.yaml. */
export const BoxPayloadSchema = z
  .object(
    {
      name: nameField,
      description: descriptionField.optional(),
      image: imageRef,
      ...policyFields,
    },
    typeMessage({ other: "must be a mapping of the box's fields" }),
  )
  .strict();
export type BoxPayloadEntry = z.infer<typeof BoxPayloadSchema>;

/** A validated box as the gateway stores it. */
export interface ParsedBox {
  name: string;
  description: string;
  /** `<repository>@sha256:<digest>`. */
  image: string;
  /** `sha256:<digest>`. */
  digest: string;
  policy: BoxPolicy;
}

/** A validated box.yaml, before its image has a digest. */
export interface ParsedBoxFile {
  name: string;
  description: string;
  image: { ref: string } | { build: { dockerfile: string; context: string } };
  policy: BoxPolicy;
}

const labelOf = (name: unknown) => (typeof name === "string" && BOX_NAME_RE.test(name) ? name : "<invalid-name>");
const safeKey = (k: string) => (/^[A-Za-z0-9_-]{1,64}$/.test(k) && !isSecretShaped(k) ? k : "<invalid-key>");

function firstIssue(issues: ZodIssue[]): { path: string; message: string } {
  const unknown = issues.filter((i) => i.code === "unrecognized_keys").sort((a, b) => a.path.length - b.path.length)[0];
  const issue = unknown ?? issues[0]!;
  const base = issue.path
    .map((seg) => (typeof seg === "number" ? `[${seg}]` : safeKey(seg)))
    .reduce((acc, s) => (s.startsWith("[") || !acc ? acc + s : `${acc}.${s}`), "");
  if (issue.code === "unrecognized_keys") {
    return { path: `${base ? `${base}.` : ""}${safeKey(String(issue.keys[0] ?? ""))}`, message: "is not a known key" };
  }
  return { path: base, message: issue.message };
}

/** The first place `${` appears in a parsed tree, as a field path; undefined when it does not. */
function placeholderPath(v: unknown, path: string): string | undefined {
  if (typeof v === "string") return v.includes("${") ? path : undefined;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = placeholderPath(v[i], `${path}[${i}]`);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const here = path ? `${path}.${safeKey(k)}` : safeKey(k);
      if (k.includes("${")) return here;
      const hit = placeholderPath(x, here);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}
const NO_PLACEHOLDER = "contains ${, and a box has no placeholders: nothing is expanded, and a box holds no secret";

/** The policy of validated fields, every default filled in and every list in a canonical order. */
function policyOf(who: string, f: Pick<BoxPayloadEntry, "tier" | "resources" | "egress" | "env" | "mcp" | "durable" | "refresh">): BoxPolicy {
  const memoryMb = f.resources?.memoryMb ?? DEFAULT_BOX_RESOURCES.memoryMb;
  const memoryReserveMb = f.resources?.memoryReserveMb ?? defaultMemoryReserveMb(memoryMb);
  if (memoryReserveMb > memoryMb) throw new PayloadError(`${who}: resources.memoryReserveMb must be at most memoryMb`);
  const sorted = (l: readonly string[] | undefined) => [...(l ?? [])].sort();
  const sortedMap = <T>(m: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(m ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    tier: f.tier ?? "gvisor",
    resources: {
      cpu: f.resources?.cpu ?? DEFAULT_BOX_RESOURCES.cpu,
      memoryMb,
      memoryReserveMb,
      pids: f.resources?.pids ?? DEFAULT_BOX_RESOURCES.pids,
      homeMb: f.resources?.homeMb ?? DEFAULT_BOX_RESOURCES.homeMb,
      workspaceExtrasMb: f.resources?.workspaceExtrasMb ?? DEFAULT_BOX_RESOURCES.workspaceExtrasMb,
      rootOverlayMb: f.resources?.rootOverlayMb ?? DEFAULT_BOX_RESOURCES.rootOverlayMb,
    },
    egress: { allow: sorted(f.egress?.allow), deny: sorted(f.egress?.deny) },
    env: sortedMap(f.env),
    mcp: {
      stdio: sortedMap(Object.fromEntries(Object.entries(f.mcp?.stdio ?? {}).map(([n, s]) => [n, { command: s.command, args: [...(s.args ?? [])] }]))),
    },
    durable: { exclude: sorted(f.durable?.exclude) },
    refresh: { force: f.refresh?.force ?? false, note: f.refresh?.note ?? "" },
  };
}

/** Parse one box.yaml. `dir` is the directory name under boxes/. Throws PayloadError naming the box and the field. */
export function parseBoxYaml(dir: string, yaml: string): ParsedBoxFile {
  const who = `box '${labelOf(dir)}'`;
  if (!BOX_NAME_RE.test(dir)) throw new PayloadError(`${who}: the directory name must match ${BOX_NAME_RE.source}`);
  if (yaml.length > BOX_LIMITS.yaml) throw new PayloadError(`${who}: box.yaml is larger than ${BOX_LIMITS.yaml} characters`);
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (e) {
    const where = e instanceof YAMLParseError ? `${e.code}${e.linePos ? ` at line ${e.linePos[0].line}` : ""}` : "unreadable";
    throw new PayloadError(`${who}: box.yaml is not valid YAML (${where})`);
  }
  // Checked on the parsed tree first so the message can name the field; then
  // on the text, which also covers a comment and anything a YAML feature hid.
  const at = placeholderPath(raw, "");
  if (at !== undefined) throw new PayloadError(`${who}: ${at} ${NO_PLACEHOLDER}`);
  if (yaml.includes("${")) {
    const line = yaml.slice(0, yaml.indexOf("${")).split("\n").length;
    throw new PayloadError(`${who}: line ${line} of box.yaml ${NO_PLACEHOLDER}`);
  }
  const r = BoxFileSchema.safeParse(raw);
  if (!r.success) {
    const { path, message } = firstIssue(r.error.issues);
    throw new PayloadError(`${who}: ${path ? `${path} ` : ""}${message}`);
  }
  const f = r.data;
  if (f.name !== dir) throw new PayloadError(`${who}: name must equal the directory name`);
  const image = f.image.ref !== undefined
    ? { ref: f.image.ref }
    : { build: { dockerfile: f.image.build!.dockerfile ?? "Dockerfile", context: f.image.build!.context ?? "." } };
  return { name: f.name, description: f.description ?? "", image, policy: policyOf(who, f) };
}

/** Validate one payload entry (the gateway's own check). Throws PayloadError naming the box and the field. */
export function parseBoxPayload(raw: unknown): ParsedBox {
  const who = `box '${labelOf((raw as { name?: unknown } | null)?.name)}'`;
  const at = placeholderPath(raw, "");
  if (at !== undefined) throw new PayloadError(`${who}: ${at} ${NO_PLACEHOLDER}`);
  const r = BoxPayloadSchema.safeParse(raw);
  if (!r.success) {
    const { path, message } = firstIssue(r.error.issues);
    throw new PayloadError(`${who}: ${path ? `${path} ` : ""}${message}`);
  }
  const f = r.data;
  return { name: f.name, description: f.description ?? "", image: f.image, digest: digestOf(f.image), policy: policyOf(who, f) };
}

/**
 * A stand-in digest: what `personas render --no-push` and `--check` report for
 * an image that no registry holds. It starts with 24 zero hex digits (96 zero
 * bits, which no real sha256 of an image manifest has in practice), so the
 * gateway and a node can tell one from a real digest without a registry. A
 * payload that carries one is for a dry run only: a real sync refuses it, and
 * a node refuses to boot a session pinned to one.
 */
export const BOX_STAND_IN_DIGEST_PREFIX = `sha256:${"0".repeat(24)}`;
/** The registry of a stand-in image when no registry is configured. `.invalid` never resolves. */
export const BOX_STAND_IN_REGISTRY = "registry.invalid";

/** Build the stand-in digest for a build context hash (64 hex digits). */
export function standInDigestFor(contextHash: string): string {
  return `${BOX_STAND_IN_DIGEST_PREFIX}${createHash("sha256").update(`slaude-box-unpushed\0${contextHash}`).digest("hex").slice(0, 40)}`;
}

/** Whether a digest (`sha256:<hex>`) or an image reference names no real image. */
export function isStandInImage(imageOrDigest: string): boolean {
  const at = imageOrDigest.indexOf("@");
  const digest = at >= 0 ? imageOrDigest.slice(at + 1) : imageOrDigest;
  if (digest.startsWith(BOX_STAND_IN_DIGEST_PREFIX)) return true;
  return at >= 0 && (imageOrDigest.startsWith(`${BOX_STAND_IN_REGISTRY}/`) || imageOrDigest.startsWith(`${BOX_STAND_IN_REGISTRY}:`));
}

/** `sha256:<hex>` of an image reference. */
export function digestOf(image: string): string {
  return image.slice(image.indexOf("@") + 1);
}

/** The payload entry of a parsed file whose image now has a digest. Defaults are written out, so the gateway stores what was reviewed. */
export function toBoxPayload(file: ParsedBoxFile, image: string): BoxPayloadEntry {
  const p = file.policy;
  return {
    name: file.name,
    ...(file.description ? { description: file.description } : {}),
    image,
    tier: p.tier,
    resources: { ...p.resources },
    egress: { allow: [...p.egress.allow], deny: [...p.egress.deny] },
    env: { ...p.env },
    mcp: { stdio: Object.fromEntries(Object.entries(p.mcp.stdio).map(([n, s]) => [n, { command: s.command, args: [...s.args] }])) },
    durable: { exclude: [...p.durable.exclude] },
    refresh: { ...p.refresh },
  };
}

/** A policy as stored and signed: one fixed key order, so equal policies are equal text. */
export function canonicalPolicy(p: BoxPolicy): string {
  const map = <T>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({
    tier: p.tier,
    resources: {
      cpu: p.resources.cpu,
      memoryMb: p.resources.memoryMb,
      memoryReserveMb: p.resources.memoryReserveMb,
      pids: p.resources.pids,
      homeMb: p.resources.homeMb,
      workspaceExtrasMb: p.resources.workspaceExtrasMb,
      rootOverlayMb: p.resources.rootOverlayMb,
    },
    egress: { allow: [...p.egress.allow].sort(), deny: [...p.egress.deny].sort() },
    env: map(p.env),
    mcp: { stdio: map(Object.fromEntries(Object.entries(p.mcp.stdio).map(([n, s]) => [n, { command: s.command, args: s.args }]))) },
    durable: { exclude: [...p.durable.exclude].sort() },
    refresh: { force: p.refresh.force, note: p.refresh.note },
  });
}

export const policyHash = (p: BoxPolicy): string => createHash("sha256").update(canonicalPolicy(p)).digest("hex");

/**
 * What changed between two versions of a box, one short line per field, for
 * the dry run and the audit trail. Names and numbers only: an `env` value, a
 * server's command and arguments, and the refresh note are never printed.
 */
export function boxDiff(prev: { digest: string; policy: BoxPolicy } | null, next: { digest: string; policy: BoxPolicy }): string[] {
  if (!prev) return ["new box"];
  const out: string[] = [];
  if (prev.digest !== next.digest) out.push("image: new digest");
  const a = prev.policy;
  const b = next.policy;
  if (a.tier !== b.tier) out.push(`tier: ${a.tier} -> ${b.tier}`);
  for (const k of Object.keys(b.resources) as Array<keyof BoxPolicy["resources"]>) {
    if (a.resources[k] !== b.resources[k]) out.push(`resources.${k}: ${a.resources[k]} -> ${b.resources[k]}`);
  }
  const listDiff = (label: string, x: readonly string[], y: readonly string[]) => {
    for (const v of y) if (!x.includes(v)) out.push(`${label}: +${v}`);
    for (const v of x) if (!y.includes(v)) out.push(`${label}: -${v}`);
  };
  listDiff("egress.allow", a.egress.allow, b.egress.allow);
  listDiff("egress.deny", a.egress.deny, b.egress.deny);
  listDiff("env", Object.keys(a.env), Object.keys(b.env));
  for (const k of Object.keys(b.env)) if (Object.hasOwn(a.env, k) && a.env[k] !== b.env[k]) out.push(`env: ~${k}`);
  listDiff("mcp.stdio", Object.keys(a.mcp.stdio), Object.keys(b.mcp.stdio));
  for (const k of Object.keys(b.mcp.stdio)) {
    if (Object.hasOwn(a.mcp.stdio, k) && JSON.stringify(a.mcp.stdio[k]) !== JSON.stringify(b.mcp.stdio[k])) out.push(`mcp.stdio: ~${k}`);
  }
  listDiff("durable.exclude", a.durable.exclude, b.durable.exclude);
  if (a.refresh.force !== b.refresh.force) out.push(`refresh.force: ${b.refresh.force ? "on" : "off"}`);
  if (a.refresh.note !== b.refresh.note) out.push("refresh.note: changed");
  return out;
}
