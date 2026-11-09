import { describe, expect, test, beforeEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { paths } from "../src/config/home";
import * as PendingGates from "../src/db/pending-gates";
import { ApprovalGate } from "../src/gateway/slack/approval-gate";
import { setSoulData, __resetSoulDataMemo } from "../src/soul/extract";
import { SoulDataSchema } from "../src/soul/data";
import * as AuditEvents from "../src/db/audit-events";
import { flushAudits } from "../src/audit/emit";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../src/persona/registry";
import { __setGrantsReader, invalidateGrants } from "../src/access/role";
import type { Grant } from "../src/access/grants";

type Handler = (a: any) => Promise<void>;

function fakeApp() {
  const handlers: { matcher: RegExp; fn: Handler }[] = [];
  const posts: any[] = [];
  const updates: any[] = [];
  const app: any = {
    action: (matcher: RegExp, fn: Handler) => handlers.push({ matcher, fn }),
    client: {
      chat: {
        postMessage: async (m: any) => {
          posts.push(m);
          return { ok: true, ts: "1234.5678" };
        },
        update: async (m: any) => {
          updates.push(m);
          return { ok: true };
        },
      },
    },
  };
  return {
    app,
    posts,
    updates,
    fire: async (action_id: string, userId: string) => {
      const respond: any = (() => {
        const calls: any[] = [];
        const fn = async (m: any) => {
          calls.push(m);
        };
        (fn as any).calls = calls;
        return fn;
      })();
      const ack = async () => {};
      for (const h of handlers) {
        if (h.matcher.test(action_id)) {
          await h.fn({
            ack,
            action: { action_id },
            body: { user: { id: userId } },
            respond,
          });
        }
      }
      return respond;
    },
  };
}

beforeEach(() => {
  if (existsSync(paths.soul)) unlinkSync(paths.soul);
});


// The gate now writes the durable pending_gates row before posting the
// prompt, so the Block Kit message lands a few microtasks after request()
// is called — wait for it instead of reading posts[0] synchronously.
async function firstPost(f: { posts: any[] }): Promise<any> {
  for (let i = 0; i < 500 && f.posts.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  if (f.posts.length === 0) throw new Error("no prompt posted");
  return f.posts[0];
}

describe("ApprovalGate", () => {
  test("approve flow resolves with decision", async () => {
    writeFileSync(
      paths.soul,
      ["# Persona", "## Approvers", "- <@U001>: anything"].join("\n"),
    );
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);

    const promise = gate.request({
      channel: "C",
      threadTs: "T",
      summary: "do thing",
      tools: ["Bash"],
      files: ["/x"],
      risks: "boom",
      category: "code",
    });

    await firstPost(f);
    expect(f.posts.length).toBe(1);
    const actionMatch = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve"));
    await f.fire(actionMatch.action_id, "U001");
    const d = await promise;
    expect(d.approved).toBe(true);
    expect(d.by).toBe("U001");
  });

  test("per-channel override: channel approver eligible, global approver is not", async () => {
    setSoulData(SoulDataSchema.parse({
      manager: { userId: "U0MGR00001" },
      approvers: [{ userId: "U0GLOBAL01", scope: "anything", catchall: true }],
      channelOverrides: [{
        channel: "C0CHAN0001",
        approvers: [{ userId: "U0CHANAPP1", scope: "anything", catchall: true }],
      }],
    }));
    try {
      const f = fakeApp();
      const gate = new ApprovalGate(f.app, []);
      // Pending in the overridden channel; only the channel approver (+ manager,
      // auto-retained) may clear it — the global approver must NOT.
      let resolved = false;
      const p = gate.request({ channel: "C0CHAN0001", threadTs: "T", summary: "x" })
        .then((d) => { resolved = true; return d; });
      const okId = (await firstPost(f)).blocks
        .find((b: any) => b.type === "actions")
        .elements.find((e: any) => e.action_id.includes("approve")).action_id;
      await f.fire(okId, "U0GLOBAL01"); // global approver replaced out of this channel
      await new Promise((r) => setTimeout(r, 5));
      expect(resolved).toBe(false);
      await f.fire(okId, "U0MGR00001"); // manager always retained
      expect((await p).approved).toBe(true);
    } finally {
      __resetSoulDataMemo();
    }
  });

  test("a named persona: its approvers and managers by role, with no scope matching; the default's approver is not", async () => {
    const alpha = {
      name: "alpha", slackUserId: "U0ALPHAP", outClient: null,
      soulJson: { manager: { userId: "UALPHAMGR" }, approvers: [{ userId: "UALPHADBA", scope: "database schema changes", catchall: false }] },
    } as any;
    const reg: PersonaRegistry = {
      lookupByUserId: () => null, lookupByName: (n) => (n === "alpha" ? alpha : null), list: () => [alpha],
      isMultiPersonaMode: () => true, isManaged: () => true, tombstonedPersonaFor: () => null,
    };
    setPersonaRegistry(reg);
    __setGrantsReader(async () => []);
    setSoulData(SoulDataSchema.parse({
      manager: { userId: "UMGRDEF" },
      approvers: [{ userId: "UGLOBALDEF", scope: "anything", catchall: true }],
    }));
    try {
      const f = fakeApp();
      const gate = new ApprovalGate(f.app, []);
      let resolved = false;
      const p = gate.request({ channel: "CPLAIN", threadTs: "T", summary: "deploy the frontend", persona: "alpha" })
        .then((d) => { resolved = true; return d; });
      const okId = (await firstPost(f)).blocks
        .find((b: any) => b.type === "actions")
        .elements.find((e: any) => e.action_id.includes("approve")).action_id;
      await f.fire(okId, "UGLOBALDEF"); // the default persona's approver
      await f.fire(okId, "UMGRDEF"); // the default persona's manager
      await new Promise((r) => setTimeout(r, 5));
      expect(resolved).toBe(false);
      await f.fire(okId, "UALPHADBA"); // alpha's approver, though the scope does not match
      expect(await p).toMatchObject({ approved: true, by: "UALPHADBA" });

      const g2 = fakeApp();
      const gate2 = new ApprovalGate(g2.app, []);
      const p2 = gate2.request({ channel: "CPLAIN", threadTs: "T", summary: "x", persona: "alpha" });
      const id2 = (await firstPost(g2)).blocks
        .find((b: any) => b.type === "actions")
        .elements.find((e: any) => e.action_id.includes("approve")).action_id;
      await g2.fire(id2, "UALPHAMGR"); // alpha's manager
      expect(await p2).toMatchObject({ approved: true, by: "UALPHAMGR" });
    } finally {
      __resetPersonaRegistry();
      __setGrantsReader(null);
      __resetSoulDataMemo();
    }
  });

  describe("a named persona with no approver or manager of its own", () => {
    const withBare = async (fn: () => Promise<void>) => {
      // No structured soul and a default soul with no manager: every unit falls back to an empty default.
      const bare = { name: "bare", slackUserId: "UBAREP", outClient: null } as any;
      setPersonaRegistry({
        lookupByUserId: () => null, lookupByName: (n) => (n === "bare" ? bare : null), list: () => [bare],
        isMultiPersonaMode: () => true, isManaged: () => true, tombstonedPersonaFor: () => null,
      });
      __setGrantsReader(async () => []);
      try {
        await fn();
      } finally {
        __resetPersonaRegistry();
        __setGrantsReader(null);
        __resetSoulDataMemo();
      }
    };
    const approveId = async (f: { posts: any[] }) =>
      (await firstPost(f)).blocks.find((b: any) => b.type === "actions").elements.find((e: any) => e.action_id.includes("approve")).action_id;

    test("never the legacy list or SLAUDE_APPROVERS: the default's manager decides", async () => {
      await withBare(async () => {
        // The legacy "category: ids" block and the env list name ULEGACY and UENV.
        writeFileSync(paths.soul, "# Persona\n## Approvers\n- default: ULEGACY\n");
        setSoulData(SoulDataSchema.parse({ manager: { userId: "UMGRDEF" } }));
        const f = fakeApp();
        const gate = new ApprovalGate(f.app, ["UENV"]);
        let resolved = false;
        const p = gate.request({ channel: "CPLAIN", threadTs: "T", summary: "x", persona: "bare" }).then((d) => ((resolved = true), d));
        const id = await approveId(f);
        await f.fire(id, "ULEGACY");
        await f.fire(id, "UENV");
        await new Promise((r) => setTimeout(r, 5));
        expect(resolved).toBe(false);
        await f.fire(id, "UMGRDEF");
        expect(await p).toMatchObject({ approved: true, by: "UMGRDEF" });
      });
    });

    test("an agent.yaml default persona with no approver or manager: nobody, not the env list or anyone", async () => {
      const registry = { lookupByUserId: () => null, lookupByName: () => null, list: () => [], isMultiPersonaMode: () => false, isManaged: () => true, tombstonedPersonaFor: () => null, defaultPersona: () => ({ model: null, mcp: null, definition: {} }) } as PersonaRegistry;
      setPersonaRegistry(registry);
      setSoulData(SoulDataSchema.parse({}));
      try {
        const f = fakeApp();
        const gate = new ApprovalGate(f.app, ["UENV"]);
        const ac = new AbortController();
        let resolved = false;
        const p = gate.request({ channel: "CPLAIN", threadTs: "T", summary: "x" }, ac.signal).then((d) => ((resolved = true), d));
        const card = JSON.stringify((await firstPost(f)).blocks);
        expect(card).not.toContain("!nobody");
        await f.fire(await approveId(f), "UENV");
        await f.fire(await approveId(f), "URANDOM");
        await new Promise((r) => setTimeout(r, 5));
        expect(resolved).toBe(false);
        ac.abort();
        expect((await p).approved).toBe(false);
      } finally {
        __resetPersonaRegistry();
      }
    });

    test("never anyone: with no manager anywhere nobody may approve", async () => {
      await withBare(async () => {
        setSoulData(SoulDataSchema.parse({}));
        const f = fakeApp();
        const gate = new ApprovalGate(f.app, []);
        const ac = new AbortController();
        let resolved = false;
        const p = gate.request({ channel: "CPLAIN", threadTs: "T", summary: "x", persona: "bare" }, ac.signal).then((d) => ((resolved = true), d));
        const card = JSON.stringify((await firstPost(f)).blocks);
        expect(card).toContain("nobody (no manager is configured)");
        expect(card).not.toContain("!nobody");
        await f.fire(await approveId(f), "URANDOM");
        await new Promise((r) => setTimeout(r, 5));
        expect(resolved).toBe(false);
        ac.abort();
        expect((await p).approved).toBe(false);
      });
    });
  });

  describe("deny grants", () => {
    const deny = (subjectId: string): Grant => ({
      subjectKind: "user", subjectId, role: "member", deny: true, dmOnly: false, source: "console",
    });
    const approveId = async (f: { posts: any[] }) =>
      (await firstPost(f)).blocks.find((b: any) => b.type === "actions").elements.find((e: any) => e.action_id.includes("approve")).action_id;
    const refusedRows = async (sessionId: string) => {
      for (let i = 0; ; i++) {
        await flushAudits();
        const items = (await AuditEvents.list({ sessionId, action: "gate.approval.refused" })).items;
        if (items.length || i >= 200) return items;
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const withGrants = async (grants: () => Grant[], fn: () => Promise<void>) => {
      __setGrantsReader(async (persona) => (persona === "default" ? grants() : []));
      try {
        await fn();
      } finally {
        __setGrantsReader(null);
        __resetSoulDataMemo();
      }
    };

    test("a denied soul approver of the default persona cannot approve; the others can", async () => {
      await withGrants(() => [deny("U0DENIED1")], async () => {
        setSoulData(SoulDataSchema.parse({
          approvers: [
            { userId: "U0DENIED1", scope: "anything", catchall: true },
            { userId: "U0APPROV1", scope: "anything", catchall: true },
          ],
        }));
        const f = fakeApp();
        const gate = new ApprovalGate(f.app, []);
        let resolved = false;
        const p = gate.request({ channel: "CPLAIN", threadTs: "T", summary: "x", sessionId: "SDENY1" }).then((d) => ((resolved = true), d));
        const card = JSON.stringify((await firstPost(f)).blocks);
        expect(card).toContain("<@U0APPROV1>");
        expect(card).not.toContain("U0DENIED1");
        const id = await approveId(f);
        await f.fire(id, "U0DENIED1");
        await new Promise((r) => setTimeout(r, 5));
        expect(resolved).toBe(false);
        await f.fire(id, "U0APPROV1");
        expect(await p).toMatchObject({ approved: true, by: "U0APPROV1" });
        const [ev] = await refusedRows("SDENY1");
        expect(ev).toMatchObject({ actorId: "U0DENIED1", decision: "refused" });
      });
    });

    test("when every approver the chain names is denied, nobody may approve (not anyone)", async () => {
      await withGrants(() => [deny("U0DENIED1")], async () => {
        setSoulData(SoulDataSchema.parse({ approvers: [{ userId: "U0DENIED1", scope: "anything", catchall: true }] }));
        const f = fakeApp();
        const gate = new ApprovalGate(f.app, []);
        const ac = new AbortController();
        let resolved = false;
        const p = gate.request({ channel: "CPLAIN", threadTs: "T", summary: "x" }, ac.signal).then((d) => ((resolved = true), d));
        const id = await approveId(f);
        await f.fire(id, "U0DENIED1");
        await f.fire(id, "U0RANDOM1");
        await new Promise((r) => setTimeout(r, 5));
        expect(resolved).toBe(false);
        ac.abort();
        expect((await p).approved).toBe(false);
      });
    });

    test("a card anyone may decide still refuses a denied clicker; others decide it", async () => {
      await withGrants(() => [deny("U0DENIED1")], async () => {
        writeFileSync(paths.soul, "# Persona\n");
        setSoulData(SoulDataSchema.parse({}));
        const f = fakeApp();
        const gate = new ApprovalGate(f.app, []);
        let resolved = false;
        const p = gate.request({ channel: "CPLAIN", threadTs: "T", summary: "x", sessionId: "SDENY2" }).then((d) => ((resolved = true), d));
        const id = await approveId(f);
        await f.fire(id, "U0DENIED1");
        await new Promise((r) => setTimeout(r, 5));
        expect(resolved).toBe(false);
        const [ev] = await refusedRows("SDENY2");
        expect(ev).toMatchObject({ actorId: "U0DENIED1", decision: "refused" });
        expect(ev!.summary).toContain("denied");
        await f.fire(id, "U0RANDOM1");
        expect(await p).toMatchObject({ approved: true, by: "U0RANDOM1" });
      });
    });

    test("a named persona: a deny added after the card was posted refuses the click", async () => {
      const alpha = { name: "alpha", slackUserId: "U0ALPHAP", outClient: null, soulJson: { manager: { userId: "UALPHAMGR" }, approvers: [{ userId: "UALPHAAPP", scope: "anything", catchall: true }] } } as any;
      setPersonaRegistry({
        lookupByUserId: () => null, lookupByName: (n) => (n === "alpha" ? alpha : null), list: () => [alpha],
        isMultiPersonaMode: () => true, isManaged: () => true, tombstonedPersonaFor: () => null,
      });
      let stored: Grant[] = [];
      __setGrantsReader(async (persona) => (persona === "alpha" ? stored : []));
      try {
        const f = fakeApp();
        const gate = new ApprovalGate(f.app, []);
        let resolved = false;
        const p = gate.request({ channel: "CPLAIN", threadTs: "T", summary: "x", persona: "alpha" }).then((d) => ((resolved = true), d));
        const id = await approveId(f);
        stored = [deny("UALPHAAPP")];
        invalidateGrants("alpha");
        await f.fire(id, "UALPHAAPP");
        await new Promise((r) => setTimeout(r, 5));
        expect(resolved).toBe(false);
        await f.fire(id, "UALPHAMGR");
        expect(await p).toMatchObject({ approved: true, by: "UALPHAMGR" });
      } finally {
        __resetPersonaRegistry();
        __setGrantsReader(null);
        __resetSoulDataMemo();
      }
    });
  });

  test("deny by authorized user", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U002>: anything\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    const p = gate.request({ channel: "C", threadTs: "T", summary: "x" });
    const denyId = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("deny")).action_id;
    await f.fire(denyId, "U002");
    expect((await p).approved).toBe(false);
  });

  test("unauthorized clicker → ignored, plan stays pending", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    let resolved = false;
    const p = gate.request({ channel: "C", threadTs: "T", summary: "x" }).then((d) => {
      resolved = true;
      return d;
    });
    const okId = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await f.fire(okId, "U999"); // not in allowlist
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    // legitimate approver clears it
    await f.fire(okId, "U001");
    expect((await p).approved).toBe(true);
  });

  test("env approvers fallback when no soul block", async () => {
    if (existsSync(paths.soul)) unlinkSync(paths.soul);
    writeFileSync(paths.soul, "# Persona\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, ["U500"]);
    const p = gate.request({ channel: "C", threadTs: "T", summary: "x" });
    const id = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await f.fire(id, "U500");
    expect((await p).approved).toBe(true);
  });

  test("legacy 'category: ids' source resolves approvers", async () => {
    writeFileSync(
      paths.soul,
      ["# Persona", "## Approvers", "- code: U0XXXXXXXXX"].join("\n"),
    );
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    const p = gate.request({ channel: "C", threadTs: "T", summary: "x", category: "code" });
    const id = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await f.fire(id, "U0XXXXXXXXX");
    expect((await p).approved).toBe(true);
  });

  test("legacy default key when category missing", async () => {
    writeFileSync(
      paths.soul,
      ["# Persona", "## Approvers", "- default: U0XXXXXXXXX"].join("\n"),
    );
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    const p = gate.request({ channel: "C", threadTs: "T", summary: "x", category: "ops" });
    const id = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await f.fire(id, "U0XXXXXXXXX");
    expect((await p).approved).toBe(true);
  });

  test("abort signal denies pending", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    const ac = new AbortController();
    const p = gate.request({ channel: "C", threadTs: "T", summary: "x" }, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const d = await p;
    expect(d.approved).toBe(false);
    expect(d.by).toBe("system");
    expect(d.note).toBe("aborted");
  });

  test("post includes tools / files / risks / approvers blocks", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    void gate.request({
      channel: "C",
      threadTs: "T",
      summary: "x".repeat(200),
      tools: ["Bash", "Edit"],
      files: ["/a"],
      risks: "irreversible",
    });
    const blocks = (await firstPost(f)).blocks;
    expect(JSON.stringify(blocks)).toContain("Tools:");
    expect(JSON.stringify(blocks)).toContain("Files:");
    expect(JSON.stringify(blocks)).toContain("irreversible");
    expect(JSON.stringify(blocks)).toContain("Approver(s):");
  });

  test("duplicate click → already-decided message, no second resolve", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    const p = gate.request({ channel: "C", threadTs: "T", summary: "x" });
    const id = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await f.fire(id, "U001");
    await p;
    const updatesBefore = f.updates.length;
    // Fire again — pending entry gone
    const respond = await f.fire(id, "U001");
    const note = (respond as any).calls.find((c: any) => /already decided/.test(c.text));
    expect(note).toBeTruthy();
    // The decided card is the only visible record: never replaced or cleared.
    expect(note.replace_original).toBe(false);
    expect(note.response_type).toBe("ephemeral");
    expect(note.blocks).toBeUndefined();
    expect(f.updates.length).toBe(updatesBefore);
  });

  test("click on an expired row says expired, not decided, and leaves the card alone", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    const p = gate.request({ channel: "C", threadTs: "T", summary: "x" });
    const id = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    // a sweep on another replica expired the row; the card's buttons are still live
    await PendingGates.resolve(id.replace(/^slaude_appr:(approve|deny):/, ""), "expired", "system");
    const respond = await f.fire(id, "U001");
    const note = (respond as any).calls[0];
    expect(note.text).toContain("expired");
    expect(note.text).not.toContain("already decided");
    expect(note.replace_original).toBe(false);
    expect(f.updates.length).toBe(0);
    expect((await p).approved).toBe(false);
  });

  test("empty summary → fallback text", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    void gate.request({ channel: "C", threadTs: "T", summary: "" });
    expect(JSON.stringify((await firstPost(f)).blocks)).toContain("(no summary)");
  });

  test("timeout auto-denies + posts update", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
    const f = fakeApp();
    // 0.05s timeout — fast enough for the test, large enough for setTimeout precision.
    const gate = new ApprovalGate(f.app, [], { timeoutSeconds: () => 0.05 as any });
    const d = await gate.request({ channel: "C", threadTs: "T", summary: "stuck" });
    expect(d.approved).toBe(false);
    expect(d.by).toBe("system");
    expect(d.note).toMatch(/^timeout-/);
    // chat.update fired with the hourglass copy.
    expect(f.updates.length).toBe(1);
    expect(f.updates[0].text).toMatch(/Auto-denied/);
  });

  test("approve before timeout clears timer (no auto-deny)", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, [], { timeoutSeconds: () => 0.1 as any });
    const p = gate.request({ channel: "C", threadTs: "T", summary: "x" });
    const id = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await f.fire(id, "U001");
    const d = await p;
    expect(d.approved).toBe(true);
    // Wait past the timeout window — no extra chat.update should have fired.
    await new Promise((r) => setTimeout(r, 150));
    expect(f.updates.length).toBe(0);
  });

  test("abort clears timer", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, [], { timeoutSeconds: () => 0.1 as any });
    const ac = new AbortController();
    const p = gate.request({ channel: "C", threadTs: "T", summary: "x" }, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const d = await p;
    expect(d.note).toBe("aborted");
    await new Promise((r) => setTimeout(r, 150));
    // Timer was cleared on abort — no timeout update.
    expect(f.updates.length).toBe(0);
  });

  test("structured approvers from soul data", async () => {
    writeFileSync(
      paths.soul,
      ["# Persona", "## Approvers", "- `code`: <@U100> anything"].join("\n"),
    );
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    const p = gate.request({ channel: "C", threadTs: "T", summary: "deploy code", category: "code" });
    const id = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await f.fire(id, "U100");
    expect((await p).approved).toBe(true);
  });

  test("scoped approvers matched by summary keyword", async () => {
    writeFileSync(
      paths.soul,
      ["# Persona", "## Approvers", "- `deploy`: <@U200> production deploys"].join("\n"),
    );
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    const p = gate.request({ channel: "C", threadTs: "T", summary: "deploy to production" });
    const id = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await f.fire(id, "U200");
    expect((await p).approved).toBe(true);
  });

  test("structured approvers with no match falls through to env", async () => {
    writeFileSync(
      paths.soul,
      ["# Persona", "## Approvers", "- `database`: <@U300> schema changes only"].join("\n"),
    );
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, ["U400"]);
    const p = gate.request({ channel: "C", threadTs: "T", summary: "deploy frontend", category: "deploy" });
    const id = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await f.fire(id, "U400");
    expect((await p).approved).toBe(true);
  });

  describe("audit", () => {
    // Fire-and-forget writes, some behind a guarded resolve: poll until the
    // expected count lands (or a short deadline passes).
    async function auditRows(sessionId: string, want = 1) {
      for (let i = 0; ; i++) {
        await flushAudits();
        const items = (await AuditEvents.list({ sessionId, action: "gate.approval." })).items;
        if (items.length >= want || i >= 200) return items;
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    const buttonId = async (f: { posts: any[] }, verb: string) =>
      (await firstPost(f)).blocks
        .find((b: any) => b.type === "actions")
        .elements.find((e: any) => e.action_id.includes(verb)).action_id;

    test("a non-approver click is refused, the approver's click is decided", async () => {
      writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
      const f = fakeApp();
      const gate = new ApprovalGate(f.app, []);
      const p = gate.request({ channel: "C", threadTs: "T", summary: "write shared page", category: "kb", sessionId: "SAPR1" });
      const id = await buttonId(f, "approve");
      await f.fire(id, "U999");
      await f.fire(id, "U001");
      await p;
      const rows = await auditRows("SAPR1", 2);
      expect(rows.map((r) => [r.action, r.decision, r.actorId]).sort()).toEqual([
        ["gate.approval.decided", "allow", "U001"],
        ["gate.approval.refused", "refused", "U999"],
      ]);
      for (const r of rows) {
        expect(r).toMatchObject({ targetKind: "approval", targetId: "kb", persona: "default", channelId: "C", threadTs: "T" });
        expect(r.details.category).toBe("kb");
      }
    });

    test("the request's persona is stamped into the row and recorded", async () => {
      writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U002>: anything\n");
      const f = fakeApp();
      const gate = new ApprovalGate(f.app, []);
      const p = gate.request({ channel: "C", threadTs: "T", summary: "x", sessionId: "SAPRP", persona: "helper" });
      await f.fire(await buttonId(f, "deny"), "U002");
      await p;
      const [ev] = await auditRows("SAPRP");
      expect(ev!.persona).toBe("helper");
    });

    test("the timeout is asked for the request's own persona", async () => {
      writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U002>: anything\n");
      const f = fakeApp();
      const asked: Array<string | null | undefined> = [];
      const gate = new ApprovalGate(f.app, [], { timeoutSeconds: (persona) => (asked.push(persona), 0) });
      const p = gate.request({ channel: "C", threadTs: "T", summary: "x", sessionId: "SAPRT", persona: "helper" });
      await f.fire(await buttonId(f, "deny"), "U002");
      await p;
      expect(asked).toEqual(["helper"]);
    });

    test("the card's summary and its decided line are redacted with the persona's patterns", async () => {
      writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U002>: anything\n");
      setSoulData(SoulDataSchema.parse({ approvers: [{ userId: "U002", scope: "anything", catchall: true }], redactPatterns: ["project-\\w+"] }));
      try {
        const f = fakeApp();
        const gate = new ApprovalGate(f.app, []);
        const p = gate.request({ channel: "C", threadTs: "T", summary: "Ship project-falcon", sessionId: "SAPRX" });
        const card = await firstPost(f);
        expect(JSON.stringify(card.blocks)).not.toContain("project-falcon");
        expect(JSON.stringify(card.blocks)).toContain("Ship [REDACTED]");
        await f.fire(await buttonId(f, "approve"), "U002");
        await p;
      } finally {
        __resetSoulDataMemo();
      }
    });

    test("deny records decision deny", async () => {
      writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U002>: anything\n");
      const f = fakeApp();
      const gate = new ApprovalGate(f.app, []);
      const p = gate.request({ channel: "C", threadTs: "T", summary: "x", sessionId: "SAPR2" });
      await f.fire(await buttonId(f, "deny"), "U002");
      await p;
      const [ev] = await auditRows("SAPR2");
      // A request with no scope or category is named by its own summary.
      expect(ev).toMatchObject({ action: "gate.approval.decided", decision: "deny", targetId: "x" });
    });

    test("the auto-deny timer records gate.approval.expired once", async () => {
      writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
      const f = fakeApp();
      const gate = new ApprovalGate(f.app, [], { timeoutSeconds: () => 0.05 as any });
      await gate.request({ channel: "C", threadTs: "T", summary: "stuck", sessionId: "SAPR3" });
      const rows = await auditRows("SAPR3");
      expect(rows.map((r) => [r.action, r.decision, r.actorKind])).toEqual([["gate.approval.expired", "expired", "system"]]);
    });

    test("open(): the timer records expired; a click on the poll row records decided", async () => {
      writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
      const f = fakeApp();
      const gate = new ApprovalGate(f.app, [], { timeoutSeconds: () => 0.05 as any });
      await gate.open({ channel: "C", threadTs: "T", summary: "a", sessionId: "SAPR4" });
      await auditRows("SAPR4");
      const slow = new ApprovalGate(fakeApp().app, [], { timeoutSeconds: () => 0 });
      const { pendingId } = await slow.open({ channel: "C", threadTs: "T", summary: "b", sessionId: "SAPR4" });
      await f.fire(`slaude_appr:approve:${pendingId}`, "U999");
      await f.fire(`slaude_appr:approve:${pendingId}`, "U001");
      const rows = await auditRows("SAPR4", 3);
      expect(rows.map((r) => r.action).sort()).toEqual([
        "gate.approval.decided",
        "gate.approval.expired",
        "gate.approval.refused",
      ]);
    });

    test("an abort records gate.approval.cancelled", async () => {
      writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
      const f = fakeApp();
      const gate = new ApprovalGate(f.app, []);
      const ac = new AbortController();
      const p = gate.request({ channel: "C", threadTs: "T", summary: "x", sessionId: "SAPR5" }, ac.signal);
      await firstPost(f);
      ac.abort();
      await p;
      const [ev] = await auditRows("SAPR5");
      expect(ev).toMatchObject({ action: "gate.approval.cancelled", decision: "cancelled", actorKind: "system" });
    });

    test("a failed card post records gate.approval.cancelled on both paths", async () => {
      writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
      const f = fakeApp();
      f.app.client.chat.postMessage = async () => {
        throw new Error("slack down");
      };
      const gate = new ApprovalGate(f.app, []);
      await expect(gate.request({ channel: "C", threadTs: "T", summary: "x", sessionId: "SAPR6" })).rejects.toThrow();
      await expect(gate.open({ channel: "C", threadTs: "T", summary: "y", sessionId: "SAPR6" })).rejects.toThrow();
      const rows = await auditRows("SAPR6", 2);
      expect(rows.map((r) => r.action)).toEqual(["gate.approval.cancelled", "gate.approval.cancelled"]);
    });
  });
});
