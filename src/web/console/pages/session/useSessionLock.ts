/**
 * The console's active-surface lock on one session (src/queue/panel-lock.ts):
 * while an operator holds it, Slack replies in the thread are paused and the
 * operator drives the session from the Chat tab.
 *
 * - take: POST /lock (409 with the owner when someone else holds it).
 * - hold: POST /heartbeat every third of the TTL; a 409 means the lock was
 *   lost (expired, or a superadmin took over).
 * - release: POST /release; also sent (keepalive) when the page goes away, so
 *   Slack is not left paused for a full TTL.
 * - take over: POST /force-release (superadmin): the caller becomes the owner.
 * A 503 means the deployment has no lock backend: chat works without one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionDetailResponse, SessionForceReleaseResponse, SessionHeartbeatResponse, SessionLockResponse, SessionReleaseResponse,
} from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { api } from "../../client";

const DEFAULT_TTL = 60_000;

export interface SessionLock {
  owner: string | null;
  mine: boolean;
  /** The deployment has no lock backend (503): chat without exclusivity. */
  unsupported: boolean;
  /** We held the lock and lost it. */
  lost: boolean;
  /** Who holds it now, when we lost it to a take-over; null when it expired or was released. */
  lostTo: string | null;
  busy: "take" | "release" | "force" | null;
  error: string | null;
  take: () => Promise<void>;
  release: () => Promise<void>;
  forceTake: () => Promise<boolean>;
  /** A chat send took the lock (the server acquires it on chat). */
  claimed: () => void;
  /** Someone else holds it (from a 409 elsewhere). */
  heldBy: (owner: string | null) => void;
  clearError: () => void;
}

const ownerOf = (e: unknown): string | null => {
  const b = e instanceof ApiError ? (e.body as { owner?: unknown } | null) : null;
  return b && typeof b.owner === "string" ? b.owner : null;
};

const pathFor = (sessionId: string, sub: string) => `/api/sessions/${encodeURIComponent(sessionId)}/${sub}`;

export function useSessionLock(sessionId: string, initialOwner: string | null | undefined, me: string | null): SessionLock {
  const [owner, setOwner] = useState<string | null>(initialOwner ?? null);
  const [ttl, setTtl] = useState(DEFAULT_TTL);
  const [unsupported, setUnsupported] = useState(false);
  const [lost, setLost] = useState(false);
  const [lostTo, setLostTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<SessionLock["busy"]>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = !!me && owner === me;
  const mineRef = useRef(mine);
  mineRef.current = mine;

  // The page reloaded the session: take the server's word for the owner,
  // unless we hold it (our heartbeat is the better source then).
  useEffect(() => {
    if (initialOwner === undefined) return;
    if (!mineRef.current) setOwner(initialOwner ?? null);
  }, [initialOwner]);

  // A lost-to-someone notice ends once that person no longer holds it.
  useEffect(() => {
    if (lost && lostTo && owner !== lostTo) {
      setLost(false);
      setLostTo(null);
    }
  }, [lost, lostTo, owner]);

  const fail = useCallback((e: unknown, verb: string) => {
    if (e instanceof ApiError && e.status === 503) {
      setUnsupported(true);
      return;
    }
    if (e instanceof ApiError && e.status === 409) {
      const o = ownerOf(e);
      setOwner(o);
      setError(o ? `${o} is driving this session.` : "Someone else is driving this session.");
      return;
    }
    if (e instanceof ApiError && e.status === 403) {
      setError(`Only a superadmin can ${verb}.`);
      return;
    }
    setError(`Could not ${verb}: ${(e as Error).message}`);
  }, []);

  const regained = useCallback(() => {
    setLost(false);
    setLostTo(null);
  }, []);

  const take = useCallback(async () => {
    setBusy("take");
    setError(null);
    try {
      const r = await api.post<SessionLockResponse>(pathFor(sessionId, "lock"));
      setOwner(r.locked_by);
      setTtl(r.ttl_ms || DEFAULT_TTL);
      regained();
    } catch (e) {
      fail(e, "take control");
    } finally {
      setBusy(null);
    }
  }, [sessionId, fail, regained]);

  const release = useCallback(async () => {
    setBusy("release");
    setError(null);
    try {
      await api.post<SessionReleaseResponse>(pathFor(sessionId, "release"));
      setOwner(null);
    } catch (e) {
      fail(e, "release control");
    } finally {
      setBusy(null);
    }
  }, [sessionId, fail]);

  const forceTake = useCallback(async () => {
    setBusy("force");
    setError(null);
    try {
      const r = await api.post<SessionForceReleaseResponse>(pathFor(sessionId, "force-release"));
      setOwner(r.owner);
      regained();
      return true;
    } catch (e) {
      fail(e, "take over this session");
      return false;
    } finally {
      setBusy(null);
    }
  }, [sessionId, fail, regained]);

  // Heartbeat while we hold it. A 409 means we lost it: ask who holds it now,
  // to tell a take-over apart from an expiry or a release elsewhere.
  useEffect(() => {
    if (!mine || unsupported) return;
    let alive = true;
    const every = Math.max(5_000, Math.floor(ttl / 3));
    const t = setInterval(() => {
      api.post<SessionHeartbeatResponse>(pathFor(sessionId, "heartbeat")).then(
        (r) => {
          if (alive && r.ttl_ms && r.ttl_ms !== ttl) setTtl(r.ttl_ms);
        },
        async (e: unknown) => {
          if (!alive || !(e instanceof ApiError && e.status === 409)) return; // a blip: the next beat retries inside the TTL
          let now: string | null = null;
          try {
            now = (await api.get<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`)).panel_locked_by ?? null;
          } catch {
            /* unknown: report it as expired */
          }
          if (!alive) return;
          const taken = now && now !== me ? now : null;
          setOwner(taken);
          setLostTo(taken);
          setLost(true);
        },
      );
    }, every);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [mine, unsupported, ttl, sessionId, me]);

  // Leaving the page (or the tab) hands the thread back to Slack.
  useEffect(() => {
    const url = `${api.base}${pathFor(sessionId, "release")}`;
    const send = () => {
      if (!mineRef.current) return;
      void fetch(url, { method: "POST", headers: { "x-panel-csrf": "1" }, credentials: "same-origin", keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", send);
    return () => {
      window.removeEventListener("pagehide", send);
      send();
    };
  }, [sessionId]);

  const claimed = useCallback(() => {
    if (me) setOwner(me);
    regained();
  }, [me, regained]);
  const heldBy = useCallback((o: string | null) => setOwner(o), []);
  const clearError = useCallback(() => setError(null), []);

  return { owner, mine, unsupported, lost, lostTo, busy, error, take, release, forceTake, claimed, heldBy, clearError };
}
