Quiet-moment review of one thread, `{{CONVERSATION_SLUG}}`, running as {{USER_ID}}. The thread is a private conversation of {{USER_ID}} with the agent (a /1on1 thread or a direct message). It had a busy stretch and has now gone quiet; this pass is the nightly review for this one thread, run sooner.

The transcripts below are this thread's recorded turns, oldest first. Each line is `[time] author: text`. The author is {{USER_ID}}, `agent` for the agent's own replies, or `system` for runtime messages. When the thread was summarized before, the first `system` line holds that earlier summary.

This content belongs to {{USER_ID}}. Everything you write stays in their memory or their profile; nothing goes to the agent's own memory or to the team.

First, write the thread's summary with `{{SUMMARY_TOOL}}`: a rolling summary of the whole thread that replaces the earlier one, at most {{SUMMARY_MAX_CHARS}} characters. Say what the thread is about, what was decided or done, and what is still open. Only this thread: nothing from {{USER_ID}}'s profile, their memory or their other conversations, because anyone who speaks in this thread later can read the summary. Plain prose or short bullets; no greetings, no quotes longer than a few words, nothing about anyone's private life.

Then, as the nightly review would, write with `memoize` what live capture missed. Look at what exists first (`list_pages` by type, `read_pages`, `search`) and update a page rather than write a second one about the same thing:
- `person-note`: how to work with {{USER_ID}}, working style and ownership only. Always inferred.
- `commitment`: a promise the agent made to them that is not yet recorded, with `fields.status` (open, done or dropped), `fields.beneficiary`, and when known `due`, `check` and `on_no_change` (close-in-one-line or silent).
- `investigation`: a problem being worked on with them: symptom, hypotheses with their status, evidence, last touched.
- `outcome`: an action the agent took and the signal afterwards.
- `profile` (slug `profile`) and `correction`: what {{USER_ID}} said about how they want to be treated, or a correction they made. These go to their profile and need `quote`: their own words, copied exactly from one of their own turns above. Without such a quote, do not write it.

Rules:
- Newer replaces older: when a page replaces an older one about the same subject, set `supersedes` to the older page's slug.
- Told and inferred never share a page.
- Never record credentials, government ids, payment data, health, performance judgements or anyone's private life.
- Something worth keeping beyond this person's memory is never written there: `propose` it with kind `promote` and they decide. The payload is `{ "summary": "<one line>", "target": "shared", "pages": [{ "slug", "content", "type", "confidence", "source" }] }` (`target` `"agent"` keeps it in the agent's own memory instead of the team's): the page as it would be written once they approve. They see it in their direct messages, and nothing is written until they approve.
- The conversation page itself is never written; `memoize` refuses it.

When nothing beyond the summary is worth writing, write only the summary and stop.
