---
title: "Upload path confinement: the tool read whatever path it was given"
date: 2026-11-17
---

# Upload path confinement: the tool read whatever path it was given

**Date:** 2026-11-17

## Problem

The agent's `upload` tool takes an absolute path. A node forwards the call
unchanged to `POST /v1/tools/surface/upload`, and the gateway's Slack surface
opened that path on the gateway's own filesystem and posted the bytes to
Slack. In a single-process (mono) deployment the same code ran in process. The
tool description said "an absolute path under the session working dir", but
nothing enforced it. Any path the gateway process could read was uploaded: a
process file such as `/proc/self/environ`, or a file under the gateway's data
directory. The caller is a model that reads untrusted text, so the path is
attacker influenced.

## Fix

The check is on the resolved file, not the string:

1. The surface asks its binding for the session's working directory. The
   gateway answers from the session row (`working_dir`), which it created for
   the thread. A node-claimed session has the same row: the node reads it
   through `/v1/sessions` and does not create one. No session id, no row, or a
   failed lookup gives no folder, and an upload with no folder is refused.
2. The supplied path must be absolute. Its realpath must be inside the realpath
   of the folder (compared with a separator, so `work-evil` is not inside
   `work`). That rejects `..` traversal and symlinks, or symlinked directories,
   that leave the folder, and accepts a symlink that stays inside.
3. The file is opened once (read only, non-blocking so a FIFO cannot hang the
   call, no-follow on the final component), and `fstat` on the descriptor must
   say regular file. The upload streams from that descriptor, never from the
   path again. After the open the path is resolved once more and must still
   name the same inode inside the folder, which narrows a swap of a parent
   directory between the first check and the open.
4. A refusal says `upload refused: <name> is not a regular file under this
   session's working directory`, with the base name only. The same text is used
   for every cause, so a probe learns nothing about what exists elsewhere. The
   tool plane returns it as a tool error (HTTP 200 with `isError`), not a 500.

Where the worker and the gateway share a data volume the session folder is the
same path on both, so a legitimate upload from the workspace is unchanged. A
worker whose folder is not visible to the gateway is refused (the file cannot
be resolved), which is the safe outcome; uploading from such a worker needs a
different design that does not read the node's path on the gateway.

## Also

The deprecated `slackHandlers.upload` had no contract entry, no tool-plane case
and no registration, so nothing could call it. It is deleted with its tests
rather than confined. Other places that open a path an agent names were
reviewed and are not changed here: skill tools take a validated slug under the
skills root, and attachments are written (not read) under the session folder.
