# Release candidate pipeline

**Date:** 2026-08-23
**Status:** shipped

## Context

Releases went straight from `main` to a stable `vX.Y.Z` tag. Anything that broke
the install path broke it for every user at once, and the only recovery was a
follow-up patch release. We wanted a soak stage.

## What already worked

`release.yml` had `prerelease: ${{ contains(github.ref_name, '-') }}` — a tag with
a hyphen already published as a GitHub pre-release. And `install.sh` resolves the
version from `releases/latest`, which GitHub *excludes pre-releases from*. So the
"don't hand an RC to normal users" half was free: no new workflow, no new trigger.

The gap was everything around it.

## Three latent bugs the RC path exposed

Cutting a fake `0.41.0-rc.1` locally surfaced bugs that had been dormant because
no version string had ever contained a non-numeric character.

1. **`tests/installer/smoke.sh` version parse.** Used
   `sed -E 's/.*"([0-9.]+)".*/\1/'`. On `"version": "0.41.0-rc.1"` there is no
   `"`-delimited run of pure `[0-9.]`, so the pattern **did not match at all** and
   sed passed the line through unchanged — `VERSION` became the whole JSON line.
   A silent no-match, not an error. Fixed to the capture `package-release.sh`
   already used: `s/.*"version": *"([^"]+)".*/\1/`.

2. **`src/cli/dist.ts` `SEMVER = /^\d+\.\d+\.\d+$/`.** This gates
   `currentVersion()`, `installedVersions()`, `previousVersion()`, and
   `pruneVersions()`. An installed RC failed the test, so `slaude version`
   reported `(none)` and rollback/prune could not see the directory. An RC was
   installable but not *operable* — precisely the thing an RC is supposed to
   prove. Regex widened to accept a prerelease suffix, and `cmpSemver` extended
   to sort per spec: prerelease below its own stable, numeric identifiers
   compared numerically so `rc.10 > rc.2`.

3. **Tag / `package.json` drift was unguarded.** `install.sh` builds the asset URL
   from the *tag*; `package-release.sh` names the tarball from *`package.json`*.
   Disagreement ships a release whose download 404s, and nothing checked. Added a
   fail-fast step at the top of `release.yml`.

The lesson: the RC pipeline paid for itself before its first real RC. A format
that has only ever been exercised with one shape (`\d+\.\d+\.\d+`) accumulates
parsers that assume that shape, and a *silent* non-match is the common failure —
neither the sed nor the regex threw.

## What shipped

- `scripts/promote-rc.sh` — strips `-rc.N`, bumps `package.json`, commits, tags,
  pushes. Refuses unless: tag is well-formed, RC tag exists, stable tag does not,
  clean `main`, RC is an ancestor of HEAD, stable notes file exists. Prints
  commits that landed after the RC (those would ship unsoaked). `--dry-run`.
- `release.yml` — tag/version guard; installer smoke test against the packaged
  tarball on every tag (`ci.yml` only smoked on main/PRs, so tag builds shipped
  the install path unverified).
- `dist.ts` prerelease-aware version handling + test coverage.
- Flow documented in `CLAUDE.md` and `.claude/skills/release-prep/SKILL.md`.

## Deliberately not done

- **No auto-promotion on a soak timer.** Promotion is a judgment call; the script
  is a guard rail, not a scheduler.
- **`slaude update` still pulls an RC user back to stable.** Falls out of
  `releases/latest` semantics. Correct: an RC is a deliberate pin, and a user who
  runs `update` is asking for the supported version.
- **No `cut-rc.sh`.** Cutting is a version bump and a tag; the CI guard catches
  the one mistake that matters (drift). Add it if cutting turns out to be error-prone
  in practice.
