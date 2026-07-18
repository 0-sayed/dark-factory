# Dark Factory Operator Guide

Use this reference for project setup, controller operation, recovery, and cleanup. Dark Factory remains the only control-plane entry point.

## Source Of Truth

Resolve the runtime checkout containing `orchestrator/dark-factory.js` and set it as `DARK_FACTORY_HOME`.

Before a mutating command, run:

```bash
node "$DARK_FACTORY_HOME/orchestrator/dark-factory.js" --help
```

The live CLI and registered project state override examples in this guide. Do not compensate for a missing controller capability by operating AO, Archon, merge skills, or worker worktrees manually.

## System Ownership

```text
Dark Factory
  -> selects runnable Task Graph entries
  -> enforces concurrency and task-limit budgets
  -> asks AO to create or restore managed workers/worktrees
  -> AO worker runs Archon auto-feature with --no-worktree
  -> auto-feature plans, implements, validates, performs QA, commits, and ships
  -> worker runs auto-merge prepare, including auto-squash review cleanup
  -> Dark Factory orders ready PRs and runs merge finalization
  -> Dark Factory reconciles task/PR truth and coordinates cleanup
```

Ownership boundaries:

- The target project's Task Graph is scheduling truth.
- Dark Factory owns cross-task scheduling, supervision, merge order, and cleanup coordination.
- AO owns worker sessions and worktrees.
- Archon owns the feature workflow inside the AO worktree.
- The assigned worker owns feature code mutation.
- GitHub PR/check truth overrides stale worker status during reconciliation.
- Operators inspect lower layers but do not bypass the controller to mutate them.

## Target Project Readiness

Before registration or execution, verify:

- the target is a Git repository with an `origin` remote and default branch;
- its planning folder is committed and clean;
- `planning/roadmap/tasks.md` contains the supported single Task Graph table;
- task dependencies and referenced context files exist;
- the repository exposes a validation command in `AGENTS.md` or project tooling;
- required local dev services can be started;
- Docker Compose exists when the project needs isolated services;
- GitHub CLI authentication and required branch checks are usable;
- required secrets stay in ignored local files or configured environment sources.

Dark Factory fetches `origin` before scheduling and refuses to run when the local default branch or planning state is unsafe.

## Project Registration

Register a project once from the Dark Factory runtime checkout:

```bash
node "$DARK_FACTORY_HOME/orchestrator/dark-factory.js" init \
  --project <id> \
  --planning <target-planning-path>
```

Useful registration options:

| Option                        | Purpose                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `--ao-command <command>`      | Store a non-default AO launcher.                                     |
| `--worker-plugin <name>`      | Select the AO worker plugin; normal value is `archon`.               |
| `--env-file <from -> to>`     | Copy an environment file into a new worker when missing; repeatable. |
| `--cleanup-command <command>` | Run project-owned cleanup inside eligible worktrees; repeatable.     |
| `--registry <path>`           | Override the project registry location.                              |
| `--tasks-file <path>`         | Override the Task Graph file when supported by the current CLI.      |

Use `init` again to update or add registered projects. Project registration and configuration sync run through the Go AO daemon API; do not hand-edit daemon project state.

## Controller Commands

All commands run through:

```text
node "$DARK_FACTORY_HOME/orchestrator/dark-factory.js" <command>
```

| Command                                 | Meaning                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `init --project <id> --planning <path>` | Register or update a target project.                                                                        |
| `run --project <id> --dry-run`          | Observe, reconcile, and preview scheduling without spawning workers. May regenerate local factory state.    |
| `run --project <id> --run`              | Start supervised scheduling and worker execution.                                                           |
| `pause --project <id>`                  | Stop new launches while existing workers and ready PR handling continue.                                    |
| `stop --project <id> --dry-run`         | Preview stop scope.                                                                                         |
| `stop --project <id> --run`             | Fence scheduling and stop managed worker activity while preserving worktrees/resources. Verify every layer. |
| `recover --project <id> --dry-run`      | Preview recovery of existing managed work only.                                                             |
| `recover --project <id> --run`          | Restore recoverable sessions without launching new tasks.                                                   |
| `resume --project <id>`                 | Set scheduling active; verify that a live controller actually supervises it.                                |
| `status --project <id>`                 | Read controller state; correlate it with live AO, Archon, GitHub, and process truth.                        |
| `cleanup --project <id> --dry-run`      | Preview managed cleanup without scheduling new work. Generated state may still change.                      |
| `cleanup --project <id> --run`          | Execute approved scoped cleanup.                                                                            |
| `dashboard`                             | Generate or refresh the all-project dashboard.                                                              |

## Run Controls

| Option                                    | Meaning                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `--concurrency <n>`                       | Maximum active AO sessions for the project. Default is automatic and capped at 4.                       |
| `--task-limit <n>`                        | Maximum tasks started or resumed by this run. It accepts any positive integer; omitted means unlimited. |
| `--session <id>`                          | Limit `cleanup` to a specific AO session; repeatable for an explicit multi-session scope.               |
| `--supervision-interval-ms <ms>`          | Delay between autonomous supervision passes.                                                            |
| `--max-autonomous-supervision-passes <n>` | Maximum controller supervision passes.                                                                  |
| `--stale-after-ms <ms>`                   | Threshold used to classify active sessions as stale.                                                    |
| `--cleanup`                               | Enable completed-session/worktree cleanup during a run; default behavior.                               |
| `--no-cleanup`                            | Skip completed-session/worktree cleanup for this run.                                                   |

Never invent concurrency or task-limit values for a production run. Use the values requested by the user.

## Path And Integration Overrides

These are advanced options. Prefer registered defaults and use them only after checking live help and project configuration.

| Option                              | Meaning                                        |
| ----------------------------------- | ---------------------------------------------- |
| `--project-config <path>`           | Legacy or explicit project configuration path. |
| `--registry <path>`                 | Project registry path.                         |
| `--ao-command <command>`            | Store or temporarily override the AO launcher. |
| `--worker-plugin <name>`            | AO worker execution adapter.                   |
| `--state-path <path>`               | Runner state path.                             |
| `--observability-state-path <path>` | Observability snapshot path.                   |
| `--event-log-path <path>`           | Append-only event log path.                    |
| `--dashboard-output-path <path>`    | Dashboard output path.                         |

Project-specific runtime environment belongs in project configuration, not hardcoded worker-plugin logic.

## Safe Start Procedure

1. Inspect registration, target repository cleanliness, default-branch sync, Task Graph, and live processes.
2. Run `status` and correlate all layers.
3. Run `run --dry-run` with the intended concurrency and task limit.
4. Report selected tasks, existing recoverable work, merge candidates, cleanup scope, and blockers.
5. After explicit authorization, run with `--run` and the same budget.
6. Keep the controller process alive and observe controller-reported state.

Start the Go AO daemon through the Agent Orchestrator desktop app, or use `ao daemon` from an AO development checkout. Dark Factory performs project registration and configuration sync through the daemon API before it manages worker sessions.

## State Interpretation

- `active` is desired control mode, not proof that the controller is alive.
- `paused` suppresses new launches; it does not stop existing workers.
- `stopped` preserves worktrees and resources for recovery.
- `recovering` allows existing-work restoration and suppresses fresh launches.
- A failed or killed AO session does not prove the task failed when a PR exists.
- A green or merged PR can advance reconciliation even when worker status is stale.
- Review lifecycle processes such as auto-merge, auto-squash, and quiet-window waiters count as active worker ownership between Archon runs.
- Cleanup failure is `cleanup_failed`; it must not overwrite a merged feature outcome.

Status must answer:

- Is the controller process/lease alive?
- Which AO workers are active, stopped, failed, or merged?
- Which Archon run and workflow stage belongs to each worker?
- Which PR/check/review state is current?
- Which tasks were charged to the current task-limit budget?
- What is the single next controller action?

## Recovery Procedure

Reconcile in this order:

1. GitHub PR and current required checks.
2. AO session and worktree identity.
3. Recorded Archon run and durable workflow artifacts.
4. Worker process/runtime state.
5. Task Graph status and dependency readiness.

Then resume the owning worker at the latest incomplete stage through Dark Factory. If a PR already exists, recover from PR/auto-merge state rather than rerunning feature implementation.

Never repair feature code, QA output, commits, review threads, or merge conflicts from the controller. If recovery cannot proceed, report one problem, three options, and one recommendation.

## Stop Procedure

`stop --run` is not cleanup. After invoking it, verify:

1. new scheduling is fenced;
2. the parent Dark Factory controller is stopped;
3. managed AO worker sessions are stopped;
4. spawned Archon workflow processes are stopped;
5. worktrees, containers, volumes, browser-auth state, and branches remain intact.

If any layer remains live, report stop as incomplete.

## Cleanup Procedure

Cleanup requires no live controller, AO worker, or Archon workflow for the selected resources.

Go AO cleanup is a two-stage lifecycle: Dark Factory requests termination, waits for AO to report the session terminated, then invokes project-scoped workspace reclaim. A merged task or stopped process alone does not prove its worktree was removed.

1. Run cleanup preview, using repeatable `--session <id>` options when cleanup must be limited to specific AO sessions.
2. Enumerate exact eligible processes, temporary browser profiles, project cleanup commands, Docker Compose resources, completed worktrees, and safe local merged branches.
3. Obtain explicit approval for that scope.
4. Run cleanup.
5. Verify each approved resource is absent and retained audit state still exists.

Safety rules:

- Never use broad `wtc clean`.
- Never delete unrecorded or unrelated Docker resources.
- Preserve persistent browser profiles and browser-auth state.
- Preserve a worktree when browser or resource cleanup fails.
- Do not delete worktrees with uncommitted or user-owned changes.
- Do not treat stop authorization as cleanup authorization.

## Troubleshooting Boundaries

Inspect AO, Archon, GitHub, browser, Docker, and worktree state to locate the failing layer. Apply repairs through the owning layer only:

- controller/scheduler defect: change Dark Factory as a separate development task;
- worker implementation/QA/CI/review defect: resume the owning worker;
- AO lifecycle defect: recover through Dark Factory and separately fix AO only when explicitly requested;
- Archon workflow defect: report it and request explicit permission before editing workflow files;
- target-project infrastructure/auth dependency: start or configure it through declared project setup, never project-specific worker hacks;
- cleanup defect: preserve resources and report `cleanup_failed`.

Do not turn an operational incident into an unapproved runtime refactor.

## Completion Criteria

- Start: controller alive, selected workers active, concurrency respected, task budget recorded.
- Recover: existing workers resumed without launching new features.
- Stop: controller, AO workers, and spawned Archon runs absent.
- Merge: PR merged, task status reconciled, descendants reevaluated.
- Cleanup: approved managed resources absent, persistent state preserved, no unrelated resources touched.
