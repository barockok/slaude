---
title: "Direct Slack upload: the node sends the bytes, the gateway never carries them"
date: 2026-11-17
---

# Direct Slack upload: the node sends the bytes, the gateway never carries them

**Date:** 2026-11-17

## Problem

A node forwarded the agent's `upload` call to the gateway, which read the path
on its own filesystem. That failed for any file the gateway could not see, and
(before rc.26) it let an agent make the gateway upload files that were never the
agent's. Confining the read to the session working directory fixed the second
problem and exposed a third: that directory is created by the gateway and can be
owned by another user than the node's, so a node agent had no path it could both
write and upload.

## Mechanism

Slack's v2 upload is three calls: `files.getUploadURLExternal` (name, length,
optional alt text) returns a presigned `upload_url` and a `file_id`; the bytes go
to that URL; `files.completeUploadExternal` (channel, thread, caption, title)
finishes it. The upload is split across the two processes:

1. **`upload_begin` (gateway).** Input: file name, declared size, alt text. The
   gateway cleans the name (base name, control characters removed, length
   capped), enforces `SLAUDE_UPLOAD_MAX_BYTES`, applies a per-session limit of 10
   a minute, calls `getUploadURLExternal` with the persona's own Slack client, and
   returns the URL, the file id and a handle.
2. **The bytes (node).** The node POSTs the file to the URL as a raw body
   (`Content-Type: application/octet-stream`, `Content-Length` set), streamed from
   the descriptor it opened and checked, with no timeout but the turn's own stop.
   It then checks Slack's answer: HTTP 200 and a body of `OK - <n>` with `n` the
   declared size. Anything else is an error and complete is not called.
3. **`upload_complete` (gateway).** Input: the handle, a title, a caption. The
   gateway verifies the handle, judges the caption through the outbound choke
   point (`deliver`, so the owner's reply rules can redact, refuse or hold it) and
   calls `completeUploadExternal`.

Both tools are `restOnly` contract tools: the node shim mounts every other
contract tool, and a model that could call `upload_begin` would receive Slack's
URL and could send any file its shell can read, past the node's read guard. They
go through `executeToolCall`, so validation, the wake allow-list (default deny by
name, so a wake or heartbeat cannot start an upload), the call metric and the
label gate all apply.

**The handle** is a value signed with the job secret and a payload `typ` of
`upload`. The job-token verifier refuses any token with a `typ`, and the handle
verifier requires it, so neither passes as the other. It carries the tenant,
persona, session, workspace, channel, thread, whether the post goes to the channel
root (`post`), the Slack app, label, run-as identity, file id, name, declared size
and alt text, and expires after ten minutes on its own (not capped by the job
token, which refreshes every 15). At complete its tenant, persona and session must
equal the caller's job claims, and the destination is read from the handle, never
from the request body.

**The node's read guard.** An `upload` on a node is refused first when the turn
runs in a remote environment (the file is on the user's machine). Otherwise the
path must resolve to a regular file under the session working directory or the
session's scratch directory. The file is opened once with `O_NOFOLLOW`, checked
with `fstat` on the descriptor, and streamed from it; the declared size is the
descriptor's size, the stream is cut at that size, and a file that ends early
fails the transfer. A path swapped after the open cannot change what is sent.

**The scratch directory.** On a typical deployment the worker's user cannot write
the working directory, but can write the temp area. Each session gets a private
(0700) directory there, given to the agent as `$TMPDIR` and `$SLAUDE_SCRATCH`
and removed with the session. The whole of `/tmp` is not allowed, because it is
shared by every session on the worker. Setting `TMPDIR` for the agent only adds a
path under the temp area, and the child-env scrub strips nothing it needs.

## What Slack does (measured, small payloads, no message posted)

- A raw body (`curl --data-binary`) is accepted and answered with HTTP 200 and
  `OK - <n>`; multipart also works.
- A body longer than the declared length is accepted and truncated to the
  declared length; a body shorter than declared fails with HTTP 500.
- The upload URL is not single use: a second POST to the same URL returned 200.
  It is a bearer for that one file until it expires.
- `files.completeUploadExternal` does not verify the bytes: it succeeded for an
  upload whose body was short and answered 500, and for a file id whose bytes
  were never sent. The node's check of Slack's answer is the only verification.
  Completing the same id twice returned the same file.
- `files.getUploadURLExternal` accepted declared lengths up to 5 GB, so Slack's
  per-file maximum is not enforced at begin. The cap is ours, enforced at begin;
  because Slack truncates to the declared length, it cannot be exceeded by
  lying in the body.
- Not measured: the URL's expiry, what Slack does with an upload that is never
  completed, and a second complete with a channel (it may post twice).

## Decisions and limits

- The caption is judged inside `upload_complete`, after the bytes are already at
  Slack, because the hold waits on one blocking call with no way to return a card
  id. The node neither retries nor times out during the wait. A denied caption
  means the upload is never completed.
- The title, file name and alt text are not run through the reply rules, as in
  the co-located path (a captionless upload never called the choke point). The
  file name is cleaned. A held title would raise a second card for one file.
- The audit size and the metric size are declared sizes.
- The gateway cannot tell a node that completes without sending bytes: that node
  can only post an empty file into its own conversation.
- The per-session limiter is in Redis on a gateway and in memory otherwise, and
  falls back to memory for a call when Redis errors.
- The read guard is not a boundary against an agent with a shell on the same node.
- An older gateway does not serve `upload_begin`; a new node falls back to the
  path call once and logs it. An old node against a new gateway keeps the rc.26
  behaviour.
- The upload URL is checked against an exact host list (default `files.slack.com`, https) by the gateway at begin and again by the node, and redirects are not followed, so a wrong URL never receives bytes.
- A session the console holds is refused at begin ("upload not sent", result `suppressed`), so no Slack call or allowance is spent; a hold that starts between begin and complete is reported the same way and is not audited.
- A scratch directory that cannot be made does not stop the session: it boots without `TMPDIR`, with one log line, and uploads read from the working directory only. Scratch files do not survive a cold resume or a move to another node; stale scratch roots from a crashed worker are swept (older than a day, same owner) at the next start.
- The handle holds only the destination, file id, name and declared size, so a maximal alt text cannot push it past the complete input cap. A handle is not bound to one turn: another turn of the same session can complete it, into the begin turn's destination, within its ten minutes. Completing twice posts twice (not guarded).
- The per-session limiter gives up on Redis after 500 ms and uses its in-process count.
