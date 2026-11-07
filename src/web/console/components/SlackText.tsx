import { createContext, useContext, useMemo, type ReactNode } from "react";
import { parseSlackMarkup } from "../lib/slack-markup";

/** Slack user id -> display name, for `<@U…>` mentions (from history answers and the live tail). */
const SlackUsers = createContext<Readonly<Record<string, string>>>({});

export function SlackUsersProvider({ users, children }: { users: Readonly<Record<string, string>>; children: ReactNode }) {
  return <SlackUsers.Provider value={users}>{children}</SlackUsers.Provider>;
}

/** Text with Slack markup shown as it reads in Slack: links, @names, #channels, no escapes. */
export function SlackText({ text }: { text: string }) {
  const users = useContext(SlackUsers);
  const segs = useMemo(() => parseSlackMarkup(text, users), [text, users]);
  return (
    <>
      {segs.map((s, i) =>
        s.kind === "link" ? (
          <a key={i} className="sl-link sl-break" href={s.href} target="_blank" rel="noopener noreferrer">
            {s.text}
          </a>
        ) : s.kind === "user" || s.kind === "channel" ? (
          <span key={i} className="sl-mention" title={s.id}>
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
