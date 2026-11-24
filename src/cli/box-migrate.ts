/**
 * The two commands an operator runs before opting a persona into a box (box
 * spec, "Stdio MCP servers and the node manifest", "Migration path").
 *
 *   slaude box from-manifest <node.json> <persona> [--workspace <server,...>]
 *       What becomes of each stdio server the node manifest allows the
 *       persona, once the persona is boxed. A box holds no secret, so:
 *         1. a server with no env, or only literal non-secret values, moves
 *            into the box's `mcp.stdio` unchanged (the image must contain it);
 *         2. a server whose env carries a node secret cannot move into a box:
 *            it becomes a gateway-side server, reached through the bridge;
 *         3. a server that needs a secret AND the session's files fits
 *            neither side: the persona stays unboxed, or the server is split.
 *
 *   slaude box preflight <persona> --repo <deploy repo> [--manifest <node.json>]
 *                        [--private-code | --no-private-code] [--code-host <server>]
 *       The opt-in checklist. It reports only and edits nothing.
 *
 * Both read files. Neither prints an env value, a header or a URL's query.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderForm } from "../box/env";
import { boxTierCapability } from "../box/capability";
import { isSecretShaped } from "../box/definition";
import type { BoxTier } from "../box/policy";
import { BOX_SUPPORTED_PROVIDER_FORMS, declaredProviderForms } from "../box/provider-forms";
import { hasNonPlainRef, stdioEnvRefs } from "../config/stdio-server";
import { readDeclaredNodeManifest, type DeclaredNodeManifest } from "../node/manifest";
import { AGENT_YAML, parseAgentYaml } from "../persona/agent-def";
import { PayloadError } from "../persona/sync/errors";
import { BOX_YAML, readBoxDir } from "./box";

/** An env name that reads like it holds a credential. */
const CREDENTIAL_NAME_RE = /(?:^|_)(?:token|secret|password|passwd|passphrase|credentials?|api_?key|private_?key|access_?key|auth|authorization|cookie|pat)(?:_|$)/i;
/** An argument that says the server works on the session's files. */
const WORKSPACE_ARG_RE = /(?:^|[-_=/])(?:workspace|workdir|cwd|repo(?:sitory)?(?:-?(?:path|dir|root))?|project(?:-?(?:path|dir|root))?|root)(?:$|[-_=/])|^\.$|^\.\/|\$PWD/i;

export type ManifestCase = "box" | "gateway" | "split";

export interface ManifestServerVerdict {
  name: string;
  case: ManifestCase;
  /** Case `box`: what to write under the box's `mcp.stdio`. */
  stdio?: { command: string; args: string[] };
  /** Case `box`: the server's literal env values, which move to the box's own `env` (a box server has no env of its own). */
  boxEnv?: Record<string, string>;
  /** Cases `gateway` and `split`: the env NAMES that carry a node secret. Never a value. */
  secretEnv?: string[];
  /** Cases `gateway` and `split`: the node variables those names reference. */
  nodeVars?: string[];
  /** Things to check by hand, in plain sentences. */
  notes: string[];
}

export interface FromManifestResult {
  persona: string;
  /** False: the manifest does not list the persona, so it gets no server today. */
  listed: boolean;
  servers: ManifestServerVerdict[];
}

/** Whether an env entry carries a node-held or secret value: a reference, a secret shape, or a name that reads like a credential. */
function envIsSecret(key: string, value: string): boolean {
  return value.includes("${") || CREDENTIAL_NAME_RE.test(key) || isSecretShaped(value);
}

/**
 * Classify the servers a manifest allows a persona. `workspace`: the servers
 * the operator says read the session's files (the manifest cannot say). Without
 * it, an argument that names the workspace is taken as a sign.
 */
export function classifyManifest(m: DeclaredNodeManifest, persona: string, o: { workspace?: readonly string[] } = {}): FromManifestResult {
  const listed = Object.hasOwn(m.allow, persona);
  const entry = listed ? m.allow[persona]! : [];
  const names = entry === "*" ? Object.keys(m.mcpServers) : [...entry];
  const stated = new Set(o.workspace ?? []);
  for (const n of stated) {
    if (!Object.hasOwn(m.mcpServers, n)) throw new PayloadError(`--workspace names '${/^[a-z0-9][a-z0-9_-]{0,63}$/.test(n) ? n : "a server"}', which the manifest does not declare`);
  }
  const servers = names.sort().map((name): ManifestServerVerdict => {
    const s = m.mcpServers[name]!;
    const args = s.args ?? [];
    const env = s.env ?? {};
    const notes: string[] = [];
    const secretEnv = Object.keys(env).filter((k) => envIsSecret(k, env[k]!)).sort();
    if (secretEnv.length === 0) {
      const absolute = s.command.startsWith("/");
      if (!absolute) notes.push("command must be the program's absolute path inside the box image; this manifest names it by a bare name");
      if (args.some((a) => isSecretShaped(a))) notes.push("an argument looks like a credential; a box refuses it, so this server cannot move as it is");
      if (Object.keys(env).length) notes.push("a server in a box has no env of its own: its values go in the box's env, which every process in the box sees");
      notes.push("the box image must contain the program");
      return { name, case: "box", stdio: { command: s.command, args: [...args] }, ...(Object.keys(env).length ? { boxEnv: { ...env } } : {}), notes };
    }
    const nodeVars = [...new Set(secretEnv.flatMap((k) => stdioEnvRefs(env[k]!)))].sort();
    if (secretEnv.some((k) => hasNonPlainRef(env[k]!))) notes.push("an env value uses a ${ form the node refuses; the manifest is not valid as written");
    const readsFiles = stated.has(name) || args.some((a) => WORKSPACE_ARG_RE.test(a));
    if (readsFiles) {
      notes.push(stated.has(name) ? "stated with --workspace: it reads the session's files" : "its arguments name the workspace, so it is taken to read the session's files (pass --workspace to state which servers do)");
      notes.push("a gateway-side server cannot see the workspace and a boxed one cannot hold the secret: keep the persona unboxed, or split the server into a credential-free part in the box and a gateway-side part");
      return { name, case: "split", secretEnv, nodeVars, notes };
    }
    notes.push("run it as an HTTP MCP service the gateway can reach (its own HTTP transport, or a stdio-to-HTTP wrapper beside the gateway)");
    notes.push("declare it in the persona's mcp with its credential as a ${PERSONA_*} placeholder; it reaches the agent through the bridge");
    return { name, case: "gateway", secretEnv, nodeVars, notes };
  });
  return { persona, listed, servers };
}

const yamlText = (v: string): string => (/^[A-Za-z0-9_./:@+-]+$/.test(v) && !/^[-0-9]/.test(v) ? v : JSON.stringify(v));

/** The text `slaude box from-manifest` prints. */
export function renderFromManifest(r: FromManifestResult): string {
  const out: string[] = [];
  if (!r.listed) {
    out.push(`persona '${r.persona}' is not listed in the manifest's allow: it gets no stdio server today, so there is nothing to move.`);
    return out.join("\n") + "\n";
  }
  if (r.servers.length === 0) {
    out.push(`persona '${r.persona}' is allowed no stdio server: there is nothing to move.`);
    return out.join("\n") + "\n";
  }
  const moves = r.servers.filter((s) => s.case === "box");
  for (const s of r.servers) {
    if (s.case === "box") out.push(`${s.name}: moves into the box (mcp.stdio)`);
    else if (s.case === "gateway") out.push(`${s.name}: needs a gateway-side server`);
    else out.push(`${s.name}: needs both a token and the workspace`);
    if (s.secretEnv?.length) out.push(`  env that carries a node secret: ${s.secretEnv.join(", ")}`);
    if (s.nodeVars?.length) out.push(`  node variables referenced: ${s.nodeVars.join(", ")}`);
    for (const n of s.notes) out.push(`  - ${n}`);
  }
  if (moves.length) {
    out.push("");
    out.push("# for the box's box.yaml");
    out.push("mcp:");
    out.push("  stdio:");
    for (const s of moves) {
      out.push(`    ${s.name}:`);
      out.push(`      command: ${yamlText(s.stdio!.command)}`);
      if (s.stdio!.args.length) out.push(`      args: [${s.stdio!.args.map(yamlText).join(", ")}]`);
    }
    const env = Object.assign({}, ...moves.map((s) => s.boxEnv ?? {})) as Record<string, string>;
    if (Object.keys(env).length) {
      out.push("env:");
      for (const k of Object.keys(env).sort()) out.push(`  ${k}: ${JSON.stringify(env[k])}`);
    }
  }
  const stays = r.servers.filter((s) => s.case === "split");
  out.push("");
  out.push(
    stays.length
      ? `${stays.length} server(s) fit neither side: persona '${r.persona}' stays unboxed until ${stays.length === 1 ? "it is" : "they are"} split or dropped.`
      : r.servers.some((s) => s.case === "gateway")
        ? `persona '${r.persona}' can be boxed once the gateway-side server(s) above are deployed and declared in its mcp.`
        : `persona '${r.persona}' can be boxed: every server it is allowed moves into the box.`,
  );
  return out.join("\n") + "\n";
}

export type CheckStatus = "ok" | "fail" | "manual";

export interface PreflightCheck {
  id: "persona" | "box" | "provider" | "seeding" | "manifest" | "tier" | "private-code";
  status: CheckStatus;
  /** One sentence. Names, never values. */
  detail: string;
}

export interface PreflightResult {
  persona: string;
  box: string | null;
  checks: PreflightCheck[];
  /** `boxable`: nothing failed. `stays-unboxed`: something did. Manual items are listed either way. */
  verdict: "boxable" | "stays-unboxed";
}

export interface PreflightOpts {
  /** The deploy repository (personas/ and boxes/). */
  repo: string;
  /** A node manifest to check the persona against. Absent: reported as not checked. */
  manifest?: string;
  /** Whether the persona needs private repositories or registries. Undefined: not answered. */
  privateCode?: boolean;
  /** The persona's MCP server that is the code host, when the operator names it. */
  codeHost?: string;
  /** Override the persona's box (for a persona that does not name one yet). */
  box?: string;
  /** Live nodes of a label that offer a capability. Absent: the tier check is reported as not checked. */
  liveNodes?: (label: string, capability: string) => Promise<Array<{ node: string; has: boolean }>>;
  /** The forms a box can serve. Default: the one constant. */
  supportedForms?: ReadonlySet<ProviderForm>;
}

const CODE_HOST_RE = /github|gitlab|bitbucket|gitea|forgejo|codeberg|sourcehut|gerrit|azure.?devops|code.?host|\bgit\b|\bscm\b/i;

/** The persona's MCP servers as name and host: never a path, a query or a header. */
function personaMcpServers(mcp: unknown): Array<{ name: string; type: string; host: string }> {
  const servers = (mcp as { mcpServers?: Record<string, { type?: unknown; url?: unknown }> } | null | undefined)?.mcpServers;
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers).map(([name, s]) => {
    let host = "";
    try {
      host = typeof s?.url === "string" ? new URL(s.url).host : "";
    } catch {
      host = "";
    }
    return { name, type: typeof s?.type === "string" ? s.type : "stdio", host };
  });
}

/** `slaude box preflight`: the opt-in checklist for one persona. Reads; changes nothing. */
export async function preflight(persona: string, o: PreflightOpts): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const done = (box: string | null): PreflightResult => ({ persona, box, checks, verdict: checks.some((c) => c.status === "fail") ? "stays-unboxed" : "boxable" });
  const file = join(o.repo, "personas", persona, AGENT_YAML);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(persona)) throw new PayloadError("the persona name is not a valid name");
  if (!existsSync(file)) {
    checks.push({ id: "persona", status: "fail", detail: `personas/${persona}/${AGENT_YAML} does not exist in this repository; only an agent.yaml persona can name a box` });
    return done(null);
  }
  const spec = parseAgentYaml(persona, readFileSync(file, "utf8")).spec as {
    provider?: Record<string, unknown> | null;
    mcp?: unknown;
    runsOn?: string;
    definition?: { box?: string };
  };
  checks.push({ id: "persona", status: "ok", detail: `personas/${persona}/${AGENT_YAML} is valid` });

  // The box and its tier.
  const boxName = o.box ?? spec.definition?.box ?? null;
  let tier: BoxTier | null = null;
  if (!boxName) {
    checks.push({ id: "box", status: "manual", detail: "the persona names no box yet; pass --box <name> to check it against one (SLAUDE_BOX_DEFAULT on the gateway would also box it)" });
  } else if (!existsSync(join(o.repo, "boxes"))) {
    checks.push({ id: "box", status: "manual", detail: `this repository has no boxes/ folder, so box '${boxName}' is checked against the deployed boxes at sync, not here` });
  } else {
    const entry = readBoxDir(join(o.repo, "boxes")).find((b) => b.file.name === boxName);
    if (!entry) checks.push({ id: "box", status: "fail", detail: `box '${boxName}' is not defined: boxes/${boxName}/${BOX_YAML} does not exist` });
    else {
      tier = entry.file.policy.tier;
      checks.push({ id: "box", status: "ok", detail: `box '${boxName}' is defined; its weakest accepted tier is ${tier}` });
    }
  }

  // The provider credential form: no secret enters a box, so the provider proxy must be able to serve it.
  const supported = o.supportedForms ?? BOX_SUPPORTED_PROVIDER_FORMS;
  const forms = declaredProviderForms(spec.provider ?? null);
  const bad = forms.filter((f) => !supported.has(f));
  if (forms.length === 0) {
    checks.push({ id: "provider", status: "manual", detail: `the persona declares no provider of its own, so it uses the deployment's credential, which is not visible here; it must be one of: ${[...supported].sort().join(", ")}` });
  } else if (bad.length) {
    checks.push({ id: "provider", status: "fail", detail: `its provider credential form (${bad.join(", ")}) cannot be used from a box; give it one of: ${[...supported].sort().join(", ")}` });
  } else {
    checks.push({ id: "provider", status: "ok", detail: `its provider credential form (${forms.join(", ")}) can be served to a box` });
  }

  // Node-side credential seeding: a boxed session's config directory never holds a credential.
  const mcp = personaMcpServers(spec.mcp);
  const notHttp = mcp.filter((s) => s.type !== "http").map((s) => s.name);
  if (notHttp.length) {
    checks.push({ id: "seeding", status: "fail", detail: `its mcp declares server(s) that are not HTTP (${notHttp.join(", ")}); only an HTTP server goes through the gateway's bridge, and a box gets no credential file` });
  } else {
    checks.push({
      id: "seeding",
      status: "manual",
      detail: `its ${mcp.length} declared MCP server(s) go through the gateway's bridge; a plugin on the node that connects to a service with a token seeded on the node would not have that token in a box (check the plugin inventory)`,
    });
  }

  // The node manifest: a server with a secret cannot move into a box.
  if (!o.manifest) {
    checks.push({ id: "manifest", status: "manual", detail: "no node manifest was given (--manifest <node.json>); a boxed session ignores the manifest, so check each server the persona uses with `slaude box from-manifest`" });
  } else {
    const r = classifyManifest(readDeclaredNodeManifest(readFileSync(o.manifest, "utf8"), "the given file"), persona);
    const blocked = r.servers.filter((s) => s.case !== "box");
    if (!r.listed || r.servers.length === 0) checks.push({ id: "manifest", status: "ok", detail: "the manifest allows the persona no stdio server" });
    else if (blocked.length) {
      checks.push({
        id: "manifest",
        status: "fail",
        detail: `the manifest allows it server(s) that carry a node secret (${blocked.map((s) => `${s.name}: ${s.case === "split" ? "needs both a token and the workspace" : "needs a gateway-side server"}`).join("; ")}); run \`slaude box from-manifest\` for what to deploy instead`,
      });
    } else checks.push({ id: "manifest", status: "ok", detail: `the ${r.servers.length} server(s) the manifest allows it are credential-free and move into the box's mcp.stdio (${r.servers.map((s) => s.name).join(", ")})` });
  }

  // A live node of the persona's label that offers the box's tier.
  const label = spec.runsOn ?? "default";
  if (tier === null) checks.push({ id: "tier", status: "manual", detail: "the box's tier is not known here, so no node was asked" });
  else if (tier === "none") checks.push({ id: "tier", status: "ok", detail: "the box accepts tier none, which every node offers" });
  else if (!o.liveNodes) checks.push({ id: "tier", status: "manual", detail: `not checked (no Redis in this environment): a live node of label '${label}' must offer tier ${tier} or stronger` });
  else {
    const nodes = await o.liveNodes(label, boxTierCapability(tier));
    const n = nodes.filter((x) => x.has).length;
    if (n > 0) checks.push({ id: "tier", status: "ok", detail: `${n} of ${nodes.length} live node(s) of label '${label}' offer tier ${tier} or stronger` });
    else checks.push({ id: "tier", status: "fail", detail: nodes.length ? `none of the ${nodes.length} live node(s) of label '${label}' offers tier ${tier}` : `label '${label}' has no live node` });
  }

  // Private code: a box has no token, so git and package managers reach public hosts only.
  if (o.privateCode === undefined) {
    checks.push({ id: "private-code", status: "manual", detail: "not answered: does this persona need private repositories or registries from its shell? Run again with --private-code or --no-private-code" });
  } else if (!o.privateCode) {
    checks.push({ id: "private-code", status: "ok", detail: "it needs no private repository or registry from its shell" });
  } else {
    const named = o.codeHost ? mcp.find((s) => s.name === o.codeHost) : undefined;
    const guessed = mcp.filter((s) => CODE_HOST_RE.test(s.name) || CODE_HOST_RE.test(s.host));
    if (o.codeHost && !named) {
      checks.push({ id: "private-code", status: "fail", detail: `--code-host names a server that is not in the persona's mcp; without a gateway-side MCP server for the code host it stays unboxed` });
    } else if (named) {
      checks.push({ id: "private-code", status: named.type === "http" ? "ok" : "fail", detail: named.type === "http" ? `private code is reached through its gateway-side MCP server '${named.name}'; git and package managers in the box still reach public hosts only` : `server '${named.name}' is not an HTTP server, so it does not go through the gateway` });
    } else if (guessed.length) {
      checks.push({ id: "private-code", status: "manual", detail: `its mcp declares ${guessed.map((s) => `'${s.name}'`).join(", ")}, which looks like a code host; confirm with --code-host <server>. Git and package managers in the box reach public hosts only` });
    } else {
      checks.push({ id: "private-code", status: "fail", detail: "stays unboxed: it needs private repositories or registries and its mcp declares no MCP server for the code host (a box holds no token, so git cannot clone a private repository)" });
    }
  }
  return done(boxName);
}

const MARK: Record<CheckStatus, string> = { ok: "ok    ", fail: "FAIL  ", manual: "check " };

/** The text `slaude box preflight` prints. */
export function renderPreflight(r: PreflightResult): string {
  const lines = r.checks.map((c) => `${MARK[c.status]} ${c.id}: ${c.detail}`);
  const manual = r.checks.filter((c) => c.status === "manual").length;
  lines.push("");
  lines.push(
    r.verdict === "boxable"
      ? `persona '${r.persona}': nothing here stops it from being boxed${manual ? `; ${manual} item(s) above could not be decided from these files and need a look` : ""}.`
      : `persona '${r.persona}': stays unboxed until the failed item(s) above are settled.`,
  );
  lines.push("This command reports only. It changed nothing.");
  return lines.join("\n") + "\n";
}
