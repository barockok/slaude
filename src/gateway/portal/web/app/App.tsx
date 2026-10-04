import { useCallback, useEffect, useState } from "react";
import { api, ApiError, CONNECT_RESULTS, type Integration, type Me } from "./api";

/** The result the OAuth callback redirected back with, read once at load and
 *  then removed from the URL so a reload does not repeat it. */
function useConnectResult(): string | null {
  const [result] = useState(() => new URLSearchParams(location.search).get("connect"));
  useEffect(() => {
    if (result) history.replaceState(null, "", location.pathname);
  }, [result]);
  return result;
}

/** The Slack identities bound to this account, each with an Unlink button. */
export function IdentityList({
  identities,
  busy,
  onUnlink,
}: {
  identities: Me["slackIdentities"];
  busy: string | null;
  onUnlink: (teamId: string, slackUserId: string) => void;
}) {
  return (
    <ul className="list">
      {identities.map((s) => {
        const key = `${s.teamId}:${s.slackUserId}`;
        return (
          <li key={key}>
            <div>
              <strong>Slack</strong>
              <span className="host">
                {s.slackUserId} in {s.teamId}
              </span>
            </div>
            <div className="actions">
              <button onClick={() => onUnlink(s.teamId, s.slackUserId)} disabled={busy === key}>
                Unlink
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const result = useConnectResult();

  const load = useCallback(async () => {
    try {
      const [who, list] = await Promise.all([api.me(), api.integrations()]);
      setMe(who);
      setIntegrations(list);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        location.href = "/portal/auth/login?returnTo=/portal";
        return;
      }
      setError(e instanceof Error ? e.message : "Could not load your integrations.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect(id: string) {
    setBusy(id);
    setError(null);
    try {
      // The browser leaves for the provider here and comes back to
      // /portal/oauth/callback, which redirects to /portal?connect=…
      location.href = (await api.connect(id)).authorizeUrl;
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : "Could not start the connection.");
    }
  }

  async function disconnect(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api.disconnect(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect.");
    } finally {
      setBusy(null);
    }
  }

  async function unlink(teamId: string, slackUserId: string) {
    setBusy(`${teamId}:${slackUserId}`);
    setError(null);
    try {
      await api.unlink(teamId, slackUserId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not unlink.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main>
      <header>
        <h1>Your integrations</h1>
        {me && <p className="who">Signed in as {me.email}</p>}
      </header>

      {result && <p className="notice" role="status">{CONNECT_RESULTS[result] ?? "That did not complete."}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {/* Phase 3's rule, stated rather than implied: "connected" is not the
          same as "used everywhere", and someone who assumes otherwise will be
          surprised in a channel thread. */}
      <p className="scope">
        These apply when an agent is working as you — in your 1:1 with it, and in
        anything you schedule there. In a channel thread the agent uses its own
        identity instead.
      </p>

      {integrations === null && !error && <p className="muted">Loading…</p>}

      {integrations?.length === 0 && (
        <p className="muted">This deployment has no connectable integrations configured.</p>
      )}

      {!!integrations?.length && (
        <ul className="list">
          {integrations.map((i) => (
            <li key={i.id}>
              <div>
                <strong>{i.name}</strong>
                <span className="host">{i.host}</span>
                {i.usedBy.length > 0 && <span className="host">Used by {i.usedBy.join(", ")}</span>}
              </div>
              <div className="actions">
                {i.connected ? (
                  <>
                    <span className="badge">Connected</span>
                    <button onClick={() => void disconnect(i.id)} disabled={busy === i.id}>
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button className="primary" onClick={() => void connect(i.id)} disabled={busy === i.id}>
                    Connect
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!!me?.slackIdentities.length && (
        <>
          <h2>Slack accounts</h2>
          <IdentityList identities={me.slackIdentities} busy={busy} onUnlink={(t, u) => void unlink(t, u)} />
        </>
      )}

      {me && me.slackIdentities.length === 0 && (
        <p className="muted">
          No Slack account is connected yet. Message an agent in Slack and use the link it sends you.
        </p>
      )}
    </main>
  );
}
