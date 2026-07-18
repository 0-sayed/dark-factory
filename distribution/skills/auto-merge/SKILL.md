---
name: auto-merge
description: Use when an existing GitHub PR should be made green and merged after feature implementation is complete.
---

# Auto Merge

Use this after a PR exists. Do not use it to implement a feature or open the PR.

## Run

```bash
node "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/auto-merge/scripts/auto-merge.mjs"
```

Modes:

- `--mode prepare`: run `auto-squash` and `merge-gate` until the PR is mergeable, then stop with `READY_TO_MERGE`.
- `--mode finalize`: run `auto-squash` and `merge-gate` until the PR is merged. This is the default.

## Contract

- Runs the `auto-squash` skill driver first.
- Runs the `merge-gate` Archon workflow second.
- Repeats only when `merge-gate` writes `NEEDS_SQUASH` or `PENDING`.
- In `prepare` mode, stops successfully only when `.archon/state/merge-status.json` says `READY_TO_MERGE`.
- In `finalize` mode, stops successfully only when `.archon/state/merge-status.json` says `MERGED`.
- Stops blocked when `merge-gate` writes `BLOCKED` or returns an unknown outcome.

## Boundaries

- `auto-feature` creates or updates the PR and then stops.
- `auto-squash` owns review comments and failed reported PR checks.
- `merge-gate` owns mergeability, stale-branch handling, conflict resolution, frontend-conflict QA, and the final merge.
- Dark Factory owns merge-queue order; workers should use `prepare`, and the Dark Factory merge queue should use `finalize`.
- This skill is the outer driver. Do not call it from inside an Archon workflow on the same checkout.
