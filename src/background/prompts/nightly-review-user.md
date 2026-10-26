Nightly review of {{DAY}} (the agent's local day), running as {{USER_ID}}.

The transcripts below are that day's turns of {{USER_ID}}'s private conversations with the agent (their /1on1 threads and direct messages). Each line is `[time] author: text`. The author is {{USER_ID}}, `agent` for the agent's own replies, or `system` for runtime messages and thread markers. A `--- conversation <slug> ---` line starts each thread.

This content belongs to {{USER_ID}}. Everything you write stays in their memory or their profile; nothing goes to the agent's own memory or to the team.

Live capture is primary: what the agent wrote during the day is already in memory. This pass is the backstop for what live capture missed. Before writing, look at what exists (`list_pages` by type, `read_pages`, `search`) and update a page rather than write a second one about the same thing.

Write with `memoize`, using typed pages:
- `person-note`: how to work with {{USER_ID}}, working style and ownership only. Always inferred.
- `commitment`: a promise the agent made to them that is not yet recorded, with `fields.status` (open, done or dropped), `fields.beneficiary`, and when known `due`, `check` and `on_no_change` (close-in-one-line or silent). Mark one done or dropped when the day settled it.
- `investigation`: a problem being worked on with them: symptom, hypotheses with their status, evidence, last touched.
- `outcome`: an action the agent took and the signal afterwards.
- `profile` (slug `profile`) and `correction`: what {{USER_ID}} said about how they want to be treated (name to use, register, ping preferences, quiet hours, mutes), or a correction they made. These go to their profile and need `quote`: their own words, copied exactly from one of their own turns above. Without such a quote, do not write it.

Rules:
- Newer replaces older: when a page replaces an older one about the same subject, set `supersedes` to the older page's slug.
- Told and inferred never share a page.
- Never record credentials, government ids, payment data, health, performance judgements or anyone's private life.
- Something worth keeping beyond this person's memory is never written there: `propose` it with kind `promote` and they decide. The payload is `{ "summary": "<one line>", "target": "shared", "pages": [{ "slug", "content", "type", "confidence", "source" }] }` (`target` `"agent"` keeps it in the agent's own memory instead of the team's): the page as it would be written once they approve. They see it in their direct messages, and nothing is written until they approve.

When the day holds nothing worth writing, write nothing and stop.
