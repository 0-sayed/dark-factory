#!/usr/bin/env python3

from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


COMMENT_PREFIX = "[CODING_BOT]"

THREAD_QUERY = """
query($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      id
      isResolved
      pullRequest {
        number
        repository {
          nameWithOwner
        }
      }
      comments(first: 100) {
        nodes {
          author {
            login
          }
          body
        }
      }
    }
  }
}
""".strip()

REPLY_MUTATION = """
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(
    input: {
      pullRequestReviewThreadId: $threadId
      body: $body
    }
  ) {
    comment {
      id
    }
  }
}
""".strip()

RESOLVE_MUTATION = """
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread {
      id
    }
  }
}
""".strip()


@dataclass
class Item:
    line_index: int
    section: str
    checkbox: str
    thread_ids: list[str]
    reason: str | None
    legacy_not_worth: bool


@dataclass(frozen=True)
class PullRequestContext:
    number: int
    repo_full_name: str


class ResolveError(RuntimeError):
    pass


def gh(*args: str, json_output: bool = False) -> str | dict:
    proc = subprocess.run(
        ["gh", *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.strip() or proc.stdout.strip() or "unknown gh error"
        raise ResolveError(stderr)
    if json_output:
        return json.loads(proc.stdout)
    return proc.stdout


def gh_graphql(query: str, **variables: str) -> dict:
    args = ["api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        args.extend(["-f", f"{key}={value}"])
    return gh(*args, json_output=True)


def find_repo_root(start: Path) -> Path:
    current = start.resolve()
    for candidate in (current, *current.parents):
        if (candidate / "pr.md").exists():
            return candidate
    raise ResolveError("Could not find pr.md from the current directory upward.")


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def bot_reply_body(reason: str) -> str:
    reason = reason.strip()
    if reason.startswith(COMMENT_PREFIX):
        return reason
    return f"{COMMENT_PREFIX} {reason}"


def parse_items(lines: list[str]) -> list[Item]:
    items: list[Item] = []
    section: str | None = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "## Worth Fixing":
            section = "worth"
            continue
        if stripped == "## Not Worth Fixing":
            section = "not-worth"
            continue

        checkbox_match = re.match(r"^- \[([ xX])\] (.*)$", line)
        legacy_match = section == "not-worth" and re.match(r"^- ~~.*$", line)
        if not section or (not checkbox_match and not legacy_match):
            continue

        if checkbox_match:
            checkbox = "x" if checkbox_match.group(1).lower() == "x" else " "
        else:
            checkbox = " "

        thread_ids = re.findall(r"<!--\s*thread:([^\s>]+)", line)
        reason = None
        if section == "not-worth" and index + 1 < len(lines):
            reason_match = re.match(r"^\s*-\s+_Reason:\s*(.*?)_\s*$", lines[index + 1])
            if reason_match:
                reason = reason_match.group(1).strip()

        items.append(
            Item(
                line_index=index,
                section=section,
                checkbox=checkbox,
                thread_ids=thread_ids,
                reason=reason,
                legacy_not_worth=bool(legacy_match),
            )
        )

    return items


def fetch_thread(thread_id: str) -> dict:
    data = gh_graphql(THREAD_QUERY, threadId=thread_id)
    node = data.get("data", {}).get("node")
    if not node:
        raise ResolveError(f"Thread {thread_id} was not found.")
    return node


def current_pull_request_context() -> PullRequestContext:
    pr = gh("pr", "view", "--json", "number,url", json_output=True)
    repo = gh("repo", "view", "--json", "owner,name", json_output=True)
    try:
        return PullRequestContext(
            number=int(pr["number"]),
            repo_full_name=f'{repo["owner"]["login"]}/{repo["name"]}',
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ResolveError("Could not determine the current repository and pull request.") from exc


def require_thread_scope(thread_id: str, thread: dict, context: PullRequestContext) -> None:
    pull_request = thread.get("pullRequest") or {}
    repository = pull_request.get("repository") or {}
    thread_number = pull_request.get("number")
    thread_repo = repository.get("nameWithOwner")
    if thread_number != context.number or thread_repo != context.repo_full_name:
        raise ResolveError(
            f"Thread {thread_id} does not belong to {context.repo_full_name} "
            f"pull request {context.number}."
        )


def maybe_reply(thread_id: str, reply_body: str, thread: dict) -> None:
    comments = thread.get("comments", {}).get("nodes", [])
    already_replied = any(
        normalize(comment.get("body", "")) == normalize(reply_body)
        for comment in comments
    )
    if not already_replied:
        gh_graphql(REPLY_MUTATION, threadId=thread_id, body=reply_body)


def maybe_resolve(thread_id: str, thread: dict) -> None:
    if not thread.get("isResolved"):
        gh_graphql(RESOLVE_MUTATION, threadId=thread_id)


def update_pr_md(lines: list[str], successful_not_worth: set[int]) -> str:
    updated = list(lines)
    for index in sorted(successful_not_worth):
        line = updated[index]
        if re.match(r"^- \[[ xX]\] ", line):
            updated[index] = re.sub(r"^- \[[ xX]\]", "- [x]", line, count=1)
        elif re.match(r"^- ~~", line):
            updated[index] = line.replace("- ~~", "- [x] ~~", 1)
    return "\n".join(updated) + "\n"


def main() -> int:
    repo_root = find_repo_root(Path.cwd())
    pr_md_path = repo_root / "pr.md"
    lines = pr_md_path.read_text(encoding="utf-8").splitlines()
    items = parse_items(lines)

    context = current_pull_request_context()

    not_worth_resolved = 0
    worth_resolved = 0
    skipped = 0
    failed = 0
    successful_not_worth: set[int] = set()

    for item in items:
        if not item.thread_ids:
            skipped += 1
            continue

        if item.section == "worth" and item.checkbox != "x":
            continue
        if item.section == "not-worth" and item.checkbox == "x":
            continue

        item_ok = True
        for thread_id in item.thread_ids:
            try:
                thread = fetch_thread(thread_id)
                require_thread_scope(thread_id, thread, context)
                if item.section == "not-worth":
                    if not item.reason:
                        raise ResolveError(
                            f"Item on line {item.line_index + 1} has no _Reason: text."
                        )
                    maybe_reply(thread_id, bot_reply_body(item.reason), thread)
                maybe_resolve(thread_id, thread)
            except Exception as exc:  # noqa: BLE001
                item_ok = False
                failed += 1
                print(
                    f"Failed thread {thread_id} from line {item.line_index + 1}: {exc}",
                    file=sys.stderr,
                )

        if not item_ok:
            continue

        if item.section == "not-worth":
            successful_not_worth.add(item.line_index)
            not_worth_resolved += 1
        else:
            worth_resolved += 1

    pr_md_path.write_text(
        update_pr_md(lines, successful_not_worth),
        encoding="utf-8",
    )

    print(
        f"Resolved {not_worth_resolved} not-worth-fixing (replied + resolved), "
        f"{worth_resolved} worth-fixing (resolved). Skipped {skipped} (no thread ID)."
    )
    if failed:
        print(f"Failed: {failed} (see errors above).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
