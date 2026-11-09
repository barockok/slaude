---
title: "Skill version log: the database records what the files were, the files stay the authority"
date: 2026-11-09
---

# Skill version log: the database records what the files were, the files stay the authority

**Date:** 2026-11-09
**Status:** On branch `feat/skill-versions`.

## Mechanism

Skills stay files on disk, and the runtime still reads only those. The
gateway or mono process (a node has no database) writes a log to
`skill_versions`: one row per skill identity and version, where the identity
is the root (`global` for the shared base, the persona name for an overlay)
plus the slug.

`reconcileSkillVersions` (`src/skills/versions.ts`) walks every skill root and
fingerprints each skill: a sha256 over every file's relative path and bytes in
sorted order. A new row is written only when that hash differs from the
identity's latest row. It runs at start, every
`SLAUDE_SKILL_VERSION_RECONCILE_MINUTES` (default 5), and for one skill right
after `write_skill`, retire or restore. A retire captures from the retired
copy, so the last edit before it still reaches the log. Rows are never updated
or deleted, so a retired skill or a deleted file keeps its history.

## Decisions

- **Nothing is followed.** A symlink counts by its target text, a symlinked
  skill directory or `SKILL.md` is not recorded, and files are opened with
  `O_NOFOLLOW`, the same caution as the console's read.
- **A partial hash is worse than none.** A skill with an unreadable file is
  skipped for the pass, logged by slug and error code only. The rest continue.
- **Tool state is not content.** `.git` and `__pycache__` are left out, so
  running a skill's script does not create a version.
- **Replicas write the same log.** The version is `latest + 1` with
  `ON CONFLICT DO NOTHING`. The loser re-reads the latest row and decides
  again: the same content means nothing to do, other content takes the next
  number.
- **Captures run one at a time in a process**, each reading the disk when its
  turn comes, so two quick writes cannot be logged in the wrong order.
- **Text is capped, the hash is not.** `SKILL.md` is kept up to the 256 KB the
  console reads, with a truncated flag. The hash covers the whole tree.
