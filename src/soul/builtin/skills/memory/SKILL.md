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

### Where each kind lives
| `type` | `target` + slug | Holds |
|---|---|---|
| `profile` | `profile` + `profile` | only what the person said: name to use, register, ping preferences, quiet hours, mutes |
| `correction` (about how to treat a person) | `profile` + `correction-<short-slug>` | what was corrected, by whom, when |
| `person-note` | `mine` + `people/<userId>` | your working observations of how to work with someone; always `inferred` |
| `commitment` | `mine` + `commitments/<short-slug>` | a promise you made |
| `investigation` | `mine` + `investigations/<slug>` | symptom, hypotheses with status, evidence links, last touched |
| `correction` (about your own work) | `mine` + `self/lessons` | a candidate lesson |
| `outcome` | `mine` | an action you took and the signal afterwards |
| `lessons` / `heartbeat` | `mine` + `self/lessons` / `self/heartbeat` | one page each, kept by later phases |
| `team-fact` | `shared` + `shared/people/<userId>` or `shared/services/<name>` | ownership, who debugged what; raises an approval card |

### Commitments
Write one the moment you promise. Fields (`fields`): `promiser`,
`beneficiary`, `thread` (`<channel>:<threadTs>`), `due` (a time or an event),
`check` (what to look at when it falls due), `on_no_change`
(`close-in-one-line` or `silent`), `status` (`open`, `done`, `dropped`). When it
is kept or abandoned, write the page again with the new `status` via
`supersedes` naming the old slug.

### Profile
- `target:"profile"` takes only `profile` and `correction` pages, and a
  profile page uses the slug `profile`.
- Write it only from that person's own words, on their own turn in Slack, with
  only them as sender. Never on behalf of someone else, and never from a
  cron or background turn.
- Entries may carry `agent: <id>` to apply to one agent only.
- Act on a profile; never state it to anyone else.

### Told and inferred
What a person said (`told`) and what you concluded (`inferred`) never share a
page or an entry. If an inference turns out to match what they said, write a
new `told` page rather than editing the inferred one.

### Newer replaces older
Never edit an old page to correct it. Write the new page with `supersedes`
set to the old slug; the runtime tags the old page `superseded` and keeps it,
so you can still say why you changed your mind. A page cannot supersede itself.

### In a /1on1
Anything you learn stays in that person's own slice or their profile.
`target:"shared"` is refused, and nothing reaches `agent-<id>` or another
person's turn unless that person approves it in the /1on1.

### "What do you know about me?"
Call `mcp__slaude_kb__memory_about({ userId })` for the asker. List each
entry, labelled told or inferred, with its date. Offer to correct or delete
entries in their own profile (supersede for a correction). Correct an inferred
note when asked, if you are the agent holding it. Answer plainly, without
naming tools or pages.

### Never record
Credentials or secrets, government ids, payment data, health details,
performance judgements, private life. The runtime refuses credential-like
values on every write. If someone shares one of these, leave it out and carry
on.
