# wtc Skill Decisions

This document explains the intent and reasoning behind decisions in this skill.

---

## Why This Skill Exists

`wtc` (worktree-compose) provides Docker Compose isolation for git worktrees. However, it has limitations and quirks that caused problems in practice. This skill documents workarounds and provides helper scripts.

---

## Decision: Port Collision Fix (`wtc-fix-ports`)

### Problem
wtc's port formula `20000 + default_port + worktree_index` creates collisions when services have consecutive ports:

```
Services: 8001, 8002, 8003, 8004

WT1: 28002, 28003, 28004, 28005
WT2: 28003, 28004, 28005, 28006  ← collision!
```

### Solution
Use `index * 100` offset instead of just `index`:

```
WT1: 28101, 28102, 28103, 28104
WT2: 28201, 28202, 28203, 28204  ← no collision
```

### Why a script instead of fixing wtc?
- wtc is a third-party tool, we can't modify it
- The script patches .env after wtc runs
- Generic solution works for any project

---

## Decision: Fast Startup (`wtc-up`)

### Problem
`wtc start` always runs `docker compose up -d --build`. The `--build` flag:
- Rebuilds images from Dockerfiles
- Checks network for base image updates
- Wastes bandwidth and time when images already exist

### Solution
`wtc-up` script runs `docker compose up -d` without `--build`:
- Uses existing images
- No network checks
- Fast startup for daily use

### When to use which
| Command | When |
|---------|------|
| `wtc start <index>` | First time, or after Dockerfile changes |
| `wtc-up` | Daily startup, images already built |

---

## Decision: Database Readiness Warning

### Problem
wtc starts Docker containers but doesn't:
- Run database migrations
- Seed data
- Verify schema state

Agents assumed "container running = ready to use" and wasted time debugging missing data.

### Solution
Document in SKILL.md that database readiness is separate from container readiness. Remind to check migrations/seeds.

---

## Decision: Generic Skill (No Project-Specific Content)

### Problem
Earlier versions had project-specific content (port tables, service names, make commands). This made the skill:
- Unusable for other projects
- Harder to maintain
- Confusing when content didn't match current project

### Solution
Keep skill generic. Project-specific details go in:
- Project's CLAUDE.md
- Project's Makefile
- Project's documentation

---

## Decision: Separation from Browser Automation

### Problem
Browser automation skill (`/vercel-browser`) previously tried to auto-start infrastructure, causing 5+ minute debugging spirals when things weren't set up correctly.

### Solution
Clean separation:
- `/wtc` — Docker Compose isolation only
- `/vercel-browser` — Browser automation only
- App startup — Project-specific (make dev, pnpm dev, etc.)

Each layer assumes the previous layer is already working.

---

## Scripts in This Skill

| Script | Purpose |
|--------|---------|
| `wtc-fix-ports` | Fix port collisions for consecutive service ports |
| `wtc-up` | Fast startup without --build flag |

Both are generic and work with any project.

---

## Future Considerations

- If wtc adds a `--no-build` flag, `wtc-up` becomes unnecessary
- If wtc fixes the port formula, `wtc-fix-ports` becomes unnecessary
- Watch wtc releases for these improvements
