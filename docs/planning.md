# Planning A Project

Dark Factory needs a planning folder before it can schedule work. The folder
describes what the project is, how it should be built, and which tasks may run.

## Start From The Templates

Copy the provided [`bootstrap.md`](../templates/planning/bootstrap.md) and
[`tasks.md`](../templates/planning/roadmap/tasks.md) templates into the target
repository:

```text
planning/
  bootstrap.md
  context/
    business/
    technical/
  roadmap/
    tasks.md
    dependencies.mmd
```

Only `bootstrap.md` and `roadmap/tasks.md` are required. Add context files and
`dependencies.mmd` when they help agents understand the project.

## Build The Context

Keep context files focused. Link each task only to the files it needs.

- `context/business/`: users, product goals, domain rules, and expected
  behavior.
- `context/technical/`: architecture, data model, APIs, integrations, security,
  and operational constraints.
- `roadmap/dependencies.mmd`: an optional Mermaid view of task dependencies. It
  helps humans, but the Task Graph remains the source of truth.

> **Tip:** Ask the agent to build the `roadmap/` folder based on the `context/`
> folder.

## Build The Task Graph

Use one table in `roadmap/tasks.md`. Each row needs:

- completion status
- numeric priority
- a unique task id and title
- dependency task ids
- the exact feature branch
- links to the context files needed for that task

Make tasks small enough for one worker and one pull request. A task may start
only after all of its dependencies are complete. See the
[planning contract](planning-contract.md) for the exact table format and
scheduling rules.

## Complete Bootstrap First

T000 prepares the repository for autonomous work. Complete it with human
supervision, merge its pull request manually, mark it complete in the Task
Graph, and update local `main` from `origin/main`.

Do not start Dark Factory until the planning folder and completed bootstrap are
committed to the target repository.
