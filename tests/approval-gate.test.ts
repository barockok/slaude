import { describe, expect, test, beforeEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { paths } from "../src/config/home";
import { ApprovalGate } from "../src/gateway/slack/approval-gate";
import { setSoulData, __resetSoulDataMemo } from "../src/soul/extract";
import { SoulDataSchema } from "../src/soul/data";

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

    expect(f.posts.length).toBe(1);
    const actionMatch = f.posts[0].blocks
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
      const okId = f.posts[0].blocks
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

  test("deny by authorized user", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U002>: anything\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    const p = gate.request({ channel: "C", threadTs: "T", summary: "x" });
    const denyId = f.posts[0].blocks
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
    const okId = f.posts[0].blocks
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
    const id = f.posts[0].blocks
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
    const id = f.posts[0].blocks
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
    const id = f.posts[0].blocks
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
    const blocks = f.posts[0].blocks;
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
    const id = f.posts[0].blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await f.fire(id, "U001");
    await p;
    // Fire again — pending entry gone
    const respond = await f.fire(id, "U001");
    expect((respond as any).calls.some((c: any) => /already decided/.test(c.text))).toBe(true);
  });

  test("empty summary → fallback text", async () => {
    writeFileSync(paths.soul, "# Persona\n## Approvers\n- <@U001>: anything\n");
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    void gate.request({ channel: "C", threadTs: "T", summary: "" });
    expect(JSON.stringify(f.posts[0].blocks)).toContain("(no summary)");
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
    const id = f.posts[0].blocks
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
    const id = f.posts[0].blocks
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
    const id = f.posts[0].blocks
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
    const id = f.posts[0].blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("approve")).action_id;
    await f.fire(id, "U400");
    expect((await p).approved).toBe(true);
  });
});
