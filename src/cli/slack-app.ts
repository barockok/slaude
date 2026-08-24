// Register / inspect Slack apps in the Postgres `slack_apps` registry the
// HTTP transport resolves inbound requests against (spec §4/§5).
//
// Usage (requires SLAUDE_DB=pg [+ SLAUDE_PG_URL] and SLAUDE_MASTER_KEY):
//   bun run slack-app add --api-app-id A0123 --team-id T0123 \
//       [--bot-token xoxb-…] [--signing-secret …] \
//       [--tenant default] [--persona default] [--bot-user-id U0123]
//   bun run slack-app list
//   bun run slack-app remove --api-app-id A0123 --team-id T0123
//
// --bot-token / --signing-secret fall back to SLACK_BOT_TOKEN /
// SLACK_SIGNING_SECRET so an existing .env can be imported without pasting
// secrets on the command line. Secrets are AES-256-GCM-encrypted at rest and
// never echoed back.
import { dbDialect, getDb, type DbClient } from "../db/client";
import { MasterKeyError } from "../db/crypto";
import * as SlackApps from "../db/slack-apps";

export type CliDeps = {
  /** Explicit client (tests). Default: the process facade, which must be pg. */
  dbc?: DbClient;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
};

const USAGE =
  "usage: slack-app <add|list|remove> [--api-app-id A…] [--team-id T…] " +
  "[--bot-token xoxb-…] [--signing-secret …] [--tenant id] [--persona id] [--bot-user-id U…]";

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument '${a}'`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
    flags[a.slice(2)] = v;
  }
  return flags;
}

const mask = (v: string | null | undefined) => (v ? `${v.slice(0, 5)}…` : "(none)");

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const envv = deps.env ?? process.env;
  const [cmd, ...rest] = argv;

  let flags: Record<string, string>;
  try {
    flags = parseFlags(rest);
  } catch (e: any) {
    err(`[slack-app] ${e.message}`);
    err(USAGE);
    return 1;
  }

  let dbc = deps.dbc;
  if (!dbc) {
    if (dbDialect() !== "pg") {
      err(
        "[slack-app] the slack_apps registry lives in Postgres — set SLAUDE_DB=pg (and SLAUDE_PG_URL) first",
      );
      return 1;
    }
    dbc = await getDb(); // applies pending migrations
  }

  try {
    switch (cmd) {
      case "add": {
        const apiAppId = flags["api-app-id"];
        const teamId = flags["team-id"];
        const botToken = flags["bot-token"] ?? envv.SLACK_BOT_TOKEN;
        const signingSecret = flags["signing-secret"] ?? envv.SLACK_SIGNING_SECRET;
        if (!apiAppId || !teamId) {
          err("[slack-app] add requires --api-app-id and --team-id");
          err(USAGE);
          return 1;
        }
        if (!botToken || !signingSecret) {
          err(
            "[slack-app] add requires --bot-token and --signing-secret (or SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET in the environment)",
          );
          return 1;
        }
        const row = await SlackApps.upsert(
          {
            api_app_id: apiAppId,
            team_id: teamId,
            tenant_id: flags["tenant"],
            persona_id: flags["persona"],
            bot_token: botToken,
            signing_secret: signingSecret,
            bot_user_id: flags["bot-user-id"] ?? null,
          },
          dbc,
        );
        out(
          `[slack-app] registered ${row.api_app_id}/${row.team_id} ` +
            `tenant=${row.tenant_id} persona=${row.persona_id} bot_user=${row.bot_user_id ?? "-"} ` +
            `(bot token ${mask(botToken)}, secrets encrypted at rest)`,
        );
        return 0;
      }
      case "list": {
        const rows = await SlackApps.list(dbc);
        if (rows.length === 0) {
          out("[slack-app] registry is empty — add one with: bun run slack-app add");
          return 0;
        }
        for (const r of rows) {
          out(
            `${r.api_app_id}/${r.team_id}  tenant=${r.tenant_id} persona=${r.persona_id} ` +
              `bot_user=${r.bot_user_id ?? "-"} updated=${new Date(r.updated_at).toISOString()}`,
          );
        }
        return 0;
      }
      case "remove": {
        const apiAppId = flags["api-app-id"];
        const teamId = flags["team-id"];
        if (!apiAppId || !teamId) {
          err("[slack-app] remove requires --api-app-id and --team-id");
          return 1;
        }
        const gone = await SlackApps.remove(apiAppId, teamId, dbc);
        out(
          gone
            ? `[slack-app] removed ${apiAppId}/${teamId}`
            : `[slack-app] no row for ${apiAppId}/${teamId}`,
        );
        return gone ? 0 : 1;
      }
      default: {
        err(USAGE);
        return 1;
      }
    }
  } catch (e: any) {
    if (e instanceof MasterKeyError) {
      err(`[slack-app] ${e.message}`);
    } else {
      err(`[slack-app] failed: ${e?.message ?? e}`);
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
