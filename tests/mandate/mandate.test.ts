import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as CronJobs from "../../src/db/cron-jobs";
import { SoulDataSchema } from "../../src/soul/data";
import { __resetSoulDataMemo, setSoulData } from "../../src/soul/extract";
import { __resetPersonaRegistry, setManagedDefaultSoul, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import { listMandates } from "../../src/mandate";
import * as SO from "../../src/db/soul-overrides";
import * as AgentGrants from "../../src/db/agent-grants";
import { invalidateGrants } from "../../src/access/role";

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
    { channel: "CREVIEW", approvers: [{ userId: "UDAVE", scope: "reviews", catchall: false }] },
  ],
};

// The mandate text lives in the soul text, which is what the mandate read
// model and the scheduler read (no extraction cache here: the parse applies).
const SCOUT_MD = `# Scout

## Mandate
Keep the team informed.

## Channel <#CTEAM|team>
### Mandate
Answer team questions.

## Proactive
- Enabled: yes
- Watch: mail, tracker
- Highest: ask
- Wake: yes

## Channel <#COPS|ops>
### Mandate
Run ops triage.
### Proactive
- Enabled: yes
- Highest: act

## Channel <#CQUIET|quiet>
### Proactive
- Enabled: no
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

async function cron(personaId: string | undefined, prompt: string, cronExpr = "0 9 * * *", channelId = "CTEAM") {
  return CronJobs.create({ channelId, createdBy: "UALICE", cronExpr, prompt, nextRunAt: Date.now() + 60_000, personaId });
}

const sorted = (xs: string[]) => [...xs].sort();
const grant = (persona: string, subjectId: string, role: "manager" | "approver" | "member", deny = false) =>
  AgentGrants.create({ persona, subjectKind: "user", subjectId, role, deny, createdBy: "UMGR" });

beforeEach(async () => {
  await db.run("DELETE FROM cron_jobs");
  await db.run("DELETE FROM agent_grants");
  invalidateGrants();
  await SO.clear();
  setSoulData(DEFAULT);
  setManagedDefaultSoul("# Default\n");
  setPersonaRegistry(registryWith([
    { name: "scout", soulJson: SCOUT_JSON, soulMd: SCOUT_MD },
    { name: "quiet", soulJson: {}, soulMd: "# Quiet\n" },
  ]));
});
afterEach(async () => {
  await db.run("DELETE FROM agent_grants");
  invalidateGrants();
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
      "channel:CQUIET",
      "channel:CTEAM",
      "heartbeat",
      ...[active.id, longJob.id].sort().map((id) => `cron:${id}`),
    ]);

    const global = ms[0]!;
    expect(global).toMatchObject({ kind: "global", source: "soul", instructions: "Keep the team informed.", triggers: ["any admitted message"] });
    // Who the approval gate admits: managers plus global approvers.
    expect(sorted(global.approvers)).toEqual(["UALICE", "UBACKUP", "USCOUT"]);
    expect(global.approverNote).toBeUndefined();

    const ops = ms.find((m) => m.id === "channel:COPS")!;
    expect(ops).toMatchObject({ kind: "channel", source: "soul", channelId: "COPS", instructions: "Run ops triage.", triggers: ["messages in <#COPS>"] });
    // The channel's own approvers replace the global ones there.
    expect(sorted(ops.approvers)).toEqual(["UBACKUP", "UBOB", "USCOUT"]);
    expect(ops.inheritsGlobal).toBeUndefined();
    expect(ops.proactive).toEqual({ enabled: true, highest: "act" });

    const team = ms.find((m) => m.id === "channel:CTEAM")!;
    expect(sorted(team.approvers)).toEqual(["UALICE", "UBACKUP", "USCOUT"]);
    expect(team.proactive).toBeUndefined();

    // An approvers-only block of soul_json is access, not a mandate: not listed.
    expect(ms.some((m) => m.id === "channel:CREVIEW")).toBe(false);
    // A block with no mandate text, proactive only.
    const quiet = ms.find((m) => m.id === "channel:CQUIET")!;
    expect(quiet).toMatchObject({ instructions: "", inheritsGlobal: true, proactive: { enabled: false } });

    const hb = ms.find((m) => m.id === "heartbeat")!;
    expect(hb).toMatchObject({ kind: "heartbeat", source: "proactive", triggers: ["heartbeat round", "wake"] });
    expect(hb.instructions).toContain("mail, tracker");
    expect(hb.instructions).toContain("ask");
    expect(sorted(hb.approvers)).toEqual(["UALICE", "UBACKUP", "USCOUT"]);

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
    // The soul's effective approvers, as the gate scope-matches them (no manager appended).
    expect(ms[0]!.approvers).toEqual(["UAPP"]);
    expect(ms.every((m) => m.approverNote === "scope-matched per request")).toBe(true);
  });

  test("heartbeat without wake, and an unreadable soul text reads as no heartbeat", async () => {
    // One switch: `Enabled: yes` alone also wakes; `Wake: no` narrows to the round.
    setManagedDefaultSoul("## Proactive\n- Enabled: yes\n");
    expect((await listMandates("default")).find((m) => m.id === "heartbeat")!.triggers).toEqual(["heartbeat round", "wake"]);
    setManagedDefaultSoul("## Proactive\n- Enabled: yes\n- Wake: no\n");
    const hb = (await listMandates("default")).find((m) => m.id === "heartbeat")!;
    expect(hb.triggers).toEqual(["heartbeat round"]);
    expect(hb.instructions).toContain("no sources");

    setPersonaRegistry(registryWith([{ name: "ghost", soulPath: "/nonexistent/SOUL.md" } as never]));
    const ms = await listMandates("ghost");
    expect(ms.some((m) => m.kind === "heartbeat")).toBe(false);
  });

  test("default persona: a channel block's approvers replace the soul's global list", async () => {
    setSoulData(SoulDataSchema.parse({ ...DEFAULT, channelOverrides: [{ channel: "COPS", approvers: [{ userId: "UOPS", scope: "deploys", catchall: false }] }] }));
    const j = await cron(undefined, "ops sweep", "0 9 * * *", "COPS");
    const ms = await listMandates("default");
    expect(ms.find((m) => m.id === "channel:COPS")!.approvers).toEqual(["UOPS", "UMGR"]);
    expect(ms.find((m) => m.id === `cron:${j.id}`)!.approvers).toEqual(["UOPS", "UMGR"]);
  });

  test("a stored console approver grant appears, everywhere", async () => {
    await grant("scout", "UCAROL", "approver");
    const ms = await listMandates("scout");
    expect(ms.find((m) => m.id === "global")!.approvers).toContain("UCAROL");
    expect(ms.find((m) => m.id === "channel:COPS")!.approvers).toContain("UCAROL");
  });

  test("a denied user is gone", async () => {
    await grant("scout", "UALICE", "member", true);
    const ms = await listMandates("scout");
    expect(sorted(ms.find((m) => m.id === "global")!.approvers)).toEqual(["UBACKUP", "USCOUT"]);
  });

  test("a named persona with no approvers or managers shows the default persona's managers", async () => {
    setSoulData(SoulDataSchema.parse({ mandate: "default mandate" }));
    setPersonaRegistry(registryWith([{ name: "lone", soulJson: { mandate: "Do lone things." }, soulMd: "# Lone\n\n## Mandate\nDo lone things.\n" }]));
    expect((await listMandates("lone"))[0]!.approvers).toEqual([]);
    await grant("default", "UBOSS", "manager");
    const ms = await listMandates("lone");
    expect(ms[0]).toMatchObject({ id: "global", approvers: ["UBOSS"] });
  });

  test("a cron in a channel with its own approvers shows that channel's approvers", async () => {
    const j = await cron("scout", "ops sweep", "0 9 * * *", "COPS");
    const c = (await listMandates("scout")).find((m) => m.id === `cron:${j.id}`)!;
    expect(sorted(c.approvers)).toEqual(["UBACKUP", "UBOB", "USCOUT"]);
  });

  test("filesystem persona (no soul_json): mandates from its soul text, heartbeat from a channel switch, its crons", async () => {
    const md = `# Pilot

## Mandate
- Keep the release train on time.
- Flag blockers early.

## Channel <#CREL|release>
### Mandate
Post the release status every morning.
### Proactive
- Enabled: yes

## Channel <#CMUTE|mute>
### Proactive
- Enabled: no
`;
    // A default soul with its own channel block must not leak into the persona's list.
    setSoulData(SoulDataSchema.parse({ ...DEFAULT, channelOverrides: [{ channel: "CDEF", approvers: [{ userId: "UOPS", scope: "x", catchall: false }] }] }));
    setPersonaRegistry(registryWith([{ name: "pilot", soulMd: md }]));
    const j = await cron("pilot", "morning sweep", "*/30 * * * *", "CREL");
    const ms = await listMandates("pilot");
    expect(ms.map((m) => m.id)).toEqual(["global", "channel:CMUTE", "channel:CREL", "heartbeat", `cron:${j.id}`]);
    expect(ms[0]!.instructions).toBe("Keep the release train on time. Flag blockers early.");
    const rel = ms.find((m) => m.id === "channel:CREL")!;
    expect(rel).toMatchObject({ instructions: "Post the release status every morning.", proactive: { enabled: true } });
    expect(rel.inheritsGlobal).toBeUndefined();
    expect(ms.find((m) => m.id === "channel:CMUTE")!).toMatchObject({ inheritsGlobal: true, proactive: { enabled: false } });
    // Global `## Proactive` is absent: a channel's own `Enabled: yes` turns wakes on.
    const hb = ms.find((m) => m.id === "heartbeat")!;
    expect(hb.triggers).toEqual(["heartbeat round", "wake"]);
    expect(hb.instructions).toBe("Works on its own in <#CREL>.");
  });

  test("the mandate text matches what the scheduler's wake prompt reads", async () => {
    const { personaMandates } = await import("../../src/background/scheduler");
    for (const name of ["scout", "default"]) {
      const ms = await listMandates(name);
      const channelIds = ms.filter((m) => m.kind === "channel").map((m) => m.channelId!);
      const sched = personaMandates(name, channelIds);
      expect(ms.find((m) => m.id === "global")?.instructions ?? "").toBe(sched.global.trim());
      for (const c of channelIds) expect(ms.find((m) => m.id === `channel:${c}`)!.instructions || null).toBe(sched.channels[c] ?? null);
    }
  });

  test("a named persona with no soul text of its own reads the default persona's soul text", async () => {
    setManagedDefaultSoul("# Default\n\n## Mandate\nThe default soul text mandate.\n");
    setPersonaRegistry(registryWith([{ name: "bare" }]));
    expect((await listMandates("bare"))[0]).toMatchObject({ id: "global", instructions: "The default soul text mandate." });
  });

  test("filesystem persona with only a global proactive switch shows the heartbeat", async () => {
    setPersonaRegistry(registryWith([{ name: "solo", soulMd: "# Solo\n\n## Proactive\n- Enabled: yes\n" }]));
    const ms = await listMandates("solo");
    expect(ms.map((m) => m.id)).toEqual(["heartbeat"]);
  });
});

describe("listMandates scoped mandates", () => {
  const SCOPED_MD = `# Scoped

## Mandate
Keep the team informed.

## Channel <#CTEAM|team>
### Mandate
Mode: extend
Answer team questions.

## Channel <#CQUIET|quiet>
### Proactive
- Enabled: no

## Channel <#CPUB2|pub2>
### Mandate
Replace it here.

## Scope public
### Mandate
Mode: reduce
No internals.

## Scope dm
### Mandate
Be brief.
`;
  const scoped = () => {
    setPersonaRegistry(registryWith([{ name: "scoped", soulJson: { allowedChannels: ["CQUIET", "CPUB2"], trustedChannels: ["CTEAM"] }, soulMd: SCOPED_MD }]));
    return listMandates("scoped");
  };
  const byId = (ms: Awaited<ReturnType<typeof listMandates>>, id: string) => ms.find((m) => m.id === id)!;

  test("a channel card shows its boundary, mode and effective text", async () => {
    const c = byId(await scoped(), "channel:CTEAM");
    expect(c.boundary).toBe("channel:CTEAM");
    expect(c.mode).toBe("extend");
    expect(c.instructions).toBe("Answer team questions.");
    expect(c.effective).toBe("Keep the team informed.\n\nAdditional mandate for this channel (in addition to the mandate above):\nAnswer team questions.");
    expect(c.inheritsGlobal).toBeUndefined();
  });

  test("a no-mode channel is an override and its effective text is its own", async () => {
    const c = byId(await scoped(), "channel:CPUB2");
    expect(c.mode).toBe("override");
    expect(c.effective).toBe("Replace it here.");
  });

  test("scope blocks are cards with their boundary and effective text", async () => {
    const ms = await scoped();
    const pub = byId(ms, "scope:trust:public");
    expect(pub.kind).toBe("scope");
    expect(pub.boundary).toBe("trust:public");
    expect(pub.mode).toBe("reduce");
    expect(pub.effective).toContain("Limit for public channels");
    expect(byId(ms, "scope:dm").effective).toBe("Be brief.");
  });

  test("a channel with no mandate of its own that a scope reaches follows it, not the global", async () => {
    const c = byId(await scoped(), "channel:CQUIET");
    expect(c.inheritsGlobal).toBeUndefined();
    expect(c.effectiveFrom).toBe("trust:public");
    expect(c.effective).toContain("No internals.");
  });
});
