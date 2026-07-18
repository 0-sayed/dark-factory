---
name: auto-squash
description: Use when a PR should be processed in repeated review passes, waiting for a quiet window between runs and stopping only when no unresolved review threads remain.
allowed-tools:
  - Bash
user-invocable: true
---

# Auto Squash

Use this when `pr-scan -> pr-fix -> pr-resolve` should run as repeated fresh-context passes instead of one long loop node.

## Run

```bash
node "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/auto-squash/scripts/review-cycle.js" run --workflow auto-squash --state-file .archon/.state/review-cycle.json --quiet-state-file .archon/.state/review-bots.json --quiet-window-seconds 300 --timeout-seconds 1800 --poll-interval-seconds 30
```

## Workflow Contract

- The workflow should start with a `check-convos` script node using `runtime: bun`.
- `scripts/review-convo-check.mjs` delegates to the Node driver so the review-cycle logic runs on Node 22+.
- Downstream nodes should run only when `"$check-convos.output == 'CONTINUE'"`.

## Stop Condition

- `STOP` means the PR has zero unresolved review threads, required checks are settled, and no reported PR checks are failing. Non-required pending checks do not block this decision.
- Exception: if GitHub reports the PR has merge conflicts and required checks are unavailable, `STOP` means review feedback is clear and the PR is ready for the `merge-gate` conflict-resolution workflow.
- The external driver exits immediately after a workflow run whose `check-convos` signal is `STOP`.
- `CONTINUE` means there are unresolved review threads or failed reported PR checks, so the driver waits for the next quiet window and runs the workflow again.
- If applicable checks are pending, `check-convos` waits for them before deciding.
- If applicable checks fail, `check-convos` returns `CONTINUE` so the next pass can scan and repair.
