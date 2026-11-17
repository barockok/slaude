# 08: memory console

## Purpose

The console's Memory page is read-only browsing of the memory stores (brain
sources): the store list with page counts and kinds, a store's pages, one
page with content, type, tags and links. Personal (`user-*`) and profile
(`profile-*`) stores hold what one person told an agent: an operator does not
see them in the list and gets `403` on their pages; a superadmin sees them,
and every private page a superadmin opens writes a `memory.page.viewed` audit
row (no content in it). With the brain disabled or remote the API answers
`503` with a reason.

Code: `src/gateway/panel/api.ts` (`GET /panel/api/memory/stores`,
`GET /panel/api/memory/stores/:id/pages?cursor&limit`,
`GET /panel/api/memory/pages?store=&slug=`), `src/knowledge/memory-browse.ts`,
`src/knowledge/scope.ts` (`storeKind`), `src/web/console/pages/memory/`.

## Setup

- Unit floor: `bun test tests/panel/console-memory.test.ts tests/knowledge/memory-browse.test.ts`
- Environment B with the brain enabled (do not set `SLAUDE_BRAIN_DISABLED`).
  The brain is embedded (PGLite under `$SLAUDE_HOME/brain`) and single
  writer: stop the gateway before seeding, start it again after.
- Seed pages (gateway stopped, same shell environment as the gateway):

```sh
cat > "$IT/seed-memory.ts" <<EOF
const { brainCall, closeBrain, ensureSources, getBrain } = await import("$REPO/src/knowledge/brain.ts");
const scope = (s: string) => ({ clientId: "it", sourceId: s, allowedSources: [s] });
await getBrain();
await ensureSources(["user-ualice", "profile-tdev-ualice"]);
await brainCall("put_page", { slug: "notes/it-shared-a", content: "---\ntype: note\ntags: [it]\n---\nShared integration test page. See [B](notes/it-shared-b)." }, scope("shared"));
await brainCall("put_page", { slug: "notes/it-shared-b", content: "---\ntype: note\n---\nSecond shared integration test page." }, scope("shared"));
await brainCall("add_link", { from: "notes/it-shared-a", to: "notes/it-shared-b", link_type: "see_also", context: "integration test" }, scope("shared"));
await brainCall("put_page", { slug: "notes/it-personal", content: "Personal integration test page." }, scope("user-ualice"));
await brainCall("put_page", { slug: "notes/it-profile", content: "Profile integration test page." }, scope("profile-tdev-ualice"));
await closeBrain();
process.exit(0);
EOF
# stop the gateway (kill its pid), then:
bun "$IT/seed-memory.ts"      # the first run applies the brain's migrations (about 110 lines of output)
# start the gateway again as in README B5
```

## Steps

1. Run the unit floor.
2. As `lead` (superadmin): `GET /panel/api/memory/stores`.
3. As `lead`: open `http://localhost:8080/panel/memory`. Screenshot.
4. Open the `Shared` store (`/panel/memory/shared`). Screenshot.
5. Open `notes/it-shared-a` (`/panel/memory/shared/page?slug=notes%2Fit-shared-a`). Screenshot.
6. `GET /panel/api/memory/stores/shared/pages?limit=1` then the same with the returned `nextCursor`.
7. `GET /panel/api/memory/pages?store=shared&slug=notes/it-shared-a` and count
   `psqlq "SELECT COUNT(*) FROM audit_events WHERE action='memory.page.viewed';"` before and after.
8. As `lead`: `GET /panel/api/memory/pages?store=user-ualice&slug=notes/it-personal`,
   then open `/panel/memory/user-ualice/page?slug=notes%2Fit-personal`. Screenshot.
9. `psqlq "SELECT action, actor_kind, actor_id, target_kind, target_id, summary, details::text FROM audit_events WHERE action='memory.page.viewed' ORDER BY id DESC LIMIT 2;"`
10. Sign out; sign in as `alice` (operator). `GET /panel/api/memory/stores`.
11. As `alice`: `GET /panel/api/memory/stores/user-ualice/pages`,
    `GET /panel/api/memory/pages?store=user-ualice&slug=notes/it-personal`,
    `GET /panel/api/memory/pages?store=profile-tdev-ualice&slug=notes/it-profile`.
12. As `alice`: open `/panel/memory` and `/panel/memory/user-ualice`. Screenshots.
13. `psqlq "SELECT action, actor_id, decision FROM audit_events WHERE actor_id='alice@example.com' AND action='panel.memory.private' ORDER BY id DESC LIMIT 3;"`
14. Validation: `GET /panel/api/memory/stores/NOT_VALID/pages` and
    `GET /panel/api/memory/pages?store=shared&slug=notes/does-not-exist`.
15. Read-only: `POST /panel/api/memory/stores` with `x-panel-csrf: 1`.

## Expected observations

1. All pass.
2. `200`; `stores` includes `{ id: "shared", kind: "shared", label: "Shared", pageCount: 2 }`,
   `{ id: "user-ualice", kind: "personal", label: "Personal: ualice", pageCount: 1 }`,
   `{ id: "profile-tdev-ualice", kind: "profile", label: "Profile", pageCount: 1 }`,
   and `{ id: "public", kind: "public", label: "Public", ... }`. An `agent-*`
   store may also be listed (`Agent mind: default` when it maps to the default persona).
3. Page title `Memory`; each store with its label, kind and page count; the
   personal and profile stores carry the private marker (hover title
   `Only superadmins can open this store, and every page they open is recorded in the audit trail.`).
4. A table labelled `Pages in Shared` with `notes/it-shared-a` and `notes/it-shared-b`.
5. Cards `Content` (the body text), `About` (with `Slug` `notes/it-shared-a`),
   `Links` (one link to `notes/it-shared-b`, type `see_also`), and the tag `it`.
   No audit description under the title (shared is not private).
6. First page: one item and `nextCursor` `"1"`; second page: the other item and `nextCursor` `null`.
7. `200` with `store`, `slug`, `type`, `title`, `content`, `tags`, `links`; the
   `memory.page.viewed` count does not change (shared reads are not audited).
8. `200`; the page view's header description reads
   `Opening this page was recorded in the audit trail.`
9. Two rows (API read and page view), each
   `memory.page.viewed | operator | lead@example.com | memory_page | user-ualice/notes/it-personal | viewed a personal memory page`
   with details `{"store":"user-ualice","slug":"notes/it-personal","storeKind":"personal","operatorRole":"superadmin"}`;
   no page content in summary or details.
10. `200`; no store with kind `personal` or `profile` in the list.
11. Each `403` with `{"error":"action 'memory.private' requires the superadmin role","required":"superadmin"}`.
12. The stores page lists no private store. The direct URL to `user-ualice`
    shows the empty state `This store is private` with
    `Personal and profile stores hold what one person told an agent. Only superadmins can open them, and each page they open is recorded in the audit trail.`
13. At least three rows `panel.memory.private | alice@example.com | refused` (step 11, plus any the pages of step 12 requested).
14. `422` `{"error":"invalid store id"}` (store ids are `[a-z0-9-]{1,32}`), and
    `404` `{"error":"no such page in that store"}`.
15. `405` `{"error":"method not allowed"}`.

## Cleanup

The seeded pages stay in the scratch brain and go with `rm -rf "$IT"`. Audit
rows stay.

## Notes

- The seed script was run once while writing this file against a fresh
  brain: it produced exactly the stores and counts in expectation 2 (plus a
  `default` source of kind `other` with 0 pages, which the console may list
  with its id as label).
- The store id for a person is `user-` plus the lower-cased Slack id; a
  profile store is `profile-<team>-<user>` lower-cased (`src/knowledge/scope.ts`).
- If step 2 answers `503`, the brain is disabled or remote in this process:
  the body names which; report the scenario BLOCKED.
