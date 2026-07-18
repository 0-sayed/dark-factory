# Dependencies

This is the installation checklist for dependencies that are not bundled as
source in this repository. Immutable repository revisions are recorded in
[`dependencies.lock.json`](../dependencies.lock.json), which is the source of
truth for fork URLs and commit SHAs.

Follow [`setup.md`](setup.md) for installation and verification.

## Core Dependencies

| Dependency                  | Tested Version                                          | Source                                                                                   |
| --------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Agent Orchestrator fork     | Locked repository revision                              | <https://github.com/0-sayed/agent-orchestrator>                                          |
| worktree-compose fork       | Locked repository revision                              | <https://github.com/0-sayed/worktree-compose>                                            |
| Archon CLI                  | `0.5.0`                                                 | <https://github.com/coleam00/Archon/releases/tag/v0.5.0>                                 |
| Superpowers Codex plugin    | `6.0.3` (`v6.0.3`)                                      | <https://github.com/obra/superpowers>                                                    |
| `fix-merge-conflicts` skill | Content hash `9a539a5c5359e25c9a57df5a741e42524f2fe3c8` | <https://github.com/cursor/plugins/tree/main/cursor-team-kit/skills/fix-merge-conflicts> |

Dark Factory-owned AO plugins are included in `ao-plugins/`. Required custom
skills, Archon workflows, and Archon helper scripts are snapshotted in
`distribution/`.

Install the external conflict-resolution skill through skills.sh tooling:

```bash
npx -y skills add cursor/plugins --skill fix-merge-conflicts
```

The recorded content hash identifies the currently tested installed snapshot.

Clone the two fork repositories beside this repository, or set
`DARK_FACTORY_AO_CHECKOUT` and `DARK_FACTORY_WTC_CHECKOUT` to their checkout
paths. Verify that both checkouts match the tested revisions with:

```bash
node scripts/verify-dependencies.mjs
```

## Machine Dependencies

| Tool                                    | Tested Version                                           |
| --------------------------------------- | -------------------------------------------------------- |
| Linux                                   | Current supported platform                               |
| Node.js                                 | `22.14.0`                                                |
| Go                                      | `1.25.7` or newer, required to build AO                  |
| npm and Corepack                        | Required with Node.js                                    |
| Python                                  | Python 3 required by `pr-resolve`                        |
| pnpm                                    | `10.26.2`                                                |
| Bun                                     | `1.3.6`                                                  |
| Codex CLI                               | `0.144.5`                                                |
| GitHub CLI                              | `2.83.2`                                                 |
| Docker Engine and Docker Compose plugin | Docker `29.1.3`; Compose v2 required                     |
| agent-browser                           | `0.24.1`                                                 |
| Google Chrome                           | Required for browser QA                                  |
| POSIX shell                             | `/bin/sh` on Unix; Git Bash or Bash on Windows           |
| tmux                                    | Required by AO on Linux and macOS                        |
| SQLite CLI                              | Required by Dark Factory recovery checks                 |
| patchutils                              | Required by the commit skill for partial staging         |
| `ss` or `lsof`                          | Required for local development readiness checks          |
| procps and util-linux                   | Required for browser process and session isolation tools |
| git, Corepack, and curl                 | Required                                                 |

The Vercel CLI is not required. The bundled `vercel-browser` skill uses Google
Chrome and `agent-browser`.

macOS and Windows are not currently supported. Cross-platform worker helpers do
not imply that the complete Dark Factory installation has been qualified on
those operating systems.

## Target Project Requirements

- A GitHub repository with an authenticated `origin` remote.
- A committed planning folder with the supported Task Graph.
- A discoverable repository validation command.
- A runnable local development environment.
- Docker Compose only when the target project requires local services.
- PostgreSQL client (`psql`) is optional and required only when a target project
  uses automatic local OAuth redirect registration against PostgreSQL.

Secrets, GitHub credentials, browser profiles, and application login state stay
local and must never be added to this repository.
