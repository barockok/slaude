import { beforeEach, describe, expect, test } from "bun:test";
import { main } from "../../src/cli/env";
import { sharedBindingCounts, unbindShared } from "../../src/remote/definitions/unbind";
import { flushAudits } from "../../src/audit/emit";
import { db } from "../../src/db/schema";
import * as Envs from "../../src/db/environments";
import { insertPersonal, insertShared, bindShared, reset } from "../remote/definitions/helpers";
import { FP, HOST } from "../remote/definitions/helpers";

const run = async (...argv: string[]) => {
  const lines: string[] = [];
  const code = await main(argv, { out: (s) => lines.push(s) });
  return { code, text: lines.join("\n") };
};

beforeEach(async () => {
  await reset();
});

describe("slaude env", () => {
  test("list and --dry-run report counts and names, never a host", async () => {
    const a = await insertShared();
    const b = await insertShared({ name: "second" });
    await bindShared(a, "C0EXAMPLE", "1.1");
    await bindShared(a, "C0EXAMPLE", "2.2");
    await bindShared(b, "C0EXAMPLE", "3.3");
    const list = await run("list");
    expect(list.text).toContain("env:team-sandbox: 2 threads");
    expect(list.text).toContain("env:second: 1 thread");
    const dry = await run("unbind-shared", "--all-tenants", "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.text).toContain("Would unbind 3 threads");
    for (const out of [list.text, dry.text]) {
      expect(out).not.toContain(HOST);
      expect(out).not.toContain(FP);
    }
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).not.toBeNull();
  });

  test("a tenant's unbind leaves another tenant's threads bound, audits under the right tenant and cleans up each session's remote jobs", async () => {
    if (db.dialect !== "pg") return;
    const a = await insertShared({ tenant: "tenant-a" });
    const b = await insertShared({ tenant: "tenant-b" });
    await bindShared(a, "C0EXAMPLE", "1.1");
    await bindShared(b, "C0EXAMPLE", "2.2");
    await db.run("INSERT INTO sessions (id, created_at, updated_at, model, working_dir, status, claude_started, slack_team_id, slack_channel_id, slack_thread_ts, permission_mode, persona_id) VALUES ('S-un', 1, 1, 'm', '/tmp', 'idle', 0, 'T0EXAMPLE', 'C0EXAMPLE', '1.1', 'default', 'agent-a')");
    const released: string[] = [];
    const done = await unbindShared("tenant-a", { release: async (_r, sid) => { released.push(sid); } });
    expect(done).toEqual([{ tenant: "tenant-a", threads: 1 }]);
    expect(released).toEqual(["S-un"]);
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).toBeNull();
    expect(await Envs.findBinding("C0EXAMPLE", "2.2")).not.toBeNull();
    expect(await sharedBindingCounts("tenant-b")).toEqual([{ name: "team-sandbox", tenant: "tenant-b", threads: 1 }]);
    const r = await run("unbind-shared", "--tenant", "tenant-b", "--apply");
    await flushAudits();
    const audit = await db.one<{ tenant_id: string }>("SELECT tenant_id FROM audit_events WHERE action = 'environment.unbound_shared'");
    expect(audit?.tenant_id).toBe("tenant-b");
    expect(r.text).toContain("not told");
  });

  test("--apply removes only bindings to shared rows and keeps the rows", async () => {
    const shared = await insertShared();
    const personal = await insertPersonal();
    await bindShared(shared, "C0EXAMPLE", "1.1");
    await Envs.bind({ channelId: "C0EXAMPLE", threadTs: "9.9", envId: personal, dir: "/home/dev", lockByEnv: false });
    const r = await run("unbind-shared", "--tenant", "default", "--apply");
    expect(r.code).toBe(0);
    expect(r.text).toContain("Unbound 1 thread");
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).toBeNull();
    expect(await Envs.findBinding("C0EXAMPLE", "9.9")).not.toBeNull();
    expect(await Envs.getEnv(shared)).not.toBeNull();
    expect((await run("unbind-shared", "--tenant", "default", "--apply")).text).toContain("Unbound 0 threads");
  });

  test("unbind-shared needs a tenant (or --all-tenants spelled out) and exactly one of --dry-run and --apply", async () => {
    const a = await insertShared();
    await bindShared(a, "C0EXAMPLE", "1.1");
    expect((await run("unbind-shared", "--apply")).code).toBe(2);
    expect((await run("unbind-shared", "--dry-run")).code).toBe(2);
    expect((await run("unbind-shared", "--tenant", "default", "--all-tenants", "--apply")).code).toBe(2);
    expect((await run("unbind-shared", "--tenant", "Bad Tenant", "--apply")).code).toBe(2);
    expect((await run("unbind-shared", "--tenant", "default")).code).toBe(2);
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).not.toBeNull();
    expect((await run("unbind-shared", "--all-tenants", "--dry-run", "--apply")).code).toBe(2);
    expect((await run("bogus")).code).toBe(2);
    expect((await run("list", "--apply")).code).toBe(2);
  });
});
