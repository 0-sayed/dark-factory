# Dark Factory

A [dark factory](https://en.wikipedia.org/wiki/Lights_out_%28manufacturing%29) is a factory that can keep working with little human help. This project brings
that idea to software development: AI agents plan, write code, test, review,
open PRs and merge them.

You provide a [planning folder](docs/planning.md) describing what to build. The
first [bootstrap pull request](templates/planning/bootstrap.md) runs with human
supervision and is merged manually. After that, Dark Factory handles the rest.

You control each run with two limits:

- **Parallel task limit:** how many tasks can run at the same time.
- **Run task limit:** the maximum number of tasks Dark Factory starts in one run.

## System Overview

| Part                                                                | Purpose                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dark Factory                                                        | Coordinates tasks, workers, merges, recovery, and cleanup                                                                                                                                                                                                               |
| [Agent Orchestrator](https://github.com/0-sayed/agent-orchestrator) | Manages workers, worktrees, processes, and logs                                                                                                                                                                                                                         |
| [AO Plugins](ao-plugins/)                                           | Connect AO workers to Archon and report their lifecycle to Dark Factory                                                                                                                                                                                                 |
| [Archon](https://github.com/coleam00/Archon)                        | Runs step-by-step agent workflows: prompt -> shell command -> prompt -> ...                                                                                                                                                                                             |
| [Archon Workflows](distribution/archon-workflows/)                  | Runs implementation with [`auto-feature`](distribution/archon-workflows/auto-feature.yaml), review cleanup with [`auto-squash`](distribution/archon-workflows/auto-squash.yaml), and merge readiness with [`merge-gate`](distribution/archon-workflows/merge-gate.yaml) |
| [Dark Factory Skill](skills/dark-factory/)                          | Teaches your agent how to use Dark Factory                                                                                                                                                                                                                              |
| [Planning Templates](templates/planning/)                           | Help create the project context, roadmap, and bootstrap                                                                                                                                                                                                                 |

## Getting Started

Linux is the only currently supported platform.

1. Complete the [setup guide](docs/setup.md).
2. Create the target repository's `planning/` folder by following the
   [planning guide](docs/planning.md).
3. Complete T000 by following the target repository's
   [`planning/bootstrap.md`](templates/planning/bootstrap.md) with human
   supervision. Merge its pull request manually, mark T000 complete, and update
   local `main` from `origin/main`. Do not run Dark Factory before this gate is
   complete.
4. Ask your agent:

   > Use the [Dark Factory skill](skills/dark-factory/) to start `<repository-path>`.

**Documentation:** [Setup](docs/setup.md) | [Planning](docs/planning.md) | [System Flow](docs/system-flow.md) | [Architecture](docs/architecture.md) | [Dependencies](docs/dependencies.md) | [Planning Contract](docs/planning-contract.md) | [Operator Guide](skills/dark-factory/references/operator-guide.md) | [Distribution](distribution/README.md)
