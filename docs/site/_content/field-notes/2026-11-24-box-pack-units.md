---
title: "Boxes, phase 5 storage side: pack units, a confined archive reader, and parking"
date: 2026-11-24
---

# Boxes, phase 5 storage side: pack units, a confined archive reader, and parking

**Date:** 2026-11-24
**Status:** Storage, packer and `FsSync` parts done and dark (nothing constructs `FsSync` with a box dependency yet). The worker, dispatch and sweeper parts of phase 5 are not done.
**Plan:** `docs/superpowers/plans/2026-11-24-box-implementation.md`, Phase 5. **Spec:** `docs/superpowers/specs/2026-11-24-box-design.md`, "Durability and sync".

## What exists

- `src/storage/pack-manifest.ts`, `src/storage/pack-sync.ts`: a version 2 manifest (`kind: "pack"`, `layers`), `flushPack` and `hydratePack`. Same rules as the per-file sync: the fence check sits just before the manifest write, an unchanged tree writes nothing, a hydrate clears its marker before it rewrites the local copy. `latestManifest` returns either kind; `latestTreeManifest` is the per-file reader and refuses a pack manifest, so the two formats never share a unit. `gcSession` reads `layers[].hash`.
- `src/box/boxd/pack.ts`: `scan`, `diff`, `create`, `validateListing`, `apply`, `clear`, and `localPacker`, the packer behind the `PackPort` interface that `FsSync` uses. The box supervisor will serve the same interface over its protocol.
- `src/node/fs-sync.ts`: a unit has a kind (`tree` or `pack`); a boxed session is tracked with `wx` and `hm` besides `tx` and `ws`; parking; a pruner.

## Decisions, and why

**The archive is written and read in TypeScript, not by `tar`.** A plain ustar tar with pax records for long names, zstd through the runtime's built-in codec. The reader that lists an archive for validation is the reader that extracts it, so there is no second parser that could see a hostile archive differently from the one that was checked. It also runs the same on macOS (bsdtar) and on a node (GNU tar). The plan's tech stack lists GNU tar and zstd on nodes; neither is needed for packs now.

**A type change always comes with a removal.** `diff` puts a path whose type changed in both lists: removed and changed. `apply` deletes the layer's removed paths first, so it never has to replace one kind of thing with another, and can refuse it: a file where a directory is, a directory where a symlink is, with no removal in the layer, is an error. That one rule covers "a path changing type between layers" and "a symlink from layer 1 used as a directory in layer 2" (the walk to a path checks every parent with `lstat` and refuses anything but a real directory).

**An existing file is unlinked and created anew**, never opened for writing: a later layer cannot write through a hard link or a symlink an earlier one planted. Mode bits above `0o777` are dropped at both ends. Nothing is chowned unless the packer is told an owner.

**Reject or skip.** A hostile archive is rejected. A stored `wx` archive can also meet something the per-file unit put in its way (the workspace now has a file where the extras expect a directory, or the ignore list changed). Rejecting there would make every later hydrate of that session fail. So during a hydrate, a path blocked by something these layers did not write themselves is skipped and counted; what the layers wrote themselves is still an error. Entries outside the unit's filter are skipped too: the extras can never overwrite a workspace file.

**One directory holds the extras of one image at a time.** `wx` is keyed by directory and image, but two sessions on different images in one folder share the same `node_modules` on disk. Left alone, each unit's marker would claim a directory the other had rewritten, and a flush would store one image's files under the other's name. The directory now has a recorded owner. When another image's unit takes it, the owner is flushed, both units' markers and indexes are cleared, and the old image's extras are deleted, so the next hydrate starts from what is stored for that image, or from nothing. Correct, and slow if two such sessions alternate. A directory with no recorded owner is adopted as it is. Giving each image its own directory behind a mount would remove the cost; that is the supervisor's side.

**Compaction compares like with like.** The spec says "more than 1.5 times the live bytes". Layer sizes are compressed and live bytes are not, so each layer also records `rawBytes` and the manifest `liveBytes`, both before compression. Compaction never writes on its own: an unchanged tree stays unwritten.

**Parking is a table, not a state of the session.** `evict` of a boxed session flushes its four units and records the session with its units and their sizes in `parked.json` beside the markers, so a process recreated on the same disk still accounts for what an earlier one left. Trust still comes from the markers alone. The pruner drops the least recently used session above `SLAUDE_BOX_PARK_BUDGET_MB` or while free disk is short, and never one with a flush still owed. A session that lost its lock or a unit to another node is not parked: what can be flushed is, and the copies are deleted.

## A finding: a piped zstd stream stalls on large archives (Bun 1.3.11)

Reading an archive with `createReadStream(path).pipe(createZstdDecompress())` and an async iterator stopped for good on a 100 MB archive once the consumer awaited between reads. The process sat idle with every download finished and nothing applied. 75 MB did not stall, and neither did a reader that never awaited, so no unit test of ordinary size shows it. The 50,000 file load run found it. Both directions now make one `write` at a time, wait for the stream's callback and take output from `data` events. The load script is the regression check; there is no unit test for it.

## Numbers (measured, with limits)

`bun scripts/load/pack-sync.ts --files 50000 --mb 500`, run once on a developer laptop (macOS, the machine busy with other test runs), against the **local directory store**, so no network is in these numbers:

| Step | Seconds |
|---|---|
| First flush (scan, archive, compress, store): 500 MB to a 151.5 MB archive | 15.0 |
| Flush, nothing changed | 0.32 |
| Flush, 10 files edited (a 1.6 KB delta layer) | 0.32 |
| Cold hydrate, 2 layers, 50,000 files | 14.2 |
| Warm hydrate (parked resume) | 0.01 |

The time is file system work, not compression: an uncompressed run took as long. **Not run:** the same script against a real S3-compatible server (`--store s3`), and anything on a Linux node. The spec's estimates stay estimates until that run; these numbers only show the code path completes at this size and where its time goes.

## Not done

- `src/node/worker.ts`: pass `boxOf` and `packer` to `FsSync`; stop the sandbox on `onFenced` and on a lost lock; start it only after `beforeTurn` returns `ok`; set and clear the `parked(sessionId)` key from `onPark`; turn `onQuota` into notices; call `prune()` on a timer with a free-disk reading; pass a park budget of half the box volume; log once when storage is not `s3`.
- `src/queue/keys.ts` (`parked`), `src/gateway/core/dispatch.ts` (prefer the parked node), `src/gateway/core/storage-sweeper.ts` (remove a closed session's `hm` unit).
- The supervisor's protocol for `PackPort`, and where its index and spool directories live under `SLAUDE_BOX_DIR`.
- `tests/integration/box-resume.test.ts`: needs the gVisor driver and the worker wiring; not written.
