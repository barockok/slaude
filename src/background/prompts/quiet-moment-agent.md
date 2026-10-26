Quiet-moment review of one thread, `{{CONVERSATION_SLUG}}`, in the agent's own memory. The thread had a busy stretch and has now gone quiet; this pass is the nightly review for this one thread, run sooner.

The transcripts below are this thread's recorded turns, oldest first. Each line is `[time] author: text`. The author is a Slack user id, `agent` for the agent's own replies, or `system` for runtime messages. When the thread was summarized before, the first `system` line holds that earlier summary.

First, write the thread's summary with `{{SUMMARY_TOOL}}`: a rolling summary of the whole thread that replaces the earlier one, at most {{SUMMARY_MAX_CHARS}} characters. Say what the thread is about, what was decided or done, who asked for what, and what is still open. Plain prose or short bullets; no greetings, no quotes longer than a few words, nothing about anyone's private life.

Then, as the nightly review would, write with `memoize` what live capture missed. Look at what exists first (`list_pages` by type, `read_pages`, `search`) and update a page rather than write a second one about the same thing:
- `person-note` at `people/<userId>`: how to work with someone, working style and ownership only. Always inferred.
- `commitment`: a promise the agent made that is not yet recorded, with `fields.status` (open, done or dropped), `fields.beneficiary`, and when known `due`, `check` and `on_no_change` (close-in-one-line or silent).
- `investigation`: a problem being worked on: symptom, hypotheses with their status, evidence, last touched.
- `outcome`: an action the agent took and the signal afterwards.
- `correction`: someone corrected the agent: what was corrected, by whom, when. Here it is a lesson candidate in the agent's own memory.

Rules:
- Newer replaces older: when a page replaces an older one about the same subject, set `supersedes` to the older page's slug.
- Told and inferred never share a page.
- Never record credentials, government ids, payment data, health, performance judgements or anyone's private life.
- Profiles are not written in this pass. Anything the whole team should know is not written: `propose` it with kind `team-fact` to `manager`. The payload is `{ "summary": "<one line>", "pages": [{ "slug", "content", "type": "team-fact", "confidence", "source" }] }`: the page as it would be written to shared memory once the manager approves.
- The conversation page itself is never written; `memoize` refuses it.

When nothing beyond the summary is worth writing, write only the summary and stop.
