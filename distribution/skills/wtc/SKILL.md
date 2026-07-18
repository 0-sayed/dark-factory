---
name: wtc
description: Use when user invokes /wtc to work with Docker Compose worktree isolation, start/stop infra per worktree, or check worktree status
---

# wtc — worktree-compose

Zero-config Docker Compose isolation for git worktrees. Each worktree gets its own containers, ports, and volumes — no conflicts when running multiple branches simultaneously.

**Repo:** https://github.com/0-sayed/worktree-compose

The active `wtc` binary must be installed on `PATH`. Verify with:

```bash
command -v wtc
wtc --version
```

---

## Port Formula

```
remapped_port = 20000 + default_port + stable_slot * portStride
```

`stable_slot` is based on existing Docker Compose projects for the branch, so
cleanup or a changed `git worktree list` order does not make a live worktree
reuse another worktree's ports. Run `wtc ls` to see `index` and `slot`; values
like `1 (5)` mean visible index 1 is using stable slot 5.

---

## Port Collision Problem

The default formula `20000 + port + index` creates collisions when services have consecutive ports:

```
Service ports: 8001, 8002, 8003, 8004

WT1: 28002, 28003, 28004, 28005
WT2: 28003, 28004, 28005, 28006  ← overlaps WT1
WT3: 28004, 28005, 28006, 28007  ← overlaps WT1 & WT2
```

**Fix:** Set `portStride` in `.wtcrc.json` so each slot gets its own port band:

```
WT1: 28101, 28102, 28103, 28104
WT2: 28201, 28202, 28203, 28204  ← no overlap
WT3: 28301, 28302, 28303, 28304  ← no overlap
```

Current WTC releases handle this directly. The bundled
`wtc-fix-ports` script is legacy fallback only; do not use it as the primary
path unless the local WTC binary is unavailable.

---

## Database Readiness

`wtc` isolates Docker infra. It does NOT guarantee database state.

**After `wtc start`, before starting your app:**

1. Verify database is reachable on the remapped port
2. Run migrations if needed
3. Run seeds if needed

Do NOT assume a running database means migrations are applied or seed data exists.

---

## Commands

**CRITICAL: Always run wtc from the repo root**, not from inside a worktree.

```bash
wtc ls                  # list all worktrees with indices, status, ports
wtc start 1 3           # start infra for worktrees by index
wtc stop 1 3            # stop (preserves volumes)
wtc restart 1           # stop → resync → rebuild → start
wtc promote 1           # copy worktree changes into current branch
wtc clean               # stop all, remove all worktrees + prune Docker (DESTRUCTIVE)
```

---

## Workflow

```bash
# 1. From repo root
cd /path/to/repo
wtc ls                    # see worktree indices
wtc start <index>         # start Docker infra

# 2. Move into worktree
cd <worktree-path>

# 3. Check database readiness
# Run migrations/seeds if needed

# 4. Start app (project-specific)
# e.g., make dev, pnpm dev, npm run dev
```

---

## What wtc Does

1. Creates isolated Docker Compose project per worktree
2. Remaps ports so each worktree has unique ports
3. Syncs docker-compose.yml and .env from main branch
4. Injects port overrides into worktree's .env

---

## What wtc Does NOT Do

- Start your app servers (backend, frontend)
- Run database migrations
- Seed data
- Manage browser automation

These are project-specific — handle them via Makefile, scripts, or the repo's instructions file.

---

## Port Requirements

wtc can only remap ports declared with env var defaults:

```yaml
# wtc can remap
ports:
  - "${POSTGRES_PORT:-5432}:5432"

# wtc skips (hardcoded)
ports:
  - "5432:5432"
```

---

## Gotchas

- **Run from repo root** — wtc derives project name from current directory
- **wtc syncs from main** — worktree-local docker-compose.yml changes are overwritten
- **--build flag** — `wtc start` runs `docker compose up -d --build`, which checks network for image updates. For fast startup after first run, use `wtc-up` script (see below).
- **Consecutive ports can collide when `portStride` is too small** — see Port Collision Problem above

---

## Optional: wtc as MCP Server

```json
{
  "mcpServers": {
    "wtc": {
      "command": "wtc",
      "args": ["mcp"]
    }
  }
}
```

---

## Optional: .wtcrc.json

```json
{
  "sync": [".generated/prisma-client"],
  "envOverrides": {
    "VITE_API_URL": "http://localhost:${BACKEND_PORT}"
  }
}
```

---

## Scripts Bundled with This Skill

| Script | Purpose | When to use |
|--------|---------|-------------|
| `wtc-fix-ports` | Legacy fallback for old WTC installs | Only if the installed WTC lacks native port isolation |
| `wtc-up` | Fast startup (no --build) | Daily startup when images already exist |

### wtc-up (Fast Startup)

`wtc start` always uses `--build` which checks network for base image updates. Use `wtc-up` for fast startup:

```bash
cd <worktree-path>
bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/wtc/scripts/wtc-up"
```

**When to use which:**
- `wtc start <index>` — First time setup, or after Dockerfile changes
- `wtc-up` — Daily startup, images already built, no network checks

---

## Additional Resources

See [DECISIONS.md](DECISIONS.md) for the reasoning behind design decisions in this skill.
