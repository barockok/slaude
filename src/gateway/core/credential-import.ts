/**
 * One-time import of on-disk MCP credentials into the gateway's store.
 *
 * Before phase 3 every credential lived in a `.credentials.json` on the shared
 * volume: the agent's in its own config home and each persona's, a person's
 * under `oauth/<userId>` or `oauth/<persona>/<userId>`. Nodes now seed only
 * from the store, so without this an upgrade silently loses every connected
 * integration.
 *
 * Properties that matter:
 * - Insert-only. Once the store holds a row for an owner and server it is
 *   authoritative; an old file must never replace a grant refreshed since. That
 *   also makes concurrent runs on several gateway replicas harmless, so this
 *   needs no lock.
 * - Files are read, never modified or deleted. A rollback to the previous
 *   version still finds them.
 * - Only the `mcpOAuth` subtree is read. The agent's own Anthropic login in the
 *   same file is not a credential this store holds.
 * - A person is imported only when their Slack id resolves to exactly one
 *   account. The on-disk path carries no workspace, so an id bound to two
 *   different accounts in two workspaces has no safe owner, and is skipped
 *   rather than guessed. No binding at all is skipped too: the person's next
 *   /mcp connect after /link recreates it.
 * - The log reports counts. Never a Slack id, never a token.
 *
 * The agent's tenant is "default": sessions are created with tenant 'default'
 * and the dispatcher resolves the same value, so that is the owner a turn will
 * ask for.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../config/home";
import { agentConfigDir } from "../../agent/oauth-home";
import { accountIdsForSlackUserAnyTeam } from "../../db/accounts";
import { isEntry, putCredentialIfAbsent } from "../../db/mcp-credentials";
import type { CredentialOwner } from "../../agent/credential-owner";

export interface ImportRoots {
  /** The agent's own config home (default persona). */
  agentHome: string;
  /** Directory holding `<persona>/.claude` homes. */
  personasRoot: string;
  /** `$SLAUDE_HOME/oauth`: `<userId>/` and `<persona>/<userId>/` homes. */
  oauthRoot: string;
}

export interface ImportResult {
  imported: number;
  skippedNoAccount: number;
  skippedAmbiguous: number;
  skippedUnreadable: number;
}

const TENANT = "default";

function defaultRoots(): ImportRoots {
  return { agentHome: agentConfigDir(), personasRoot: paths.personas, oauthRoot: join(paths.home, "oauth") };
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const children = (p: string) => (isDir(p) ? readdirSync(p) : []);
const credFile = (dir: string) => join(dir, ".credentials.json");

/** The mcpOAuth subtree of a credentials file, or null if unreadable. */
function readMcpOAuth(dir: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(credFile(dir), "utf8"));
    const m = parsed?.mcpOAuth;
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch {
    return null;
  }
}

export async function importOnDiskCredentials(roots: ImportRoots = defaultRoots()): Promise<ImportResult> {
  const r: ImportResult = { imported: 0, skippedNoAccount: 0, skippedAmbiguous: 0, skippedUnreadable: 0 };

  async function importDir(dir: string, owner: CredentialOwner) {
    if (!existsSync(credFile(dir))) return;
    const m = readMcpOAuth(dir);
    if (m === null) {
      r.skippedUnreadable++;
      return;
    }
    for (const [key, e] of Object.entries(m)) {
      if (!isEntry(e)) {
        r.skippedUnreadable++;
        continue;
      }
      if (await putCredentialIfAbsent(owner, key, e)) r.imported++;
    }
  }

  async function importPerson(dir: string, slackUserId: string) {
    if (!existsSync(credFile(dir))) return;
    const accounts = await accountIdsForSlackUserAnyTeam(slackUserId);
    if (accounts.length === 0) {
      r.skippedNoAccount++;
      return;
    }
    if (accounts.length > 1) {
      r.skippedAmbiguous++;
      return;
    }
    await importDir(dir, { kind: "account", accountId: accounts[0]! });
  }

  // The agent: default persona, then each named persona's home.
  await importDir(roots.agentHome, { kind: "agent", tenant: TENANT, persona: "default" });
  for (const persona of children(roots.personasRoot)) {
    await importDir(join(roots.personasRoot, persona, ".claude"), { kind: "agent", tenant: TENANT, persona });
  }

  // People: oauth/<userId>/ holds a credentials file directly; a directory
  // without one is a persona grouping of oauth/<persona>/<userId>/.
  for (const name of children(roots.oauthRoot)) {
    const dir = join(roots.oauthRoot, name);
    if (!isDir(dir)) continue;
    if (existsSync(credFile(dir))) {
      await importPerson(dir, name);
      continue;
    }
    for (const userId of children(dir)) {
      const userDir = join(dir, userId);
      if (isDir(userDir)) await importPerson(userDir, userId);
    }
  }

  console.log(
    `[credential-import] imported=${r.imported} skipped_no_account=${r.skippedNoAccount} ` +
      `skipped_ambiguous=${r.skippedAmbiguous} skipped_unreadable=${r.skippedUnreadable}`,
  );
  return r;
}
