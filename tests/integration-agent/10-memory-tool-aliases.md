# 10: memory tool names and kb aliases

## Purpose

The agent's memory tools get user-facing names, and the old names stay as
aliases with identical handlers, because resumed sessions keep calling them.
Mapping (spec "Memory (rebrand of kb)", plan Task 13; the table lives in code
as `MEMORY_TOOL_ALIASES` in `src/tools/contracts/kb.ts`):

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

Both names are mounted on the in-process MCP server `slaude_kb` (full names
`mcp__slaude_kb__<name>`), on the node shims, and on the REST tool plane
(`POST /v1/tools/kb/<name>`, where an alias is mapped to its new name before
dispatch). An alias has the same schema object and handler as its new name;
its description is `Alias of memory_x (deprecated). ...`.

Required alongside: `SLAUDE_AUTO_ALLOW_TOOLS` expands aliases both ways
(`autoAllowFromEnv` in `src/gateway/slack/permission-gate.ts`); the profile
write guard (`src/agent/profile-write-guard.ts`) matches both `kb_memoize` and
`memory_save`; the built-in `slaude:memory` skill governs `memory_save` and,
through the alias table, `kb_memoize`; the wake allow-list allows every
`slaude_kb` tool under either name; prompt and skill text use only the
`memory_*` names; the gated-dispatch approval categories keep the strings `kb`
and `kb-admin` (dispatch classifies by gbrain op, not by tool name).

Every `mcp__slaude_kb__*` tool is allowed without a permission card by the
static policy (`permissionPolicy`), so a call never shows a permission card;
a shared or admin write still asks for approval through the gated dispatch.

## Setup

- Environment B with the memory seed from scenario 08 (shared pages
  `notes/it-shared-a` and `notes/it-shared-b`).
- base64url helper:
  `b64u() { printf '%s' "$1" | base64 | tr '+/' '-_' | tr -d '=\n'; }`
- The mock journal records counts, not message contents (see
  `e2e/mock-llm/README.md`: `messages` is a number). A tool call that came
  back to the model shows as a second `multi-tool` row with a larger
  `messages` count:
  `mt() { curl -fsS http://127.0.0.1:9092/__mock/journal | jq -c '[.[] | select(.tag == "multi-tool") | .messages]'; }`
- Clear the mock journal before each tool step:
  `curl -fsS -X DELETE http://127.0.0.1:9092/__mock/journal`.

## Steps

1. Unit floor:
   `bun test tests/tools/memory-aliases.test.ts tests/tools/contracts.test.ts tests/gateway/api/v1-roundtrip.test.ts tests/agent/profile-write-guard.test.ts tests/agent/skill-gate.test.ts tests/soul.test.ts tests/soul/builtin.test.ts tests/soul/runtime-golden.test.ts tests/permission-gate.test.ts tests/proactive/wake-guard.test.ts tests/knowledge/kb-memoize-typed.test.ts tests/knowledge/memory-about.test.ts`.
2. New name, read:
   `say ADEFAULT UALICE CTEAM "[[mock:multi-tool n=1 tool=mcp__slaude_kb__memory_search args=$(b64u '{"query":"integration test page"}')]] alias new search"`;
   poll the thread up to 30 s, then `mt`.
3. Old name, read: the same with `tool=mcp__slaude_kb__kb_search` and text
   `alias old search`; then `mt`.
4. New name, write (own store, no approval):
   `say ADEFAULT UALICE CTEAM "[[mock:multi-tool n=1 tool=mcp__slaude_kb__memory_save args=$(b64u '{"pages":[{"slug":"notes/it-alias-new","content":"Written through memory_save.","summary":"integration test"}]}')]] alias new save"`;
   then `mt` and `msgs` for the thread.
5. Old name, write: the same with `tool=mcp__slaude_kb__kb_memoize`, slug
   `notes/it-alias-old`, content `Written through kb_memoize.`.
6. As `lead`: `GET /panel/api/memory/stores`, find the default agent's store
   (`kind` `agent`), then
   `GET /panel/api/memory/pages?store=<that id>&slug=notes/it-alias-new` and
   the same for `notes/it-alias-old`.
7. Stores, both names: `tool=mcp__slaude_kb__memory_stores` and
   `tool=mcp__slaude_kb__list_kbs` (args `$(b64u '{}')`); `mt` after each.
8. Auto-allow expansion. A `slaude_kb` call never shows a permission card
   (static policy above), so the expansion has no visible effect on a turn;
   check the parsed set the gateway and nodes build instead:
   `cd "$REPO" && SLAUDE_AUTO_ALLOW_TOOLS=mcp__slaude_kb__memory_save bun -e 'import {autoAllowFromEnv} from "./src/gateway/slack/permission-gate"; console.log([...autoAllowFromEnv()].sort().join(","))'`
   and the same with `SLAUDE_AUTO_ALLOW_TOOLS=mcp__slaude_kb__kb_memoize`.
9. Prompt text:
   `grep -n 'kb_memoize\|kb_search\|kb_think\|list_kbs\|search_kbs' "$REPO/src/soul/runtime/core.md" "$REPO/src/soul/loader.ts" "$REPO/skills/how-slaude-works/SKILL.md" "$REPO"/src/soul/builtin/skills/*/SKILL.md`
   and the same grep for `memory_save\|memory_search\|memory_think`.
10. The rendered system prompt, both brain modes (the mock journal does not
    keep the system prompt):
    `cd "$REPO" && for d in "" 1; do SLAUDE_BRAIN_DISABLED=$d bun -e 'import {runtimeBaseline} from "./src/soul/loader"; import {brainEnabled} from "./src/knowledge/brain"; console.log([...new Set(runtimeBaseline(brainEnabled()).match(/\b(memory|kb)_[a-z_]+|\b(list|search)_kbs\b/g))].sort().join(" "))'; done`.

## Expected observations

1. All pass.
2. No card. `mt` prints two rows, the second with a larger `messages` count
   (the tool result came back to the model).
3. Same as step 2: the alias runs the same handler.
4. No card; `mt` as in step 2.
5. Same.
6. `200` for both pages, contents `Written through memory_save.` and
   `Written through kb_memoize.`, both in the agent's own store
   (`agent-<id>`).
7. `mt` as in step 2 for both names (same handler; the unit test
   `tests/tools/memory-aliases.test.ts` asserts the two results are equal).
8. Both runs print
   `mcp__slaude_kb__kb_memoize,mcp__slaude_kb__memory_save`.
9. The first grep prints nothing. The second grep prints `memory_*` names in
   every file.
10. Brain enabled: `memory_about memory_get memory_graph memory_list
    memory_save memory_search memory_search_stores memory_stores memory_think
    memory_thread_history`. Brain disabled: `memory_save memory_search
    memory_search_stores memory_stores memory_think`. No `kb_*` name, no
    `list_kbs` or `search_kbs`. The `kb_*` aliases are still
    offered to the model in the tool list itself (they stay callable), each
    described as `Alias of memory_x (deprecated)`; the prompt text never names
    them.

## Cleanup

As `lead` nothing can delete memory pages from the console (read-only). The
pages live in the scratch brain and go with `rm -rf "$IT"`.

## Notes

- Inside a `/1on1` the default store is the person's own; these steps run in
  a channel turn, so `memory_save` without `target` writes to the agent's own
  store (`agent-<id>`).
- `memory_about` keeps its name; it is not part of the alias table.
- The episodic conversation memory (`src/memory/`, tables `memory_turns` and
  `memory_facts`, node API `/v1/tools/memory/*`) is unchanged by the rebrand.
