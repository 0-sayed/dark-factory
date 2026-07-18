# Dark Factory Planning Contract

Status: reusable contract.

## Required Files

Each target project has a planning folder. New projects start with:

- `planning/bootstrap.md`
- `planning/roadmap/tasks.md`

When registering a project, point Dark Factory at the planning folder:

```bash
node orchestrator/dark-factory.js init --project my-project --planning ../my-project/planning
```

`init` validates that `roadmap/tasks.md` exists and records the project in `.dark-factory/projects.json`. Project registration and configuration sync then run through the Go AO daemon API; no daemon project state is generated in this repository.

For a new project, start from the copyable templates:

- `templates/planning/bootstrap.md`
- `templates/planning/roadmap/tasks.md`

The bootstrap template defines the human-supervised repository foundation. Its
T000 pull request must be merged manually and mark T000 complete. You must not
run Dark Factory while T000 is incomplete. After the merge, update local `main`
from `origin/main`, then register the project and preview scheduling with a
dry-run.

The planning folder and completed T000 bootstrap must be committed before real
orchestration starts. AO creates worker worktrees from Git state, so uncommitted
planning changes in the source checkout are not visible inside spawned workers.

Before scheduling, Dark Factory runs a planning freshness preflight:

- fetch `origin` for the target project when an `origin` remote exists
- require local `defaultBranch` to match `origin/defaultBranch`
- require the planning folder to have no uncommitted changes

Multiple projects are supported. Register each project with a unique `--project` id, then run one project at a time with:

```bash
node orchestrator/dark-factory.js run --project my-project --dry-run
```

## Required Table

### Task Graph

Required columns:

| Column       | Meaning                                                               |
| ------------ | --------------------------------------------------------------------- |
| `Done`       | `[x]` means complete; anything else means incomplete.                 |
| `Priority`   | Lower number runs and merges first among currently unblocked tasks.   |
| `Task`       | Task id and title, for example `` `T004` - Auth polish ``.            |
| `Depends On` | Comma-separated task ids, or `-` / `—` for none.                      |
| `Branch`     | Exact branch AO should create for the task.                           |
| `Context`    | Comma-separated planning/context files to include in the task prompt. |

Optional visualization can live beside it, for example `planning/roadmap/dependencies.mmd`, but Mermaid is not source of truth. The Task Graph table owns dependencies, priority, branches, status, and context.

## Scheduling Rule

The Task Graph is a DAG. A task is runnable when:

1. Its row is not `[x]`.
2. Every dependency is effectively complete.
3. It is not already active or observed as `blocked`, `failed`, `stale`, `done`, or `merged`.

Dark Factory fills available worker slots up to `--concurrency` from all runnable tasks, sorted by `Priority` then task id.
When `--task-limit <n>` is set, a single top-level Dark Factory run may start or resume at most N tasks total, even if `--concurrency` is higher.

In Dark Factory runtime:

1. An AO worker runs `auto-feature`, updates its own Task Graph row in the PR, ships the PR, and runs `$auto-merge --mode prepare`.
2. Dark Factory treats `tasks.md [x]`, observed `completed`, observed `done`, or observed `merged` as effective task completion so stale roadmap checkboxes do not freeze scheduling.
3. Dark Factory finalizes ready PRs one at a time by `Priority` then task id.
4. After each merge, Dark Factory refreshes the project main checkout, re-reads the Task Graph, and reruns `$auto-merge --mode prepare` for remaining ready PRs before finalizing the next one.
5. Failed or blocked tasks block their descendants through dependencies, not unrelated runnable work.

`--concurrency` remains the active-worker cap. `--task-limit` is a per-run start/resume budget that counts both restored sessions and brand-new launches together.

Stale failed GitHub check runs are filtered by `$auto-merge`. Dark Factory does not inspect historical check runs; it trusts the ready or merged signal produced after prepare/finalize.

## Control Rule

`pause` writes durable project control state and stops new launches by forcing concurrency to zero. It does not kill active workers and does not prevent ready PR finalization.

`stop` writes durable stopped state and terminates active AO worker sessions. It does not delete worktrees, clean resources, or launch replacements.

`recover` writes durable recovering state, observes the project, and restores recoverable sessions in recover-only mode so no brand-new tasks launch during recovery.

`resume` switches the project back to active scheduling. `status` prints the current control state.

## Controller Isolation Rule

Dark Factory controls scheduling, observation, recovery, cleanup, and merge queue transitions. It does not become the feature implementer for a worker worktree. This applies to fresh tasks, resumed tasks, failed tasks, and ready PRs.

Every runner state must record that controller-side worker worktree mutation is forbidden. If a worker PR or merge queue step blocks, the durable blocked state must point to `resume_worker_session`. The controller may resume the AO/Archon worker session or report the blocker. It must not directly mutate project feature code in the worker worktree.

## Validation Rule

The tracker fails loudly when:

- a task id is duplicated
- a task depends on a missing task
- dependencies contain a cycle

## AO Mapping

The local `tasks-md` tracker plugin maps:

- `getIssue(Txxx)` -> one Task Graph row
- `branchName(Txxx)` -> Task Graph `Branch`
- `generatePrompt(Txxx)` -> selected task packet with task id, title, branch, tasks path, priority, dependencies, and context files
- `listIssues({ state: "open" })` -> runnable DAG tasks sorted by priority then task id
- `listIssues({ state: "closed" })` -> completed tasks
- `listIssues({ state: "all" })` -> all tasks
