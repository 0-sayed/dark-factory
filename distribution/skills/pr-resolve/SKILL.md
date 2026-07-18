---
name: pr-resolve
description: Use when pr.md exists with review items whose GitHub review threads must be replied to or resolved on the current pull request.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
user-invocable: true
---

# PR Resolve

Use this after `pr.md` has been updated and the worth-fixing code changes are done.

## Run

```bash
python3 "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/pr-resolve/scripts/resolve-pr-threads.py"
```

The script finds the repo root by locating `pr.md`, so it can be run from anywhere inside the repo or worktree.

## What The Script Does

- Parses `pr.md` from both `Worth Fixing` and `Not Worth Fixing`.
- For checked worth-fixing items, resolves each linked thread without replying.
- For unchecked not-worth-fixing items, posts `[CODING_BOT] ` plus the `_Reason:`, avoids duplicate replies with the same body, then resolves each linked thread.
- Marks only fully successful not-worth-fixing items as `[x]` in `pr.md`.

## Requirements

- `pr.md` exists in the repo root.
- Review items use `<!-- thread:PRRT_... -->` metadata.
- `gh` is authenticated for the GitHub account that should comment and resolve threads.

## Notes

- Keep the reasoning in `pr.md` tight. The script prefixes the `_Reason:` text with `[CODING_BOT] ` before posting.
- Do not hand-roll inline `gh api graphql` commands for this flow. Run the skill script instead.

## Common Mistakes

| Mistake                                                | Fix                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Resolving not-worth-fixing without replying            | Always reply first on those — silent resolves are rude                                            |
| Replying to worth-fixing threads                       | No reply needed — the code fix is the response                                                    |
| Marking worth-fixing `[ ]` as `[x]`                    | Their checkbox tracks the code fix, not the resolve                                               |
| Skipping worth-fixing `[x]` items                      | `[x]` means fix is done — that's when you SHOULD resolve the thread                               |
| Resolving worth-fixing `[ ]` items                     | `[ ]` means fix not done yet — skip, nothing to resolve                                           |
| Only resolving the first thread on a multi-thread item | Parse ALL `<!-- thread:... -->` blocks per item — each is a separate thread that must be resolved |
| Marking `[x]` when only some threads succeeded         | All threads for an item must succeed — partial success leaves the item unmarked so it retries     |
| Interpolating body directly into GraphQL query string  | Always use `-f body='...'` variable — direct interpolation breaks on quotes, backticks, newlines  |
| Writing long counter-arguments                         | Keep it 1-3 sentences.                                                                             |
