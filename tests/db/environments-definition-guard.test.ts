import { beforeEach, describe, expect, test } from "bun:test";
import * as Envs from "../../src/db/environments";
import { db } from "../../src/db/schema";
import { __resetMasterKeyCache } from "../../src/db/crypto";

/** A definition row as definition sync writes it (written directly: sync arrives in a later task of this slice). */
async function insertDefinition(name = "team-sandbox", retiredAt: number | null = null): Promise<string> {
  const id = `d${name}`;
  await db.run(
    `INSERT INTO environments (id, team_id, user_id, name, kind, config, secrets, default_dir, created_at, updated_at, source, definition_name, definition_hash, retired_at)
     VALUES (?, 'def~default', ?, ?, 'ssh', ?, NULL, '/srv/work', 1, 1, 'definition', ?, 'h1', ?)`,
    [id, name, name, JSON.stringify({ host: "build-box.example.com", user: "dev", shared: "true", trust: "unlocked" }), name, retiredAt],
  );
  return id;
}

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  __resetMasterKeyCache();
  await Envs._wipeForTests();
});

describe("definition rows are managed by sync only", () => {
  test("updateEnv, rename, deleteEnv and createEnv refuse a definition row", async () => {
    const id = await insertDefinition();
    await expect(Envs.updateEnv(id, { defaultDir: "/tmp" })).rejects.toBeInstanceOf(Envs.DefinitionManagedError);
    await expect(Envs.updateEnv(id, { name: "renamed" })).rejects.toBeInstanceOf(Envs.DefinitionManagedError);
    await expect(Envs.updateEnv(id, { config: { host: "x" } })).rejects.toBeInstanceOf(Envs.DefinitionManagedError);
    await expect(Envs.deleteEnv(id)).rejects.toBeInstanceOf(Envs.DefinitionManagedError);
    await expect(Envs.createEnv({ teamId: "def~default", userId: "x", name: "x", kind: "ssh", config: {} })).rejects.toBeInstanceOf(Envs.DefinitionManagedError);
    const row = await db.one<{ default_dir: string; name: string }>("SELECT default_dir, name FROM environments WHERE id = ?", [id]);
    expect(row).toEqual({ default_dir: "/srv/work", name: "team-sandbox" });
  });

  test("a binding survives a refused delete", async () => {
    const id = await insertDefinition();
    await Envs.bind({ channelId: "C0EXAMPLE", threadTs: "1.1", envId: id, dir: "/srv/work", lockByEnv: false });
    await expect(Envs.deleteEnv(id)).rejects.toBeInstanceOf(Envs.DefinitionManagedError);
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).not.toBeNull();
  });

  test("a definition row reads as source definition, and retired when retired_at is set", async () => {
    const live = await insertDefinition("live");
    const gone = await insertDefinition("gone", 5);
    expect((await Envs.getEnv(live))).toMatchObject({ source: "definition", retired: false });
    expect((await Envs.getEnv(gone))).toMatchObject({ source: "definition", retired: true });
  });

  test("the error message names no config", async () => {
    const id = await insertDefinition();
    const e = (await Envs.deleteEnv(id).catch((x) => x)) as Error;
    expect(e.message).toContain("defined in the repository");
    expect(e.message).not.toContain("example.com");
  });

  test("personal behaviour is unchanged", async () => {
    const e = await Envs.createEnv({ teamId: "T0EXAMPLE", userId: "U0EXAMPLE", name: "mine", kind: "ssh", config: { host: "h" }, secrets: { k: "v" }, defaultDir: "/a" });
    expect(e).toMatchObject({ source: "user", retired: false, name: "mine", defaultDir: "/a" });
    const u = await Envs.updateEnv(e.id, { name: "renamed", defaultDir: "/b" });
    expect(u).toMatchObject({ name: "renamed", defaultDir: "/b", secrets: { k: "v" } });
    expect(u!.updatedAt).toBeGreaterThan(e.updatedAt - 1);
    await Envs.bind({ channelId: "C0EXAMPLE", threadTs: "2.2", envId: e.id, dir: "/b", lockByEnv: true });
    const removed = await Envs.deleteEnv(e.id);
    expect(removed).toHaveLength(1);
    expect(await Envs.getEnv(e.id)).toBeNull();
    expect(await Envs.updateEnv("nope", { name: "x" })).toBeNull();
  });
});
