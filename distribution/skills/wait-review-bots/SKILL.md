---
name: wait-review-bots
description: Use when a PR review cycle is already in flight and you need a resumable quiet-window wait based on GitHub activity instead of named bot completions.
allowed-tools:
  - Bash
user-invocable: true
---

# Wait Review Bots

Use this when a PR review cycle is already in flight and you want a resumable quiet-window wait instead of blocking on named bots.

## Run

1. Capture the current PR and head SHA into repo-local state.
2. Wait until the current head SHA has been quiet for 10 minutes.

```bash
node "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/wait-review-bots/scripts/review-bots.js" capture --force --state-file .archon/.state/review-bots.json
node "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/wait-review-bots/scripts/review-bots.js" wait --state-file .archon/.state/review-bots.json --quiet-window-seconds 600 --timeout-seconds 1800 --poll-interval-seconds 30
```

## What Counts As Activity

- PR reviews on the captured head SHA
- Inline review comments on the captured head SHA
- Top-level PR comments after capture

## Rules

- If new activity appears, the quiet timer resets to that activity timestamp.
- If the PR head changes after capture, stop and re-capture.
- Keep the state file inside `.archon/.state/` so the repo owns the run state but not the implementation.
- `wait` is rerunnable. If the PR has already been quiet long enough, rerunning exits immediately.

## Notes

- The script first tries the current branch PR, then falls back to resolving the PR from the current HEAD commit.
- Use this skill when bot comments are inconsistent and you care more about “has review activity gone quiet?” than “did each named bot post?”.
