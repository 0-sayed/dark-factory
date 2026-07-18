# Architecture

Dark Factory owns orchestration. AO owns worker execution resources, and
Archon owns implementation inside each AO-created worktree.

## Ownership

| Layer            | Owns                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Dark Factory     | Task selection, concurrency and task budgets, dependency gating, recovery decisions, merge ordering, reconciliation, and cleanup coordination |
| Go AO            | Project records, worker sessions, worktrees, processes, lifecycle state, reports, and logs                                                    |
| Archon           | Feature planning, implementation, repository validation, QA, commits, PR creation, and merge preparation                                      |
| GitHub           | Authoritative PR state, checks, review threads, and merge result                                                                              |
| worktree-compose | Optional per-worktree Docker Compose isolation and resource teardown                                                                          |

Project registration and configuration sync run through the Go AO daemon API.
Dark Factory loads its repository-local tracker and worker plugins through the
AO project configuration; teammates do not install those plugins globally.

## Lifecycle

```text
Task Graph
  -> Dark Factory selects dependency-unblocked tasks within the run budget
  -> Go AO creates one worker session and worktree per selected task
  -> Archon auto-feature plans, implements, validates, performs QA, and ships
  -> the worker runs auto-merge preparation and resolves review feedback
  -> Dark Factory serializes final merge attempts by priority and task id
  -> GitHub merge truth is reconciled back into task and AO state
  -> Dark Factory coordinates browser, process, Docker, branch, and worktree cleanup
```

Stale failed GitHub check runs are handled by the worker review lifecycle. Dark
Factory consumes the resulting ready, blocked, or merged evidence rather than
repairing feature code itself.

## Controller Isolation Rule

The controller may inspect worker state, restore the owning AO session, and run
approved orchestration or cleanup operations. It must never edit feature files,
commit, push, or resolve conflicts inside a managed worker worktree.

Durable state records this as
`controller_must_not_mutate_worker_worktree`. Recovery points back to the
owning worker session instead of creating an untracked manual repair path.

## Repository Boundaries

| Path                   | Purpose                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `orchestrator/`        | Dark Factory controller, observer, scheduler, dashboard, and tests |
| `ao-plugins/`          | Repository-local tracker and Archon worker adapters                |
| `distribution/`        | Reviewed snapshots installed into Archon and agent-skill homes     |
| `skills/dark-factory/` | Operator-facing control-plane skill                                |
| `templates/`           | Target-project planning starter                                    |
| `.dark-factory/`       | Ignored local registry, runtime state, events, and dashboards      |

AO and worktree-compose source are not vendored. Their fork URLs and exact
tested revisions are owned by `dependencies.lock.json`.

## Archon Workspace Warning

AO already creates the worker worktree. The Archon worker therefore runs
`auto-feature` with `--no-worktree` inside that workspace. A workspace source
symlink warning is harmless unless the workflow exits unsuccessfully.
