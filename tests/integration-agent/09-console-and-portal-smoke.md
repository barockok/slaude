# 09: console and portal smoke

## Purpose

Every console page and every portal page loads, in light and dark, at
1440 px and 390 px wide, without horizontal page scroll, with no uncaught
error in the browser console; navigation works on a phone (the sidebar
becomes an overlay behind the `Open navigation` button); sign out works; the
portal's My agents lists the agents the signed-in person's linked Slack
identities hold a role on.

Code: `src/web/console/App.tsx` (routes and nav labels),
`src/web/portal/App.tsx`, `src/web/ui/AppShell.tsx`, `src/web/ui/theme.ts`
(`data-theme` on `<html>`), `src/web/console/dev/stub.ts`,
`src/gateway/portal/api.ts` (`GET /portal/api/my-agents`), and the existing
Playwright smoke `tests/panel-web/` (`bun run test:web`).

## Setup

- Unit floor: `cd "$REPO" && bun run web:build && bun run test:web`
- Environment C for steps 2 to 7 (`VITE_STUB=1 bun run panel:dev`, base URL
  `http://localhost:5173/panel/` unless Vite prints another port).
- Environment B for steps 8 to 14.
- Browser: Chromium via Playwright, deviceScaleFactor 1. Two viewports:
  desktop 1440x900, phone 390x844.
- The overflow probe, run in the page after it settles:
  `document.documentElement.scrollWidth <= window.innerWidth`
  must be `true`. Collect browser console messages of type `error` per page.

Console pages (paths under `/panel`):

| Nav label | Path | Heading |
|---|---|---|
| Overview | `/` | `Overview` |
| Agents | `/agents` | `Agents` |
| (agent detail) | `/agents/default`, `/agents/default/mandates`, `/agents/default/access`, `/agents/default/activity` | agent name; tabs `Overview`, `Mandates`, `Access`, `Activity` |
| Sessions | `/sessions` | `Sessions` |
| (session detail) | `/sessions/<id>` and `/sessions/<id>/audit` | session; an Audit tab |
| Approvals and audit | `/audit` | `Approvals and audit` |
| Access | `/access` | `Access` |
| Memory | `/memory` | `Memory` |
| Environments | `/environments` | `Environments` |

Portal pages (paths under `/portal`): `My account` `/`, `Integrations`
`/integrations`, `My agents` `/agents`.

## Steps

Environment C (stub):

1. Run the unit floor.
2. For each console path in the table (use the first agent and the first
   session the stub lists for the detail rows), at 1440x900: load it, wait
   for the table or content to replace the skeletons, run the overflow probe,
   take a screenshot `09-c-<page>-1440-light.png`.
3. Switch to dark: open the account menu (`Account: <name>` button), choose
   `Dark`. Confirm `document.documentElement.getAttribute("data-theme") === "dark"`.
   Repeat step 2 for every page with suffix `-1440-dark`.
4. Set the viewport to 390x844 and repeat steps 2 and 3 (`-390-light`, `-390-dark`).
5. At 390 px: click `Open navigation`; the sidebar opens over the page;
   click `Agents`; the overlay closes and the Agents page shows. Screenshot.
6. Open a new tab at `/panel/?stubEmpty=1`: every list page shows its empty
   state (for example the Audit page `No audit events yet`; an agent's Access
   tab `No grants`). Screenshots at 1440.
7. Open a new tab at `/panel/audit?stubFail=audit`: the page shows an error
   state, not a blank page or a stuck skeleton. Then a new tab at
   `/panel/agents?as=operator` and open an agent's Access tab: no `Add grant`
   button. Screenshots.

Environment B (real gateway):

8. Sign in as `lead`. Repeat step 2 for every console page at 1440 light and
   390 dark only (real data). Note any page that differs from the stub run.
9. Theme persistence: choose `Light` in the account menu, reload: `data-theme`
   is `light`. Choose `System`, reload: no `data-theme` attribute.
10. Sign out: account menu, `Sign out`. Then
    `psqlq "SELECT action, actor_id FROM audit_events WHERE action LIKE 'panel.auth.%' ORDER BY id DESC LIMIT 3;"`.
11. Portal link: as Alice, DM the agent `/link`:
    `say ADEFAULT UALICE DUALICE '/link'`; then
    `curl -fsS "$F/calls?method=chat.postEphemeral" | jq -r '.calls[-1].args.text'`.
12. Sign in to the portal as `alice` (`http://localhost:8080/portal/`). Open
    the link URL from step 11 and press its `Connect` button.
13. Give Alice a role she would not have from the soul alone: as `lead` in the
    console, POST `{"subjectKind":"user","subjectId":"UALICE","role":"approver"}`
    to `/panel/api/agents/scout/grants`. As `alice` in the portal, open
    `My agents` (`/portal/agents`) and `GET /portal/api/my-agents`.
14. Portal pages: for `/portal/`, `/portal/integrations`, `/portal/agents`,
    run the overflow probe and take screenshots at 1440 light, 1440 dark,
    390 light and 390 dark (portal account menu, same theme items).

## Expected observations

1. `web:build` succeeds; the Playwright smoke passes.
2. Every page renders its heading; overflow probe `true`; no console errors.
3. `data-theme` is `dark`; every page renders with the dark page background;
   probe `true`.
4. Same at 390 px; tables scroll inside their own container if needed, never
   the page.
5. The overlay opens and closes; navigation works.
6. Empty states render; no errors.
7. An error state with a message; the operator view has no `Add grant`.
8. Same as 2 with real data.
9. As described.
10. The browser leaves the console (`POST /panel/auth/logout`, then
    `/panel/auth/login`, which goes to Keycloak; if Keycloak still has a
    session it signs straight back in, which is expected). The audit rows
    include `panel.auth.logout | lead@example.com`.
11. An ephemeral whose text starts `:link: Connect your account: http://localhost:8080/portal/link?t=`
    and contains `The link expires in 15 minutes.`
12. The page `Connect your account` shows `Workspace` `TDEV` and
    `Slack user` `UALICE`; after `Connect` the status line reads
    `Connected. You can close this page.` and the button is disabled;
    `GET /portal/api/me` lists the identity `TDEV` / `UALICE`.
13. `200`; `agents` is exactly
    `[{ persona: "scout", teamId: "TDEV", slackUserId: "UALICE", role: "approver" }]`.
    `default` is absent: My agents counts user-level roles only, and Alice
    reaches the default agent only through channel grants
    (`src/gateway/portal/my-agents.ts`). The page lists the same agent and role.
14. Every portal page renders; probe `true`; no console errors.

## Cleanup

As `lead`, revoke the `scout` grant for `UALICE`. Unlink Alice's identity in
the portal (`My account`, the unlink action) if later scenarios need an
unlinked account. Close the browser.

## Notes

- Portal pages may still be placeholders while the portal task is in
  progress; a placeholder page that loads cleanly is a PASS for the smoke
  steps, and My agents data is checked through the API (step 13).
- The stub keeps its URL switches in `sessionStorage`, so open a new tab for
  each switch, or they leak into later steps.
