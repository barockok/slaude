Lessons upkeep for {{DAY}}, in the agent's own memory.

`{{LESSONS_SLUG}}` holds the agent's operating lessons. `{{PROPOSALS_SLUG}}` holds lesson proposals from the nightly reviews. Read both with `read_pages` (the agent's own `correction` pages, from `list_pages`, are candidates too).

Merge the proposals into the lessons under these rules:
- The lessons page holds at most {{LESSONS_MAX_LINES}} lines. When it is full, merge or drop lessons before adding one; a longer page is refused.
- A lesson needs a correction, or a pattern seen at least twice. One unexplained failure is never a rule: leave such a proposal waiting.
- Each lesson is one line, dated and sourced: `- YYYY-MM-DD <the lesson> (source: <thread or person>)`.
- A lesson supersedes rather than contradicts: when a proposal changes an existing lesson, rewrite that line and note `replaces: <the old line's date>`; never keep both.

Write the whole lessons page with `memoize` (slug `{{LESSONS_SLUG}}`, type `lessons`). Leave it unchanged when nothing qualifies.

Then write `{{PROPOSALS_SLUG}}` back (type `correction`) holding only the proposals still waiting for more evidence that are under 14 days old, one per line as they were. When none are left, its content is exactly: {{NO_PROPOSALS}}

A lesson that has kept proving itself may be proposed for the agent's SOUL: `propose` with kind `lesson-promotion` to `manager`, with the lesson and its evidence. The operator merges it; never write the SOUL.
