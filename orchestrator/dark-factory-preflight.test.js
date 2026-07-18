import assert from "node:assert/strict";
import test from "node:test";

import { verifyProjectPlanningFresh } from "./dark-factory-preflight.js";

const project = {
  id: "sample",
  path: "/repo/sample",
  defaultBranch: "main",
  tracker: { tasksPath: "planning/roadmap/tasks.md" },
};

test("verifyProjectPlanningFresh fetches origin and accepts matching local and remote default branch", async () => {
  const calls = [];

  const result = await verifyProjectPlanningFresh({
    project,
    runGit: async (args) => {
      calls.push(args);
      if (args[0] === "remote") return "git@github.com:org/sample.git\n";
      if (args[0] === "rev-parse" && args.at(-1) === "refs/heads/main") return "abc123\n";
      if (args[0] === "rev-parse" && args.at(-1) === "refs/remotes/origin/main") return "abc123\n";
      if (args[0] === "status") return "";
      return "";
    },
  });

  assert.deepEqual(calls, [
    ["remote", "get-url", "origin"],
    ["fetch", "origin", "--quiet"],
    ["rev-parse", "--verify", "refs/heads/main"],
    ["rev-parse", "--verify", "refs/remotes/origin/main"],
    ["status", "--porcelain", "--", "planning"],
  ]);
  assert.deepEqual(result, {
    checked: true,
    defaultBranch: "main",
    fastForwarded: false,
    mode: "remote",
    projectId: "sample",
    planningPath: "planning",
  });
});

test("verifyProjectPlanningFresh fast-forwards a clean stale local planning branch before scheduling", async () => {
  const calls = [];

  const result = await verifyProjectPlanningFresh({
    project,
    runGit: async (args) => {
      calls.push(args);
      if (args[0] === "remote") return "git@github.com:org/sample.git\n";
      if (args[0] === "rev-parse" && args.at(-1) === "refs/heads/main") return "local-old\n";
      if (args[0] === "rev-parse" && args.at(-1) === "refs/remotes/origin/main") return "remote-new\n";
      if (args[0] === "status") return "";
      if (args[0] === "merge-base") return "";
      if (args[0] === "merge") return "Updating local-old..remote-new\nFast-forward\n";
      return "";
    },
  });

  assert.deepEqual(calls, [
    ["remote", "get-url", "origin"],
    ["fetch", "origin", "--quiet"],
    ["rev-parse", "--verify", "refs/heads/main"],
    ["rev-parse", "--verify", "refs/remotes/origin/main"],
    ["status", "--porcelain"],
    ["merge-base", "--is-ancestor", "refs/heads/main", "refs/remotes/origin/main"],
    ["merge", "--ff-only", "refs/remotes/origin/main"],
    ["status", "--porcelain", "--", "planning"],
  ]);
  assert.equal(result.fastForwarded, true);
});

test("verifyProjectPlanningFresh blocks stale dirty checkout instead of fast-forwarding", async () => {
  await assert.rejects(
    verifyProjectPlanningFresh({
      project,
      runGit: async (args) => {
        if (args[0] === "remote") return "git@github.com:org/sample.git\n";
        if (args[0] === "rev-parse" && args.at(-1) === "refs/heads/main") return "local-old\n";
        if (args[0] === "rev-parse" && args.at(-1) === "refs/remotes/origin/main") return "remote-new\n";
        if (args[0] === "status") return " M README.md\n";
        return "";
      },
    }),
    /Cannot fast-forward planning checkout for sample: checkout has uncommitted changes/,
  );
});

test("verifyProjectPlanningFresh blocks divergent local planning branch before scheduling", async () => {
  await assert.rejects(
    verifyProjectPlanningFresh({
      project,
      runGit: async (args) => {
        if (args[0] === "remote") return "git@github.com:org/sample.git\n";
        if (args[0] === "rev-parse" && args.at(-1) === "refs/heads/main") return "local-ahead\n";
        if (args[0] === "rev-parse" && args.at(-1) === "refs/remotes/origin/main") return "remote-new\n";
        if (args[0] === "status") return "";
        if (args[0] === "merge-base") throw new Error("not ancestor");
        return "";
      },
    }),
    /Planning checkout is stale for sample: local main cannot fast-forward to origin\/main/,
  );
});

test("verifyProjectPlanningFresh blocks uncommitted planning changes", async () => {
  await assert.rejects(
    verifyProjectPlanningFresh({
      project,
      runGit: async (args) => {
        if (args[0] === "remote") return "git@github.com:org/sample.git\n";
        if (args[0] === "rev-parse") return "abc123\n";
        if (args[0] === "status") return " M planning/roadmap/tasks.md\n";
        return "";
      },
    }),
    /Planning folder has uncommitted changes for sample/,
  );
});

test("verifyProjectPlanningFresh skips remote freshness when no origin remote exists", async () => {
  const calls = [];

  const result = await verifyProjectPlanningFresh({
    project,
    runGit: async (args) => {
      calls.push(args);
      if (args[0] === "remote") {
        const error = new Error("No such remote");
        error.code = 2;
        throw error;
      }
      if (args[0] === "status") return "";
      return "";
    },
  });

  assert.deepEqual(calls, [
    ["remote", "get-url", "origin"],
    ["status", "--porcelain", "--", "planning"],
  ]);
  assert.equal(result.mode, "local");
  assert.equal(result.fastForwarded, false);
});
