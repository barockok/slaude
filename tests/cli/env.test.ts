import { beforeEach, describe, expect, test } from "bun:test";
import { main } from "../../src/cli/env";
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
    const dry = await run("unbind-shared", "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.text).toContain("Would unbind 3 threads");
    for (const out of [list.text, dry.text]) {
      expect(out).not.toContain(HOST);
      expect(out).not.toContain(FP);
    }
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).not.toBeNull();
  });

  test("--apply removes only bindings to shared rows and keeps the rows", async () => {
    const shared = await insertShared();
    const personal = await insertPersonal();
    await bindShared(shared, "C0EXAMPLE", "1.1");
    await Envs.bind({ channelId: "C0EXAMPLE", threadTs: "9.9", envId: personal, dir: "/home/dev", lockByEnv: false });
    const r = await run("unbind-shared", "--apply");
    expect(r.code).toBe(0);
    expect(r.text).toContain("Unbound 1 thread");
    expect(await Envs.findBinding("C0EXAMPLE", "1.1")).toBeNull();
    expect(await Envs.findBinding("C0EXAMPLE", "9.9")).not.toBeNull();
    expect(await Envs.getEnv(shared)).not.toBeNull();
    expect((await run("unbind-shared", "--apply")).text).toContain("Unbound 0 threads");
  });

  test("unbind-shared needs exactly one of --dry-run and --apply; unknown commands are usage errors", async () => {
    expect((await run("unbind-shared")).code).toBe(2);
    expect((await run("unbind-shared", "--dry-run", "--apply")).code).toBe(2);
    expect((await run("bogus")).code).toBe(2);
    expect((await run("list", "--apply")).code).toBe(2);
  });
});
