import type { Me } from "./api";

/** The Slack identities bound to this account, each with an Unlink button.
 *  Kept apart from App.tsx (which reads browser globals) so it renders and
 *  tests without a DOM. */
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
