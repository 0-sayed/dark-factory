---
name: vercel-browser
description: Launch Chrome in debug mode and automate browser interactions. Use when the user needs to navigate websites, interact with web pages, fill forms, take screenshots, or test web applications.
allowed-tools: Bash(agent-browser:*), Bash(google-chrome:*), Bash(pgrep:*), Bash(pkill:*), Bash(ss:*), Bash(sleep:*), Bash(curl:*), Bash(git:*), Bash(chrome-launch:*)
---

# Browser Automation with Worktree Isolation

Each worktree gets its own Chrome instance on a unique debug port and its own slim automation profile. No conflicts when running parallel browser automation and no dependency on your main Chrome profile.

Chrome launches with a large fixed window by default for predictable QA recording.
---

## Quick Start (Recommended)

```bash
# Launch Chrome
bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/vercel-browser/scripts/chrome-launch"

# Or launch and open a URL
bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/vercel-browser/scripts/chrome-launch" http://localhost:3000

# Then use agent-browser
agent-browser --session $SESSION --cdp $DEBUG_PORT open http://localhost:3000
```

The `chrome-launch` script:
1. Detects worktree index automatically
2. Launches Chrome with unique debug port
3. Reuses one slim profile per worktree by default
4. Opens Chrome at `CHROME_WINDOW_SIZE` or `1920,1080` by default
5. Supports `CHROME_WINDOW_POSITION=0,0` and `CHROME_WINDOW_SIZE=1600,1000`
6. Auto-loads saved local auth state for local URLs when `browser-auth` is installed

Optional auth reuse:

```bash
# Local URLs auto-load saved local auth state after launch, if browser-auth is installed
bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/vercel-browser/scripts/chrome-launch" http://localhost:3000

# Load a stable auth alias across worktrees/ports
BROWSER_AUTH_NAME=my-local-app-auth \
  bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/vercel-browser/scripts/chrome-launch" http://127.0.0.1:4173

# Disable local auth auto-load for this launch
BROWSER_AUTH_AUTO_LOAD=0 bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/vercel-browser/scripts/chrome-launch" http://localhost:3000

# Verify auth during launch and refresh through browser-auth when configured
BROWSER_AUTH_NAME=my-local-app-auth \
BROWSER_AUTH_VERIFY_URL=http://127.0.0.1:4172/user \
BROWSER_AUTH_LOGIN_URL=http://127.0.0.1:4173/login \
  bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/vercel-browser/scripts/chrome-launch" http://127.0.0.1:4173
```

`browser-auth` is optional. If it is not installed, has no saved state, or the URL is not local, Chrome still launches normally. Local auth auto-load is enabled by default only for local HTTP/HTTPS origins; public URLs are skipped. Set `BROWSER_AUTH_AUTO_LOAD=0` to disable it, or `BROWSER_AUTH_AUTO_LOAD=1` to request it explicitly. When `BROWSER_AUTH_NAME` is set, `chrome-launch` tries that saved auth alias first, then falls back to the exact launch URL origin. Use one alias per local app/session, for example `crm-admin-auth` and `billing-admin-auth`. When `BROWSER_AUTH_VERIFY_URL` or `BROWSER_AUTH_ENSURE=1` is set, `chrome-launch` calls `browser-auth ensure` instead of plain load.

---

## Manual Setup (Alternative)

### Step 1: Detect worktree and set ports

```bash
get_worktree_index() {
    local current_dir=$(pwd -P)
    local index=0
    while IFS= read -r line; do
        local wt_path=$(echo "$line" | awk '{print $1}')
        wt_path=$(cd "$wt_path" 2>/dev/null && pwd -P || echo "$wt_path")
        [[ "$current_dir" == "$wt_path" ]] && echo "$index" && return
        ((index++))
    done < <(git worktree list 2>/dev/null)
    echo "0"
}

WT_INDEX=$(get_worktree_index)
DEBUG_PORT=$((9222 + WT_INDEX))
SESSION="wt${WT_INDEX}"
PROFILE="${XDG_CACHE_HOME:-$HOME/.cache}/vercel-browser/profiles/wt${WT_INDEX}"

echo "Worktree: $WT_INDEX | Chrome: $DEBUG_PORT | Session: $SESSION"
```

### Step 2: Launch Chrome (if not running)

```bash
if ! pgrep -f "remote-debugging-port=$DEBUG_PORT" > /dev/null; then
    google-chrome \
        --remote-debugging-port=$DEBUG_PORT \
        --user-data-dir="$PROFILE" \
        --no-first-run --no-default-browser-check \
        --window-position="${CHROME_WINDOW_POSITION:-0,0}" \
        --window-size="${CHROME_WINDOW_SIZE:-1920,1080}" \
        --disable-extensions --disable-sync &
fi

```

### Step 3: Use agent-browser with session isolation

```bash
# ALWAYS include --session and --cdp on every command
agent-browser --session $SESSION --cdp $DEBUG_PORT open http://localhost:3000
agent-browser --session $SESSION --cdp $DEBUG_PORT snapshot -i
agent-browser --session $SESSION --cdp $DEBUG_PORT click @e1
```

---

## Quick Reference

| Worktree | Index | Chrome Port | Session |
|----------|-------|-------------|---------|
| main | 0 | 9222 | wt0 |
| worktree 1 | 1 | 9223 | wt1 |
| worktree 2 | 2 | 9224 | wt2 |

---

## Core Commands

```bash
# Navigation
agent-browser open <url>
agent-browser back
agent-browser reload
agent-browser close

# Snapshot (get element refs)
agent-browser snapshot -i          # interactive elements only

# Interactions (use @refs from snapshot)
agent-browser click @e1
agent-browser fill @e2 "text"
agent-browser press Enter
agent-browser hover @e1

# Get info
agent-browser get text @e1
agent-browser get url
agent-browser get title

# Screenshots
agent-browser screenshot file.png
agent-browser screenshot --full    # full page

# Wait
agent-browser wait @e1             # wait for element
agent-browser wait 2000            # wait ms
agent-browser wait --text "Done"   # wait for text
```

---

## Workflow

```bash
agent-browser open <url>        # Navigate
agent-browser snapshot -i       # Get elements with refs (@e1, @e2, ...)
agent-browser click @e1         # Interact using refs
agent-browser snapshot -i       # Re-snapshot after navigation
```

---

## Cleanup

```bash
# Kill Chrome for specific worktree
pkill -f "remote-debugging-port=9223"

# Kill ALL automation Chrome instances
pkill -f "remote-debugging-port="
```

---

## Complete Setup Script

```bash
# Detect worktree
get_worktree_index() {
    local current_dir=$(pwd -P)
    local index=0
    while IFS= read -r line; do
        local wt_path=$(echo "$line" | awk '{print $1}')
        wt_path=$(cd "$wt_path" 2>/dev/null && pwd -P || echo "$wt_path")
        [[ "$current_dir" == "$wt_path" ]] && echo "$index" && return
        ((index++))
    done < <(git worktree list 2>/dev/null)
    echo "0"
}

WT_INDEX=$(get_worktree_index)
export DEBUG_PORT=$((9222 + WT_INDEX))
export SESSION="wt${WT_INDEX}"
PROFILE="${XDG_CACHE_HOME:-$HOME/.cache}/vercel-browser/profiles/wt${WT_INDEX}"

echo "Worktree: $WT_INDEX | Chrome: $DEBUG_PORT | Session: $SESSION"

# Launch Chrome if needed
if ! pgrep -f "remote-debugging-port=$DEBUG_PORT" > /dev/null; then
    echo "Launching Chrome..."
    google-chrome \
        --remote-debugging-port=$DEBUG_PORT \
        --user-data-dir="$PROFILE" \
        --no-first-run --no-default-browser-check \
        --window-position="${CHROME_WINDOW_POSITION:-0,0}" \
        --window-size="${CHROME_WINDOW_SIZE:-1920,1080}" \
        --disable-extensions --disable-sync &
    for i in {1..10}; do ss -tlnp 2>/dev/null | grep -q ":$DEBUG_PORT" && break; sleep 1; done
fi

echo "Ready. Use: agent-browser --session $SESSION --cdp $DEBUG_PORT <command>"
```

---

## Scripts Bundled with This Skill

| Script | Purpose |
|--------|---------|
| `chrome-launch` | Launch Chrome with worktree detection |

Always invoke the bundled scripts by path:
```bash
bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/vercel-browser/scripts/chrome-launch"
```

---

## Notes

- **No infra management** — this skill only handles browser automation
- **App must be running** — start your app first (via Makefile, pnpm dev, etc.)
- **Profiles are isolated** — each worktree has its own slim Chrome profile
- **Coexists with normal Chrome** — automation uses separate user-data-dir
- **Auth reuse is local-first** — local URLs load saved local auth state automatically when `browser-auth` is installed
- **Auth auto-load can be disabled** — set `BROWSER_AUTH_AUTO_LOAD=0` for a clean unauthenticated launch
- **Auth aliases are supported** — set `BROWSER_AUTH_NAME=<alias>` to reuse one saved local login across different worktree ports
- **Do not rely on PATH** — call the bundled scripts via `bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/vercel-browser/scripts/..."`
- **Window sizing uses Chrome flags** — set `CHROME_WINDOW_SIZE` or `CHROME_WINDOW_POSITION` when needed
