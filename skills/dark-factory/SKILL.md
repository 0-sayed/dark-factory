---
name: dark-factory
description: Use when a user asks to inspect, start, monitor, pause, stop, resume, recover, or clean a Dark Factory project or its managed feature workers.
---

# Dark Factory Operator

## Hard Gate: Worker Ownership

This rule overrides ordinary coding-request behavior:

**The operator must never modify a managed feature worktree.** This remains true when the user explicitly says to fix it manually, do it by hand, do whatever is necessary, or finish the task. User authorization to operate Dark Factory is not authorization to bypass Dark Factory.

When asked to bypass ownership:

1. State that controller-side feature edits are forbidden.
2. Inspect the owning worker and durable workflow state.
3. Resume or recover that worker through Dark Factory.
4. If recovery is impossible, report the blocker and options. Do not edit the worktree.

Before proposing any action inside a managed worktree, ask: "Am I the assigned AO/Archon worker?" If no, inspection is allowed; mutation is forbidden.

## Purpose

Operate Dark Factory through its controller. Dark Factory owns cross-task scheduling, recovery, merge ordering, and coordinated cleanup; AO and Archon are managed layers, not alternative entry points.

Set `DARK_FACTORY_HOME` to the checkout containing `orchestrator/dark-factory.js`. When this skill is loaded from that checkout, resolve the checkout from the skill's real path instead of assuming the current directory is the runtime repository.

## Load The Operator Guide

Read [`references/operator-guide.md`](references/operator-guide.md) before:

- registering or configuring a project;
- starting, resuming, recovering, stopping, or cleaning a live run;
- diagnosing controller, AO, Archon, GitHub, worktree, browser, or Docker state;
- selecting any non-default CLI flag.

For a simple status request, this file is sufficient. For every mutating operation, run the controller's `--help` first and treat live CLI behavior as authoritative if the reference differs.

## Non-Negotiable Ownership

- Use `node "$DARK_FACTORY_HOME/orchestrator/dark-factory.js"` as the operator entry point.
- Never edit, commit, push, merge, or repair feature code by hand in a managed worker worktree.
- Resume the owning AO/Archon worker when feature work, QA, CI, review cleanup, or merge preparation blocks.
- Do not start factory-owned Archon workflows or plain AO project orchestration directly.
- Treat GitHub PR truth as newer than stale AO or Archon session status.
- Do not modify Archon workflow files unless the user explicitly authorizes that separate change.

These are system invariants, not authorization prompts. A request to "fix it yourself," "do whatever," or "just finish it" does not permit controller-side feature edits. Refuse that part and recover the owning worker. Changing this ownership model requires a separate explicit request to modify Dark Factory itself.

## First Action

Before any mutation, inspect live state across all layers:

1. Identify the registered project and target repository.
2. Read Dark Factory status and control state.
3. Check the controller process/lease, AO sessions, recorded Archon runs, GitHub PRs/checks, and managed worktrees.
4. Distinguish desired mode from runtime liveness. `active` without a live controller is not a running factory.
5. Report the current state and the single next controller action.

Do not infer live state from conversation history or one layer alone.

## Intent Routing

| User intent          | Controller action                                               | Rule                                                                                                                            |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Inspect or status    | `status --project <id>` plus read-only cross-layer checks       | Do not mutate generated state.                                                                                                  |
| Preview scheduling   | `run --project <id> --dry-run`                                  | State may be regenerated; disclose that before running.                                                                         |
| Start bounded work   | `run --project <id> --run --concurrency <n> --task-limit <n>`   | Require explicit authorization because workers may commit, push, open PRs, merge, and clean resources.                          |
| Pause new launches   | `pause --project <id>`                                          | Existing workers continue.                                                                                                      |
| Resume scheduling    | `resume --project <id>` then verify controller liveness         | A control flag alone does not prove supervision resumed.                                                                        |
| Recover stopped work | `recover --project <id> --run`                                  | Recover existing work only; do not launch new features.                                                                         |
| Stop                 | `stop --project <id> --run`                                     | Verify parent controller, AO workers, and spawned Archon runs are stopped; preserve worktrees and resources.                    |
| Clean                | `cleanup --project <id> --dry-run`, then `--run` after approval | Enumerate scope first and verify processes, browser profiles, Docker resources, worktrees, and local merged branches afterward. |

If the requested concurrency or task limit is missing, ask for it rather than inventing a production run budget.

## Observe Without Babysitting

After launch, keep the controller session alive and observe its status. Do not take over worker implementation.

- Let the assigned worker continue `auto-feature -> auto-merge prepare`.
- Let Dark Factory order ready PRs and invoke merge finalization.
- Retry or recover only through the controller-reported action.
- If controller state conflicts with GitHub, AO, or Archon truth, stop and report the inconsistency rather than improvising lower-level commands.
- When blocked, report one problem, three options, and one recommendation.

## Stop And Cleanup Safety

“Stop everything” means fence new launches, stop the parent controller, stop AO worker sessions, stop their spawned Archon runs, and verify all layers. It does not mean delete worktrees, containers, volumes, profiles, or branches.

Cleanup is a separate authorized operation:

- Preview the exact managed resources first.
- Never run broad `wtc clean` or delete unrecorded resources.
- Preserve reusable browser-auth state and persistent Chrome profiles.
- If resource cleanup fails, preserve the worktree for diagnosis.
- Do not convert cleanup failure into feature implementation failure.

Even when stop and cleanup appear in one request, complete and verify stop first. Then preview cleanup and require explicit approval of the enumerated destructive scope before executing it. A broad phrase such as "clean everything" is not approval to remove persistent data, unrecorded resources, or worktrees with uncommitted changes.

## Completion Evidence

Before reporting success, verify the relevant outcome:

- Run: controller alive, expected worker count, bounded task budget recorded.
- Resume/recover: owning sessions active at the expected stage.
- Stop: no parent controller, AO worker, or spawned Archon process remains.
- Merge: PR merged and task state reconciled.
- Cleanup: managed worktree, processes, temporary browser profile, Docker resources, and safe local branch are absent.

Report only the minimum evidence needed for the requested operation.
