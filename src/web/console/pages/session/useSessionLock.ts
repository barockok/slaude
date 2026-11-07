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
  SessionForceReleaseResponse, SessionHeartbeatResponse, SessionLockResponse, SessionReleaseResponse,
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

export function useSessionLock(sessionId: string, initialOwner: string | null | undefined, me: string | null): SessionLock {
  const [owner, setOwner] = useState<string | null>(initialOwner ?? null);
  const [ttl, setTtl] = useState(DEFAULT_TTL);
  const [unsupported, setUnsupported] = useState(false);
  const [lost, setLost] = useState(false);
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

  const path = (sub: string) => `/api/sessions/${encodeURIComponent(sessionId)}/${sub}`;

  const fail = (e: unknown, verb: string) => {
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
  };

  const take = useCallback(async () => {
    setBusy("take");
    setError(null);
    try {
      const r = await api.post<SessionLockResponse>(path("lock"));
      setOwner(r.locked_by);
      setTtl(r.ttl_ms || DEFAULT_TTL);
      setLost(false);
    } catch (e) {
      fail(e, "take control");
    } finally {
      setBusy(null);
    }
  }, [sessionId]);

  const release = useCallback(async () => {
    setBusy("release");
    setError(null);
    try {
      await api.post<SessionReleaseResponse>(path("release"));
      setOwner(null);
    } catch (e) {
      fail(e, "release control");
    } finally {
      setBusy(null);
    }
  }, [sessionId]);

  const forceTake = useCallback(async () => {
    setBusy("force");
    setError(null);
    try {
      const r = await api.post<SessionForceReleaseResponse>(path("force-release"));
      setOwner(r.owner);
      setLost(false);
      return true;
    } catch (e) {
      fail(e, "take over this session");
      return false;
    } finally {
      setBusy(null);
    }
  }, [sessionId]);

  // Heartbeat while we hold it.
  useEffect(() => {
    if (!mine || unsupported) return;
    const every = Math.max(5_000, Math.floor(ttl / 3));
    const t = setInterval(() => {
      api.post<SessionHeartbeatResponse>(path("heartbeat")).then(
        (r) => r.ttl_ms && setTtl(r.ttl_ms),
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 409) {
            setOwner(null);
            setLost(true);
          }
          // A network blip: the next beat tries again well inside the TTL.
        },
      );
    }, every);
    return () => clearInterval(t);
  }, [mine, unsupported, ttl, sessionId]);

  // Leaving the page (or the tab) hands the thread back to Slack.
  useEffect(() => {
    const url = `${api.base}${path("release")}`;
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

  return {
    owner,
    mine,
    unsupported,
    lost,
    busy,
    error,
    take,
    release,
    forceTake,
    claimed: useCallback(() => {
      if (me) setOwner(me);
      setLost(false);
    }, [me]),
    heldBy: useCallback((o: string | null) => setOwner(o), []),
    clearError: useCallback(() => setError(null), []),
  };
}
