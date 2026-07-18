---
name: browser-auth
description: Use when browser automation needs reusable login state across worktrees without copying a full Chrome profile
---

# Browser Auth

Keep auth state separate from browser profiles.

Use this when:
- one login should work across multiple worktrees
- `vercel-browser` should stay focused on launch/testing
- you want cookies and storage reused without copying the main profile

Core commands:

```bash
# Save current auth state from the active worktree browser
bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/browser-auth/scripts/chrome-auth-save" http://localhost:3000

# Load saved auth state into the active worktree browser
bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/browser-auth/scripts/chrome-auth-load" http://localhost:3000

# Load, verify, and refresh local auth when a login command or login URL is configured
BROWSER_AUTH_VERIFY_URL=http://localhost:3001/user \
  BROWSER_AUTH_LOGIN_URL=http://localhost:3000/login \
  bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/browser-auth/scripts/chrome-auth-ensure" http://localhost:3000 my-local-app-auth
```

How it works:
- saves only cookies, localStorage, and sessionStorage for one origin
- saves and loads only local HTTP/HTTPS origins (`localhost`, `*.localhost`, `127.0.0.1`, `0.0.0.0`, `::1`)
- refuses public/non-local websites and filters non-local cookies
- stores auth files under `~/.local/state/vercel-browser/auth/`
- does not store passwords
- `ensure` loads saved auth, verifies the current session with `BROWSER_AUTH_VERIFY_URL`, and refreshes only when `BROWSER_AUTH_LOGIN_COMMAND` or `BROWSER_AUTH_LOGIN_URL` is provided

Notes:
- run `bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/vercel-browser/scripts/chrome-launch"` first so Chrome is already up on the worktree port
- save and load auth explicitly with the `browser-auth` scripts
- last login wins per site origin
- treat auth files like secrets
- some sites with short-lived or device-bound sessions may still require re-login
- use `BROWSER_AUTH_NAME`/name override for stable auth aliases across dynamic worktree ports

Scripts:
- `bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/browser-auth/scripts/chrome-auth-save"`
- `bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/browser-auth/scripts/chrome-auth-load"`
- `bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/browser-auth/scripts/chrome-auth-verify"`
- `bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/browser-auth/scripts/chrome-auth-ensure"`
- `bash "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/browser-auth/scripts/chrome-auth-sync"`
