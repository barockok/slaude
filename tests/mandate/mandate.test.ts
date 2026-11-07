import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as CronJobs from "../../src/db/cron-jobs";
import { SoulDataSchema } from "../../src/soul/data";
import { __resetSoulDataMemo, setSoulData } from "../../src/soul/extract";
import { __resetPersonaRegistry, setManagedDefaultSoul, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import { listMandates } from "../../src/mandate";
import * as SO from "../../src/db/soul-overrides";

const DEFAULT = SoulDataSchema.parse({
  manager: { userId: "UMGR" },
  approvers: [{ userId: "UAPP", scope: "anything", catchall: true }],
  mandate: "default mandate",
});

const SCOUT_JSON = {
  manager: { userId: "USCOUT" },
  backupManager: { userId: "UBACKUP" },
  approvers: [{ userId: "UALICE", scope: "anything", catchall: true }],
  mandate: "Keep the team informed.",
  channelOverrides: [
    { channel: "CTEAM", mandate: "Answer team questions." },
    { channel: "COPS", mandate: "Run ops triage.", approvers: [{ userId: "UBOB", scope: "deploys", catchall: false }] },
  ],
};

const SCOUT_MD = `# Scout

## Proactive
- Enabled: yes
- Watch: mail, tracker
- Highest: ask
- Wake: yes

## Channel <#COPS|ops>
### Proactive
- Enabled: yes
- Highest: act
`;

function registryWith(personas: Array<Pick<Persona, "name"> & { soulJson?: unknown; soulMd?: string }>): PersonaRegistry {
  const full = personas.map((p) => ({ slackUserId: `UP${p.name.toUpperCase()}`, config: { slackUserId: "UX", name: p.name }, outClient: null, ...p }) as Persona);
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => full.find((p) => p.name === n) ?? null,
    list: () => full,
    isMultiPersonaMode: () => full.length > 0,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
  };
}

async function cron(personaId: string | undefined, prompt: string, cronExpr = "0 9 * * *") {
  return CronJobs.create({ channelId: "CTEAM", createdBy: "UALICE", cronExpr, prompt, nextRunAt: Date.now() + 60_000, personaId });
}

beforeEach(async () => {
  await db.run("DELETE FROM cron_jobs");
  await SO.clear();
  setSoulData(DEFAULT);
  setManagedDefaultSoul("# Default\n");
  setPersonaRegistry(registryWith([
    { name: "scout", soulJson: SCOUT_JSON, soulMd: SCOUT_MD },
    { name: "quiet", soulJson: {}, soulMd: "# Quiet\n" },
  ]));
});
afterEach(() => {
  __resetPersonaRegistry();
  __resetSoulDataMemo();
  setManagedDefaultSoul(null);
});

describe("listMandates", () => {
  test("global, channel blocks, heartbeat and crons, in order", async () => {
    const long = "x".repeat(120);
    const active = await cron("scout", `Post the weekly digest\nwith links`, "0 9 * * 1");
    const longJob = await cron("scout", long);
    await CronJobs.recordRun(active.id, "ok");
    const paused = await cron("scout", "paused job");
    await CronJobs.pause(paused.id);
    await cron("other", "someone else's job");
    await cron(undefined, "default persona job");

    const ms = await listMandates("scout");
    expect(ms.map((m) => m.id)).toEqual([
      "global",
      "channel:COPS",
      "channel:CTEAM",
      "heartbeat",
      ...[active.id, longJob.id].sort().map((id) => `cron:${id}`),
    ]);

    const global = ms[0]!;
    expect(global).toMatchObject({ kind: "global", source: "soul", instructions: "Keep the team informed.", triggers: ["any admitted message"] });
    expect(global.approvers).toEqual(["UALICE", "USCOUT", "UBACKUP"]);

    const ops = ms.find((m) => m.id === "channel:COPS")!;
    expect(ops).toMatchObject({ kind: "channel", source: "soul", channelId: "COPS", instructions: "Run ops triage.", triggers: ["messages in <#COPS>"] });
    expect(ops.approvers).toEqual(["UBOB", "USCOUT", "UBACKUP"]);
    expect(ops.proactive).toEqual({ enabled: true, highest: "act" });

    const team = ms.find((m) => m.id === "channel:CTEAM")!;
    expect(team.approvers).toEqual(["UALICE", "USCOUT", "UBACKUP"]);
    expect(team.proactive).toBeUndefined();

    const hb = ms.find((m) => m.id === "heartbeat")!;
    expect(hb).toMatchObject({ kind: "heartbeat", source: "proactive", triggers: ["heartbeat round", "wake"] });
    expect(hb.instructions).toContain("mail, tracker");
    expect(hb.instructions).toContain("ask");
    expect(hb.approvers).toEqual(["UALICE", "USCOUT", "UBACKUP"]);

    const c = ms.find((m) => m.id === `cron:${active.id}`)!;
    expect(c).toMatchObject({
      kind: "cron",
      source: "cron",
      title: "Post the weekly digest",
      instructions: "Post the weekly digest\nwith links",
      schedule: "0 9 * * 1",
      triggers: ["cron 0 9 * * 1"],
      channelId: "CTEAM",
    });
    expect(typeof c.lastRunAt).toBe("number");
    const l = ms.find((m) => m.id === `cron:${longJob.id}`)!;
    expect(l.title.length).toBe(80);
    expect(l.lastRunAt).toBeNull();
  });

  test("a persona with no mandate text and no heartbeat returns only its crons", async () => {
    const j = await cron("quiet", "check the queue");
    const ms = await listMandates("quiet");
    expect(ms.map((m) => m.id)).toEqual([`cron:${j.id}`]);
  });

  test("default persona: global mandate and crons stored as 'default'", async () => {
    const j = await cron(undefined, "morning standup");
    await cron("scout", "not mine");
    const ms = await listMandates("default");
    expect(ms.map((m) => m.id)).toEqual(["global", `cron:${j.id}`]);
    expect(ms[0]!.instructions).toBe("default mandate");
    expect(ms[0]!.approvers).toEqual(["UAPP", "UMGR"]);
  });

  test("heartbeat without wake, and an unreadable soul text reads as no heartbeat", async () => {
    setManagedDefaultSoul("## Proactive\n- Enabled: yes\n");
    const hb = (await listMandates("default")).find((m) => m.id === "heartbeat")!;
    expect(hb.triggers).toEqual(["heartbeat round"]);
    expect(hb.instructions).toContain("no sources");

    setPersonaRegistry(registryWith([{ name: "ghost", soulPath: "/nonexistent/SOUL.md" } as never]));
    const ms = await listMandates("ghost");
    expect(ms.some((m) => m.kind === "heartbeat")).toBe(false);
  });
});
