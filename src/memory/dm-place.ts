/**
 * A manager's own DM place, for the /1on1 a manager holds (owner decision 1): the DM place and the
 * person's slice are read together there, and nobody else's DM place is ever read. The DM channel
 * of a person is opened through Slack (no table maps a person to a DM channel), once per process
 * per person; any failure or a slow answer means "no DM place", which only reads less.
 */
import type { PlaceInput, PlaceRef } from "./place";

const TIMEOUT_MS = 1500;
const CAP = 2000;
const channels = new Map<string, string>();

/** Tests: forget the cached DM channels. */
export const __resetDmPlaceForTests = (): void => channels.clear();

export async function managerDmPlace(i: {
  agentId: string;
  teamId: string;
  userId: string;
  personaId?: string | null;
  /** Open (or find) the DM channel with this user; null when it cannot be. */
  open: (userId: string) => Promise<string | null>;
  place: (p: PlaceInput) => Promise<PlaceRef>;
  timeoutMs?: number;
}): Promise<PlaceRef | undefined> {
  try {
    const key = `${i.agentId}\0${i.teamId}\0${i.userId}`;
    const work = (async (): Promise<PlaceRef | undefined> => {
      let channel = channels.get(key) ?? null;
      if (!channel) {
        channel = await i.open(i.userId);
        if (!channel) return undefined;
        if (channels.size >= CAP) channels.clear();
        channels.set(key, channel);
      }
      const ref = await i.place({ agentId: i.agentId, teamId: i.teamId, channel, personaId: i.personaId ?? null });
      return ref.kind === "place" && ref.boundaryKind === "dm" ? ref : undefined;
    })();
    work.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<undefined>((r) => {
      timer = setTimeout(() => r(undefined), i.timeoutMs ?? TIMEOUT_MS);
    });
    try {
      return await Promise.race([work, slow]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}
