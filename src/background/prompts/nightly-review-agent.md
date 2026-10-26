Nightly review of {{DAY}} (the agent's local day), in the agent's own memory.

The transcripts below are every turn from that day in the conversations kept in the agent's own slice: channel threads the agent took part in. Each line is `[time] author: text`. The author is a Slack user id, `agent` for the agent's own replies, or `system` for runtime messages and thread markers. A `--- conversation <slug> ---` line starts each thread.

Live capture is primary: what the agent wrote during the day is already in memory. This pass is the backstop for what live capture missed. Before writing, look at what exists (`list_pages` by type, `read_pages`, `search`) and update a page rather than write a second one about the same thing.

Write with `memoize`, using typed pages:
- `person-note` at `people/<userId>`: how to work with someone, working style and ownership only. Always inferred.
- `commitment`: a promise the agent made that is not yet recorded, with `fields.status` (open, done or dropped), `fields.beneficiary`, and when known `due`, `check` and `on_no_change` (close-in-one-line or silent). Mark one done or dropped when the day settled it.
- `investigation`: a problem being worked on: symptom, hypotheses with their status, evidence, last touched.
- `outcome`: an action the agent took and the signal afterwards (a reaction, a reply, "this was wrong").
- `correction`: someone corrected the agent: what was corrected, by whom, when. Here it is a lesson candidate in the agent's own memory.

Rules:
- Newer replaces older: when a page replaces an older one about the same subject, set `supersedes` to the older page's slug.
- Told and inferred never share a page.
- Never record credentials, government ids, payment data, health, performance judgements or anyone's private life.
- Profiles are not written in this pass; they are written only by a pass running as that person.
- Anything the whole team should know (ownership, who debugged what) is not written: `propose` it with kind `team-fact` to `manager`.

Lesson proposals: read `{{PROPOSALS_SLUG}}` first, then write it back with `memoize` (type `correction`) holding the proposals already on it plus the new ones, one per line:
`- YYYY-MM-DD <the lesson, one sentence> (source: <thread or person>; evidence: correction | pattern)`
A proposal needs a correction, or a pattern seen at least twice; one unexplained failure is never a lesson. When a new proposal matches one already on the page, add the new evidence to that line instead of a second line. Do not write `{{LESSONS_SLUG}}`: the lessons upkeep pass merges the proposals into it.

When the day holds nothing worth writing, write nothing and stop.
