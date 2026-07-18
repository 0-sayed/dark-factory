# Setup

This is the current teammate setup path for Linux. It installs reviewed
integration snapshots while keeping AO and worktree-compose as independently
pinned forks. macOS and Windows are not supported yet.

Run every command from the Dark Factory repository root unless a step says
otherwise.

## 1. Install Machine Dependencies

Install the tools and tested versions listed in
[`dependencies.md`](dependencies.md). In particular, AO must be built with
Go `1.25.7` or newer, and `$HOME/.local/bin` must be on `PATH`:

```bash
go version
docker compose version
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
```

Persist that `PATH` export in the user's shell profile before continuing.

Install and authenticate Codex and GitHub CLI, then verify both accounts:

```bash
codex login
codex login status
gh auth login
gh api user --jq .login
```

Install the pinned Superpowers marketplace plugin and the external conflict
resolution skill:

```bash
codex plugin marketplace add obra/superpowers --ref v6.0.3
codex plugin add superpowers@superpowers-dev
npx -y skills add cursor/plugins --skill fix-merge-conflicts
```

Install the browser QA runtime and Google Chrome:

```bash
npm install --global agent-browser@0.24.1
agent-browser --version
google-chrome --version
```

## 2. Build Pinned Forks

Clone the forks beside Dark Factory. Custom checkout locations can be supplied
with `DARK_FACTORY_AO_CHECKOUT` and `DARK_FACTORY_WTC_CHECKOUT`:

```bash
export DARK_FACTORY_ROOT="$(pwd -P)"
export DARK_FACTORY_AO_CHECKOUT="${DARK_FACTORY_AO_CHECKOUT:-$DARK_FACTORY_ROOT/../agent-orchestrator}"
export DARK_FACTORY_WTC_CHECKOUT="${DARK_FACTORY_WTC_CHECKOUT:-$DARK_FACTORY_ROOT/../worktree-compose}"

git clone https://github.com/0-sayed/agent-orchestrator.git "$DARK_FACTORY_AO_CHECKOUT"
git clone https://github.com/0-sayed/worktree-compose.git "$DARK_FACTORY_WTC_CHECKOUT"
```

Exact tested revisions live only in
[`../dependencies.lock.json`](../dependencies.lock.json). Check out those
revisions before building:

```bash
AO_COMMIT="$(node -p "require('./dependencies.lock.json').repositories['agent-orchestrator'].commit")"
WTC_COMMIT="$(node -p "require('./dependencies.lock.json').repositories['worktree-compose'].commit")"

git -C "$DARK_FACTORY_AO_CHECKOUT" checkout --detach "$AO_COMMIT"
git -C "$DARK_FACTORY_WTC_CHECKOUT" checkout --detach "$WTC_COMMIT"
```

Build and install both the AO CLI and AO desktop from the same pinned fork. The
installer stamps the fork release source into both artifacts, installs them
atomically, and writes a checksum receipt for doctor. Close an existing AO
desktop application before updating its runtime:

```bash
node scripts/install-ao-runtime.mjs \
  --home "$HOME" \
  --checkout "$DARK_FACTORY_AO_CHECKOUT"
```

This prevents `ao start` from silently pairing the pinned fork CLI with an
upstream desktop daemon that lacks Dark Factory's external-worker support.

Build and link worktree-compose without changing the caller's directory:

```bash
(
  cd "$DARK_FACTORY_WTC_CHECKOUT"
  pnpm install --frozen-lockfile
  pnpm build
  npm link
)
```

Install Archon CLI `0.5.0` from its
[official release](https://github.com/coleam00/Archon/releases/tag/v0.5.0), then
verify all pinned repositories and active runtimes:

```bash
node scripts/verify-dependencies.mjs
```

## 3. Install Reviewed Assets

First verify the repository snapshots:

```bash
node scripts/manage-distribution.mjs verify-source
```

Install them into an explicit user home:

```bash
node scripts/manage-distribution.mjs install --home "$HOME"
node scripts/manage-distribution.mjs verify-install --home "$HOME"
```

The command installs:

- Archon workflows into `.archon/workflows`
- Archon helper scripts into `.archon/scripts`
- worker skills into `.agents/skills`
- the Dark Factory operator skill into `.agents/skills/dark-factory`

AO plugins remain repository-local. Dark Factory references `ao-plugins/`
directly while synchronizing project configuration through the Go AO daemon
API; setup does not copy these plugins into user configuration.

An existing different file is never replaced silently. Review the difference
first, then rerun with `--overwrite` only when replacing it is intentional.

## 4. Start AO And Run Doctor

The AO desktop application owns the daemon. Start it and do not continue until
`state` is `ready`:

```bash
ao start
ao status --json
```

Doctor verifies the supported platform, pinned source checkouts, active runtime
versions, pinned AO desktop and CLI checksums, reviewed and installed assets,
AO daemon, authenticated Codex and GitHub access, required plugin and skill,
Docker Compose, process/session utilities, and browser/tooling prerequisites:

```bash
node scripts/manage-distribution.mjs doctor --home "$HOME"
```

## 5. Validate Dark Factory

```bash
npm run validate
```

Then follow the README quickstart.

## Isolated Installation Check

This test builds the pinned AO fork and installs the complete runtime plus
reviewed assets into a temporary home. It never replaces the real AO runtime,
Archon workflows, or skills:

```bash
TEMP_HOME="$(mktemp -d)"
node scripts/install-ao-runtime.mjs \
  --home "$TEMP_HOME" \
  --checkout "$DARK_FACTORY_AO_CHECKOUT"
node scripts/manage-distribution.mjs install --home "$TEMP_HOME"
node scripts/manage-distribution.mjs verify-install --home "$TEMP_HOME"
node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true })" "$TEMP_HOME"
```

## Updating Snapshots

The installed Archon and skill locations remain the development source of
truth. After changing an installed workflow, script, or skill:

1. Replace its complete copy under `distribution/`.
2. Refresh reviewed checksums:

```bash
node scripts/manage-distribution.mjs refresh-manifest
```

3. Run source verification and the clean-install tests.

Never copy credentials, browser profiles, runtime state, logs, or machine paths
into the repository.
