---
name: release-prep
description: Use when cutting a new slaude release, bumping version, or writing release notes. Triggers on phrases like "prep the release", "cut a release", "ship a version", or when version tag work needed.
---

# Release Prep

## Overview

Slaude release workflow. Granular commits, hand-written release notes, automated verification. Follows `docs/site/_content/releases/<tag>.md` convention from `CLAUDE.md`.

Two paths:

- **Direct** — bump, tag `vX.Y.Z`, push. For patches and low-risk minors.
- **Release candidate** — tag `vX.Y.Z-rc.N` first, soak, then promote to `vX.Y.Z`. Use for anything touching the install path, the DB schema, or the agent loop.

Both run the same `release.yml`; the RC path just publishes as a GitHub *pre-release* (auto-detected from the `-` in the tag) so `install.sh` never picks it up as `latest`.

## When to Use

- User asks to prep/cut/ship a release
- Version bump needed
- Release notes need writing
- Post-merge release verification needed

## Quick Reference

| Step | Command / Action |
|---|---|
| Find last tag | `git describe --tags --abbrev=0` |
| Diff commits | `git log <tag>..HEAD --oneline` |
| Check changed files | `git diff --stat <tag>..HEAD` |
| Type check | `bun run typecheck` |
| Run tests | `bun test` |
| Installer smoke | `bash tests/installer/smoke.sh` |
| Promote an RC | `scripts/promote-rc.sh vX.Y.Z-rc.N [--dry-run]` |

## Release Workflow

### 1. Diff since last tag

```bash
git describe --tags --abbrev=0
git log <tag>..HEAD --oneline --no-decorate
git diff --stat <tag>..HEAD
```

### 2. Determine version (semver)

- **Major** (`X.0.0`): breaking schema/config/API change
- **Minor** (`x.Y.0`): new features, non-breaking additions
- **Patch** (`x.y.Z`): bugfixes only, no new features

Default to minor if any `feat:` commits since last tag. Patch only if all commits are `fix:`, `docs:`, `test:`, `chore:`.

### 3. Bump version

Edit `package.json` `"version"` field. Commit separately:

```
chore(release): bump version to X.Y.Z
```

### 4. Write release notes

Create `docs/site/_content/releases/vX.Y.Z.md`. Structure:

```markdown
## vX.Y.Z — <one-line summary>

<paragraph describing release theme/motivation>

### Features

- **Area: feature name.** Description. Link to files if non-obvious.

### Fixes

- **Area: fix description.** What was broken, what changed.

### Internal

- Tests, docs, refactorings that don't affect runtime behavior.

### Commits

- `type(scope): subject` (short-sha)
- ...

**Full diff:** https://github.com/barockok/slaude/compare/vPREV...vX.Y.Z
```

Rules:
- Hand-written, not git-log dump
- Group by category (Features / Fixes / Internal)
- Explain *why* not just *what*
- Link findings docs when relevant
- List key commits at bottom

Commit separately:

```
docs(release): vX.Y.Z release notes

<feature summary one-liner>
```

### 5. Tag and push

```bash
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

### 6. Verify build

```bash
bun run typecheck
bun test
```

Zero failures required. Check coverage report: aim for 97%+ function, 99%+ line.

## Release Candidate Workflow

Use when the change touches `install.sh`, the dist/version layout, the DB schema, or the agent loop — anywhere a bad stable tag is expensive to walk back.

### 1. Cut the RC

Write `docs/site/_content/releases/vX.Y.Z.md` **first** — under the *stable* name. `promote-rc.sh` requires it, and the RC build reuses it.

```bash
# package.json version must be the full RC string, tag and all
sed -i -E 's/("version": *")[^"]+(")/\1X.Y.Z-rc.1\2/' package.json
git commit -am "chore(release): vX.Y.Z-rc.1"
git tag vX.Y.Z-rc.1
git push origin main && git push origin vX.Y.Z-rc.1
```

`release.yml` then: verifies tag == package.json, runs tests, packages the tarball, runs the installer smoke test, and publishes a GitHub **pre-release**.

The tag and `package.json` MUST agree — `install.sh` builds the asset URL from the tag while `package-release.sh` names the tarball from `package.json`. The workflow fails fast on a mismatch rather than shipping a 404.

### 2. Soak

Install the RC explicitly (it is never `latest`):

```bash
SLAUDE_VERSION=X.Y.Z-rc.1 curl -fsSL https://raw.githubusercontent.com/barockok/slaude/main/install.sh | bash
```

Check `slaude version` reports the RC. Run it against a real workspace. `slaude update` will pull *back* to the newest stable — that is intentional; an RC is a deliberate pin.

Found a bug? Fix on main, cut `-rc.2`. Don't patch an RC tag in place.

### 3. Promote

```bash
scripts/promote-rc.sh vX.Y.Z-rc.2 --dry-run   # inspect first
scripts/promote-rc.sh vX.Y.Z-rc.2
```

The script refuses to run unless: the tag is `vX.Y.Z-rc.N`, the RC tag exists, the stable tag does *not*, you are on a clean `main`, the RC is an ancestor of HEAD, and `docs/site/_content/releases/vX.Y.Z.md` exists. It prints any commits that landed after the RC — those ship **unsoaked**, so re-cut an RC if that list is non-trivial. Then it bumps `package.json`, commits, tags, and pushes on confirmation.

### Ancestor check failure

If `promote-rc.sh` fails with `RC is not an ancestor of HEAD`, the RC tag was cut from a different commit than what's on `main` (e.g. docs/rebranding commits landed on main after the RC was cut but before the tag was pushed). Diagnose first:

```bash
git diff <rc-tag-sha>..<main-equivalent-sha> --stat
```

If the divergence is **docs/chore only** (no logic, no package.json, no schema changes), it is safe to promote manually:

1. Edit `package.json`: strip `-rc.N` suffix.
2. Enable hooks: `git config core.hooksPath .githooks`
3. Stage + leak scan:
   ```bash
   git add package.json
   git diff --cached -U0 | grep -nIiE 'acme|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY'
   # no output = clean
   ```
4. Commit (**no** `Co-Authored-By` trailer — hook enforces this):
   ```bash
   git commit -m "chore(release): promote vX.Y.Z-rc.N to vX.Y.Z"
   ```
5. Tag and push (re-mint GitHub token right before push):
   ```bash
   git tag vX.Y.Z
   printf '%s' '<freshCloneUrl>' > /tmp/.gu
   git push "$(cat /tmp/.gu)" main 2>&1 | sed -E 's#https://[^@]*@#https://***@#g'
   git push "$(cat /tmp/.gu)" vX.Y.Z 2>&1 | sed -E 's#https://[^@]*@#https://***@#g'
   rm -f /tmp/.gu
   ```

If the divergence includes **any logic or schema change**, re-cut an RC from HEAD instead.

## Release Note Anti-Patterns

| Bad | Good |
|---|---|
| "Various bugfixes and improvements" | Specific feature names with context |
| Raw git log dump | Hand-written categories with why |
| One commit per bullet | Group related commits under feature heading |
| Skip commit list entirely | Include key commits for traceability |
| Mix features and fixes in one list | Separate sections |

## Example

See `docs/site/_content/releases/v0.9.0.md` for complete example of multi-feature release with ignore gate, cron routing, info-capture tools, and KB search.
