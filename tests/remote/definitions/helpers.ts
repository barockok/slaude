import { createHash } from "node:crypto";
import * as Envs from "../../../src/db/environments";
import { putKeyIfAbsent } from "../../../src/db/remote";
import { db } from "../../../src/db/schema";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { __setSshResolverForTests } from "../../../src/remote/kinds/ssh";
import { definitionRowId, definitionTeam } from "../../../src/remote/definitions/resolve";

export const FP = "SHA256:" + "A".repeat(43);
export const HOST = "build-box.example.com";
export const PRIV = "-----BEGIN OPENSSH PRIV" + "ATE KEY-----\nplanted-secret-material\n-----END OPENSSH PRIV" + "ATE KEY-----";

export async function reset(): Promise<void> {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  __resetMasterKeyCache();
  __setSshResolverForTests(async () => ["93.184.216.34"]);
  await db.run("DELETE FROM env_bindings");
  await db.run("DELETE FROM environments");
  await db.run("DELETE FROM remote_keys");
  await db.run("DELETE FROM one_on_one_locks");
  await db.run("DELETE FROM sessions");
}

/** A definition row as definition sync writes it, with its key pair. */
export async function insertShared(o: { tenant?: string; name?: string; retired?: boolean; config?: Record<string, string>; hash?: string } = {}): Promise<string> {
  const tenant = o.tenant ?? "default";
  const name = o.name ?? "team-sandbox";
  const id = definitionRowId(tenant, name);
  const config = o.config ?? { host: HOST, user: "dev", port: "22", hostKey: FP, shared: "true", trust: "unlocked" };
  const hash = o.hash ?? createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const cols = ["id", "team_id", "user_id", "name", "kind", "config", "default_dir", "created_at", "updated_at", "source", "definition_name", "definition_hash", "retired_at"];
  const vals: unknown[] = [id, definitionTeam(tenant), name, name, "ssh", JSON.stringify(config), "/srv/work", 1, 1, "definition", name, hash, o.retired ? 5 : null];
  if (db.dialect === "pg") {
    cols.unshift("tenant_id");
    vals.unshift(tenant);
  }
  await db.run(`INSERT INTO environments (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, vals);
  await putKeyIfAbsent(definitionTeam(tenant), name, { privateKey: PRIV, publicKey: "ssh-ed25519 AAAAplanted" });
  return id;
}

export const bindShared = (id: string, channelId = "C0EXAMPLE", threadTs = "1.1") =>
  Envs.bind({ channelId, threadTs, envId: id, dir: "/srv/work", lockByEnv: false });

export async function insertPersonal(userId = "U0EXAMPLE", name = "mine"): Promise<string> {
  const e = await Envs.createEnv({ teamId: "T0EXAMPLE", userId, name, kind: "ssh", config: { host: HOST, user: "dev", port: "22", hostKey: FP }, defaultDir: "/home/dev" });
  return e.id;
}
