---
name: dev-start
description: Auto-detect and start dev servers for TypeScript/Node projects. Worktree-aware.
---

# dev-start — Auto-detect Dev Server Startup

Automatically detects project type and starts the appropriate dev server. Works in any directory, including git worktrees.

---

## Quick Start

```bash
# From inside your project or worktree
dev-start
```

The script auto-detects:
1. Package manager (pnpm > yarn > npm)
2. Available scripts (dev, start:dev, serve, start)
3. Monorepo setup and workspace app roles
4. One backend and one frontend when both exist

---

## What It Detects

### Package Manager Priority
1. `pnpm-lock.yaml` → pnpm
2. `yarn.lock` → yarn
3. `package-lock.json` → npm
4. Default → pnpm

### Script Priority
Checks `package.json` scripts in this order:
1. `dev` — most common
2. `start:dev` — NestJS convention
3. `serve` — Vue/some frameworks
4. `start` — fallback

### Monorepo Detection
- If `turbo.json` exists → uses `turbo dev`
- If `pnpm-workspace.yaml` exists → inspects workspace packages and starts backend/frontend candidates
- If `nx.json` exists → uses `nx run-many --target=dev`

### Safe Defaults
- Prefers interactive entrypoints such as API/server/gateway + frontend/dashboard/web
- De-prioritizes worker-style packages such as worker, consumer, queue, cron, scheduler, AI/ML, analysis, ingestion

---

## Usage

### Basic (auto-detect everything)
```bash
dev-start
```

### With filter (monorepos)
```bash
dev-start --filter @myorg/api    # pnpm filter
dev-start --filter api           # turbo/nx filter
```

### Specific script
```bash
dev-start --script start:dev
```

### Dry run (show what would run)
```bash
dev-start --dry-run
```

---

## Worktree Awareness

When run inside a worktree:
- Uses the worktree's `package.json`
- Uses the worktree's `.env` (with remapped ports from wtc)
- Merges local override env files after `.env`: `.env.local`, `.env.development.local`, `~/.config/dev-start/env`, and sorted `~/.config/dev-start/env.d/*.env`
- Starts servers bound to worktree-specific ports

No extra configuration needed — just run from inside the worktree.

---

## Environment Variables

The script respects these env vars if set:

| Variable | Purpose |
|----------|---------|
| `DEV_START_PM` | Force package manager (pnpm, yarn, npm) |
| `DEV_START_SCRIPT` | Force script name |
| `DEV_START_FILTER` | Default filter for monorepos |

Local override files are for machine-specific dependency URLs or credentials that must not be committed. Later files win, so a file in `~/.config/dev-start/env.d/` can override project defaults for every worktree on the machine.

---

## Integration with wtc

Typical workflow:
```bash
# 1. Start Docker infra (from repo root)
wtc start <index>

# 2. Enter the worktree
cd <worktree-path>

# 3. Fix ports
wtc-fix-ports

# 4. Start dev servers
dev-start
```

---

## Troubleshooting

### "No package.json found"
You're not in a Node/TypeScript project directory.

### "No dev script found"
Your `package.json` doesn't have `dev`, `start:dev`, `serve`, or `start` scripts.
Use `--script <name>` to specify a custom script.

### Wrong package manager detected
Set `DEV_START_PM=pnpm` (or yarn/npm) before running.

### Monorepo runs everything, I want just one service
Use `--filter`:
```bash
dev-start --filter @hena-wadeena/identity
```

---

## Scripts Bundled with This Skill

| Script | Purpose |
|--------|---------|
| `dev-start` | Auto-detect and start dev servers |

Run from anywhere:
```bash
bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/dev-start/scripts/dev-start"
```

Or add to PATH for direct invocation.
