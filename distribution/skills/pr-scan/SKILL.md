---
name: pr-scan
description: Scan the current PR for all feedback (review comments, CI failures, linked issues), categorize as "worth fixing" or "not worth fixing", and write a tracking file to pr.md. Supports incremental updates — re-run to merge new comments without losing progress.
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
user-invocable: true
---

# PR Scan

Scan the current PR, gather all feedback and failures, categorize them by importance, and generate or update a tracking file.

## Workflow

### Step 1: Detect Current PR

```bash
# Get PR number from current branch
gh pr view --json number,title,url,headRefName --jq '{number, title, url, branch: .headRefName}'
```

If no PR exists for the current branch, stop and tell the user:
> "No open PR found for branch `<branch>`. Push your branch and open a PR first."

### Step 2: Check for Existing pr.md

Check if `pr.md` already exists in the project root.

- **If it does NOT exist** — this is a **fresh run**. Proceed to Step 3.
- **If it DOES exist** — this is an **incremental run**. Parse the existing file before proceeding:

**Parse existing pr.md:**
Read the file and extract all items from both sections. For each item with thread metadata, record:
- `thread_ids` — all `<!-- thread:PRRT_... -->` IDs
- `section` — "worth" or "not-worth"
- `checkbox_state` — `[x]` or `[ ]`
- `full_text` — the complete item text (including reason line for not-worth-fixing)

Build a **known threads map**: `thread_id → item`. This is used in Step 4 to avoid duplicating or overwriting existing items.

Also preserve any CI or non-thread items exactly as-is (they'll be re-evaluated from fresh data).

### Step 3: Fetch All Issues

Run these commands to gather data from all sources:

**Review threads (inline comments — single GraphQL query):**

```bash
gh api graphql -f query='
query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          path
          line
          comments(first: 1) {
            nodes {
              body
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}' -f owner='{owner}' -f repo='{repo}' -F number={pr_number}
```

This single query gives you everything needed for each review thread: `id` (thread node ID for pr.md metadata), resolution status, file path, line, first comment body, and author. Skip threads where `isResolved` is already `true`.

**Pagination:** If `pageInfo.hasNextPage` is `true`, re-run the query with `-f cursor='{endCursor}'` to fetch the next page. Repeat until `hasNextPage` is `false`. Collect all nodes across all pages before categorizing.

**CI / check failures:**

```bash
# Step 1: get failing checks from the PR check rollup.
gh pr view --json statusCheckRollup --jq '
.statusCheckRollup[]
| select(
    (.__typename == "CheckRun" and (.conclusion == "FAILURE" or .conclusion == "ERROR" or .conclusion == "TIMED_OUT" or .conclusion == "CANCELLED" or .conclusion == "ACTION_REQUIRED"))
    or
    (.__typename == "StatusContext" and (.state == "FAILURE" or .state == "ERROR"))
  )
'
```

**Important:** Do NOT use `gh pr checks` for this step. It is brittle under restricted Codex/Archon command policies. Use `gh pr view --json statusCheckRollup` instead.

Do NOT include pending/in-progress checks. For `CheckRun`, only include completed failure conclusions: `FAILURE`, `ERROR`, `TIMED_OUT`, `CANCELLED`, or `ACTION_REQUIRED`. For `StatusContext`, only include failure states: `FAILURE` or `ERROR`.

**Step 2: Fetch failure details.** The approach depends on where the check comes from:

**GitHub Actions checks** (link contains `github.com/.../actions/runs/`):

Extract the run ID from the `link` field (format: `.../actions/runs/{run_id}/job/{job_id}`) and fetch the actual failure log:

```bash
gh run view <run_id> --log-failed 2>&1 | tail -500
```

If `--log-failed` returns no output (e.g. the failure is in a setup step), fall back to:

```bash
gh run view <run_id> --json jobs --jq '.jobs[] | select(.conclusion == "failure") | {name, steps: [.steps[] | select(.conclusion == "failure") | {name, conclusion}]}'
```

**External CI checks** (CircleCI, Jenkins, Vercel, Netlify, etc. — link does NOT contain `github.com/.../actions/runs/`):

`gh run view` won't work for these. Instead, use the check's `name` and `description` fields as the basis for the item. Write it as:
- `<check name>: <description> — CI (<provider>)` if the description is informative
- `<check name> failing — CI (external)` if the description is empty or generic

Include the link in a comment so the user can investigate: `<!-- link:<url> -->`

**Step 3: Parse individual failures from the log.**

A single CI job can contain **multiple distinct failures** (e.g. 5 failing tests, 3 TypeScript errors, 2 lint violations). Group them under the parent check as nested items.

Read the log output and identify every individual failure:
- Each failing test assertion = separate nested item
- Each TypeScript/compilation error = separate nested item
- Each lint violation = separate nested item
- Each migration error = separate nested item

**Format: parent check with nested failures:**

```markdown
- [ ] Integration Tests failing — CI
  - [ ] UserService.create throws "Cannot read properties of undefined"
  - [ ] AuthGuard.validate rejects expired tokens with wrong error code
- [ ] TypeScript check failing — CI
  - [ ] Property 'userId' does not exist on type 'Request' in gateway.controller.ts:42
- [ ] Database migration failing — CI
  - [ ] column "published_at" already exists in sentiment_data
```

The parent item is the CI check name. The nested items are the individual failures from the log. Each gets its own checkbox for individual tracking.

**If a check has only one failure**, still use the nested format for consistency:

```markdown
- [ ] Lint failing — CI
  - [ ] Unexpected console.log in auth.service.ts:15
```

**Do NOT collapse multiple failures into one parent** like "5 tests failing — CI" with no children. Each failure needs to be individually listed.

If multiple jobs fail in the same run, fetch the log per failing job (each has its own job ID in the link). Each failing job becomes its own parent item.

**Linked GitHub issues (parse from PR body):**

```bash
# Get PR body text
gh pr view --json body --jq '.body'
```

Then parse for patterns: `Fixes #N`, `Closes #N`, `Resolves #N`, `#N` references.
For each linked issue number, fetch its details:

```bash
gh issue view <number> --json title,body,labels,state --jq '{title, body, labels: [.labels[].name], state}'
```

### Step 4: Categorize (with merge logic)

**Fresh run:** Categorize every collected item as **worth fixing** or **not worth fixing** (see criteria below).

**Incremental run:** Only categorize items that are NEW — i.e., their thread IDs are NOT in the known threads map from Step 2.

For existing items:
- **Thread still unresolved on GitHub** — keep the item exactly as-is (preserve checkbox state, description, reason)
- **Thread now resolved on GitHub AND item is `[x]`** — drop the item (it's done)
- **Thread now resolved on GitHub BUT item is `[ ]`** — keep it (someone resolved it outside our workflow; the user might still want to track it). Add a note: `(resolved on GitHub)` to the description if not already present.

For CI and non-thread items: always re-evaluate from fresh data (CI status changes between runs).

**Categorization criteria:**

**Worth fixing** (any of these apply):
- CI/build/test failures — these block the PR
- Security concerns raised by a reviewer
- Bug risks or logic errors identified
- Breaking changes or regressions
- Reviewer explicitly requested changes (not suggestions)
- Linked issues that this PR is supposed to resolve

**Not worth fixing** (all of these apply):
- Style or naming nitpicks with no functional impact
- "Consider" or "nice to have" suggestions
- Opinions without technical justification
- Feedback already addressed in a different way
- Out of scope for what this PR does

### Step 4.5: Validate Before Categorizing

**Do NOT blindly trust review bot suggestions.** Before finalizing each item's category, apply these validation rules:

1. **Verify it matters here** — Grep for the project's actual config/rules (ESLint config, tsconfig, CLAUDE.md). A bot might say "this violates best practice X" but the project may have intentionally opted out. Config is truth, not the bot's assumptions.

2. **Separate problem from solution** — A real problem doesn't mean the suggested fix is right. Evaluate them independently. The problem might be worth fixing with a completely different approach.

3. **Grep for existing patterns** — Before accepting any suggestion, check how the codebase already handles the same situation. Consistency with the project beats the bot's suggestion.

4. **Search online when you can't confidently evaluate** — If you don't know whether a pattern is correct or idiomatic, look it up. Don't guess or defer to the bot's authority.

5. **Push back when the bot is wrong** — If validation shows the suggestion is incorrect or unnecessary, categorize as "not worth fixing" with YOUR reasoning — don't accept it just because a bot said it.

**This step changes the categorization question from** "Does this look like a real issue?" **to** "Is this actually a real issue in THIS project, and if so, is the suggested fix correct?"

### Step 5: Write `pr.md`

Write the file to the **project root** as `pr.md`. Resolve the project root from the current working directory (`pwd`), never from hardcoded or context-inferred paths — this ensures correctness in git worktrees. Use this exact format:

```markdown
# PR #<number> — <title>

> Generated: <YYYY-MM-DD> | Branch: <branch-name> | Last updated: <YYYY-MM-DD HH:MM>

## Worth Fixing

- [ ] Short summary of the issue — @reviewer <!-- thread:<thread_node_id> -->
  > **src/path/to/file.ts:42**
  >
  > [raw review comment body, verbatim, no modifications]

- [ ] Short summary — @reviewer1, @reviewer2 <!-- thread:<id1> --> <!-- thread:<id2> -->
  > **src/path/to/file.ts:10**
  >
  > [raw comment body from reviewer1]

  > **src/other/file.ts:25**
  >
  > [raw comment body from reviewer2]

- [ ] CI Integration Tests failing — CI
  - [ ] UserService.create throws "Cannot read properties of undefined"
  - [ ] AuthGuard.validate rejects expired tokens with wrong error code

- [ ] Short summary — Issue #N
  > [issue title and relevant body excerpt]

## Not Worth Fixing

- [ ] ~~Short summary of the issue — @reviewer~~ <!-- thread:<thread_node_id> -->
  - _Reason: <brief explanation why it's not worth fixing>_
  > **src/path/to/file.ts:42**
  >
  > [raw review comment body, verbatim]
```

**Rules for the output:**

**General:**
- No sub-categories or tags — just flat lists
- Source attribution is the reviewer username (e.g. `@coderabbitai`, `@greptile-bot`) or `CI` for check failures or `Issue #N` for linked issues
- **Both sections use checkboxes** — `[ ]` for pending, `[x]` for done
- "Not worth fixing" items are additionally struck through (`~~`)
- If a section is empty, write `_None found._` under the heading

**Review comment items:**
- **One-liner summary** — a short description YOU generate for scanning. This is the ONLY part you write yourself.
- **File path + line** — from the GraphQL `path` and `line` fields, shown as `**path:line**` at the start of the blockquote.
- **Raw comment body** — the reviewer's comment copied **verbatim** into the blockquote. No summarizing, no reformatting, no stripping. Whatever the reviewer/bot wrote (markdown, code suggestions, explanations, collapsible sections) goes in exactly as-is. Different bots (CodeRabbit, Greptile, Codex, Gemini) have different formats — do NOT try to normalize them. Just quote.
- **Multiple threads per item:** When combining related reviews into one item, include a separate blockquote per reviewer/location. Capture ALL thread IDs — one `<!-- thread:<id> -->` per thread, all on the same line.
- **Thread metadata:** `<!-- thread:<thread_node_id> -->` appended to the summary line. The thread node ID comes directly from the GraphQL `reviewThreads.nodes[].id` field.

**CI items — MUST use nested tree format:**
- **NEVER write CI failures as a single flat line.** Always use parent check + indented children.
- Parent item = check name (e.g. `- [ ] Integration Tests failing — CI`)
- Each individual failure = indented child with its own checkbox (e.g. `  - [ ] specific error message here`)
- Even if there's only ONE failure, still nest it under the parent
- No thread metadata (CI has no review threads)

```markdown
# CORRECT — always do this:
- [ ] Integration Tests failing — CI
  - [ ] SyntaxError: Cannot use import statement outside a module in app.e2e-spec.ts

# WRONG — never do this:
- [ ] Integration Tests: SyntaxError: Cannot use import statement outside a module in app.e2e-spec.ts — CI
```

**Non-review items:**
- CI failures and linked issues have no review threads — don't add `<!-- thread:... -->` to those.

**Edge cases:**
- If a review comment couldn't be matched to a GraphQL thread, omit the `<!-- thread:... -->` for that item.
- **Ordering on incremental runs:** Existing items keep their position. New items are appended at the end of their respective section.
- **Preserve checkbox state:** On incremental runs, never reset an `[x]` back to `[ ]`.
- **Preserve raw comment bodies:** On incremental runs, never modify the blockquoted comment body of existing items.

### Step 6: Report

After writing the file, print a short summary:

**Fresh run:**
```
Wrote pr.md — X worth fixing, Y not worth fixing.
```

**Incremental run:**
```
Updated pr.md — X new items added (A worth fixing, B not worth fixing). Total: C worth fixing, D not worth fixing.
```

If no new items were found on an incremental run:
```
Updated pr.md — no new items. Total: C worth fixing, D not worth fixing.
```

## Notes

- The `{owner}/{repo}` values come from: `gh repo view --json owner,name --jq '{owner: .owner.login, repo: .name}'`
- If `gh` is not authenticated or the command fails, tell the user to run `gh auth login`
- If there are zero issues across all sources, write `pr.md` with both sections showing `_None found._`
