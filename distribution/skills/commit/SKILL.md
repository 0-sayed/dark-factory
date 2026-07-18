---
name: commit
description: Create atomic, well-ordered git commits following conventional commit format. Use when committing changes, creating commits, or when the user mentions "commit", "git commit", "stage changes", "partial staging", or splitting work into multiple commits. Supports commit planning and partial hunk staging for separating unrelated changes.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
user-invocable: true
---

# Atomic Commit Skill

Create well-structured, atomic git commits following the conventional commit specification. This skill supports partial staging to separate unrelated changes within the same file.

## Quick Reference

**Conventional Commit Format:**

```
<type>[optional scope][optional !]: <description>

[optional body]

[optional footer(s)]
```

**Types:** `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `ci`, `build`, `style`, `revert`

**Breaking Changes:** Use **!** after type/scope or **BREAKING CHANGE:** / **BREAKING-CHANGE:** in footer.

## Workflow

### Step 1: Inventory Changes

```bash
git status --short
git diff --name-only         # Unstaged files
git diff --cached --name-only # Staged files
```

**Always skip these files** — never stage or commit them:
- `pr.md`
- `summary.md`
- `learn.md`
- `review.codex.md`
- anything under `.ao/`
- anything under `docs/superpowers/`
- anything under `.superpowers/`

### Step 2: Categorize by Dependency Order

Commit in this order to ensure dependencies exist before dependents:

1. **Infrastructure & Configuration** - Migrations, schemas, configs, Docker, CI/CD
2. **Shared Libraries & Types** - Type definitions, interfaces, utilities, constants
3. **Core Service Logic** - Services, use cases, handlers, repositories
4. **API & Controllers** - Controllers, routes, resolvers, views, CLI
5. **Tests & Documentation** - Test files, README, docs

### Step 3: Plan Commit Groups

Before staging, write a commit plan when there is more than one changed file,
more than one hunk, or both staged and unstaged changes:

```text
1. type(scope): description
   files/hunks:
   why grouped:
```

A single commit is allowed only when every staged change serves one purpose and
the message does not need "and", commas, or multiple concerns to describe it.

### Step 4: Create Atomic Commits

For each logical change, stage related files and commit:

```bash
git add <files>
git commit -m "type(scope): description"

# For non-trivial changes, include agent-readable context
git commit -m "type(scope): description" -m "Why/decision/risk context."
```

**Partial Staging:** When a file contains multiple unrelated changes, use the `git-smart-stage.sh` script (see `commit-guide.md` for details):

```bash
# List hunks in a file
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" list-hunks <file>

# Stage specific hunks
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-hunks <file> "1,3"

# Stage hunks matching a pattern
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-regex <file> "validation"

# Split nearby edits that Git reports as one hunk
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" list-hunks <file> --fine
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-hunks <file> "2" --fine

# Stage a new untracked file
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-new <file>
```

### Step 5: Verify

```bash
git diff --cached  # Before commit: staged diff matches one logical change
git status --short # After commit: only expected leftovers remain
```

### Step 6: Push (if requested)

```bash
git push                    # Existing branch
git push -u origin <branch> # New branch
```

## Key Principles

- **Atomic commits**: Each commit does ONE thing
- **No "and" in messages**: If you need "and", split into multiple commits
- **Dependency order**: Schema before repository, service before controller
- **Commit-plan checkpoint**: Plan groups before staging whenever the worktree is not trivially one change
- **Cross-file grouping**: Related changes across files go in ONE commit
- **Tests with behavior**: Commit tests with the behavior they verify unless the change is test-only maintenance
- **Partial staging**: Use when a file has multiple unrelated changes
- **Commit as agent memory**: Add a body when the why, constraint, or risk is not obvious from the diff; do not add bodies for obvious mechanical changes

## Documentation

For detailed patterns, examples, and troubleshooting, read:

- `${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/commit-guide.md` - Complete reference documentation
- `${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh --help` - Partial staging script help

## Requirements

The partial staging commands require `patchutils`. Inventory commands such as
`status`, `summary`, `list-hunks`, `show-diff`, `analyze`, and `stage-new` do
not require it.

```bash
# Ubuntu/Debian
sudo apt install patchutils

# macOS
brew install patchutils

# Fedora/RHEL
sudo dnf install patchutils
```
