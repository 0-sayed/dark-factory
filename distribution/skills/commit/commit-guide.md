# Commit Guide - Complete Reference

This document provides comprehensive guidance for creating atomic, well-ordered git commits.

## Table of Contents

1. [Conventional Commit Format](#conventional-commit-format)
2. [Dependency Layers](#dependency-layers)
3. [Cross-File Logical Grouping](#cross-file-logical-grouping)
4. [Commit Plan Checkpoint](#commit-plan-checkpoint)
5. [Commit as Agent Memory](#commit-as-agent-memory)
6. [Partial Staging](#partial-staging)
7. [Examples](#examples)
8. [Troubleshooting](#troubleshooting)
9. [Tooling Integration](#tooling-integration)

---

## Conventional Commit Format

### Full Format
```
<type>[optional scope][optional !]: <description>

[optional body]

[optional footer(s)]
```

### Types

`feat`, `fix`, and breaking changes have defined SemVer meaning in the
Conventional Commits specification. The other types below are local policy
and common ecosystem conventions.

| Type | Description | SemVer |
|------|-------------|--------|
| `feat` | New feature | MINOR |
| `fix` | Bug fix | PATCH |
| `refactor` | Code restructuring (no behavior change) | - |
| `chore` | Maintenance tasks | - |
| `docs` | Documentation only | - |
| `test` | Adding/updating tests | - |
| `perf` | Performance improvements | - |
| `ci` | CI/CD changes | - |
| `build` | Build system or dependencies | - |
| `style` | Code style (formatting, semicolons) | - |
| `revert` | Reverting a previous commit | - |

### Breaking Changes

Use **!** after type/scope:
```
feat!: remove deprecated API endpoints
feat(api)!: change authentication flow
```

Or use **BREAKING CHANGE:** or **BREAKING-CHANGE:** in footer:
```
feat(api): update user authentication

BREAKING CHANGE: JWT tokens now expire after 1 hour instead of 24 hours
```

### Subject Line Rules
- Keep under 72 characters
- Use imperative mood ("add" not "added" or "adds")
- No period at the end
- Be specific about what changed
- NEVER use "and" (indicates multiple changes)

### Body Guidelines
- Optional for obvious mechanical changes
- Use for non-trivial changes where the diff does not explain the intent
- Explain the "why" and decision context, not the implementation diary
- Wrap at 72 characters

### Footer Options
- `Closes #123` or `Fixes #123` - auto-closes issues
- `Refs #456` - references without closing
- `BREAKING CHANGE: <description>` or `BREAKING-CHANGE: <description>` - breaking change details
- `Co-authored-by: Name <email>` - credit co-authors
- `Signed-off-by: Name <email>` - DCO sign-off

---

## Dependency Layers

Commit in this order to ensure dependencies exist before code that uses them.
Keep tests with the behavior they verify unless the change is test-only
maintenance; separate "code then tests" commits weaken bisectability.

### Layer 1: Infrastructure & Configuration

**Database and schema files:**
- Migrations: `*.sql`, `migrations/*`, `db/migrate/*`, `alembic/*`
- Schemas: `schema.*`, `*.schema.*`, `prisma/schema.prisma`, `models.py`
- ORM configs: `drizzle.config.*`, `ormconfig.*`, `database.yml`

**Configuration files:**
- Build: `tsconfig.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`
- Environment: `.env*`, `config/*`, `settings.*`
- Docker: `Dockerfile`, `docker-compose.yml`, `*.dockerfile`
- CI/CD: `.github/workflows/*`, `.gitlab-ci.yml`, `Jenkinsfile`

### Layer 2: Shared Libraries & Types

**Type definitions and interfaces:**
- TypeScript: `types/*`, `*.d.ts`, `interfaces/*`
- Python: `types.py`, `typing_extensions.py`, `protocols.py`
- Go: `types.go`, `interfaces.go`
- Java/Kotlin: `**/dto/*`, `**/model/*`, `**/entity/*`
- Rust: `types.rs`, `mod.rs` (type modules)

**Shared utilities:**
- `lib/*`, `libs/*`, `shared/*`, `common/*`, `utils/*`, `helpers/*`, `pkg/*`
- Constants and enums: `constants.*`, `enums.*`

### Layer 3: Core Service Logic

**Business logic implementations:**
- Services: `*Service.*`, `*_service.*`, `services/*`
- Use cases: `*UseCase.*`, `usecases/*`, `application/*`
- Handlers: `*Handler.*`, `handlers/*`
- Repositories: `*Repository.*`, `*_repository.*`, `repositories/*`
- Modules: `*Module.*`, `modules/*`

### Layer 4: API & Controllers

**External interfaces:**
- Controllers: `*Controller.*`, `*_controller.*`, `controllers/*`
- Routes: `routes.*`, `router.*`, `*_routes.*`, `api/*`
- Resolvers (GraphQL): `*Resolver.*`, `resolvers/*`
- Views (MVC): `views/*`, `templates/*`, `pages/*`
- CLI commands: `commands/*`, `cmd/*`

### Layer 5: Tests & Documentation

**Test files (by language):**
- JavaScript/TypeScript: `*.test.*`, `*.spec.*`, `__tests__/*`
- Python: `test_*`, `*_test.py`, `tests/*`
- Go: `*_test.go`
- Java: `*Test.java`, `*Spec.java`, `src/test/*`
- Rust: `#[test]` in `*.rs`, `tests/*`
- Ruby: `*_spec.rb`, `*_test.rb`, `spec/*`, `test/*`

**Documentation:**
- `README*`, `CHANGELOG*`, `docs/*`, `*.md`

---

## Cross-File Logical Grouping

### Definition

A **logical change** is a self-contained unit of work that:
- Does ONE thing (single purpose/single responsibility)
- Can be described in one commit message without using "and"
- Is independently revertable without breaking other features
- Works with `git cherry-pick` (can be applied to another branch alone)
- Works with `git bisect` (if this commit introduced a bug, it's findable)

### When to Split Commits

Split changes into separate commits when they represent:
- Different bug fixes (even in the same file)
- Unrelated features or enhancements
- Refactoring vs. new functionality
- Configuration changes vs. code changes
- Different concerns (e.g., security fix + performance improvement)

### When to Combine Across Files

Combine changes from MULTIPLE files into ONE commit when they:
- Implement the same feature together (e.g., model + service + controller)
- Fix the same bug across layers
- Are meaningless without each other
- Would break the build/tests if committed separately

---

## Commit Plan Checkpoint

Before staging, write a commit plan when the worktree has more than one changed
file, more than one hunk, or both staged and unstaged changes. This prevents
the common failure mode of committing everything because it is faster.

Use this format:

```text
1. type(scope): description
   files/hunks:
   why grouped:
```

Only make one commit when all staged changes serve one purpose and the message
does not need "and", commas, or multiple concerns to describe it.

Good grouping examples:
- A service fix and its test for the same behavior
- A schema change, generated type, and repository update that must land together
- A UI state fix and the colocated component test that verifies it

Split instead when changes include:
- A feature plus unrelated cleanup
- Multiple bug fixes, even in one file
- Refactoring plus behavior change
- Config/tooling change plus application code

After staging each planned group, verify `git diff --cached` still shows one
logical change before committing.

---

## Commit as Agent Memory

Treat each non-trivial atomic commit as a small, durable memory unit for future
agents and maintainers. The subject says what changed; the body says why it
changed and what context must survive.

Use a body when the change includes:
- A non-obvious bug cause, constraint, invariant, or risk
- A tradeoff or rejected simpler option
- Migration, compatibility, or rollout context
- A reference to an issue, PR, doc, migration guide, or prior commit

Skip the body for obvious mechanical changes, formatting, typo fixes, simple
renames, or dependency bumps where the subject and diff are enough.

Good body content:
- 1-2 short paragraphs, or 2-4 bullets
- The reason this change exists
- The high-level decision, not a restatement of the diff
- Any risk or follow-up a future agent must preserve

Bad body content:
- Tool logs, test output dumps, or generated transcripts
- Agent diary such as "I inspected..." or "then I changed..."
- Generic summaries already visible in the diff
- Review conversations copied into history

Preferred command form for a non-trivial commit:

```bash
git commit \
  -m "fix(auth): reject stale QA bypass sessions" \
  -m "The bypass cookie could survive after the configured QA user changed because validation only checked that the cookie existed." \
  -m "Tie validation to the configured QA user id so stale browser sessions fail closed while keeping local QA fast."
```

If the body grows beyond a few focused lines, first consider whether the commit
should be split. If it is still long because the decision affects future work
beyond this commit, keep the commit body concise and link to the durable doc.

---

## Partial Staging

When a file contains multiple unrelated changes, use partial staging to separate them.

### Available Commands

```bash
# Check staging status across all files
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" status

# Get JSON summary for AI parsing
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" summary

# List all hunks in a file with previews
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" list-hunks <file>

# Show diff with hunk numbers annotated
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" show-diff <file>

# Stage specific hunks by number
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-hunks <file> "1,3-5"

# Split nearby edits that Git reports as one hunk
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" list-hunks <file> --fine
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-hunks <file> "2" --fine

# Stage hunks matching a regex pattern
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-regex <file> "validation"

# Stage hunks affecting specific line ranges
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-lines <file> "10-50"

# Analyze hunks (JSON output)
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" analyze <file>

# Split file into individual hunk patches
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" split-hunks <file>

# Stage a new untracked file
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-new <file>

# Dry-run: preview without staging
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-hunks <file> "1,3" --dry-run

# Batch stage regex across multiple files
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-regex-all "validation" "src/**/*"
```

Use `--fine` when normal `list-hunks` shows one hunk that contains multiple
nearby logical changes. Fine mode uses zero-context diffs, so verify
`git diff --cached` carefully before committing.

### Workflow Example

```bash
# Step 1: Analyze what hunks exist
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" list-hunks src/user_service.py

# Output shows:
# Hunk #1: validation logic
# Hunk #2: caching logic
# Hunk #3: error handling

# Step 2: Stage only validation hunks
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-hunks src/user_service.py 1

# Step 3: Verify staged changes
git diff --cached src/user_service.py

# Step 4: Commit
git commit -m "feat(user): add input validation"

# Step 5: Continue with remaining hunks...
```

### Cross-File Partial Staging

When multiple files each contain parts of multiple logical changes:

```bash
# Logical Change A: "Add validation" - spans 3 files

# Stage validation hunks from each file
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-regex src/models/user.py "validate"
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-regex src/services/user_service.py "validate"
"${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/commit/git-smart-stage.sh" stage-regex src/api/user_controller.py "validate"

# Verify the staged changes are coherent
git diff --cached

# Commit the validation feature
git commit -m "feat(user): add input validation"
```

### Fallback: Direct filterdiff

If the script is unavailable:

```bash
# List hunks
git diff path/to/file | grep -n '^@@'

# Stage specific hunk (e.g., hunk #2)
git diff path/to/file | filterdiff --hunks=2 | git apply --cached

# Stage hunks matching a pattern
git diff path/to/file | grepdiff "validation" --output-matching=hunk | git apply --cached
```

---

## Examples

### Database and Service Change

**Changes:**
- `database/migrations/001_add_sentiment.sql` (new)
- `src/repositories/sentiment_repository.py` (new)
- `src/services/analysis_service.py` (modified)

**Commits:**
```bash
# Commit 1: Schema first
git add database/migrations/001_add_sentiment.sql
git commit -m "feat(database): add sentiment data schema"

# Commit 2: Repository next
git add src/repositories/sentiment_repository.py
git commit -m "feat(database): add sentiment repository"

# Commit 3: Service last
git add src/services/analysis_service.py
git commit -m "feat(analysis): integrate sentiment data repository"
```

### Breaking Change

```bash
git add src/api/users_controller.py src/dto/user_dto.py

git commit -m "feat(api)!: change user list response to paginated format

Previously, GET /users returned all users in a single array.
Now it returns paginated results with metadata.

BREAKING CHANGE: GET /users now requires pagination parameters.
- Add ?page=1&limit=20 to requests
- Response shape changed from User[] to { data: User[], meta: PaginationMeta }

Migration guide:
1. Update all /users API calls to include pagination params
2. Update response handling to extract data from response.data

Closes #789"
```

### Revert Commit

```bash
# Find the commit to revert
git log --oneline -10

# Revert it
git revert abc1234 --no-commit

# Review and commit
git diff --cached
git commit -m "revert: feat(checkout): add express checkout button

This reverts commit abc1234def5678.

The express checkout feature was causing payment failures
on iOS Safari due to a popup blocker issue.

Refs #892"
```

---

## Troubleshooting

### patchutils not installed

```bash
# Check if installed
which filterdiff

# Install
sudo apt install patchutils      # Debian/Ubuntu
sudo dnf install patchutils      # Fedora/RHEL
brew install patchutils          # macOS
sudo pacman -S patchutils        # Arch
apk add patchutils               # Alpine
```

### Patch apply fails

If `git apply --cached` fails:
1. The hunk may have conflicts with already-staged changes
2. Inspect `git diff --cached` and unstage only the conflicting path or hunk if needed
3. Stage hunks in order from top of file to bottom
4. If one normal hunk contains multiple nearby unrelated edits, rerun the
   listing and staging command with `--fine`

### Regex matches nothing

If stage-regex finds no hunks:
1. Check the actual diff content: `git diff <file>`
2. Try a broader regex pattern
3. Fall back to hunk numbers: `stage-hunks <file> 1,2`

### Commit rejected by commitlint

1. Check the error message for the specific rule violation
2. Common issues:
   - Subject too long (max 72 chars)
   - Invalid type
   - Missing scope when required
3. Fix and retry: `git commit --amend`

### Verification after commit

Do not require a clean worktree. This skill intentionally skips `pr.md`,
`summary.md`, `learn.md`, `review.codex.md`, and anything under
`superpowers/`; users may also have unrelated local changes.
Verify that the staged diff matched one logical change before committing, the
commit was created with the intended message, and any remaining dirty files
are expected leftovers.

---

## Tooling Integration

### Node.js (npm/yarn/pnpm)

```bash
npm install -D @commitlint/cli @commitlint/config-conventional husky
npx husky init
echo 'npx --no -- commitlint --edit $1' > .husky/commit-msg
echo "module.exports = { extends: ['@commitlint/config-conventional'] };" > commitlint.config.js
```

### Python

```bash
pip install commitizen pre-commit
# Add to .pre-commit-config.yaml:
# - repo: https://github.com/commitizen-tools/commitizen
#   hooks:
#     - id: commitizen
```

### Go

```bash
go install github.com/conventionalcommit/commitlint@latest
# Add to .git/hooks/commit-msg
```

### Ruby

```bash
gem install overcommit
overcommit --install
# Configure in .overcommit.yml
```

### Rust

```bash
cargo install cocogitto
cog init
```

### Generic (any language)

```bash
pip install pre-commit
# Add commitlint hook to .pre-commit-config.yaml
```
