import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildObservabilitySnapshot,
  classifySession,
  hydrateSessionPullRequests,
  runObservabilityOnce,
} from "./dark-factory-observability.js";
import * as Observability from "./dark-factory-observability.js";

function issue(id, state = "open") {
  return {
    id,
    title: `${id} task`,
    state,
    branchName: `feat/${id.toLowerCase()}`,
  };
}

test("classifySession maps AO statuses into observable states", () => {
  const now = new Date("2026-06-16T10:00:00.000Z");

  assert.equal(classifySession({ status: "working", lastActivityAt: "2026-06-16T09:59:00.000Z" }, { now }), "running");
  assert.equal(classifySession({ status: "working", lastActivityAt: "2026-06-16T08:00:00.000Z" }, { now }), "running");
  assert.equal(classifySession({ status: "needs_input", lastActivityAt: "2026-06-16T08:00:00.000Z" }, { now }), "needs_input");
  assert.equal(classifySession({ status: "killed" }, { now }), "queued");
  assert.equal(classifySession({ status: "errored" }, { now }), "failed");
  assert.equal(classifySession({ status: "killed", agentReportedState: "ready_for_review" }, { now }), "ready_to_merge");
  assert.equal(classifySession({ status: "done" }, { now }), "merged");
  assert.equal(classifySession({ status: "done", pr: { merged: true } }, { now }), "merged");
});

test("normalizeLifecycleStatus maps raw observability states into lifecycle states", () => {
  const now = new Date("2026-06-16T10:00:00.000Z");

  assert.deepEqual(Observability.LIFECYCLE_STATUSES, [
    "queued",
    "running",
    "in_review",
    "ready_to_merge",
    "merging",
    "merged",
    "failed",
    "needs_input",
    "cleanup_failed",
  ]);
  assert.equal(Observability.normalizeLifecycleStatus({ prReadiness: "ready" }, { now }), "ready_to_merge");
  assert.equal(Observability.normalizeLifecycleStatus({ prReadiness: "running" }, { now }), "in_review");
  assert.equal(Observability.normalizeLifecycleStatus({ prReadiness: "queued" }, { now }), "running");
  assert.equal(
    Observability.normalizeLifecycleStatus(
      {
        status: "killed",
        pr: { state: "OPEN" },
        prReadiness: "queued",
        agentReportedState: "needs_input",
        agentMilestone: "failed",
      },
      { now },
    ),
    "running",
  );
  assert.equal(
    Observability.normalizeLifecycleStatus(
      {
        status: "killed",
        prReadiness: "queued",
        agentReportedState: "needs_input",
      },
      { now },
    ),
    "needs_input",
  );
  assert.equal(
    Observability.normalizeLifecycleStatus(
      {
        status: "killed",
        prReadiness: "queued",
        agentMilestone: "failed",
      },
      { now },
    ),
    "failed",
  );
  assert.equal(Observability.normalizeLifecycleStatus({ status: "killed" }, { now }), "queued");
  assert.equal(Observability.normalizeLifecycleStatus({ status: "merging" }, { now }), "merging");
  assert.equal(Observability.normalizeLifecycleStatus({ status: "cleanup_failed" }, { now }), "cleanup_failed");
  assert.equal(Observability.normalizeLifecycleStatus({ agentMilestone: "failed" }, { now }), "failed");
  assert.equal(Observability.normalizeLifecycleStatus({ agentReportedState: "failed" }, { now }), "failed");
  assert.equal(Observability.normalizeLifecycleStatus({ agentReportedState: "needs_input" }, { now }), "needs_input");
  assert.equal(Observability.normalizeLifecycleStatus({ status: "errored" }, { now }), "failed");
  assert.equal(
    Observability.normalizeLifecycleStatus({ status: "runtime_lost", pr: { state: "merged", merged: true } }, { now }),
    "merged",
  );
  assert.equal(
    Observability.normalizeLifecycleStatus(
      {
        status: "runtime_lost",
        pr: { state: "merged", merged: true },
        agentReportedState: "needs_input",
        agentMilestone: "failed",
      },
      { now },
    ),
    "merged",
  );
});

test("buildObservabilitySnapshot prefers useful task state over old duplicate failures", () => {
  const snapshot = buildObservabilitySnapshot({
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    allIssues: [issue("T001", "closed"), issue("T004"), issue("T005"), issue("T006")],
    runnableIssues: [issue("T005")],
    sessions: [
      { id: "old-failure", projectId: "sample", issueId: "T004", status: "killed" },
      { id: "finished", projectId: "sample", issueId: "T004", status: "done" },
      {
        id: "active",
        projectId: "sample",
        issueId: "T006",
        status: "working",
        lastActivityAt: "2026-06-16T08:00:00.000Z",
      },
    ],
    runnerState: { launchPlan: { toLaunch: [{ id: "T005" }] } },
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.equal(snapshot.tasks.T001.status, "merged");
  assert.equal(snapshot.tasks.T004.status, "merged");
  assert.equal(snapshot.tasks.T005.status, "queued");
  assert.equal(snapshot.tasks.T006.status, "running");
  assert.deepEqual(snapshot.summary, {
    total: 4,
    queued: 1,
    running: 1,
    in_review: 0,
    ready_to_merge: 0,
    merging: 0,
    merged: 2,
    failed: 0,
    needs_input: 0,
    cleanup_failed: 0,
  });
});

test("buildObservabilitySnapshot reports cleanup failures without changing merged task state", () => {
  const snapshot = buildObservabilitySnapshot({
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    allIssues: [issue("T001", "closed")],
    runnableIssues: [],
    sessions: [],
    runnerState: {
      cleanup: {
        resourceCleanup: {
          status: "failed",
          failures: [{ resource: "volume", reason: "resources_remaining" }],
        },
      },
    },
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.equal(snapshot.tasks.T001.status, "merged");
  assert.equal(snapshot.summary.merged, 1);
  assert.equal(snapshot.summary.cleanup_failed, 1);
});

test("buildObservabilitySnapshot exposes one current session and keeps old duplicates as history", () => {
  const snapshot = buildObservabilitySnapshot({
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    allIssues: [issue("T007")],
    runnableIssues: [],
    sessions: [
      {
        id: "old-failure",
        projectId: "sample",
        issueId: "T007",
        status: "killed",
        workspacePath: "/tmp/worktrees/old-failure",
        lastActivityAt: "2026-06-16T09:00:00.000Z",
      },
      {
        id: "ready-pr",
        projectId: "sample",
        issueId: "T007",
        status: "idle",
        workspacePath: "/tmp/worktrees/ready-pr",
        agentReportedState: "ready_for_review",
        lastActivityAt: "2026-06-16T09:30:00.000Z",
      },
    ],
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.equal(snapshot.tasks.T007.status, "ready_to_merge");
  assert.equal(snapshot.tasks.T007.currentSession.id, "ready-pr");
  assert.deepEqual(snapshot.tasks.T007.sessionHistory.map((session) => session.id), ["old-failure"]);
  assert.deepEqual(snapshot.tasks.T007.sessions.map((session) => session.id), ["ready-pr", "old-failure"]);
  assert.equal(snapshot.summary.ready_to_merge, 1);
  assert.equal(snapshot.summary.failed, 0);
});

test("buildObservabilitySnapshot ignores AO orchestrator sessions", () => {
  const snapshot = buildObservabilitySnapshot({
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    allIssues: [issue("T008")],
    runnableIssues: [issue("T008")],
    sessions: [
      {
        id: "sample-orchestrator",
        projectId: "sample",
        role: "orchestrator",
        status: "killed",
        worktree: "/tmp/worktrees/sample-orchestrator",
        lifecycle: { session: { kind: "orchestrator" } },
      },
      {
        id: "sample-t008-actual-feature",
        projectId: "sample",
        issueId: "T008",
        status: "working",
        workspacePath: "/tmp/worktrees/sample-t008-actual-feature",
      },
    ],
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(snapshot.sessions.map((session) => session.id), ["sample-t008-actual-feature"]);
  assert.equal(snapshot.tasks.T008.currentSession.id, "sample-t008-actual-feature");
});

test("runObservabilityOnce writes a durable observable snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-"));
  const runnerStatePath = join(dir, "runner.json");
  const observabilityPath = join(dir, "observability.json");

  await writeFile(runnerStatePath, JSON.stringify({ launchPlan: { toLaunch: [{ id: "T004" }] } }), "utf8");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    runnerStatePath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T004")],
    getRunnableIssues: async () => [issue("T004")],
    listSessions: async () => ({ data: [] }),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const persisted = JSON.parse(await readFile(observabilityPath, "utf8"));

  assert.equal(snapshot.tasks.T004.status, "queued");
  assert.equal(persisted.version, 1);
  assert.equal(persisted.runnerState.launchPlan.toLaunch[0].id, "T004");
  assert.equal(persisted.summary.ready_to_merge, 0);
  assert.equal(persisted.summary.queued, 1);
  assert.deepEqual(persisted.events, []);
  assert.deepEqual(persisted.eventSummary, {
    total: 0,
    byType: {},
    latestByTask: {},
  });
});

test("runObservabilityOnce treats reported merged PR metadata as merged even after a killed runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-merged-pr-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T005")],
    getRunnableIssues: async () => [issue("T005")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-5",
          projectId: "sample",
          issueId: "T005",
          status: "killed",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "needs_input",
      agentReportedNote: "dark-factory milestone=failed task=T005 phase=auto_feature",
      agentReportedPrUrl: "https://github.com/acme/sample/pull/36",
      agentReportedPrNumber: "36",
    }),
    getPullRequestState: async () => ({
      number: 36,
      url: "https://github.com/acme/sample/pull/36",
      state: "MERGED",
      mergedAt: "2026-06-19T15:58:57Z",
    }),
    now: () => new Date("2026-06-19T16:00:00.000Z"),
  });

  assert.equal(snapshot.tasks.T005.status, "merged");
  assert.equal(snapshot.summary.merged, 1);
});

test("runObservabilityOnce treats workspace merge artifact as merged after runtime loss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-workspace-merged-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T031")],
    getRunnableIssues: async () => [issue("T031")],
    listSessions: async () => ({
      data: [{ id: "sample-31", projectId: "sample", issueId: "T031", status: "killed", workspacePath: "/tmp/t031" }],
    }),
    readWorkspaceArchonState: async () => ({
      merge: {
        status: "MERGED",
        pr: { number: 36, url: "https://github.com/acme/sample/pull/36" },
        mergedAt: "2026-07-05T21:41:24Z",
      },
      qaStatus: "QA_PASSED",
    }),
    now: () => new Date("2026-07-05T21:45:00.000Z"),
  });

  assert.equal(snapshot.tasks.T031.status, "merged");
  assert.equal(snapshot.tasks.T031.sessions[0].pr.merged, true);
  assert.equal(snapshot.tasks.T031.sessions[0].pr.state, "merged");
  assert.equal(snapshot.tasks.T031.sessions[0].qaStatus, "QA_PASSED");
});

test("runObservabilityOnce treats an open green clean PR as ready to merge before stale failed AO state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-open-ready-pr-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T101")],
    getRunnableIssues: async () => [issue("T101")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-101",
          projectId: "sample",
          issueId: "T101",
          status: "killed",
          workspacePath: "/tmp/worktree-t101",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "needs_input",
      agentReportedAt: "2026-06-27T15:19:43.000Z",
      agentReportedNote: "dark-factory milestone=failed task=T101 phase=auto_feature",
      agentReportedPrUrl: "https://github.com/acme/sample/pull/88",
      agentReportedPrNumber: "88",
    }),
    getPullRequestState: async () => ({
      number: 88,
      url: "https://github.com/acme/sample/pull/88",
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [
        { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "lint", state: "SUCCESS" },
      ],
    }),
    now: () => new Date("2026-06-27T15:45:00.000Z"),
  });

  assert.equal(snapshot.tasks.T101.status, "ready_to_merge");
  assert.equal(snapshot.tasks.T101.sessions[0].observableStatus, "ready_to_merge");
  assert.equal(snapshot.tasks.T101.sessions[0].prReadiness, "ready");
  assert.equal(snapshot.summary.ready_to_merge, 1);
  assert.equal(snapshot.summary.failed, 0);
});

test("runObservabilityOnce treats an open branch PR with failed checks as running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-branch-pr-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T027")],
    getRunnableIssues: async () => [issue("T027")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-027",
          projectId: "sample",
          issueId: "T027",
          status: "killed",
          branch: "feat/t027-payables-admin",
          workspacePath: "/tmp/worktree-t027",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "needs_input",
      agentReportedAt: "2026-07-07T13:46:22.963Z",
      agentReportedNote: "dark-factory milestone=failed task=T027 phase=auto_feature",
    }),
    getPullRequestForBranch: async (branch) => ({
      number: 41,
      url: "https://github.com/acme/sample/pull/41",
      state: "OPEN",
      headRefOid: "abc123",
      mergeStateStatus: branch === "feat/t027-payables-admin" ? "DIRTY" : "CLEAN",
      statusCheckRollup: [{ name: "Merge Conflicts", status: "COMPLETED", conclusion: "FAILURE" }],
    }),
    getPullRequestState: async (pr) => pr,
    now: () => new Date("2026-07-07T14:00:00.000Z"),
  });

  assert.equal(snapshot.tasks.T027.status, "running");
  assert.equal(snapshot.tasks.T027.sessions[0].observableStatus, "running");
  assert.equal(snapshot.tasks.T027.sessions[0].pr.number, 41);
  assert.equal(snapshot.tasks.T027.sessions[0].prReadiness, "queued");
  assert.equal(snapshot.summary.running, 1);
  assert.equal(snapshot.summary.in_review, 0);
  assert.equal(snapshot.summary.ready_to_merge, 0);
  assert.equal(snapshot.summary.failed, 0);
});

test("runObservabilityOnce treats a blocked green PR as in review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-blocked-pr-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T104")],
    getRunnableIssues: async () => [issue("T104")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-104",
          projectId: "sample",
          issueId: "T104",
          status: "killed",
          workspacePath: "/tmp/worktree-t104",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "failed",
      agentReportedAt: "2026-06-27T15:19:43.000Z",
      agentReportedNote: "dark-factory milestone=failed task=T104 phase=auto_feature",
      agentReportedPrUrl: "https://github.com/acme/sample/pull/104",
      agentReportedPrNumber: "104",
    }),
    getPullRequestState: async () => ({
      number: 104,
      url: "https://github.com/acme/sample/pull/104",
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [
        { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    }),
    now: () => new Date("2026-06-27T15:45:00.000Z"),
  });

  assert.equal(snapshot.tasks.T104.status, "in_review");
  assert.equal(snapshot.tasks.T104.sessions[0].observableStatus, "in_review");
  assert.equal(snapshot.tasks.T104.sessions[0].prReadiness, "review");
  assert.equal(snapshot.summary.in_review, 1);
  assert.equal(snapshot.summary.failed, 0);
});

test("hydrateSessionPullRequests parses log-prefixed JSON from the default GitHub path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-gh-json-"));
  const binDir = join(dir, "bin");
  const ghPath = join(binDir, "gh");
  const previousPath = process.env.PATH;

  await mkdir(binDir);
  await writeFile(ghPath, [
    "#!/bin/sh",
    "printf '%s\\n' 'notice: loading gh extension'",
    "printf '%s\\n' '{\"number\":89,\"url\":\"https://github.com/acme/sample/pull/89\",\"state\":\"OPEN\",\"mergedAt\":null,\"mergeStateStatus\":\"HAS_HOOKS\",\"statusCheckRollup\":[{\"name\":\"ci\",\"status\":\"COMPLETED\",\"conclusion\":\"SUCCESS\"}]}'",
    "",
  ].join("\n"), "utf8");
  await chmod(ghPath, 0o755);
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;

  try {
    const sessions = await hydrateSessionPullRequests([
      { id: "sample-102", projectId: "sample", issueId: "T102", status: "killed", pr: { number: 89 } },
    ], { id: "sample" }, {
      readSessionMetadata: async () => ({
        agentReportedState: "needs_input",
        agentReportedNote: "dark-factory milestone=failed task=T102 phase=auto_feature",
      }),
    });

    assert.equal(sessions[0].pr.number, 89);
    assert.equal(sessions[0].pr.mergeStateStatus, "HAS_HOOKS");
    assert.equal(sessions[0].prReadiness, "ready");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("hydrateSessionPullRequests bounds GitHub CLI PR hydration", async () => {
  const calls = [];

  const sessions = await hydrateSessionPullRequests([
    {
      id: "sample-90",
      projectId: "sample",
      issueId: "T090",
      status: "working",
      workspacePath: "/tmp/sample-90",
      pr: { number: 90 },
    },
  ], { id: "sample", path: "/tmp/sample" }, {
    readSessionMetadata: async () => null,
    execFileAsync: async (file, args, options) => {
      calls.push({ file, args, options });
      assert.equal(file, "gh");
      if (args[1] === "checks") {
        return { stdout: "[]" };
      }
      return {
        stdout: JSON.stringify({
          number: 90,
          url: "https://github.com/acme/sample/pull/90",
          state: "OPEN",
          mergedAt: null,
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [],
        }),
      };
    },
  });

  assert.equal(sessions[0].pr.number, 90);
  assert.deepEqual(sessions[0].pr.currentChecks, []);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.cwd, "/tmp/sample-90");
    assert.equal(call.options.timeout, 30000);
  }
});

test("hydrateSessionPullRequests prefers current checks over historical rollup failures", async () => {
  const sessions = await hydrateSessionPullRequests([
    {
      id: "sample-78",
      projectId: "sample",
      issueId: "T078",
      status: "killed",
      workspacePath: "/tmp/sample-78",
      pr: { number: 78 },
    },
  ], { id: "sample", path: "/tmp/sample" }, {
    readSessionMetadata: async () => null,
    execFileAsync: async (_file, args) => {
      if (args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 78,
            url: "https://github.com/acme/sample/pull/78",
            state: "OPEN",
            mergedAt: null,
            mergeStateStatus: "CLEAN",
            statusCheckRollup: [
              { name: "title", status: "COMPLETED", conclusion: "FAILURE" },
              { name: "title", status: "COMPLETED", conclusion: "SUCCESS" },
            ],
          }),
        };
      }

      assert.deepEqual(args.slice(0, 3), ["pr", "checks", "78"]);
      return {
        stdout: JSON.stringify([
          { name: "title", state: "SUCCESS", bucket: "pass", workflow: "CI" },
        ]),
      };
    },
  });

  assert.equal(sessions[0].prReadiness, "ready");
});

test("hydrateSessionPullRequests reads workspace Archon artifacts by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-workspace-artifacts-"));
  const workspacePath = join(dir, "workspace");
  await mkdir(join(workspacePath, ".archon/state"), { recursive: true });
  await writeFile(join(workspacePath, ".archon/state/merge-status.json"), JSON.stringify({
    status: "MERGED",
    pr: { number: 92, url: "https://github.com/acme/sample/pull/92" },
    mergedAt: "2026-07-05T21:41:24Z",
  }), "utf8");
  await writeFile(join(workspacePath, ".archon/state/frontend-qa-status.txt"), "QA_PASSED\n", "utf8");

  const sessions = await hydrateSessionPullRequests([
    { id: "sample-92", projectId: "sample", issueId: "T092", status: "runtime_lost", workspacePath },
  ], { id: "sample" }, {
    readSessionMetadata: async () => null,
  });

  assert.equal(sessions[0].pr.number, 92);
  assert.equal(sessions[0].pr.state, "merged");
  assert.equal(sessions[0].pr.merged, true);
  assert.equal(sessions[0].qaStatus, "QA_PASSED");
  assert.equal(sessions[0].prReadiness, "merged");
});

test("hydrateSessionPullRequests reads generic QA status artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-generic-qa-"));
  const workspacePath = join(dir, "workspace");
  await mkdir(join(workspacePath, ".archon/state"), { recursive: true });
  await writeFile(join(workspacePath, ".archon/state/qa-status.txt"), "QA_BLOCKED\n", "utf8");

  const sessions = await hydrateSessionPullRequests([
    { id: "sample-93", projectId: "sample", issueId: "T093", status: "needs_input", workspacePath },
  ], { id: "sample" }, {
    readSessionMetadata: async () => null,
  });

  assert.equal(sessions[0].qaStatus, "QA_BLOCKED");
  assert.equal(Observability.normalizeLifecycleStatus(sessions[0], { now: new Date("2026-07-11T10:00:00.000Z") }), "failed");
});

test("normalizeLifecycleStatus treats QA failed and blocked as autonomous failures", () => {
  const now = new Date("2026-07-11T10:00:00.000Z");

  assert.equal(
    Observability.normalizeLifecycleStatus({ status: "needs_input", qaStatus: "QA_FAILED" }, { now }),
    "failed",
  );
  assert.equal(
    Observability.normalizeLifecycleStatus({ status: "needs_input", qaStatus: "QA_BLOCKED" }, { now }),
    "failed",
  );
  assert.equal(
    Observability.normalizeLifecycleStatus({
      status: "needs_input",
      qaStatus: "QA_BLOCKED",
      pr: { state: "merged", merged: true },
    }, { now }),
    "merged",
  );
});

test("runObservabilityOnce treats an open PR with pending checks as in review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-open-pending-pr-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T103")],
    getRunnableIssues: async () => [issue("T103")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-103",
          projectId: "sample",
          issueId: "T103",
          status: "killed",
          workspacePath: "/tmp/worktree-t103",
          pr: { number: 90 },
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "needs_input",
      agentReportedAt: "2026-06-27T15:19:43.000Z",
      agentReportedNote: "dark-factory milestone=failed task=T103 phase=auto_feature",
    }),
    getPullRequestState: async () => ({
      number: 90,
      url: "https://github.com/acme/sample/pull/90",
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [
        { name: "test", status: "IN_PROGRESS" },
      ],
    }),
    now: () => new Date("2026-06-27T15:45:00.000Z"),
  });

  assert.equal(snapshot.tasks.T103.status, "in_review");
  assert.equal(snapshot.tasks.T103.sessions[0].observableStatus, "in_review");
  assert.equal(snapshot.tasks.T103.sessions[0].prReadiness, "running");
  assert.equal(snapshot.summary.in_review, 1);
  assert.equal(snapshot.summary.failed, 0);
});

test("runObservabilityOnce hydrates plain PR URL sessions before classifying status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-string-pr-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T008")],
    getRunnableIssues: async () => [issue("T008")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-8",
          projectId: "sample",
          issueId: "T008",
          status: "killed",
          pr: "https://github.com/acme/sample/pull/41",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "ready_for_review",
      agentReportedAt: "2026-06-21T01:23:21.062Z",
    }),
    getPullRequestState: async (pr) => {
      assert.equal(pr.url, "https://github.com/acme/sample/pull/41");
      return {
        number: 41,
        url: "https://github.com/acme/sample/pull/41",
        state: "MERGED",
        mergedAt: "2026-06-21T01:43:18Z",
      };
    },
    now: () => new Date("2026-06-21T01:45:00.000Z"),
  });

  assert.equal(snapshot.tasks.T008.status, "merged");
  assert.equal(snapshot.tasks.T008.sessions[0].pr.merged, true);
  assert.equal(snapshot.summary.merged, 1);
  assert.equal(snapshot.summary.ready_to_merge, 0);
});

test("runObservabilityOnce treats ready-for-review reports as ready to merge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-ready-pr-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T006")],
    getRunnableIssues: async () => [issue("T006")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-6",
          projectId: "sample",
          issueId: "T006",
          status: "idle",
          workspacePath: "/tmp/worktree-t006",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "ready_for_review",
      agentReportedAt: "2026-06-19T15:58:57Z",
    }),
    now: () => new Date("2026-06-19T16:00:00.000Z"),
  });

  assert.equal(snapshot.tasks.T006.status, "ready_to_merge");
  assert.equal(snapshot.tasks.T006.sessions[0].observableStatus, "ready_to_merge");
  assert.equal(snapshot.tasks.T006.sessions[0].agentReportedState, "ready_for_review");
  assert.equal(snapshot.summary.ready_to_merge, 1);
});

test("runObservabilityOnce lets a valid ready artifact recover a terminated failed report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-ready-artifact-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T030")],
    getRunnableIssues: async () => [issue("T030")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-30",
          projectId: "sample",
          issueId: "T030",
          status: "killed",
          workspacePath: "/tmp/worktree-t030",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "needs_input",
      agentReportedAt: "2026-06-27T15:19:43.000Z",
      agentReportedNote: "dark-factory milestone=failed task=T030 phase=auto_feature",
    }),
    readReadyArtifact: async () => ({
      version: 1,
      projectId: "sample",
      sessionId: "sample-30",
      issueId: "T030",
      branch: "test/t030-account-lifecycle-browser-qa",
      localHead: "new-head",
      remoteHead: "new-head",
      pr: {
        number: 63,
        url: "https://github.com/acme/sample/pull/63",
        state: "OPEN",
        headRefOid: "new-head",
        mergeStateStatus: "CLEAN",
      },
      preparedAt: "2026-06-27T15:44:25.895Z",
    }),
    getPullRequestState: async () => ({
      number: 63,
      url: "https://github.com/acme/sample/pull/63",
      state: "OPEN",
      mergedAt: null,
    }),
    now: () => new Date("2026-06-27T15:45:00.000Z"),
  });

  assert.equal(snapshot.tasks.T030.status, "ready_to_merge");
  assert.equal(snapshot.tasks.T030.sessions[0].observableStatus, "ready_to_merge");
  assert.equal(snapshot.tasks.T030.sessions[0].agentMilestone, "ready_to_merge");
  assert.equal(snapshot.tasks.T030.sessions[0].readyArtifact.sessionId, "sample-30");
  assert.equal(snapshot.summary.ready_to_merge, 1);
  assert.equal(snapshot.summary.failed, 0);
});

test("runObservabilityOnce carries dark-factory milestones into task status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-milestone-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T009")],
    getRunnableIssues: async () => [issue("T009")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-9",
          projectId: "sample",
          issueId: "T009",
          status: "needs_input",
          workspacePath: "/tmp/worktree-t009",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "needs_input",
      agentReportedAt: "2026-06-20T13:49:44.426Z",
      agentReportedNote: "dark-factory milestone=failed phase=auto_feature task=T009",
    }),
    now: () => new Date("2026-06-20T13:50:00.000Z"),
  });

  assert.equal(snapshot.tasks.T009.status, "failed");
  assert.equal(snapshot.tasks.T009.sessions[0].observableStatus, "failed");
  assert.equal(snapshot.tasks.T009.sessions[0].agentMilestone, "failed");
  assert.equal(snapshot.summary.failed, 1);
});

test("runObservabilityOnce reads persisted events and attaches oldest-first task timelines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-events-"));
  const observabilityPath = join(dir, "observability.json");
  const eventLogPath = join(dir, "events.jsonl");

  await writeFile(eventLogPath, [
    JSON.stringify({
      id: "evt-1",
      version: 1,
      type: "task.started",
      projectId: "sample",
      taskId: "T010",
      timestamp: "2026-06-21T08:00:00.000Z",
    }),
    JSON.stringify({
      id: "evt-2",
      version: 1,
      type: "pr.opened",
      projectId: "sample",
      taskId: "T010",
      timestamp: "2026-06-21T09:00:00.000Z",
      metadata: { durationMs: 60000 },
    }),
    "",
  ].join("\n"), "utf8");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    eventLogPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T010")],
    getRunnableIssues: async () => [issue("T010")],
    listSessions: async () => ({ data: [] }),
    now: () => new Date("2026-06-21T10:00:00.000Z"),
  });

  assert.deepEqual(snapshot.events.map((event) => event.id), ["evt-1", "evt-2"]);
  assert.deepEqual(snapshot.tasks.T010.timeline.map((event) => event.type), ["task.started", "pr.opened"]);
  assert.equal(snapshot.tasks.T010.timeline[1].metadata.durationMs, 60000);
  assert.deepEqual(snapshot.eventSummary.byType, {
    "task.started": 1,
    "pr.opened": 1,
  });
});

test("runObservabilityOnce appends reconciliation events for changed persisted task status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-reconciled-"));
  const observabilityPath = join(dir, "observability.json");
  const eventLogPath = join(dir, "events.jsonl");

  await writeFile(observabilityPath, JSON.stringify({
    version: 1,
    project: { id: "sample" },
    tasks: {
      T006: { id: "T006", status: "ready_to_merge" },
    },
  }), "utf8");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    eventLogPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T006")],
    getRunnableIssues: async () => [issue("T006")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-t006",
          projectId: "sample",
          issueId: "T006",
          status: "done",
          pr: { number: 6 },
          lastActivityAt: "2026-06-21T09:00:00.000Z",
        },
      ],
    }),
    getPullRequestState: async () => ({
      number: 6,
      url: "https://github.com/example/repo/pull/6",
      state: "MERGED",
      mergedAt: "2026-06-21T09:30:00.000Z",
    }),
    now: () => new Date("2026-06-21T10:00:00.000Z"),
  });

  const eventLogEvents = (await readFile(eventLogPath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const reconciledEvent = {
    version: 1,
    type: "task.reconciled",
    projectId: "sample",
    taskId: "T006",
    timestamp: "2026-06-21T10:00:00.000Z",
    status: "merged",
    metadata: {
      previousStatus: "ready_to_merge",
      currentStatus: "merged",
      source: "observability",
    },
  };

  assert.equal(eventLogEvents.length, 1);
  assert.match(eventLogEvents[0].id, /.+/);
  assert.deepEqual({ ...eventLogEvents[0], id: undefined }, { ...reconciledEvent, id: undefined });
  assert.deepEqual(snapshot.events.map((event) => event.type), ["task.reconciled"]);
  assert.deepEqual(snapshot.tasks.T006.timeline.map((event) => event.type), ["task.reconciled"]);
});

test("runObservabilityOnce does not append reconciliation events for unchanged persisted task status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-reconciled-unchanged-"));
  const observabilityPath = join(dir, "observability.json");
  const eventLogPath = join(dir, "events.jsonl");

  await writeFile(observabilityPath, JSON.stringify({
    version: 1,
    project: { id: "sample" },
    tasks: {
      T006: { id: "T006", status: "ready_to_merge" },
    },
  }), "utf8");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    eventLogPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T006")],
    getRunnableIssues: async () => [issue("T006")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-t006",
          projectId: "sample",
          issueId: "T006",
          status: "idle",
          agentReportedState: "ready_for_review",
          lastActivityAt: "2026-06-21T09:00:00.000Z",
        },
      ],
    }),
    now: () => new Date("2026-06-21T10:00:00.000Z"),
  });

  await assert.rejects(() => readFile(eventLogPath, "utf8"), { code: "ENOENT" });
  assert.deepEqual(snapshot.events.map((event) => event.type), []);
  assert.deepEqual(snapshot.tasks.T006.timeline.map((event) => event.type), []);
});

test("runObservabilityOnce does not duplicate reconciliation events after a failed snapshot write retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-reconciled-retry-"));
  const observabilityPath = join(dir, "observability.json");
  const eventLogPath = join(dir, "events.jsonl");

  await writeFile(observabilityPath, JSON.stringify({
    version: 1,
    project: { id: "sample" },
    tasks: {
      T006: { id: "T006", status: "ready_to_merge" },
    },
  }), "utf8");
  await writeFile(eventLogPath, `${JSON.stringify({
    id: "evt-existing",
    version: 1,
    type: "task.reconciled",
    projectId: "sample",
    taskId: "T006",
    timestamp: "2026-06-21T09:59:00.000Z",
    status: "merged",
    metadata: {
      previousStatus: "ready_to_merge",
      currentStatus: "merged",
      source: "observability",
    },
  })}\n`, "utf8");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    eventLogPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T006")],
    getRunnableIssues: async () => [issue("T006")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-t006",
          projectId: "sample",
          issueId: "T006",
          status: "done",
          pr: { number: 6 },
          lastActivityAt: "2026-06-21T09:00:00.000Z",
        },
      ],
    }),
    getPullRequestState: async () => ({
      number: 6,
      url: "https://github.com/example/repo/pull/6",
      state: "MERGED",
      mergedAt: "2026-06-21T09:30:00.000Z",
    }),
    now: () => new Date("2026-06-21T10:00:00.000Z"),
  });

  const eventLogEvents = (await readFile(eventLogPath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));

  assert.deepEqual(eventLogEvents.map((event) => event.id), ["evt-existing"]);
  assert.deepEqual(snapshot.events.map((event) => event.id), ["evt-existing"]);
  assert.deepEqual(snapshot.tasks.T006.timeline.map((event) => event.id), ["evt-existing"]);
});

test("runObservabilityOnce derives milestone timelines from summarized session metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-derived-events-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    eventLogPath: join(dir, "missing-events.jsonl"),
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T011"), issue("T012"), issue("T013"), issue("T014"), issue("T015"), issue("T016")],
    getRunnableIssues: async () => [issue("T011"), issue("T012"), issue("T013"), issue("T014"), issue("T015"), issue("T016")],
    listSessions: async () => ({
      data: [
        { id: "sample-11", projectId: "sample", issueId: "T011", status: "working", lastActivityAt: "2026-06-21T08:00:00.000Z" },
        { id: "sample-12", projectId: "sample", issueId: "T012", status: "working", lastActivityAt: "2026-06-21T08:05:00.000Z" },
        { id: "sample-13", projectId: "sample", issueId: "T013", status: "done", lastActivityAt: "2026-06-21T08:10:00.000Z" },
        { id: "sample-14", projectId: "sample", issueId: "T014", status: "idle", lastActivityAt: "2026-06-21T08:15:00.000Z" },
        { id: "sample-15", projectId: "sample", issueId: "T015", status: "idle", lastActivityAt: "2026-06-21T08:20:00.000Z" },
        { id: "sample-16", projectId: "sample", issueId: "T016", status: "needs_input", lastActivityAt: "2026-06-21T08:25:00.000Z" },
      ],
    }),
    readSessionMetadata: async (session) => ({
      agentReportedState: session.status,
      agentReportedAt: {
        "sample-11": "2026-06-21T08:00:00.000Z",
        "sample-12": "2026-06-21T08:05:00.000Z",
        "sample-13": "2026-06-21T08:10:00.000Z",
        "sample-14": "2026-06-21T08:15:00.000Z",
        "sample-15": "2026-06-21T08:20:00.000Z",
        "sample-16": "2026-06-21T08:25:00.000Z",
      }[session.id],
      agentReportedNote: {
        "sample-11": "dark-factory milestone=auto_feature_started task=T011 phase=auto_feature",
        "sample-12": "dark-factory milestone=resume_started task=T012 phase=resume",
        "sample-13": "dark-factory milestone=auto_feature_completed task=T013 phase=auto_feature",
        "sample-14": "dark-factory milestone=pr_opened task=T014 phase=pr",
        "sample-15": "dark-factory milestone=ready_to_merge task=T015 phase=pr",
        "sample-16": "dark-factory milestone=failed task=T016 phase=auto_feature",
      }[session.id],
    }),
    now: () => new Date("2026-06-21T09:00:00.000Z"),
  });

  assert.deepEqual(snapshot.events.map((event) => [event.taskId, event.type]), [
    ["T011", "archon.workflow.started"],
    ["T012", "archon.workflow.started"],
    ["T013", "archon.workflow.finished"],
    ["T014", "pr.opened"],
    ["T015", "pr.ready"],
    ["T016", "archon.workflow.failed"],
  ]);
  assert.deepEqual(snapshot.tasks.T011.timeline.map((event) => event.type), ["archon.workflow.started"]);
  assert.deepEqual(snapshot.tasks.T012.timeline[0].metadata, { mode: "resume" });
  assert.deepEqual(snapshot.tasks.T013.timeline.map((event) => event.type), ["archon.workflow.finished"]);
  assert.deepEqual(snapshot.tasks.T014.timeline.map((event) => event.type), ["pr.opened"]);
  assert.deepEqual(snapshot.tasks.T015.timeline.map((event) => event.type), ["pr.ready"]);
  assert.deepEqual(snapshot.tasks.T016.timeline.map((event) => event.type), ["archon.workflow.failed"]);
});

test("runObservabilityOnce enriches milestone timelines with Archon node events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-archon-json-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T031")],
    getRunnableIssues: async () => [issue("T031")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-31",
          projectId: "sample",
          issueId: "T031",
          status: "working",
          lastActivityAt: "2026-06-27T10:00:30.000Z",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "working",
      agentReportedAt: "2026-06-27T10:00:00.000Z",
      agentReportedNote: "dark-factory milestone=auto_feature_started task=T031 phase=auto_feature archonRunId=run-031",
    }),
    getArchonRun: async (runId) => {
      assert.equal(runId, "run-031");
      return {
        id: runId,
        status: "running",
        events: [
          {
            type: "node_started",
            nodeId: "plan-feature",
            nodeName: "Plan feature",
            timestamp: "2026-06-27T10:01:00.000Z",
          },
          {
            type: "node_finished",
            nodeId: "plan-feature",
            nodeName: "Plan feature",
            timestamp: "2026-06-27T10:03:00.000Z",
            durationMs: 120000,
          },
          {
            type: "node_failed",
            nodeId: "implement",
            nodeName: "Implement",
            timestamp: "2026-06-27T10:05:00.000Z",
            error: "validation failed",
          },
        ],
      };
    },
    now: () => new Date("2026-06-27T10:06:00.000Z"),
  });

  assert.deepEqual(snapshot.tasks.T031.timeline.map((event) => event.type), [
    "archon.workflow.started",
    "archon.workflow.status",
    "archon.node.started",
    "archon.node.finished",
    "archon.node.failed",
  ]);
  assert.equal(snapshot.tasks.T031.timeline[1].status, "running");
  assert.equal(snapshot.tasks.T031.timeline[1].metadata.archonRunId, "run-031");
  assert.equal(snapshot.tasks.T031.timeline[2].metadata.archonRunId, "run-031");
  assert.equal(snapshot.tasks.T031.timeline[2].metadata.nodeId, "plan-feature");
  assert.equal(snapshot.tasks.T031.timeline[2].metadata.nodeName, "Plan feature");
  assert.equal(snapshot.tasks.T031.timeline[3].metadata.durationMs, 120000);
  assert.equal(snapshot.tasks.T031.timeline[4].error, "validation failed");
});

test("runObservabilityOnce reads Archon run status through the CLI by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-archon-cli-"));
  const observabilityPath = join(dir, "observability.json");
  const calls = [];

  const snapshot = await runObservabilityOnce({
    cwd: dir,
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T033")],
    getRunnableIssues: async () => [issue("T033")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-33",
          projectId: "sample",
          issueId: "T033",
          status: "working",
          lastActivityAt: "2026-06-27T10:00:30.000Z",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "working",
      agentReportedAt: "2026-06-27T10:00:00.000Z",
      agentReportedNote: "dark-factory milestone=auto_feature_started task=T033 phase=auto_feature archonRunId=run-033",
    }),
    execFileAsync: async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      assert.equal(file, "archon");
      assert.deepEqual(args, ["workflow", "get", "run-033", "--json"]);
      return {
        stdout: `INFO archon loaded workflows\n${JSON.stringify({
          id: "run-033",
          workflow_name: "auto-feature",
          status: "completed",
          last_activity_at: "2026-06-27T10:08:00.000Z",
          metadata: { node_counts: { completed: 9, failed: 0, total: 9 } },
        })}\nINFO archon done\n`,
      };
    },
    now: () => new Date("2026-06-27T10:09:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(snapshot.tasks.T033.timeline.map((event) => event.type), [
    "archon.workflow.started",
    "archon.workflow.status",
  ]);
  assert.equal(snapshot.tasks.T033.timeline[1].status, "completed");
  assert.deepEqual(snapshot.tasks.T033.timeline[1].metadata.nodeCounts, {
    completed: 9,
    failed: 0,
    total: 9,
  });
});

test("runObservabilityOnce ignores Archon enrichment failures and keeps milestone timelines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-archon-failure-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T032")],
    getRunnableIssues: async () => [issue("T032")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-32",
          projectId: "sample",
          issueId: "T032",
          status: "working",
          lastActivityAt: "2026-06-27T10:00:30.000Z",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "working",
      agentReportedAt: "2026-06-27T10:00:00.000Z",
      agentReportedNote: "dark-factory milestone=auto_feature_started task=T032 phase=auto_feature archonRunId=run-032",
    }),
    getArchonRun: async () => {
      throw new Error("archon unavailable");
    },
    now: () => new Date("2026-06-27T10:06:00.000Z"),
  });

  assert.deepEqual(snapshot.tasks.T032.timeline.map((event) => event.type), [
    "archon.workflow.started",
  ]);
});

test("runObservabilityOnce requeues interrupted workers without explicit failure milestones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-interrupted-worker-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T021")],
    getRunnableIssues: async () => [issue("T021")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-t021-retry1",
          projectId: "sample",
          issueId: "T021",
          status: "killed",
          workspacePath: "/tmp/worktree-t021",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "working",
      agentReportedAt: "2026-06-24T18:43:13.948Z",
      agentReportedNote: "dark-factory milestone=auto_feature_started task=T021 phase=auto_feature",
    }),
    now: () => new Date("2026-06-24T18:45:00.000Z"),
  });

  assert.equal(snapshot.tasks.T021.status, "queued");
  assert.equal(snapshot.tasks.T021.currentSession.observableStatus, "queued");
  assert.equal(snapshot.summary.queued, 1);
  assert.equal(snapshot.summary.failed, 0);
});

test("runObservabilityOnce requeues interrupted retries after an older explicit failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-interrupted-retry-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T021")],
    getRunnableIssues: async () => [issue("T021")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-t021",
          projectId: "sample",
          issueId: "T021",
          status: "killed",
          workspacePath: "/tmp/worktree-t021-old",
        },
        {
          id: "sample-t021-retry1",
          projectId: "sample",
          issueId: "T021",
          status: "killed",
          workspacePath: "/tmp/worktree-t021-retry1",
        },
      ],
    }),
    readSessionMetadata: async (session) => session.id.endsWith("retry1")
      ? {
          agentReportedState: "working",
          agentReportedAt: "2026-06-24T18:43:13.948Z",
          agentReportedNote: "dark-factory milestone=auto_feature_started task=T021 phase=auto_feature",
        }
      : {
          agentReportedState: "needs_input",
          agentReportedAt: "2026-06-24T18:41:43.857Z",
          agentReportedNote: "dark-factory milestone=failed task=T021 phase=auto_feature",
        },
    now: () => new Date("2026-06-24T18:45:00.000Z"),
  });

  assert.equal(snapshot.tasks.T021.status, "queued");
  assert.equal(snapshot.tasks.T021.currentSession.id, "sample-t021-retry1");
  assert.equal(snapshot.summary.queued, 1);
  assert.equal(snapshot.summary.failed, 0);
});

test("runObservabilityOnce keeps completed workers ready after AO marks runtime killed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-ready-killed-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T007")],
    getRunnableIssues: async () => [issue("T007")],
    listSessions: async () => ({
      data: [
        {
          id: "sample-7",
          projectId: "sample",
          issueId: "T007",
          status: "killed",
          workspacePath: "/tmp/worktree-t007",
        },
      ],
    }),
    readSessionMetadata: async () => ({
      agentReportedState: "ready_for_review",
      agentReportedAt: "2026-06-20T13:49:44.426Z",
    }),
    now: () => new Date("2026-06-20T13:50:00.000Z"),
  });

  assert.equal(snapshot.tasks.T007.status, "ready_to_merge");
  assert.equal(snapshot.summary.ready_to_merge, 1);
  assert.equal(snapshot.summary.failed, 0);
});

test("runObservabilityOnce synthesizes ready sessions from ready artifacts when AO listing is empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-ready-artifact-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    statePath: observabilityPath,
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T035")],
    getRunnableIssues: async () => [issue("T035")],
    listSessions: async () => ({ data: [] }),
    listReadyArtifacts: async () => [
      {
        sessionId: "sample-35",
        projectId: "sample",
        issueId: "T035",
        branch: "feat/t035",
        preparedAt: "2026-06-20T13:49:44.426Z",
        pr: { number: 44, url: "https://github.com/acme/app/pull/44", state: "open", mergeStateStatus: "CLEAN" },
      },
    ],
    getPullRequestState: async () => ({
      number: 44,
      url: "https://github.com/acme/app/pull/44",
      state: "OPEN",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [],
    }),
    now: () => new Date("2026-06-20T13:50:00.000Z"),
  });

  assert.equal(snapshot.tasks.T035.status, "ready_to_merge");
  assert.equal(snapshot.tasks.T035.currentSession.id, "sample-35");
  assert.equal(snapshot.summary.ready_to_merge, 1);
  assert.equal(snapshot.summary.queued, 0);
});

test("hydrateSessionPullRequests leaves sessions unchanged when metadata is absent", async () => {
  const sessions = await hydrateSessionPullRequests([
    { id: "sample-1", projectId: "sample", issueId: "T001", status: "killed" },
  ], { id: "sample" }, {
    readSessionMetadata: async () => null,
    getPullRequestState: async () => {
      throw new Error("should not be called");
    },
  });

  assert.deepEqual(sessions, [
    { id: "sample-1", projectId: "sample", issueId: "T001", status: "killed" },
  ]);
});

test("runObservabilityOnce defaults to a generic project rooted at cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-default-project-"));
  const observabilityPath = join(dir, "observability.json");

  const snapshot = await runObservabilityOnce({
    cwd: dir,
    statePath: observabilityPath,
    getAllIssues: async () => [issue("T001")],
    getRunnableIssues: async () => [issue("T001")],
    listSessions: async () => ({ data: [] }),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.equal(snapshot.project.id, "project");
  assert.equal(snapshot.project.name, "Project");
  assert.equal(snapshot.project.path, dir);
  assert.equal(snapshot.project.tasksPath, "planning/roadmap/tasks.md");
});

test("runObservabilityOnce lists project sessions through AO transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-observability-transport-"));
  const calls = [];
  const snapshot = await runObservabilityOnce({
    cwd: dir,
    statePath: join(dir, "observability.json"),
    project: { id: "sample", path: "/tmp/sample", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getAllIssues: async () => [issue("T004")],
    getRunnableIssues: async () => [issue("T004")],
    listReadyArtifacts: async () => [],
    transport: {
      sessionList: async (input) => {
        calls.push(input);
        return { data: [] };
      },
    },
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [{ projectId: "sample", includeTerminated: true }]);
  assert.equal(snapshot.tasks.T004.status, "queued");
});
