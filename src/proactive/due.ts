/**
 * When a commitment falls due (spec §10.1). A commitment's `due` is either:
 *   - an ISO-8601 instant with an offset or `Z` (`2026-11-02T09:00:00+07:00`):
 *     a time, checked once at that time, its last check `expireHours` later;
 *   - anything else ("after the deploy", or a time with no offset, which is
 *     never given a guessed zone): an event, polled every `pollMinutes` from
 *     when the page was written until `expireHours` after that.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export type Due = { kind: "time" | "event"; nextCheckAt: number; expiresAt: number };

export function parseDue(due: string | undefined, writtenAt: Date, o: { pollMinutes: number; expireHours: number }): Due | null {
  const text = due?.trim();
  if (!text) return null;
  const expire = o.expireHours * 3_600_000;
  if (INSTANT.test(text)) {
    const at = Date.parse(text);
    if (Number.isFinite(at)) return { kind: "time", nextCheckAt: at, expiresAt: at + expire };
  }
  const t = writtenAt.getTime();
  return { kind: "event", nextCheckAt: t + o.pollMinutes * 60_000, expiresAt: t + expire };
}

/** `<channel>:<threadTs>` → its parts, or null. */
export function parseThread(thread: string | undefined): { channelId: string; threadTs: string } | null {
  const m = /^\s*([CGD][A-Z0-9]+):(\d+(?:\.\d+)?)\s*$/.exec(thread ?? "");
  return m ? { channelId: m[1]!, threadTs: m[2]! } : null;
}
