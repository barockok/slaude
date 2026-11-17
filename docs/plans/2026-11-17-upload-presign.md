# Slack upload from a node: Slack's own presigned URL (issue 200)

> For Claude: use superpowers:executing-plans, task by task.

Goal: an agent on a node uploads a file it created locally to Slack, and the bytes go from the node straight to Slack. The gateway never reads a node path and never carries the bytes. Task 1 also closes a file-read hole that exists today.

## What is wrong today

`upload` on a node is forwarded verbatim (`src/node/shims/index.ts`, `postTool`) to `POST /v1/tools/surface/upload`. The gateway handler (`src/gateway/core/surface-mcp.ts`) calls `SlackSurface.upload` (`src/gateway/slack/surface.ts`), which does `statSync(path)` and `createReadStream(path)` on the GATEWAY.

1. Defect (issue 200): a node path that is not visible on the gateway fails.
2. Hole (found in review): a path that IS visible on the gateway is read and posted to Slack. A node agent, or prompt-injected text, can name `/proc/self/environ` or a file under the gateway's data dir and the gateway uploads its own secrets. On the live box the worker and gateway likely share a data volume, so real workspace uploads may work today; a blanket refusal could break them. Confirmed by reading the code; not exercised on the live box.

## Observed on the live box after rc.26 (smoke test)

Asked to create a file and upload it, the agent reported that the upload was refused because the session working directory is root-owned and not writable from the worker. Checked on the box (read-only):

- Session working directories are created by the gateway as `root:root` mode 755 and mounted into the worker, which runs as uid 10001. The agent cannot write into its own session working directory (verified for the channel-session folder `agent-<id>/proactive/channels/<channel>` and for per-thread folders). Only `/data/workspaces` itself is owned by 10001.
- So Task 1's confinement is correct (refused, with a clear message) but on this topology it leaves a node agent with NO path it can both write and upload. Whether uploads worked before rc.26 for some path under `/data/workspaces` cannot be told from the retained log (three upload calls, all from this smoke test).
- Consequence for the node read guard below: "under the session working directory" is the wrong root on a node. The guard's allowed roots must be where the agent can actually write: the session working directory (when writable) plus a per-session writable scratch area, to be defined (for example a `scratch` folder the worker creates under its own writable data path, or the agent's `$TMPDIR`). The refusal text must name the allowed places, not only the working directory.
- This is a second reason the Slack-direct flow is the right fix: the file never has to be visible to the gateway at all.

## Live Slack checks (done, 2026-11-17, from the box, tiny payloads, no message posted)

Run inside the gateway container (bot token from the database, never printed) with the bytes POSTed from the worker container. Test files were completed without a channel (private) and deleted afterwards.

- The worker reaches Slack's upload host (`files.slack.com`) and can POST bytes there: yes.
- Request form: a raw body (`Content-Type: application/octet-stream`, `curl --data-binary`) works (`OK - <n>`, HTTP 200); multipart also works. The node uses the raw form with a streamed body and `Content-Length`.
- Declared length: a body LONGER than declared is accepted and truncated to the declared length (stored size = declared); a body SHORTER than declared fails with HTTP 500 (`s3_upload`). So Slack bounds the stored size by the declared size, and our cap can be enforced at begin.
- The upload URL is NOT single use: a second POST to the same URL returned 200 again. Expiry not measured. It is a bearer for that one file until it expires; the file is private until completed.
- `files.completeUploadExternal` does NOT verify the bytes: it succeeded for the short-body upload that had returned 500, and for a file id whose bytes were never sent (size reported as the declared size). Completing the same id twice returned the same file without error (without a channel; whether a second complete with a channel posts twice is untested). Consequence: the NODE must check Slack's POST response (HTTP 200 and `OK - <declared size>`) before it calls complete; the gateway cannot verify bytes. A node that completes without uploading can only post an empty file into its own conversation.
- `getUploadURLExternal` accepted declared lengths up to 5 GB, so Slack does not enforce its per-file maximum at that step. Slack's documented limit is the number to use as the default cap; a huge upload was not attempted. Our cap is enforced at begin and, because Slack truncates, it cannot be exceeded by lying in the body.
- Unverified still: the URL's expiry, what Slack does with an upload that is never completed, and a second complete with a channel.

## Design: Slack's three-call upload, split across gateway and node

Slack's v2 upload (`@slack/web-api` 7.15.2, `filesUploadV2` in `WebClient.js`) is `files.getUploadURLExternal` (filename, length, optional `alt_text`) giving a presigned `upload_url` and a `file_id`, then the bytes sent to `upload_url`, then `files.completeUploadExternal` (channel, thread, caption, title). The outbound choke point already registers both names (`src/gateway/slack/outbound.ts`). We split the same calls:

1. `upload_begin` (gateway, REST tool plane): input `{filename, size, alt_text?}`. The gateway validates, enforces `SLAUDE_UPLOAD_MAX_BYTES` (default: the largest single upload Slack allows, believed to be 1 GB, confirmed live before shipping), calls `files.getUploadURLExternal` with the persona's client, and returns `{uploadUrl, fileId, handle}`. `handle` is an HMAC-signed opaque value with `typ: "upload"` (the job verifier refuses any `typ`, so a handle cannot pass as a job token; the reverse check is new code and tested). Claims: tenant, persona, session, team, channel, thread, `post`, app, label, runAs, fileId, filename, size, `alt_text`. The destination is the BEGIN turn's (on a channel session a root turn posts at the root while `thread` holds the turn's own ts, so `post` is in the handle). Its expiry is its own 10 minutes, not the job token's (the job token refreshes every 15 minutes and the node holds a fresh one at complete). At complete, the handle's tenant, persona and session must equal the caller's job claims.
2. The node sends the bytes straight to `uploadUrl`. The SDK does a POST with multipart form data; whether a raw-body POST (`curl --data-binary`) is accepted is unverified, so the recipe says "POST" and the live check below decides the form.
3. `upload_complete` (gateway, REST tool plane): input `{handle, title?, initial_comment?}`. The gateway verifies the handle and calls `files.completeUploadExternal` through the existing outbound path (`deliver()` for the caption), channel and thread from the handle, never from the node's body. Returns `{ok, file_id}`.

Both tools are `restOnly` in the contract (`src/tools/contracts/types.ts`): the shim mounts every non-`restOnly` contract tool, so otherwise the model could call `upload_begin` itself, receive Slack's URL and `curl` any file its shell can read, bypassing the node read guard. The agent-facing `upload` tool keeps its schema (`path`, `title`, `initial_comment`, `alt_text`); on a node the proxy runs begin, POST and complete as one tool call and the agent never sees the URL.

### Why this is better than proxying through the gateway

No second token audience, no single-use ledger, no migration, no temp files, no gateway body limit, no replica question (the handle is stateless). Replaying `upload_complete` can only post the same file again to a conversation the holder already writes to; whether Slack accepts a second complete for one file id is unverified. The audit size and `slaude_upload_bytes_total` are the DECLARED size, since the gateway never sees the bytes.

### Caption hold (simplified after review)

`deliver()` judges the caption and may hold it for an approval card; it is one blocking await with no "open a card and return an id" seam, and the pending kinds are fixed (`perm`, `approval`, `mcp_connect`). So the judgement stays in `upload_complete`, exactly where it is today for a caption. No bytes are in flight at that moment (Slack already has them). `postTool` already uses `noTimeout: true` and `retry: false`, so the node neither times out nor retries during a held caption. On a denial the Slack upload is never completed; what Slack does with it is unverified (expected: garbage collected). `alt_text` moves to begin because Slack takes it at `getUploadURLExternal`, not at complete.

### Remote environments

With `/env` the agent's files live on the user's machine (`src/remote/mcp.ts` aliases only Bash, Read, Write, Edit, Glob and Grep; `upload` is not aliased). A node-side `upload` with a path on a remote turn is refused from `claims.remote` BEFORE any local stat (never "file not found on this node" for a remote path), with a message that points at the recipe. For the recipe a separate pair of agent-facing tools is exposed only when `claims.remote` is present: they return the URL to the model, so it is in the transcript and possibly in the Bash status line, and we rely on Slack's single use and expiry (both unverified) and say so. The node read guard prevents mistakes; it is not a security boundary against an agent that has Bash on the same node, and the docs say that plainly.

### Node-side read guard

Only a regular file whose `realpath` is under an allowed root (the session working directory when writable, plus a per-session writable scratch area; see the live observation above); open once, `fstat` the descriptor, stream from that descriptor, and fail if the byte count differs from the declared size. `ShimDeps` needs a working-directory accessor (the session store has it). Missing file: `file not found on this node: <path>`.

### Task 1 (ships first, as PR 223): confine gateway-side path uploads

`SlackSurface.upload` and the dead legacy `slackHandlers.upload` (no contract entry, no caller; deleted) are confined: the working directory comes from the gateway's session row (`Sessions.findById(claims.session).working_dir`, the same absolute string the node uses as `cwd`, so the live shared-volume topology keeps working wherever the volume is mounted at the same path, as both compose files do). The path's realpath must be a regular file inside the realpath of that directory; open once with `O_NOFOLLOW`, `fstat` the descriptor, re-check the inode and prefix after the open, stream from the descriptor. Fail closed when the directory is unknown. Consequences to note: a mono upload from `/tmp` or another scratch directory is refused (the message should tell the agent to copy the file into its working directory: a small follow-up), and a proactive session's confinement root is its shared `agent-<id>/proactive` folder. Parent-directory swap in the instant before the open is narrowed, not eliminated (no `RESOLVE_BENEATH` in Bun).

### Co-located memory bound

`uploadV2` reads a stream fully into memory (`file-upload.js`). With the cap defaulting to Slack's maximum, a mono or shared-volume upload could allocate that much in the gateway. The co-located path gets a much lower default (100 MB, `SLAUDE_UPLOAD_COLOCATED_MAX_BYTES`), or moves to the three calls with a streamed body.

## Compatibility

- Old node, new gateway: keeps sending `path`; it works while the path is inside the session working dir on the gateway (shared volume) and is refused clearly otherwise. No capability needed.
- New node, older gateway: `upload_begin` is not served; `postTool` returns `isError` "tool unavailable" (it does not throw), the node falls back once to the old call and logs it. A new gateway also 404s for a surface without the upload capability; log that distinctly.
- Routes: place before the generic `/v1/tools/:server/:tool` route; both tools in the surface contract and through `executeToolCall` (Zod validation, wake allow-list, metric). A wake or heartbeat cannot mint: the allow-list is default-deny by name, so the new names are simply not added.
- Surface: build through `deps.slackCtx` and `deps.surfaceFor`, with the handle's claims checked against the job claims; add the names to `VOICE_QUIET_TOOLS` if they ever become agent-facing; the Stop guard still counts an upload as a reply.

## Safety

- Slack's `uploadUrl` and the handle are credentials for one file: never logged, never in an audit event or the tool-result echo, redacted in the status line (except the remote recipe, above).
- Filename: `basename`, control characters stripped, length capped. Title and alt text go through the outbound rules (a captionless upload skips `deliver()` today, so title and filename are unguarded; decided in task 4).
- Per-session rate limit on begin (10 per minute) in Redis (per replica in memory otherwise; stated), metrics `slaude_upload_total{result}`, audit `surface.upload` with channel, declared size, filename.

## Tasks, in order

1. Confine path uploads (PR 223, rc.26, deployed). Follow-up: a refusal text that names the allowed places, since the session working directory is not writable by a node agent on the live topology.
2. Live Slack checks: DONE (see the section above). Design adjustments: raw POST with `Content-Length`; the node verifies Slack's `OK - <n>` response before complete; the URL is replayable until it expires, so it is treated as a bearer credential.
3. `SlackSurface`: `filename` parameter, file id return, the three Slack calls as separate methods (`uploadV2` kept for co-located); the co-located cap.
4. Handle module (`typ: "upload"`): sign, verify, own expiry, equality with the job claims, `post` and label; tests both directions (handle refused as a job token and a job token refused as a handle), tamper, wrong session, a begin near job-token expiry with a refreshed token at complete, a channel-session root turn's destination.
5. `upload_begin` and `upload_complete` as `restOnly` contract tools through `executeToolCall`; size cap, rate limit; tests: wake refusal, voice-quiet, a held caption approved and denied (node does not time out, no duplicate), the model cannot see the pair on a plain node session, caption changed between calls cannot happen (caption only at complete).
6. Node: shim intercept beside `request_approval` (`src/node/shims/index.ts`, after the voice-quiet check; not `postTool`), `ShimDeps` working-directory accessor, the read guard, the POST to Slack with a file stream and no timeout, the older-gateway fallback matching `postTool`'s error shape, the remote-turn refusal before any stat; sim tests with a fake Slack upload host that hashes the received bytes: a missing file, a swapped file, an oversize file, Slack failing mid-stream, a remote turn with a path, a zero-byte file, unicode and overlong filenames, disk irrelevant (no temp files).
7. Remote recipe pair (only with `claims.remote`), metrics, audit, redaction, docs (including the honest read-guard statement), field note, release candidate.

## Verification

- Sim: gateway plus two node workers; a file made on a node reaches the fake Slack with identical bytes.
- Live smoke on the box (gateway plus worker): the agent creates a file in its workspace and uploads it to a channel; the file appears with the right bytes; no URL in any log line.
- RC rule: backup, deploy through vps-hardening, `verify` 0 FAIL, smoke in Slack.

## Decisions taken

- Fix first, as its own release candidate (done: PR 223).
- Cap: as large as Slack allows for a single upload; a lower deployment cap stays configurable; co-located path capped lower.
- Direct-to-Slack flow, stateless handle, no ledger.

## Open questions

- Title through the outbound rules (it is not today)?
- Remote-environment `upload` with a path: refuse with the recipe, or read over the remote exec transport?
