---
name: ship
description: Open or update a GitHub pull request from an already-committed branch. Use when the user says "ship", "open PR", "create PR", "make a PR", or "push and open a PR". Keeps PR bodies minimal and does not commit, scan review feedback, resolve threads, merge, or deploy.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
user-invocable: true
---

# Ship

Open or update a GitHub PR from a committed branch.

## Boundary

This skill owns:

- branch/base detection
- existing PR detection
- push needed to create/update the PR
- concise PR title/body creation
- draft vs ready choice
- final PR URL and shipped state

This skill does not own:

- staging or committing changes
- splitting commits
- PR feedback scanning
- review-thread resolution
- repeated review loops
- merging or deployment

Uncommitted changes are allowed. Ship only committed changes in
`<base>...HEAD`; do not stage or commit dirty worktree changes from this skill.
Mention uncommitted changes in the final response as "left unshipped" when
present.

## Workflow

### 1. Inspect State

```bash
git status --short
git branch --show-current
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
gh pr view --json number,title,url,state,isDraft 2>/dev/null
```

Stop if:

- on the default/base branch
- no commits exist ahead of the base branch
- `gh` is not authenticated

### 2. Build Minimal PR Content

Use the branch diff and commit list:

```bash
git log <base>..HEAD --oneline
git diff <base>...HEAD --stat
```

Default body:

```md
## Summary
- <one or two bullets>
```

Only include issue links when the user mentioned an issue or the branch/commits
clearly reference one. Do not add empty "Related Issues" sections. Do not use
auto-closing keywords unless the user explicitly says the PR fixes that issue.

Prefer the repository PR template when it is short and relevant. If the template
is noisy or mostly empty checklist text, use the minimal body above.

### 3. Push And Create Or Update PR

When the user says "ship", "open PR", "create PR", or equivalent, treat that as
permission to push the current branch and create/update the PR.

```bash
git push -u origin HEAD
gh pr create --title "<title>" --body-file <body-file>
```

If a PR already exists, update it instead:

```bash
gh pr edit <number> --title "<title>" --body-file <body-file>
```

Use `--draft` only when the user asks for a draft or the branch is clearly WIP.
Otherwise create a ready PR.

Never force-push. Never merge unless the user explicitly asks.

### 4. Report

Return only:

- PR URL
- draft/ready state
- blockers, if any

Keep the final response short.
