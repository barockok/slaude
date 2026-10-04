// Mint, inspect and revoke signed node credentials (node labels and routing
// spec §4.1). Runs where SLAUDE_NODE_KEY is: on the gateway.
//
// Usage:
//   bun run node-token mint --label engineering [--label eu] [--id engineering-a] [--ttl 90d]
//   bun run node-token inspect <token>     (or "-" to read the token from stdin)
//   bun run node-token revoke <id>         (requires SLAUDE_DB=pg [+ SLAUDE_PG_URL])
//
// mint prints the token once, on stdout, with a warning on stderr; inspect
// verifies and prints the claims only, never the key; revoke rejects every
// credential with that id issued before now.
import { dbDialect, getDb, type DbClient } from "../db/client";
import { parseDurationSec } from "../config/env";
import {
  DEFAULT_NODE_TTL_SEC,
  mintNodeCredential,
  nodeIdError,
  revokeNodeCredential,
  verifyNodeCredentialSync,
} from "../gateway/auth/node-credential";
import { randomBytes } from "node:crypto";

export type CliDeps = {
  /** Explicit client (tests). Default: the process facade, which must be pg. */
  dbc?: DbClient;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** stdin reader for `inspect -` (tests). */
  readStdin?: () => Promise<string>;
};

const USAGE =
  "usage: node-token mint --label <label> [--label …] [--id <id>] [--ttl 90d] | inspect <token|-> | revoke <id>";

/** Flags with values; --label may repeat. */
function parseFlags(argv: string[]): { labels: string[]; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const labels: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument '${a}'`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
    const name = a.slice(2);
    if (name === "label") labels.push(v);
    else if (name === "id" || name === "ttl") flags[name] = v;
    else throw new Error(`unknown flag ${a}`);
  }
  return { labels, flags };
}

function keysFrom(envv: NodeJS.ProcessEnv): string[] {
  return [envv.SLAUDE_NODE_KEY, envv.SLAUDE_NODE_KEY_PREVIOUS].filter((k): k is string => !!k);
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const envv = deps.env ?? process.env;
  const [cmd, ...rest] = argv;

  try {
    switch (cmd) {
      case "mint": {
        const { labels, flags } = parseFlags(rest);
        const key = envv.SLAUDE_NODE_KEY;
        if (!key) {
          err("[node-token] SLAUDE_NODE_KEY is not set; run this where the gateway's key is");
          return 1;
        }
        if (labels.length === 0) {
          err("[node-token] mint requires at least one --label");
          err(USAGE);
          return 1;
        }
        let ttlSec = DEFAULT_NODE_TTL_SEC;
        if (flags.ttl !== undefined) {
          const t = parseDurationSec(flags.ttl);
          if (t === null) {
            err(`[node-token] --ttl must be seconds or a duration like 90d (got '${flags.ttl}')`);
            return 1;
          }
          ttlSec = t;
        }
        const id = flags.id ?? `${labels[0]}-${randomBytes(3).toString("hex")}`;
        const token = mintNodeCredential({ id, labels, ttlSec }, { key, now: deps.now });
        err(
          `[node-token] minted id=${id} labels=${labels.join(",")} expires=${new Date(((deps.now ?? Date.now()) / 1000 + ttlSec) * 1000).toISOString()}. ` +
            "This is the only time it is shown. Put it in the NODE Secret as that node's SLAUDE_NODE_TOKEN; " +
            "never give it to a gateway (the gateway's legacy value is SLAUDE_NODE_LEGACY_TOKEN, a random string), " +
            "and never put it in a command line, a shell history or a log.",
        );
        out(token);
        return 0;
      }
      case "inspect": {
        let token = rest[0];
        if (!token || rest.length !== 1) {
          err(USAGE);
          return 1;
        }
        if (token === "-") token = (await (deps.readStdin ?? (() => Bun.stdin.text()))()).trim();
        const keys = keysFrom(envv);
        if (keys.length === 0) {
          err("[node-token] SLAUDE_NODE_KEY is not set; cannot verify");
          return 1;
        }
        const r = verifyNodeCredentialSync(token, { keys, now: deps.now });
        if (!r.ok) {
          err(`[node-token] invalid credential: ${r.reason}`);
          return 1;
        }
        const nowSec = Math.floor((deps.now ?? Date.now()) / 1000);
        const c = r.claims;
        out(`id=${c.id}`);
        out(`labels=${c.labels.join(",")}`);
        out(`issued=${new Date(c.iat * 1000).toISOString()}`);
        out(`expires=${new Date(c.exp * 1000).toISOString()} (in ${Math.floor((c.exp - nowSec) / 86400)} day(s))`);
        out("signature=valid (revocation is not checked here)");
        return 0;
      }
      case "revoke": {
        const id = rest[0];
        if (!id || rest.length !== 1) {
          err(USAGE);
          return 1;
        }
        const idErr = nodeIdError(id);
        if (idErr) {
          err(`[node-token] ${idErr}`);
          return 1;
        }
        let dbc = deps.dbc;
        if (!dbc) {
          if (dbDialect() !== "pg") {
            err("[node-token] revocation lives in Postgres — set SLAUDE_DB=pg (and SLAUDE_PG_URL) first");
            return 1;
          }
          dbc = await getDb(); // applies pending migrations
        }
        await revokeNodeCredential(id, dbc);
        out(`[node-token] revoked id=${id}: every credential with this id issued before now is refused within 30 s`);
        return 0;
      }
      default: {
        err(USAGE);
        return 1;
      }
    }
  } catch (e: any) {
    err(`[node-token] ${e?.message ?? e}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
