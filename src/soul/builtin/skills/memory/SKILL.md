---
name: memory
description: How to save what you learn about people, promises and investigations, and what never to save.
trigger: Before kb_memoize
governs: [mcp__slaude_kb__kb_memoize]
version: "{{SLAUDE_VERSION}}"
---
## Structured memory (`kb_memoize` with a type)
Each page carries a `type`, a `confidence` (`told` or `inferred`), a `source`,
and optionally `supersedes`. `kb_memoize` fills the common frontmatter
(`as_of` today, `source` defaults to `told by <speaker>` on a profile).
Pass `subject` (the Slack user id) for any page about a person.

### Where each kind lives
| `type` | `target` + slug | Holds |
|---|---|---|
| `profile` | `profile` + `profile` | only what the person said: name to use, register, ping preferences, quiet hours, mutes |
| `correction` (about how to treat a person) | `profile` + `correction-<short-slug>` | what was corrected, by whom, when |
| `person-note` | `mine` + `people/<userId>` | your working observations of how to work with someone; always `inferred` |
| `commitment` | `mine` + `commitments/<short-slug>` | a promise you made |
| `investigation` | `mine` + `investigations/<slug>` | symptom, hypotheses with status, evidence links, last touched |
| `correction` (about your own work) | `mine` + `self/lessons` | a candidate lesson |
| `outcome` | `mine` + `outcomes/<short-slug>` | an action you took and the signal afterwards |
| `lessons` | `mine` + `self/lessons` | one page, kept by the background lessons upkeep |
| `heartbeat` | `mine` + `self/heartbeat` | one page: your own recurring checks (below) |
| `team-fact` | `shared` + `shared/people/<userId>` or `shared/services/<name>` (a convention, not enforced) | ownership, who debugged what; raises an approval card |

### Commitments
Write one the moment you promise. Fields (`fields`): `promiser`,
`beneficiary`, `thread` (`<channel>:<threadTs>`), `due` (a time or an event),
`check` (what to look at when it falls due), `on_no_change`
(`close-in-one-line` or `silent`), `status` (`open`, `done`, `dropped`). When it
is kept or abandoned, write a new page under a new slug (for example
`commitments/<slug>-done`) with `status` `done` or `dropped` and `supersedes`
naming the open one. The new page can never reuse the old slug.
A commitment with a `thread` and a `due` is checked for you when it falls due,
in that thread: do not also schedule a cron job or a reminder for it. Write
`due` as an ISO time with its offset (`2026-11-02T09:00:00+07:00`) when there is
one; anything else is treated as an event and checked periodically for a day.

### Heartbeat
`self/heartbeat` is your own checklist of recurring checks, one line each:
what to look at, and when the result is worth interrupting someone (and
whom). When someone asks you to keep an eye on something, add a line; drop
lines that stopped mattering. Rewrite the whole page each time. It runs only
where the operator turned proactiveness on; you never need to mention it.

### Profile
- `target:"profile"` takes only `profile` and `correction` pages, and a
  profile page uses the slug `profile`.
- Write it only from that person's own words, on their own turn in Slack, with
  only them as sender. Never on behalf of someone else, and never from a
  cron or background turn.
- An entry may carry `agent: <id>` in the profile body to apply to one agent
  only. This is a convention you honour when reading (ignore entries tagged
  for another agent); the runtime does not validate it.
- Act on a profile; never state it to anyone else.
- Ping preferences are `fields` on the profile page, each only as the person
  said it: `pings` (`yes` = they want proactive DMs), `topics` (comma-separated
  topics they want pings about), `mutes` (comma-separated topics, or `all`),
  `quiet_hours` (`HH:MM-HH:MM`), `timezone` (IANA). "Don't ping me about X"
  adds X to `mutes`. Rewrite the whole profile page, keeping the other fields.

### Told and inferred
What a person said (`told`) and what you concluded (`inferred`) never share a
page or an entry. If an inference turns out to match what they said, write a
new `told` page rather than editing the inferred one.

### Newer replaces older
Never edit an old page to correct it. Write the new page with `supersedes`
set to the old slug; the runtime tags the old page `superseded` and keeps it,
so you can still say why you changed your mind. The new page needs a new
slug: a page cannot supersede itself, nor a page written in the same call. The
old page must already exist in the same memory you are writing to.

### In a /1on1
Anything you learn stays in that person's own slice or their profile.
`target:"shared"` is refused, and nothing reaches `agent-<id>` or another
person's turn unless that person approves it in the /1on1.

### "What do you know about me?"
Call `mcp__slaude_kb__memory_about({ userId })` for the asker. List each
entry, labelled told or inferred, with its date. Offer to correct or delete
entries in their own profile (supersede for a correction). Correct an inferred
note when asked by writing a new inferred page that supersedes it. Answer plainly, without
naming tools or pages.

### Never record
Credentials or secrets, government ids, payment data, health details,
performance judgements, private life. The runtime refuses credential-like
values on every write. If someone shares one of these, leave it out and carry
on.
