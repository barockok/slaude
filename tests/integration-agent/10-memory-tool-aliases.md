# 10: memory tool names and kb aliases

> **Depends on the memory rebrand task** (plan Task 13: `memory_*` tool names
> with `kb_*` aliases). At the time of writing that task has not landed:
> `grep -rln 'memory_save' "$REPO/src"` prints nothing. Until it does, run
> step 0 only and report every other step `BLOCKED (rebrand not landed)`.
> When it lands, re-read this file against the code (TODO markers below name
> what to confirm) before running it.

## Purpose

The agent's memory tools get user-facing names, and the old names stay as
aliases with identical handlers, because resumed sessions keep calling them.
Mapping (spec "Memory (rebrand of kb)", plan Task 13):

| New name | Alias (old name) |
|---|---|
| `memory_search` | `kb_search` |
| `memory_think` | `kb_think` |
| `memory_get` | `kb_get_page` |
| `memory_list` | `kb_list_pages` |
| `memory_save` | `kb_memoize` |
| `memory_delete` | `kb_delete_page` |
| `memory_graph` | `kb_graph` |
| `memory_thread_history` | `kb_thread_history` |
| `memory_stores` | `list_kbs` |
| `memory_search_stores` | `search_kbs` |
| `memory_about` | (unchanged) |

Required alongside: `SLAUDE_AUTO_ALLOW_TOOLS` expands aliases both ways; the
profile write guard (`src/agent/profile-write-guard.ts`) matches both
`kb_memoize` and `memory_save`; prompt and skill text use the `memory_*`
names (`src/soul/runtime/core.md`, the built-in memory skill under
`src/soul/builtin/skills/`, `skills/how-slaude-works/SKILL.md`,
`src/background/pass-tools.ts`, `src/proactive/commitment-index.ts`); the
gated-dispatch approval categories keep the strings `kb` and `kb-admin`.

The tools are served by the in-process MCP server `slaude_kb`, so their full
names are `mcp__slaude_kb__<name>`. Every `mcp__slaude_kb__*` tool is allowed
without a permission card by the static policy (`permissionPolicy` in
`src/gateway/slack/permission-gate.ts`), so a call never shows a card unless
it is a gated write (a shared or admin write asks for approval).

## Setup

- Environment B with the memory seed from scenario 08 (shared pages
  `notes/it-shared-a` and `notes/it-shared-b`).
- base64url helper:
  `b64u() { printf '%s' "$1" | base64 | tr '+/' '-_' | tr -d '=\n'; }`
- Clear the mock journal before each tool step so its rows are easy to find:
  `curl -fsS -X DELETE http://127.0.0.1:9092/__mock/journal`.

## Steps

0. State check: `grep -rn 'memory_search' "$REPO/src/tools/contracts/kb.ts"` and
   `grep -rln 'memory_save' "$REPO/tests"`. Record the output.
1. Unit floor: run every test file the rebrand added or changed (from step 0's
   second grep), plus
   `bun test tests/permission-gate.test.ts` (auto-allow expansion).
   TODO: name the exact files once the task lands.
2. New name, read:
   `say ADEFAULT UALICE CTEAM "[[mock:multi-tool n=1 tool=mcp__slaude_kb__memory_search args=$(b64u '{"query":"integration test page"}')]] alias new search"`;
   poll the thread; then `curl -fsS http://127.0.0.1:9092/__mock/journal | jq '.[-1].messages | map(select(.role=="tool")) | .[-1].content'`.
3. Old name, read: the same with `tool=mcp__slaude_kb__kb_search` and text `alias old search`.
4. New name, write (own slice, no approval):
   `say ADEFAULT UALICE CTEAM "[[mock:multi-tool n=1 tool=mcp__slaude_kb__memory_save args=$(b64u '{"pages":[{"slug":"notes/it-alias-new","content":"Written through memory_save.","summary":"integration test"}]}')]] alias new save"`.
5. Old name, write: the same with `tool=mcp__slaude_kb__kb_memoize`, slug `notes/it-alias-old`, content `Written through kb_memoize.`.
6. As `lead`: `GET /panel/api/memory/stores`, find the default agent's store
   (`kind` `agent`), then
   `GET /panel/api/memory/pages?store=<that id>&slug=notes/it-alias-new` and the same for `notes/it-alias-old`.
7. Stores, both names: `tool=mcp__slaude_kb__memory_stores` and
   `tool=mcp__slaude_kb__list_kbs` (args `{}` : `$(b64u '{}')`), journal tool results.
8. Auto-allow expansion: restart the gateway with
   `SLAUDE_AUTO_ALLOW_TOOLS=mcp__slaude_kb__memory_save` (and once with
   `mcp__slaude_kb__kb_memoize`) and run a call that would otherwise show a card.
   TODO: a `mcp__slaude_kb__*` call never shows a card today (static policy),
   so this is only observable for a tool outside that prefix or through the
   gated-write path; confirm with the rebrand's tests which observable
   behaviour the expansion changes, and replace this step with it.
9. Prompt text:
   `grep -n 'kb_memoize\|kb_search\|kb_think' "$REPO/src/soul/runtime/core.md" "$REPO/skills/how-slaude-works/SKILL.md" "$REPO"/src/soul/builtin/skills/*/SKILL.md`
   and the same grep for `memory_save\|memory_search\|memory_think`.
10. A turn's system prompt as the mock saw it:
    `curl -fsS http://127.0.0.1:9092/__mock/journal | jq -r '.[-1].messages[0].content' | grep -o 'mcp__slaude_kb__[a-z_]*' | sort -u`.

## Expected observations

0. Before the rebrand: no matches (BLOCKED for the rest). After: matches.
1. All pass.
2. The tool runs without a permission card (`toolran` prints 1 or more);
   the tool result names `notes/it-shared-a`.
3. Same result as step 2 (the alias has the same handler).
4. No card; `toolran` prints 1 or more.
5. Same.
6. `200` for both pages, contents `Written through memory_save.` and
   `Written through kb_memoize.`.
7. Both return the same store list.
8. TODO (see step).
9. After the rebrand: no `kb_*` names in these prompt files (only `memory_*`),
   except where a file documents the aliases on purpose.
10. The prompt offers the `memory_*` names. Whether the `kb_*` aliases are
    also listed to the model is a design choice of the rebrand: TODO record
    what is observed and check it against the task's notes.

## Cleanup

As `lead` nothing can delete memory pages from the console (read-only). The
pages live in the scratch brain and go with `rm -rf "$IT"`.

## Notes

- Inside a `/1on1` the default slice is the person's own; these steps run in
  a channel turn, so `memory_save` without `target` writes to the agent's own
  slice (`agent-<id>`).
- `memory_about` keeps its name; it is not part of the alias table.
