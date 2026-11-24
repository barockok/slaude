/**
 * A sandbox driver that starts nothing: it records what was created, started
 * and stopped, behind the real SandboxDriver interface. Tests of admission,
 * parking and drain use it where a deployment has the gVisor or bwrap driver.
 */
import type { BoxPolicy } from "../../src/box/policy";
import { defaultBoxPolicy } from "../../src/box/policy";
import type { BoxSpec, BoxTier, SandboxDriver, SandboxStopReason, SessionSandbox } from "../../src/box/sandbox";

export interface FakeDriver extends SandboxDriver {
  /** Session ids with a started sandbox, in start order. */
  running: string[];
  events: string[];
  /** Make the next `start` of this session fail. */
  failStart: Set<string>;
  probeResult: { ok: true } | { ok: false; reason: string };
}

export function fakeDriver(tier: Exclude<BoxTier, "none"> = "gvisor"): FakeDriver {
  const d: FakeDriver = {
    tier,
    running: [],
    events: [],
    failStart: new Set(),
    probeResult: { ok: true },
    async probe() {
      return d.probeResult;
    },
    create(spec: BoxSpec): SessionSandbox {
      const id = spec.sessionId;
      d.events.push(`create ${id}`);
      return {
        tier,
        async start() {
          if (d.failStart.has(id)) throw new Error("runsc: cannot start");
          d.events.push(`start ${id}`);
          d.running.push(id);
        },
        spawn() {
          throw new Error("the fake sandbox spawns nothing");
        },
        async stats() {
          return { memoryBytes: 0, pids: 0, homeBytes: 0, overlayBytes: 0 };
        },
        async stop(reason: SandboxStopReason) {
          d.events.push(`stop ${id} ${reason}`);
          d.running = d.running.filter((x) => x !== id);
        },
      };
    },
  };
  return d;
}

const digest = (c: string) => `sha256:${c.repeat(64)}`;

/** A box as the runtime sees it, with a chosen memory reserve. */
export function fakeBox(o: { reserveMb?: number; digestChar?: string; name?: string } = {}): { name: string; image: string; digest: string; policy: BoxPolicy } {
  const policy = defaultBoxPolicy();
  policy.resources.memoryReserveMb = o.reserveMb ?? 1024;
  const name = o.name ?? "ruby-dev";
  return { name, image: `ghcr.io/example/boxes/${name}@${digest(o.digestChar ?? "a")}`, digest: digest(o.digestChar ?? "a"), policy };
}

/** A minimal spec: the fake driver reads only the session id. */
export function fakeSpec(sessionId: string, box: { digest: string; policy: BoxPolicy }): BoxSpec {
  return { sessionId, tenantId: "default", persona: "ana", digest: box.digest, policy: box.policy, mounts: [], cwd: "/workspace" };
}
