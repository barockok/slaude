/**
 * A node's prewarm loop for box images (box spec, "Image build, pull and
 * prewarm").
 *
 *   - At start, and whenever the gateway announces a config reload, the node
 *     asks which images its labels need (GET /v1/node/boxes) and fetches the
 *     ones it lacks: current versions first, then older digests that recent
 *     sessions are pinned to.
 *   - A starting node reports ready once its labels' CURRENT images are
 *     present, or after a timeout, whichever comes first. Past the timeout it
 *     claims work and pulls on demand.
 *   - A session whose image is missing at claim time (`ensureFor`) pulls it
 *     under a deadline and says so once ("preparing the box"). A pull that
 *     fails fails the turn with BOX_IMAGE_UNAVAILABLE. It never runs unboxed.
 *   - After each pass the cache is trimmed to its budget, least recently used
 *     first, never an image that is current or that a session on this node
 *     is using.
 *
 * Built only on a node that offers a sandbox tier.
 */
import { BoxImageError, imageBootFailure, type ImageStore } from "../box/image";

export interface WantedImage {
  name: string;
  image: string;
  digest: string;
  current: boolean;
}

export interface BoxPrewarmDeps {
  images: ImageStore;
  /** GET /v1/node/boxes. Null: the gateway predates the route. */
  list: (tenant: string) => Promise<WantedImage[] | null>;
  /** Digests pinned by sessions warm or parked on this node: never evicted. */
  inUse: () => ReadonlySet<string>;
  /** How long one prewarm fetch may take (ms). */
  pullTimeoutMs: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export type BoxPrewarm = ReturnType<typeof makeBoxPrewarm>;

const short = (digest: string): string => digest.slice("sha256:".length, "sha256:".length + 12);

export function makeBoxPrewarm(deps: BoxPrewarmDeps) {
  const log = deps.log ?? ((l: string) => console.log(l));
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  /** What the gateway last said this node's labels need, by tenant. */
  const wanted = new Map<string, WantedImage[]>();
  /** The pass in flight (or the last one), and whether one is in flight. */
  let current: Promise<void> = Promise.resolve();
  let busy = false;
  let again: string | null = null;
  let listedOnce = false;

  const allWanted = (): WantedImage[] => [...wanted.values()].flat();
  const keep = (): Set<string> => new Set([...deps.inUse(), ...allWanted().map((w) => w.digest)]);

  async function pass(tenant: string): Promise<void> {
    let list: WantedImage[] | null;
    try {
      list = await deps.list(tenant);
    } catch (e) {
      warn(`[box] prewarm: the image list could not be read (${e instanceof Error ? e.message : String(e)}); keeping what is cached`);
      return;
    }
    listedOnce = true;
    if (list === null) {
      warn("[box] prewarm: this gateway does not serve the image list; images are pulled when a session needs one");
      return;
    }
    wanted.set(tenant, list);
    // Current images first: they are what a new session starts on, and what readiness waits for.
    for (const w of [...list].sort((a, b) => Number(b.current) - Number(a.current))) {
      if (deps.images.has(w.digest)) continue;
      try {
        await deps.images.ensure(w.image, w.digest, { deadlineMs: deps.pullTimeoutMs });
      } catch (e) {
        // One image that cannot be fetched does not stop the others; a session that needs it reports the failure itself.
        warn(`[box] prewarm: image ${short(w.digest)} of box ${w.name} was not fetched: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    deps.images.evict(keep());
  }

  return {
    /**
     * Run one pass for a tenant. Passes never overlap: a call during a pass
     * queues exactly one more, for the newest tenant asked.
     */
    refresh(tenant = "default"): Promise<void> {
      if (busy) {
        again = tenant;
        return current;
      }
      busy = true;
      current = (async () => {
        try {
          await pass(tenant);
          while (again !== null) {
            const next = again;
            again = null;
            await pass(next);
          }
        } finally {
          busy = false;
        }
      })();
      return current;
    },

    /** Whether every CURRENT image the gateway listed is present. False until the list was read once. */
    currentReady(): boolean {
      return listedOnce && allWanted().filter((w) => w.current).every((w) => deps.images.has(w.digest));
    },

    /**
     * Resolves when the current images are present or `timeoutMs` passed. The
     * answer says which: a node goes ready either way, and logs when it does
     * so without its images.
     */
    async waitReady(timeoutMs: number, pollMs = 250): Promise<"ready" | "timeout"> {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      for (;;) {
        if (this.currentReady()) return "ready";
        if (Date.now() >= deadline) {
          const missing = allWanted().filter((w) => w.current && !deps.images.has(w.digest)).length;
          warn(`[box] prewarm: going ready after ${Math.round(timeoutMs / 1000)} s with ${listedOnce ? `${missing} current image(s) still missing` : "the image list not read yet"}; they are pulled on demand`);
          return "timeout";
        }
        await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
      }
    },

    /**
     * Make a session's image present before its sandbox starts. `onStatus` is
     * called once, only when a fetch is needed. Throws a BootFailure with
     * BOX_IMAGE_UNAVAILABLE: the caller fails the turn, never runs it unboxed.
     */
    async ensureFor(box: { image: string; digest: string }, o: { deadlineMs: number; onStatus?: (text: string) => void }): Promise<void> {
      try {
        if (deps.images.has(box.digest)) {
          deps.images.touch(box.digest);
          return;
        }
        o.onStatus?.("preparing the box");
        log(`[box] image ${short(box.digest)} is not on this node: fetching it for a claimed turn`);
        await deps.images.ensure(box.image, box.digest, { deadlineMs: o.deadlineMs });
      } catch (e) {
        throw imageBootFailure(e instanceof BoxImageError ? e : new BoxImageError(e instanceof Error ? e.message : String(e), true));
      }
    },

    /** The digests present: what the heartbeat reports. */
    digests: (): string[] => deps.images.digests(),

    /** What the gateway last listed (tests, the boot log). */
    wanted: allWanted,
  };
}
