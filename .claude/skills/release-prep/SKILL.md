---
name: release-prep
description: Use when cutting a new slaude release, bumping version, or writing release notes. Triggers on phrases like "prep the release", "cut a release", "ship a version", or when version tag work needed.
---

# Release Prep

## Overview

Slaude release workflow. Granular commits, hand-written release notes, automated verification. Follows `docs/releases/<tag>.md` convention from `CLAUDE.md`.

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

Create `docs/releases/vX.Y.Z.md`. Structure:

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

## Release Note Anti-Patterns

| Bad | Good |
|---|---|
| "Various bugfixes and improvements" | Specific feature names with context |
| Raw git log dump | Hand-written categories with why |
| One commit per bullet | Group related commits under feature heading |
| Skip commit list entirely | Include key commits for traceability |
| Mix features and fixes in one list | Separate sections |

## Example

See `docs/releases/v0.9.0.md` for complete example of multi-feature release with ignore gate, cron routing, info-capture tools, and KB search.
