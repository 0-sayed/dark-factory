import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  assertWorkspaceReadyForMerge,
  buildAvailableWorkerSessionId,
  buildWorkerSessionId,
  ensureIssueWorkspace,
  findStaleLaunchWorkspaces,
  commandLooksLikeLiveWorkerProcess,
  spawnAoIssues,
  restoreAoSessions,
  resetStaleFrontendQaResumeState,
  recordAoSessionMerged,
  reconcileRunnerSnapshot,
  refreshReadyArtifactAfterPrepare,
  refreshProjectMain,
  runOnce as runOnceRaw,
  selectLaunchPlan,
  selectMergeQueuePlan,
  isProjectComplete,
  validateTrackerMergeCandidate,
} from "./dark-factory-runner.js";
import { readEvents } from "./dark-factory-events.js";

function issue(id) {
  return {
    id,
    title: `${id} task`,
    branchName: `feat/${id.toLowerCase()}`,
  };
}

function runOnce(options) {
  return runOnceRaw({
    validateTrackerCandidate: async () => null,
    ...options,
  });
}

function restorePlannedSessions(issues) {
  return {
    restored: issues.map((item) => ({
      issueId: item.id,
      sessionId: item.sessionId,
      stdout: "",
      stderr: "",
    })),
    errors: [],
  };
}

function assertWorkerPrepareBlockedWithoutResume(result, { issueId, sessionId, reasonPattern }) {
  assert.equal(result.mergeQueue.result.blocked.issueId, issueId);
  assert.equal(result.mergeQueue.result.blocked.phase, "worker-prepare");
  if (reasonPattern) assert.match(result.mergeQueue.result.blocked.reason, reasonPattern);
  assert.equal(result.mergeQueue.result.blocked.recovery.action, "resume_worker_session");
  assert.equal(result.mergeQueue.result.blocked.recovery.sessionId, sessionId);
  assert.deepEqual(result.mergeQueue.result.waiting, result.mergeQueue.result.blocked);
  assert.deepEqual(result.launchPlan.toResume.map((item) => [item.id, item.sessionId]), []);
  assert.deepEqual(result.resume.restored.map((item) => [item.issueId, item.sessionId]), []);
}

function assertWorkerPrepareResumed(result, { issueId, sessionId, reasonPattern }) {
  assert.equal(result.mergeQueue.result.blocked.issueId, issueId);
  assert.equal(result.mergeQueue.result.blocked.phase, "worker-prepare");
  if (reasonPattern) assert.match(result.mergeQueue.result.blocked.reason, reasonPattern);
  assert.equal(result.mergeQueue.result.blocked.recovery.action, "resume_worker_session");
  assert.equal(result.mergeQueue.result.blocked.recovery.sessionId, sessionId);
  assert.equal(result.mergeQueue.result.blocked.recovery.allowFullFeatureResume, true);
  assert.deepEqual(result.mergeQueue.result.waiting, result.mergeQueue.result.blocked);
  assert.deepEqual(result.launchPlan.toResume.map((item) => [item.id, item.sessionId]), [[issueId, sessionId]]);
  assert.deepEqual(result.resume.restored.map((item) => [item.issueId, item.sessionId]), [[issueId, sessionId]]);
}

test("live worker detection includes review lifecycle processes", () => {
  assert.equal(commandLooksLikeLiveWorkerProcess("node /skills/auto-merge/scripts/auto-merge.mjs --mode prepare"), true);
  assert.equal(commandLooksLikeLiveWorkerProcess("node /skills/auto-squash/scripts/review-cycle.js run"), true);
  assert.equal(commandLooksLikeLiveWorkerProcess("node /skills/wait-review-bots/scripts/review-bots.js wait"), true);
});

test("selectLaunchPlan avoids duplicate active sessions and respects concurrency", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T004"), issue("T005"), issue("T006")],
    sessions: [
      { id: "sample-4", issueId: "T004", status: "working" },
      { id: "sample-1", issueId: "T001", status: "done" },
    ],
    concurrency: 2,
  });

  assert.deepEqual(
    plan.toLaunch.map((item) => item.id),
    ["T005"],
  );
  assert.deepEqual(
    plan.activeSessions.map((session) => session.issueId),
    ["T004"],
  );
  assert.deepEqual(
    plan.skipped.map((item) => [item.id, item.reason]),
    [
      ["T004", "already_active"],
      ["T006", "concurrency_limit"],
    ],
  );
});

test("selectLaunchPlan defaults to runnable DAG size capped at four sessions", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T004"), issue("T005"), issue("T006"), issue("T007")],
    sessions: [],
  });

  assert.equal(plan.concurrency, 4);
  assert.deepEqual(
    plan.toLaunch.map((item) => item.id),
    ["T004", "T005", "T006", "T007"],
  );
  assert.deepEqual(plan.skipped, []);
});

test("selectLaunchPlan recoverOnly restores recoverable sessions without fresh launches", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T021"), issue("T022")],
    recoverOnly: true,
    sessions: [{
      id: "sample-t021-account-settings-frontend",
      projectId: "sample",
      issueId: "T021",
      status: "killed",
      workspacePath: "/tmp/t021",
    }],
    observedTasks: {
      T021: { status: "failed" },
    },
  });

  assert.deepEqual(plan.toResume.map((item) => item.id), ["T021"]);
  assert.deepEqual(plan.toLaunch, []);
  assert.deepEqual(plan.skipped.map((item) => [item.id, item.reason]), [
    ["T022", "recover_only"],
  ]);
});

test("selectLaunchPlan treats needs_input worker sessions as recoverable when a workspace exists", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T030")],
    recoverOnly: true,
    sessions: [{
      id: "sample-t030",
      issueId: "T030",
      status: "needs_input",
      workspacePath: "/tmp/t030",
    }],
  });

  assert.deepEqual(plan.activeSessions, []);
  assert.deepEqual(plan.toResume.map((item) => [item.id, item.sessionId, item.previousStatus]), [
    ["T030", "sample-t030", "needs_input"],
  ]);
  assert.deepEqual(plan.toLaunch, []);
});

test("selectLaunchPlan treats exited worker sessions as recoverable when a workspace exists", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T032"), issue("T035"), issue("T037")],
    concurrency: 2,
    sessions: [
      {
        id: "sample-t032",
        issueId: "T032",
        status: "exited",
        workspacePath: "/tmp/t032",
      },
      {
        id: "sample-t035",
        issueId: "T035",
        status: "exited",
        workspacePath: "/tmp/t035",
      },
    ],
  });

  assert.deepEqual(plan.activeSessions, []);
  assert.deepEqual(plan.toResume.map((item) => [item.id, item.sessionId, item.previousStatus]), [
    ["T032", "sample-t032", "exited"],
    ["T035", "sample-t035", "exited"],
  ]);
  assert.deepEqual(plan.toLaunch, []);
  assert.deepEqual(plan.skipped.map((item) => [item.id, item.reason]), [
    ["T037", "concurrency_limit"],
  ]);
});

test("selectLaunchPlan treats errored worker sessions as recoverable when a workspace exists", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T029")],
    concurrency: 1,
    sessions: [{
      id: "sample-t029",
      issueId: "T029",
      status: "errored",
      workspacePath: "/tmp/t029",
    }],
  });

  assert.deepEqual(plan.activeSessions, []);
  assert.deepEqual(plan.toResume.map((item) => [item.id, item.sessionId, item.previousStatus]), [
    ["T029", "sample-t029", "errored"],
  ]);
  assert.deepEqual(plan.toLaunch, []);
});

test("selectLaunchPlan treats PR sessions with dead runtimes as recoverable", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T035"), issue("T037")],
    concurrency: 1,
    sessions: [
      {
        id: "sample-t035",
        issueId: "T035",
        status: "review_pending",
        workspacePath: "/tmp/t035",
        lifecycle: {
          session: { kind: "worker", state: "terminated", reason: "runtime_lost" },
          runtime: { state: "exited", reason: "process_missing" },
          pr: { state: "open", reason: "review_pending" },
        },
      },
    ],
  });

  assert.deepEqual(plan.activeSessions, []);
  assert.deepEqual(plan.toResume.map((item) => [item.id, item.sessionId, item.previousStatus]), [
    ["T035", "sample-t035", "review_pending"],
  ]);
  assert.deepEqual(plan.toLaunch, []);
  assert.deepEqual(plan.skipped.map((item) => [item.id, item.reason]), [
    ["T037", "concurrency_limit"],
  ]);
});

test("selectLaunchPlan treats PR sessions with live runtimes as active", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T035"), issue("T037")],
    concurrency: 1,
    sessions: [
      {
        id: "sample-t035",
        issueId: "T035",
        status: "review_pending",
        workspacePath: "/tmp/t035",
        lifecycle: {
          session: { kind: "worker", state: "working", reason: "review_cleanup" },
          runtime: { state: "alive", reason: "process_running" },
          pr: { state: "open", reason: "review_pending" },
        },
      },
    ],
  });

  assert.deepEqual(plan.activeSessions.map((session) => [session.issueId, session.status]), [
    ["T035", "review_pending"],
  ]);
  assert.deepEqual(plan.toResume, []);
  assert.deepEqual(plan.toLaunch, []);
  assert.deepEqual(plan.skipped.map((item) => [item.id, item.reason]), [
    ["T035", "already_active"],
    ["T037", "concurrency_limit"],
  ]);
});

test("selectLaunchPlan treats PR sessions with live workspace processes as active", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T035"), issue("T037")],
    concurrency: 1,
    sessions: [
      {
        id: "sample-t035",
        issueId: "T035",
        status: "review_pending",
        workspacePath: "/tmp/t035",
        pr: { number: 35, state: "open" },
      },
    ],
    liveWorkspacePaths: new Set(["/tmp/t035"]),
  });

  assert.deepEqual(plan.activeSessions.map((session) => [session.issueId, session.status]), [
    ["T035", "review_pending"],
  ]);
  assert.deepEqual(plan.toResume, []);
  assert.deepEqual(plan.toLaunch, []);
  assert.deepEqual(plan.skipped.map((item) => [item.id, item.reason]), [
    ["T035", "already_active"],
    ["T037", "concurrency_limit"],
  ]);
});

test("selectLaunchPlan treats failed PR-gate sessions as recoverable without runtime metadata", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T041"), issue("T042")],
    concurrency: 1,
    sessions: [
      {
        id: "sample-t041",
        issueId: "T041",
        status: "ci_failed",
        branch: "feat/t041",
        workspacePath: "/tmp/t041",
        pr: "https://github.com/acme/sample/pull/41",
      },
    ],
    observedTasks: {
      T041: {
        status: "running",
        sessions: [{
          id: "sample-t041",
          issueId: "T041",
          status: "ci_failed",
          observableStatus: "running",
          workspacePath: "/tmp/t041",
          prReadiness: "queued",
        }],
      },
    },
  });

  assert.deepEqual(plan.activeSessions, []);
  assert.deepEqual(plan.toResume.map((item) => [item.id, item.sessionId, item.previousStatus]), [
    ["T041", "sample-t041", "ci_failed"],
  ]);
  assert.deepEqual(plan.toLaunch, []);
  assert.deepEqual(plan.skipped.map((item) => [item.id, item.reason]), [
    ["T042", "concurrency_limit"],
  ]);
});

test("buildWorkerSessionId derives readable ids from task branches", () => {
  assert.equal(
    buildWorkerSessionId(
      { id: "easygen" },
      {
        id: "T017",
        title: "Typed frontend API client",
        branchName: "feat/t017-typed-frontend-api-client",
      },
    ),
    "easygen-t017-typed-frontend-api-client",
  );
});

test("buildAvailableWorkerSessionId adds retry suffix when AO already has that id", () => {
  const issue = {
    id: "T021",
    title: "Account settings frontend",
    branchName: "feat/t021-account-settings-frontend",
  };

  assert.equal(
    buildAvailableWorkerSessionId({ id: "easygen" }, issue, [
      { id: "easygen-t021-account-settings-frontend" },
      { id: "easygen-t021-account-settings-frontend-retry1" },
    ]),
    "easygen-t021-account-settings-frontend-retry2",
  );
});

test("spawnAoIssues spawns each task with an explicit readable session id", async () => {
  const calls = [];

  await spawnAoIssues([
    {
      id: "T017",
      title: "Typed frontend API client",
      branchName: "feat/t017-typed-frontend-api-client",
    },
    {
      id: "T018",
      title: "Dashboard cards cleanup",
      branchName: "feat/t018-dashboard-cards-cleanup",
    },
  ], {
    project: { id: "easygen" },
    transport: { spawn: async (input) => calls.push(input) },
  });

  assert.deepEqual(calls.map(({ projectId, issueId, sessionId, harness }) => ({ projectId, issueId, sessionId, harness })), [
    { projectId: "easygen", issueId: "T017", sessionId: "easygen-t017-typed-frontend-api-client", harness: "external" },
    { projectId: "easygen", issueId: "T018", sessionId: "easygen-t018-dashboard-cards-cleanup", harness: "external" },
  ]);
});

test("spawnAoIssues synchronously uses the external Go AO harness with branch and prompt", async () => {
  const calls = [];
  const transport = {
    spawn: async (input) => {
      calls.push(input);
      return { id: input.sessionId, projectId: input.projectId, issueId: input.issueId };
    },
  };

  const result = await spawnAoIssues([
    {
      id: "T017",
      title: "Typed frontend API client",
      branchName: "feat/t017-typed-frontend-api-client",
      prompt: "Implement T017",
    },
  ], {
    project: { id: "easygen" },
    transport,
  });

  assert.deepEqual(calls, [{
    projectId: "easygen",
    issueId: "T017",
    sessionId: "easygen-t017-typed-frontend-api-client",
    harness: "external",
    branch: "feat/t017-typed-frontend-api-client",
    prompt: "Implement T017",
    displayName: "Typed frontend API c",
  }]);
  assert.deepEqual(result.spawned, [{
    issueId: "T017",
    sessionId: "easygen-t017-typed-frontend-api-client",
    stdout: "",
    stderr: "",
  }]);
});

test("spawnAoIssues bounds AO display names to 20 Unicode characters without changing task content", async () => {
  const calls = [];
  const title = "Implement customer-facing account recovery 🔐";

  await spawnAoIssues([{
    id: "T099",
    title,
    branchName: "feat/t099-account-recovery",
    prompt: `Implement T099: ${title}`,
  }], {
    project: { id: "sample" },
    transport: { spawn: async (input) => calls.push(input) },
  });

  assert.equal(Array.from(calls[0].displayName).length <= 20, true);
  assert.equal(calls[0].displayName, "Implement customer-f");
  assert.equal(calls[0].prompt, `Implement T099: ${title}`);
  assert.equal(title, "Implement customer-facing account recovery 🔐");
});

test("spawnAoIssues avoids existing AO session ids for retries", async () => {
  const calls = [];

  await spawnAoIssues([
    {
      id: "T021",
      title: "Account settings frontend",
      branchName: "feat/t021-account-settings-frontend",
    },
  ], {
    project: { id: "easygen" },
    sessions: [
      { id: "easygen-t021-account-settings-frontend" },
      { id: "easygen-t021-account-settings-frontend-retry1" },
    ],
    transport: { spawn: async (input) => calls.push(input) },
  });

  assert.equal(calls[0].sessionId, "easygen-t021-account-settings-frontend-retry2");
});

test("spawnAoIssues staggers session starts when a launch delay is configured", async () => {
  const events = [];

  await spawnAoIssues([
    { id: "T017", title: "Typed frontend API client", branchName: "feat/t017-typed-frontend-api-client" },
    { id: "T018", title: "Dashboard cards cleanup", branchName: "feat/t018-dashboard-cards-cleanup" },
    { id: "T019", title: "Reports export", branchName: "feat/t019-reports-export" },
  ], {
    project: { id: "easygen" },
    spawnDelayMs: 60000,
    sleep: async (ms) => {
      events.push(["sleep", ms]);
    },
    transport: { spawn: async (input) => events.push(["spawn", input.issueId]) },
  });

  assert.deepEqual(events, [
    ["spawn", "T017"],
    ["sleep", 60000],
    ["spawn", "T018"],
    ["sleep", 60000],
    ["spawn", "T019"],
  ]);
});

test("restoreAoSessions restores existing AO worker sessions", async () => {
  const calls = [];

  const result = await restoreAoSessions([
    {
      id: "T021",
      sessionId: "sample-t021-account-settings-frontend",
    },
  ], {
    transport: { sessionRestore: async (sessionId) => calls.push(sessionId) },
    prepareSessionRestore: async () => null,
  });

  assert.deepEqual(calls, ["sample-t021-account-settings-frontend"]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.restored.map((item) => [item.issueId, item.sessionId]), [
    ["T021", "sample-t021-account-settings-frontend"],
  ]);
});

test("restoreAoSessions delegates restores to Go AO transport", async () => {
  const calls = [];
  const result = await restoreAoSessions([
    { id: "T017", sessionId: "easygen-t017", workspacePath: "/tmp/easygen-t017" },
  ], {
    transport: {
      sessionRestore: async (sessionId) => {
        calls.push(sessionId);
        return { id: sessionId, projectId: "easygen", issueId: "T017" };
      },
    },
    prepareSessionRestore: async () => null,
  });

  assert.deepEqual(calls, ["easygen-t017"]);
  assert.deepEqual(result, {
    restored: [{ issueId: "T017", sessionId: "easygen-t017", stdout: "", stderr: "" }],
    errors: [],
  });
});

test("restoreAoSessions starts planned restores concurrently", async () => {
  const calls = [];
  const release = [];

  const resultPromise = restoreAoSessions([
    { id: "T021", sessionId: "sample-t021" },
    { id: "T022", sessionId: "sample-t022" },
  ], {
    transport: { sessionRestore: async (sessionId) => {
      calls.push(sessionId);
      return new Promise((resolve) => {
        release.push(resolve);
      });
    } },
    prepareSessionRestore: async () => null,
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["sample-t021", "sample-t022"]);

  release.forEach((resolve) => resolve());
  const result = await resultPromise;

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.restored.map((item) => item.issueId), ["T021", "T022"]);
});

test("restoreAoSessions suspends stale non-restorable sessions before retrying restore", async () => {
  const calls = [];
  let restoreAttempts = 0;
  const issue = {
    id: "T021",
    sessionId: "sample-t021",
    workspacePath: "/tmp/sample-t021",
  };

  const result = await restoreAoSessions([issue], {
    transport: {
      sessionRestore: async (sessionId) => {
        calls.push(["restore", sessionId]);
        restoreAttempts += 1;
        if (restoreAttempts === 1) {
          const error = new Error("Session is not restorable");
          error.status = 409;
          error.code = "SESSION_NOT_RESTORABLE";
          throw error;
        }
      },
      sessionSuspend: async (sessionId) => {
        calls.push(["suspend", sessionId]);
        return { sessionId, suspended: true, preserved: true };
      },
    },
    prepareSessionRestore: async () => null,
    detectLiveWorkerPaths: async () => new Set(),
  });

  assert.deepEqual(calls, [
    ["restore", "sample-t021"],
    ["suspend", "sample-t021"],
    ["restore", "sample-t021"],
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.restored.map((item) => [item.issueId, item.sessionId]), [["T021", "sample-t021"]]);
  assert.deepEqual(result.restored[0].recovery, {
    action: "suspend_then_restore",
    suspended: true,
    preserved: true,
  });
});

test("restoreAoSessions does not suspend when an owning worker process is live", async () => {
  const calls = [];
  const issue = {
    id: "T021",
    sessionId: "sample-t021",
    workspacePath: "/tmp/sample-t021",
  };

  const result = await restoreAoSessions([issue], {
    transport: {
      sessionRestore: async () => {
        const error = new Error("Session is not restorable");
        error.status = 409;
        error.code = "SESSION_NOT_RESTORABLE";
        throw error;
      },
      sessionSuspend: async (sessionId) => calls.push(sessionId),
    },
    prepareSessionRestore: async () => null,
    detectLiveWorkerPaths: async () => new Set([issue.workspacePath]),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result.restored, []);
  assert.equal(result.errors[0].message, "Session is not restorable");
});

test("findStaleLaunchWorkspaces detects terminal worktrees behind origin main", async () => {
  const calls = [];

  const stale = await findStaleLaunchWorkspaces([issue("T021")], {
    project: { id: "easygen", defaultBranch: "main" },
    sessions: [
      {
        id: "easygen-t021-account-settings-frontend-retry1",
        issueId: "T021",
        status: "killed",
        workspacePath: "/tmp/t021",
      },
    ],
    runWorkspaceGit: async (workspacePath, args) => {
      calls.push([workspacePath, args]);
      if (args[0] === "merge-base") throw new Error("not ancestor");
      return "";
    },
  });

  assert.deepEqual(stale, [{
    id: "T021",
    reason: "stale_existing_workspace",
    sessionId: "easygen-t021-account-settings-frontend-retry1",
    workspacePath: "/tmp/t021",
  }]);
  assert.deepEqual(calls, [
    ["/tmp/t021", ["fetch", "origin", "main", "--quiet"]],
    ["/tmp/t021", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]],
  ]);
});

test("findStaleLaunchWorkspaces ignores terminal sessions whose cleaned worktree is gone", async () => {
  const stale = await findStaleLaunchWorkspaces([issue("T021")], {
    project: { id: "easygen", defaultBranch: "main" },
    sessions: [
      {
        id: "easygen-t021-account-settings-frontend-retry1",
        issueId: "T021",
        status: "killed",
        workspacePath: "/tmp/missing-t021",
      },
    ],
    runWorkspaceGit: async () => {
      throw new Error("fatal: cannot change to '/tmp/missing-t021': No such file or directory");
    },
  });

  assert.deepEqual(stale, []);
});

test("runOnce skips launches with stale terminal worktrees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-stale-launch-"));
  const statePath = join(dir, "state.json");
  const spawned = [];

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    concurrency: 1,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T021")],
    listSessions: async () => ({
      data: [{
        id: "sample-t021-retry1",
        projectId: "sample",
        issueId: "T021",
        status: "done",
        workspacePath: "/tmp/t021",
      }],
    }),
    runWorkspaceGit: async (_workspacePath, args) => {
      if (args[0] === "merge-base") throw new Error("not ancestor");
      return "";
    },
    spawnIssues: async (issues) => spawned.push(...issues),
    now: () => new Date("2026-06-25T20:00:00.000Z"),
  });

  assert.deepEqual(spawned, []);
  assert.deepEqual(result.launchPlan.toLaunch, []);
  assert.deepEqual(result.launchPlan.skipped, [{
    id: "T021",
    reason: "stale_existing_workspace",
    sessionId: "sample-t021-retry1",
    workspacePath: "/tmp/t021",
  }]);
});

test("runOnce launches fresh worker when cleaned terminal workspace metadata remains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-cleaned-launch-"));
  const statePath = join(dir, "state.json");
  const spawned = [];

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    concurrency: 1,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T021")],
    listSessions: async () => ({
      data: [{
        id: "sample-t021-retry1",
        projectId: "sample",
        issueId: "T021",
        status: "killed",
        workspacePath: "/tmp/missing-t021",
      }],
    }),
    runWorkspaceGit: async () => {
      throw new Error("fatal: cannot change to '/tmp/missing-t021': No such file or directory");
    },
    spawnIssues: async (issues) => spawned.push(...issues),
    now: () => new Date("2026-06-25T20:00:00.000Z"),
  });

  assert.deepEqual(spawned.map((item) => item.id), ["T021"]);
  assert.deepEqual(result.launchPlan.toLaunch.map((item) => item.id), ["T021"]);
  assert.deepEqual(result.launchPlan.toResume, []);
  assert.deepEqual(result.launchPlan.skipped, []);
});

test("runOnce resumes stale failed worktrees instead of blocking them as stale launches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-stale-capacity-"));
  const statePath = join(dir, "state.json");

  const result = await runOnce({
    cwd: dir,
    dryRun: true,
    statePath,
    concurrency: 2,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T021"), issue("T026")],
    listSessions: async () => ({
      data: [{
        id: "sample-t021",
        projectId: "sample",
        issueId: "T021",
        status: "killed",
        workspacePath: "/tmp/t021",
      }],
    }),
    observabilityState: {
      tasks: {
        T021: { status: "failed" },
      },
    },
    runWorkspaceGit: async (_workspacePath, args) => {
      if (args[0] === "merge-base") throw new Error("not ancestor");
      return "";
    },
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(result.launchPlan.toResume.map((item) => [item.id, item.sessionId, item.previousStatus]), [
    ["T021", "sample-t021", "killed"],
  ]);
  assert.deepEqual(result.launchPlan.toLaunch.map((item) => item.id), ["T026"]);
  assert.deepEqual(result.launchPlan.skipped, []);
});

test("selectLaunchPlan auto concurrency shrinks to smaller runnable ready set", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T004"), issue("T005")],
    sessions: [],
  });

  assert.equal(plan.concurrency, 2);
  assert.deepEqual(
    plan.toLaunch.map((item) => item.id),
    ["T004", "T005"],
  );
  assert.deepEqual(plan.skipped, []);
});

test("selectLaunchPlan suppresses tasks already completed in observability state", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T004"), issue("T005")],
    sessions: [],
    observedTasks: {
      T004: { status: "done" },
      T005: { status: "ready" },
    },
    concurrency: 2,
  });

  assert.deepEqual(
    plan.toLaunch.map((item) => item.id),
    ["T005"],
  );
  assert.deepEqual(plan.skipped, [{ id: "T004", reason: "observed_done" }]);
});

test("selectLaunchPlan suppresses failed tasks without blocking unrelated runnable tasks", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T004"), issue("T005")],
    sessions: [],
    observedTasks: {
      T004: { status: "failed" },
    },
    concurrency: 2,
  });

  assert.deepEqual(plan.toLaunch.map((item) => item.id), ["T005"]);
  assert.deepEqual(plan.skipped, [{ id: "T004", reason: "observed_failed" }]);
});

test("selectLaunchPlan restores a failed worker session in its existing worktree", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T021"), issue("T022")],
    sessions: [{
      id: "sample-t021-account-settings-frontend",
      issueId: "T021",
      status: "failed",
      workspacePath: "/tmp/t021",
    }],
    observedTasks: {
      T021: { status: "failed" },
    },
    concurrency: 2,
  });

  assert.deepEqual(plan.toResume, [{
    id: "T021",
    branchName: "feat/t021",
    title: "T021 task",
    sessionId: "sample-t021-account-settings-frontend",
    workspacePath: "/tmp/t021",
    previousStatus: "failed",
  }]);
  assert.deepEqual(plan.toLaunch.map((item) => item.id), ["T022"]);
  assert.deepEqual(plan.skipped, []);
});

test("selectLaunchPlan skips ready sessions with dead runtimes", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T021"), issue("T022")],
    sessions: [{
      id: "sample-t021-account-settings-frontend",
      issueId: "T021",
      status: "ready_to_merge",
      workspacePath: "/tmp/t021",
      lifecycle: {
        session: { state: "terminated", reason: "runtime_lost" },
        runtime: { state: "exited", reason: "process_missing" },
      },
    }],
    concurrency: 2,
  });

  assert.deepEqual(plan.toResume, []);
  assert.deepEqual(plan.toLaunch.map((item) => item.id), ["T022"]);
  assert.deepEqual(plan.skipped, [{ id: "T021", reason: "already_ready" }]);
});

test("selectLaunchPlan blocks unrecoverable failed sessions without a worktree", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T021"), issue("T022")],
    sessions: [{
      id: "sample-t021-account-settings-frontend",
      issueId: "T021",
      status: "failed",
    }],
    observedTasks: {
      T021: { status: "failed" },
    },
    concurrency: 2,
  });

  assert.deepEqual(plan.toResume, []);
  assert.deepEqual(plan.toLaunch.map((item) => item.id), ["T022"]);
  assert.deepEqual(plan.skipped, [
    {
      id: "T021",
      reason: "resume_missing_workspace",
      sessionId: "sample-t021-account-settings-frontend",
      status: "failed",
    },
  ]);
});

test("selectLaunchPlan relaunches pre-PR failed tasks after cleaned worker workspace", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T021"), issue("T022")],
    sessions: [],
    observedTasks: {
      T021: {
        status: "failed",
        sessions: [{
          id: "sample-t021-account-settings-frontend",
          status: "killed",
          workspacePath: "/tmp/missing-t021",
          pr: null,
          readyArtifact: null,
          lifecycle: {
            pr: {
              state: "none",
              reason: "not_created",
            },
          },
        }],
      },
    },
    concurrency: 2,
  });

  assert.deepEqual(plan.toResume, []);
  assert.deepEqual(plan.toLaunch.map((item) => item.id), ["T021", "T022"]);
  assert.deepEqual(plan.skipped, []);
});

test("selectLaunchPlan blocks launches when active sessions fill concurrency", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T004")],
    sessions: [{ id: "sample-5", issueId: "T002", status: "working" }],
    concurrency: 1,
  });

  assert.deepEqual(plan.toLaunch, []);
  assert.deepEqual(plan.skipped, [{ id: "T004", reason: "concurrency_limit" }]);
});

test("selectLaunchPlan rejects explicit invalid taskLimit values", () => {
  for (const taskLimit of ["abc", -1, "0"]) {
    assert.throws(
      () => selectLaunchPlan({
        runnableIssues: [issue("T021")],
        sessions: [],
        concurrency: 1,
        taskLimit,
      }),
      /taskLimit must be a positive integer when provided/,
    );
  }
});

test("selectLaunchPlan allows internal numeric zero taskLimit to suppress launches and resumes", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T021"), issue("T022")],
    sessions: [{
      id: "sample-t021-account-settings-frontend",
      issueId: "T021",
      status: "failed",
      workspacePath: "/tmp/t021",
    }],
    observedTasks: {
      T021: { status: "failed" },
    },
    concurrency: 2,
    taskLimit: 0,
  });

  assert.equal(plan.taskLimit, 0);
  assert.equal(plan.availableTaskSlots, 0);
  assert.deepEqual(plan.toResume, []);
  assert.deepEqual(plan.toLaunch, []);
  assert.deepEqual(plan.skipped, [
    { id: "T021", reason: "task_limit" },
    { id: "T022", reason: "task_limit" },
  ]);
});

test("selectLaunchPlan lets active sessions reduce concurrency without consuming taskLimit", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T021"), issue("T022")],
    sessions: [
      { id: "sample-t010", issueId: "T010", status: "working" },
      { id: "sample-t011", issueId: "T011", status: "working" },
    ],
    concurrency: 3,
    taskLimit: 2,
  });

  assert.equal(plan.taskLimit, 2);
  assert.equal(plan.availableSlots, 1);
  assert.equal(plan.availableTaskSlots, 1);
  assert.deepEqual(plan.toLaunch.map((item) => item.id), ["T021"]);
  assert.deepEqual(plan.skipped, [{ id: "T022", reason: "concurrency_limit" }]);
});

test("selectLaunchPlan counts resumed and launched tasks against taskLimit together", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T021"), issue("T022"), issue("T023")],
    sessions: [{
      id: "sample-t021-account-settings-frontend",
      issueId: "T021",
      status: "failed",
      workspacePath: "/tmp/t021",
    }],
    observedTasks: {
      T021: { status: "failed" },
    },
    concurrency: 3,
    taskLimit: 2,
  });

  assert.equal(plan.taskLimit, 2);
  assert.equal(plan.availableTaskSlots, 2);
  assert.deepEqual(plan.toResume.map((item) => item.id), ["T021"]);
  assert.deepEqual(plan.toLaunch.map((item) => item.id), ["T022"]);
  assert.deepEqual(plan.skipped, [{ id: "T023", reason: "task_limit" }]);
});

test("selectLaunchPlan leaves taskLimit unlimited when omitted", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T021"), issue("T022"), issue("T023")],
    sessions: [{
      id: "sample-t021-account-settings-frontend",
      issueId: "T021",
      status: "failed",
      workspacePath: "/tmp/t021",
    }],
    observedTasks: {
      T021: { status: "failed" },
    },
    concurrency: 3,
  });

  assert.equal(plan.taskLimit, null);
  assert.equal(plan.availableTaskSlots, 3);
  assert.deepEqual(plan.toResume.map((item) => item.id), ["T021"]);
  assert.deepEqual(plan.toLaunch.map((item) => item.id), ["T022", "T023"]);
  assert.deepEqual(plan.skipped, []);
});

test("selectLaunchPlan recoverOnly applies taskLimit only to resumptions", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T021"), issue("T022"), issue("T023"), issue("T024")],
    sessions: [
      {
        id: "sample-t021-account-settings-frontend",
        issueId: "T021",
        status: "failed",
        workspacePath: "/tmp/t021",
      },
      {
        id: "sample-t024-account-settings-backend",
        issueId: "T024",
        status: "killed",
        workspacePath: "/tmp/t024",
      },
    ],
    observedTasks: {
      T021: { status: "failed" },
      T024: { status: "failed" },
    },
    recoverOnly: true,
    concurrency: 4,
    taskLimit: 1,
  });

  assert.deepEqual(plan.toResume.map((item) => item.id), ["T021"]);
  assert.deepEqual(plan.toLaunch, []);
  assert.deepEqual(plan.skipped, [
    { id: "T022", reason: "recover_only" },
    { id: "T023", reason: "recover_only" },
    { id: "T024", reason: "task_limit" },
  ]);
});

test("selectMergeQueuePlan orders ready tasks across the DAG by priority then id", () => {
  const plan = selectMergeQueuePlan({
    taskPlan: {
      tasks: new Map([
        ["T001", { id: "T001", done: true, priority: 10 }],
        ["T002", { id: "T002", done: false, priority: 20 }],
        ["T003", { id: "T003", done: false, priority: 30 }],
        ["T004", { id: "T004", done: false, priority: 5 }],
      ])
    },
    observedTasks: {
      T002: { status: "ready", sessions: [{ id: "sample-2", workspacePath: "/tmp/t002" }] },
      T003: { status: "ready", sessions: [{ id: "sample-3", workspacePath: "/tmp/t003" }] },
      T004: { status: "ready", sessions: [{ id: "sample-4", workspacePath: "/tmp/t004" }] },
    },
  });
  assert.deepEqual(plan.finalizeOrder, ["T004", "T002", "T003"]);
  assert.deepEqual(plan.refreshAfterMerge, [
    { after: "T004", issueIds: ["T002", "T003"] },
    { after: "T002", issueIds: ["T003"] },
    { after: "T003", issueIds: [] },
  ]);
});

test("runOnce passes taskLimit into launch planning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-task-limit-"));
  const statePath = join(dir, "state.json");
  const spawned = [];

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    concurrency: 3,
    taskLimit: 1,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T021"), issue("T022")],
    getTaskPlan: async () => ({ tasks: new Map() }),
    listSessions: async () => ({
      data: [{
        id: "sample-t021-account-settings-frontend",
        projectId: "sample",
        issueId: "T021",
        status: "failed",
        workspacePath: "/tmp/t021",
      }],
    }),
    runWorkspaceGit: async () => "",
    spawnIssues: async (issues) => spawned.push(...issues),
    restoreSessions: async (issues) => ({
      restored: issues.map((item) => ({ issueId: item.id, sessionId: item.sessionId })),
      errors: [],
    }),
    now: () => new Date("2026-07-05T12:00:00.000Z"),
  });

  assert.deepEqual(spawned, []);
  assert.equal(result.launchPlan.taskLimit, 1);
  assert.equal(result.launchPlan.availableTaskSlots, 1);
  assert.deepEqual(result.launchPlan.toResume.map((item) => item.id), ["T021"]);
  assert.deepEqual(result.launchPlan.toLaunch, []);
  assert.deepEqual(result.launchPlan.skipped, [{ id: "T022", reason: "task_limit" }]);
});

test("selectLaunchPlan charges each task only once across recovery", () => {
  const plan = selectLaunchPlan({
    runnableIssues: [issue("T021"), issue("T022"), issue("T023")],
    sessions: [
      {
        id: "sample-t021",
        issueId: "T021",
        status: "terminated",
        workspacePath: "/tmp/t021",
      },
    ],
    observedTasks: {
      T021: { status: "failed" },
      T022: { status: "queued" },
      T023: { status: "queued" },
    },
    concurrency: 3,
    taskLimit: 2,
    chargedTaskIds: ["T021"],
  });

  assert.deepEqual(plan.toResume.map((item) => item.id), ["T021"]);
  assert.deepEqual(plan.toLaunch.map((item) => item.id), ["T022"]);
  assert.deepEqual(plan.skipped, [{ id: "T023", reason: "task_limit" }]);
  assert.deepEqual(plan.chargedTaskIds, ["T021"]);
  assert.equal(plan.availableTaskSlots, 1);
});

test("reconcileRunnerSnapshot closes stale runner state from final merged observation", () => {
  const reconciled = reconcileRunnerSnapshot({
    complete: false,
    runnable: [issue("T042")],
    launchPlan: {
      toLaunch: [],
      toResume: [],
      activeSessions: [{ issueId: "T042" }],
      mergeQueue: { finalizeOrder: ["T042"], refreshAfterMerge: [], skipped: [] },
    },
  }, {
    summary: {
      total: 1,
      merged: 1,
      queued: 0,
      running: 0,
      in_review: 0,
      ready_to_merge: 0,
      merging: 0,
      failed: 0,
      needs_input: 0,
    },
  }, {
    now: () => new Date("2026-07-14T08:30:00.000Z"),
  });

  assert.equal(reconciled.complete, true);
  assert.deepEqual(reconciled.runnable, []);
  assert.deepEqual(reconciled.launchPlan.activeSessions, []);
  assert.deepEqual(reconciled.launchPlan.mergeQueue.finalizeOrder, []);
  assert.equal(reconciled.finalObservation.merged, 1);
  assert.equal(reconciled.updatedAt, "2026-07-14T08:30:00.000Z");
});

test("selectMergeQueuePlan treats ready_to_merge observability status as ready", () => {
  const plan = selectMergeQueuePlan({
    taskPlan: {
      tasks: new Map([
        ["T004", { id: "T004", done: false, priority: 40 }],
      ]),
    },
    observedTasks: {
      T004: { status: "ready_to_merge", sessions: [{ id: "sample-4", workspacePath: "/tmp/t004" }] },
    },
  });

  assert.deepEqual(plan.finalizeOrder, ["T004"]);
});

test("selectMergeQueuePlan finalizes ready_to_merge tasks even when dev processes remain live", () => {
  const plan = selectMergeQueuePlan({
    taskPlan: {
      tasks: new Map([
        ["T004", { id: "T004", done: false, priority: 40 }],
      ]),
    },
    observedTasks: {
      T004: {
        status: "ready_to_merge",
        sessions: [{
          id: "sample-4",
          status: "review_pending",
          workspacePath: "/tmp/t004",
          pr: { number: 44, state: "open", mergeStateStatus: "CLEAN" },
          lifecycle: {
            session: { kind: "worker", state: "terminated", reason: "runtime_lost" },
            runtime: { state: "exited", reason: "process_missing" },
            pr: { state: "open", reason: "review_pending" },
          },
        }],
      },
    },
    liveWorkspacePaths: new Set(["/tmp/t004"]),
  });

  assert.deepEqual(plan.finalizeOrder, ["T004"]);
  assert.deepEqual(plan.skipped, []);
});

test("selectMergeQueuePlan includes in_review PR work for review cleanup", () => {
  const plan = selectMergeQueuePlan({
    taskPlan: {
      tasks: new Map([
        ["T004", { id: "T004", done: false, priority: 40 }],
      ]),
    },
    observedTasks: {
      T004: {
        status: "in_review",
        sessions: [{
          id: "sample-4",
          workspacePath: "/tmp/t004",
          pr: { number: 44, state: "open", mergeStateStatus: "BLOCKED" },
        }],
      },
    },
  });

  assert.deepEqual(plan.finalizeOrder, ["T004"]);
});

test("selectMergeQueuePlan skips in_review PR work while the worker runtime is live", () => {
  const plan = selectMergeQueuePlan({
    taskPlan: {
      tasks: new Map([
        ["T004", { id: "T004", done: false, priority: 40 }],
      ]),
    },
    observedTasks: {
      T004: {
        status: "in_review",
        sessions: [{
          id: "sample-4",
          status: "review_pending",
          workspacePath: "/tmp/t004",
          pr: { number: 44, state: "open", mergeStateStatus: "BLOCKED" },
          lifecycle: {
            session: { kind: "worker", state: "working", reason: "review_cleanup" },
            runtime: { state: "alive", reason: "process_running" },
            pr: { state: "open", reason: "review_pending" },
          },
        }],
      },
    },
  });

  assert.deepEqual(plan.finalizeOrder, []);
  assert.deepEqual(plan.skipped, [{ id: "T004", reason: "worker_active" }]);
});

test("selectMergeQueuePlan skips in_review PR work while a workspace worker process is live", () => {
  const plan = selectMergeQueuePlan({
    taskPlan: {
      tasks: new Map([
        ["T004", { id: "T004", done: false, priority: 40 }],
      ]),
    },
    observedTasks: {
      T004: {
        status: "in_review",
        sessions: [{
          id: "sample-4",
          status: "pr_open",
          workspacePath: "/tmp/t004",
          pr: { number: 44, state: "open", mergeStateStatus: "DIRTY" },
          lifecycle: {
            session: { kind: "worker", state: "terminated", reason: "runtime_lost" },
            runtime: { state: "missing", reason: "process_missing" },
            pr: { state: "open", reason: "dirty" },
          },
        }],
      },
    },
    liveWorkspacePaths: new Set(["/tmp/t004"]),
  });

  assert.deepEqual(plan.finalizeOrder, []);
  assert.deepEqual(plan.skipped, [{ id: "T004", reason: "worker_active" }]);
});

test("selectMergeQueuePlan does not finalize runnable tasks without worker workspaces", () => {
  const plan = selectMergeQueuePlan({
    taskPlan: {
      tasks: new Map([
        ["T001", { id: "T001", done: true }],
        ["T002", { id: "T002", done: false }],
      ]),
    },
    observedTasks: {
      T002: { status: "ready", sessions: [] },
    },
  });

  assert.deepEqual(plan.finalizeOrder, []);
  assert.deepEqual(plan.skipped, [{ id: "T002", reason: "ready_missing_workspace" }]);
});

test("selectMergeQueuePlan finalizes ready-artifact-backed tasks without worker workspaces", () => {
  const plan = selectMergeQueuePlan({
    taskPlan: {
      tasks: new Map([
        ["T035", { id: "T035", done: false, priority: 1 }],
      ]),
    },
    observedTasks: {
      T035: {
        status: "ready_to_merge",
        sessions: [{
          id: "sample-35",
          issueId: "T035",
          status: "ready_to_merge",
          branch: "feat/t035",
          readyArtifact: {
            sessionId: "sample-35",
            issueId: "T035",
            branch: "feat/t035",
            pr: { number: 44, url: "https://github.com/acme/app/pull/44", state: "open" },
          },
        }],
      },
    },
  });

  assert.deepEqual(plan.finalizeOrder, ["T035"]);
  assert.deepEqual(plan.skipped, []);
});

test("isProjectComplete returns true only when all planned work is terminal", () => {
  assert.equal(isProjectComplete({
    observabilityState: {
      summary: { total: 2, done: 1, merged: 1, queued: 0, running: 0, ready: 0, blocked: 0, failed: 0, stale: 0 },
    },
    launchPlan: { toLaunch: [], toResume: [], activeSessions: [], mergeQueue: { finalizeOrder: [] } },
  }), true);

  assert.equal(isProjectComplete({
    observabilityState: {
      summary: { total: 2, done: 1, merged: 0, queued: 1, running: 0, ready: 0, blocked: 0, failed: 0, stale: 0 },
    },
    launchPlan: { toLaunch: [], toResume: [], activeSessions: [], mergeQueue: { finalizeOrder: [] } },
  }), false);
});

test("runOnce does not gate unrelated launches when another task failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-dag-failed-"));
  const statePath = join(dir, "state.json");
  const spawned = [];
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
      ["T003", { id: "T003", done: false }],
    ])
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [issue("T003")],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: { status: "failed" },
        T003: { status: "queued" },
      },
    },
    spawnIssues: async (ids) => spawned.push(...ids.map((item) => item.id)),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const persisted = JSON.parse(await readFile(statePath, "utf8"));

  assert.deepEqual(spawned, ["T003"]);
  assert.deepEqual(result.launchPlan.toLaunch.map((item) => item.id), ["T003"]);
  assert.equal(persisted.launchPlan.toLaunch.length, 1);
});

test("runOnce restores recoverable sessions before spawning new work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-resume-"));
  const statePath = join(dir, "state.json");
  const restored = [];
  const spawned = [];

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    concurrency: 2,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T021"), issue("T022")],
    listSessions: async () => ({
      data: [{
        id: "sample-t021-account-settings-frontend",
        projectId: "sample",
        issueId: "T021",
        status: "killed",
        workspacePath: "/tmp/t021",
      }],
    }),
    observabilityState: {
      tasks: {
        T021: { status: "failed" },
      },
    },
    restoreSessions: async (issues) => {
      restored.push(...issues);
      return {
        restored: issues.map((item) => ({ issueId: item.id, sessionId: item.sessionId })),
        errors: [],
      };
    },
    runWorkspaceGit: async () => "",
    spawnIssues: async (issues) => spawned.push(...issues),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const persisted = JSON.parse(await readFile(statePath, "utf8"));

  assert.deepEqual(restored.map((item) => [item.id, item.sessionId]), [
    ["T021", "sample-t021-account-settings-frontend"],
  ]);
  assert.deepEqual(spawned.map((item) => item.id), ["T022"]);
  assert.deepEqual(result.launchPlan.toResume.map((item) => item.id), ["T021"]);
  assert.deepEqual(result.launchPlan.toLaunch.map((item) => item.id), ["T022"]);
  assert.equal(persisted.resume.attempted, true);
  assert.deepEqual(persisted.resume.issueIds, ["T021"]);
});

test("resetStaleFrontendQaResumeState clears blocked QA checkpoints before restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-qa-reset-"));
  const workspacePath = join(dir, "workspace");
  const stateDir = join(workspacePath, ".archon/state");
  const logDir = join(workspacePath, ".archon/logs");
  const backupRoot = join(dir, "backups");
  const dbPath = join(dir, "archon.db");
  const calls = [];

  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(join(stateDir, "frontend-qa-result.md"), "QA_BLOCKED\n\nAuth dependency was unavailable.\n", "utf8");
  await writeFile(join(logDir, "run-1.jsonl"), [
    JSON.stringify({ type: "workflow_start", workflow_id: "run-1" }),
    JSON.stringify({ type: "node_complete", step: "start-dev", workflow_id: "run-1" }),
    JSON.stringify({ type: "node_complete", step: "plan-feature", workflow_id: "run-1" }),
    JSON.stringify({ type: "node_complete", step: "ensure-dev-for-QA", workflow_id: "run-1" }),
    JSON.stringify({ type: "node_complete", step: "QA", workflow_id: "run-1" }),
    JSON.stringify({ type: "node_error", step: "check-QA-passed", workflow_id: "run-1" }),
    "",
  ].join("\n"), "utf8");
  await writeFile(dbPath, "sqlite-db", "utf8");

  const result = await resetStaleFrontendQaResumeState({
    id: "T034",
    sessionId: "sample-t034",
    workspacePath,
  }, {
    dbPath,
    backupRoot,
    now: () => new Date("2026-07-09T13:00:00.000Z"),
    runSqlite: async (args) => {
      calls.push(args);
      const sql = String(args.at(-1));
      if (/select id from remote_agent_workflow_runs/i.test(sql)) return "run-1\n";
      if (/select count\(\*\) from remote_agent_workflow_events/i.test(sql)) return "1\n";
      return "";
    },
  });

  assert.equal(result.action, "reset_stale_frontend_qa");
  assert.equal(result.workflowRunId, "run-1");
  assert.equal(result.removedLogEvents, 4);
  assert.equal(
    await readFile(join(result.backupDir, "frontend-qa-result.md"), "utf8"),
    "QA_BLOCKED\n\nAuth dependency was unavailable.\n",
  );
  assert.equal(await readFile(join(result.backupDir, "archon.db"), "utf8"), "sqlite-db");
  assert.match(await readFile(join(result.backupDir, "run-1.jsonl"), "utf8"), /"step":"QA"/);
  assert.equal(
    await readFile(join(stateDir, "frontend-qa-result.md.stale-20260709T130000Z"), "utf8"),
    "QA_BLOCKED\n\nAuth dependency was unavailable.\n",
  );
  const updatedLog = await readFile(join(logDir, "run-1.jsonl"), "utf8");
  assert.doesNotMatch(updatedLog, /start-dev/);
  assert.doesNotMatch(updatedLog, /ensure-dev-for-QA/);
  assert.doesNotMatch(updatedLog, /"step":"QA"/);
  assert.doesNotMatch(updatedLog, /check-QA-passed/);
  assert.match(updatedLog, /plan-feature/);
  assert.match(String(calls.at(-1).at(-1)), /delete from remote_agent_workflow_events/i);
  assert.match(String(calls.at(-1).at(-1)), /step_name in \('start-dev','ensure-dev-for-QA','QA','check-QA-passed'\)/);
});

test("resetStaleFrontendQaResumeState prefers generic QA artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-generic-qa-reset-"));
  const workspacePath = join(dir, "workspace");
  const stateDir = join(workspacePath, ".archon/state");
  const logDir = join(workspacePath, ".archon/logs");
  const dbPath = join(dir, "archon.db");

  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(join(stateDir, "qa-result.md"), "QA_BLOCKED\n\nExternal dependency unavailable.\n", "utf8");
  await writeFile(join(stateDir, "qa-status.txt"), "QA_BLOCKED\n", "utf8");
  await writeFile(join(stateDir, "frontend-qa-result.md"), "QA_PASSED\n", "utf8");
  await writeFile(join(stateDir, "frontend-qa-status.txt"), "QA_PASSED\n", "utf8");
  await writeFile(join(logDir, "run-1.jsonl"), `${JSON.stringify({ type: "node_complete", step: "QA" })}\n`, "utf8");
  await writeFile(dbPath, "sqlite-db", "utf8");

  const result = await resetStaleFrontendQaResumeState({
    id: "T034",
    sessionId: "sample-t034",
    workspacePath,
  }, {
    dbPath,
    backupRoot: join(dir, "backups"),
    now: () => new Date("2026-07-09T13:00:00.000Z"),
    runSqlite: async (args) => {
      const sql = String(args.at(-1));
      if (/select id from remote_agent_workflow_runs/i.test(sql)) return "run-1\n";
      if (/select count\(\*\) from remote_agent_workflow_events/i.test(sql)) return "1\n";
      return "";
    },
  });

  assert.equal(result.action, "reset_stale_frontend_qa");
  assert.equal(
    await readFile(join(result.backupDir, "qa-result.md"), "utf8"),
    "QA_BLOCKED\n\nExternal dependency unavailable.\n",
  );
  assert.equal(await readFile(join(result.backupDir, "qa-status.txt"), "utf8"), "QA_BLOCKED\n");
  assert.equal(
    await readFile(join(stateDir, "qa-result.md.stale-20260709T130000Z"), "utf8"),
    "QA_BLOCKED\n\nExternal dependency unavailable.\n",
  );
  assert.equal(await readFile(join(stateDir, "frontend-qa-result.md"), "utf8"), "QA_PASSED\n");
});

test("resetStaleFrontendQaResumeState accepts human-written QA blocked notes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-qa-reset-note-"));
  const workspacePath = join(dir, "workspace");
  const stateDir = join(workspacePath, ".archon/state");
  const logDir = join(workspacePath, ".archon/logs");
  const dbPath = join(dir, "archon.db");

  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(join(stateDir, "frontend-qa-result.md"), "QA blocked: app URL was unreachable.\n", "utf8");
  await writeFile(join(logDir, "run-1.jsonl"), `${JSON.stringify({ type: "node_complete", step: "QA" })}\n`, "utf8");
  await writeFile(dbPath, "sqlite-db", "utf8");

  const result = await resetStaleFrontendQaResumeState({
    id: "T034",
    sessionId: "sample-t034",
    workspacePath,
  }, {
    dbPath,
    backupRoot: join(dir, "backups"),
    now: () => new Date("2026-07-09T13:00:00.000Z"),
    runSqlite: async (args) => {
      const sql = String(args.at(-1));
      if (/select id from remote_agent_workflow_runs/i.test(sql)) return "run-1\n";
      if (/select count\(\*\) from remote_agent_workflow_events/i.test(sql)) return "1\n";
      return "";
    },
  });

  assert.equal(result.action, "reset_stale_frontend_qa");
});

test("resetStaleFrontendQaResumeState accepts QA blocked notes with punctuation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-qa-reset-punctuation-"));
  const workspacePath = join(dir, "workspace");
  const stateDir = join(workspacePath, ".archon/state");
  const logDir = join(workspacePath, ".archon/logs");
  const dbPath = join(dir, "archon.db");

  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(join(stateDir, "frontend-qa-result.md"), "QA blocked.\n\nAuth dependency was unavailable.\n", "utf8");
  await writeFile(join(logDir, "run-1.jsonl"), `${JSON.stringify({ type: "node_complete", step: "QA" })}\n`, "utf8");
  await writeFile(dbPath, "sqlite-db", "utf8");

  const result = await resetStaleFrontendQaResumeState({
    id: "T034",
    sessionId: "sample-t034",
    workspacePath,
  }, {
    dbPath,
    backupRoot: join(dir, "backups"),
    now: () => new Date("2026-07-09T13:00:00.000Z"),
    runSqlite: async (args) => {
      const sql = String(args.at(-1));
      if (/select id from remote_agent_workflow_runs/i.test(sql)) return "run-1\n";
      if (/select count\(\*\) from remote_agent_workflow_events/i.test(sql)) return "1\n";
      return "";
    },
  });

  assert.equal(result.action, "reset_stale_frontend_qa");
});

test("resetStaleFrontendQaResumeState retries transient sqlite lock during checkpoint reset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-qa-reset-sqlite-lock-"));
  const workspacePath = join(dir, "workspace");
  const stateDir = join(workspacePath, ".archon/state");
  const logDir = join(workspacePath, ".archon/logs");
  const dbPath = join(dir, "archon.db");
  let deleteAttempts = 0;

  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(join(stateDir, "frontend-qa-result.md"), "QA_BLOCKED\n\nAuth dependency was unavailable.\n", "utf8");
  await writeFile(join(logDir, "run-1.jsonl"), `${JSON.stringify({ type: "node_complete", step: "QA" })}\n`, "utf8");
  await writeFile(dbPath, "sqlite-db", "utf8");

  const result = await resetStaleFrontendQaResumeState({
    id: "T034",
    sessionId: "sample-t034",
    workspacePath,
  }, {
    dbPath,
    backupRoot: join(dir, "backups"),
    sqliteBusyRetryDelayMs: 0,
    now: () => new Date("2026-07-09T13:00:00.000Z"),
    runSqlite: async (args) => {
      const sql = String(args.at(-1));
      if (/select id from remote_agent_workflow_runs/i.test(sql)) return "run-1\n";
      if (/select count\(\*\) from remote_agent_workflow_events/i.test(sql)) return "1\n";
      if (/delete from remote_agent_workflow_events/i.test(sql)) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          const error = new Error("Command failed: sqlite3 archon.db -batch delete\nError: stepping, database is locked (5)");
          error.stderr = "Error: stepping, database is locked (5)";
          throw error;
        }
      }
      return "";
    },
  });

  assert.equal(result.action, "reset_stale_frontend_qa");
  assert.equal(deleteAttempts, 2);
});

test("resetStaleFrontendQaResumeState retries transient sqlite lock during workflow lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-qa-reset-sqlite-select-lock-"));
  const workspacePath = join(dir, "workspace");
  const stateDir = join(workspacePath, ".archon/state");
  const logDir = join(workspacePath, ".archon/logs");
  const dbPath = join(dir, "archon.db");
  let lookupAttempts = 0;

  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(join(stateDir, "frontend-qa-result.md"), "QA_BLOCKED\n\nAuth dependency was unavailable.\n", "utf8");
  await writeFile(join(logDir, "run-1.jsonl"), `${JSON.stringify({ type: "node_complete", step: "QA" })}\n`, "utf8");
  await writeFile(dbPath, "sqlite-db", "utf8");

  const result = await resetStaleFrontendQaResumeState({
    id: "T034",
    sessionId: "sample-t034",
    workspacePath,
  }, {
    dbPath,
    backupRoot: join(dir, "backups"),
    sqliteBusyRetryDelayMs: 0,
    now: () => new Date("2026-07-09T13:00:00.000Z"),
    runSqlite: async (args) => {
      const sql = String(args.at(-1));
      if (/select id from remote_agent_workflow_runs/i.test(sql)) {
        lookupAttempts += 1;
        if (lookupAttempts === 1) {
          const error = new Error("Error: in prepare, database is locked (5)");
          error.stderr = "Error: in prepare, database is locked (5)";
          throw error;
        }
        return "run-1\n";
      }
      if (/select count\(\*\) from remote_agent_workflow_events/i.test(sql)) return "1\n";
      return "";
    },
  });

  assert.equal(result.action, "reset_stale_frontend_qa");
  assert.equal(lookupAttempts, 2);
});

test("runOnce does not report ready PR workspaces as stale launch blockers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-ready-not-stale-"));
  const statePath = join(dir, "state.json");
  const taskPlan = {
    tasks: new Map([
      ["T027", { id: "T027", done: false }],
      ["T028", { id: "T028", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: true,
    statePath,
    concurrency: 2,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [issue("T027"), issue("T028")],
    listSessions: async () => ({
      data: [{
        id: "sample-t027",
        projectId: "sample",
        issueId: "T027",
        status: "killed",
        workspacePath: "/tmp/t027",
      }],
    }),
    observabilityState: {
      tasks: {
        T027: {
          status: "ready_to_merge",
          sessions: [{
            id: "sample-t027",
            issueId: "T027",
            workspacePath: "/tmp/t027",
            pr: { number: 41, state: "open" },
          }],
        },
      },
    },
    runWorkspaceGit: async (_workspacePath, args) => {
      if (args[0] === "merge-base") throw new Error("behind origin main");
      return "";
    },
    now: () => new Date("2026-07-07T14:00:00.000Z"),
  });

  assert.deepEqual(result.launchPlan.mergeQueue.finalizeOrder, ["T027"]);
  assert.equal(result.launchPlan.skipped.some((item) => item.id === "T027" && item.reason === "stale_existing_workspace"), false);
  assert.deepEqual(result.launchPlan.toLaunch, []);
});

test("runOnce recoverOnly restores sessions without spawning runnable tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-recover-only-"));
  const restored = [];
  const spawned = [];

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    recoverOnly: true,
    concurrency: 2,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T021"), issue("T022")],
    listSessions: async () => ({
      data: [{
        id: "sample-t021-account-settings-frontend",
        projectId: "sample",
        issueId: "T021",
        status: "killed",
        workspacePath: "/tmp/t021",
      }],
    }),
    observabilityState: {
      tasks: {
        T021: { status: "failed" },
      },
    },
    restoreSessions: async (issues) => {
      restored.push(...issues);
      return {
        restored: issues.map((item) => ({ issueId: item.id, sessionId: item.sessionId })),
        errors: [],
      };
    },
    runWorkspaceGit: async () => "",
    spawnIssues: async (issues) => spawned.push(...issues),
    now: () => new Date("2026-06-27T11:00:00.000Z"),
  });

  assert.deepEqual(restored.map((item) => item.id), ["T021"]);
  assert.deepEqual(spawned, []);
  assert.deepEqual(result.launchPlan.toLaunch, []);
});

test("runOnce writes task.started events for spawned issues", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-launch-events-"));
  const statePath = join(dir, "state.json");
  const eventLogPath = join(dir, "events.jsonl");

  await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    eventLogPath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T004"), issue("T005")],
    listSessions: async () => ({ data: [] }),
    spawnIssues: async (issues) => ({
      spawned: issues.map((item) => ({
        issueId: item.id,
        sessionId: `sample-${item.id.toLowerCase()}`,
        stdout: "",
        stderr: "",
      })),
    }),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const events = await readEvents({ eventLogPath });

  assert.deepEqual(events.map((event) => [event.type, event.taskId, event.sessionId, event.status]), [
    ["task.started", "T004", "sample-t004", "started"],
    ["task.started", "T005", "sample-t005", "started"],
  ]);
});

test("runOnce writes task.resumed events for restored issues", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-resume-events-"));
  const statePath = join(dir, "state.json");
  const eventLogPath = join(dir, "events.jsonl");

  await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    eventLogPath,
    concurrency: 2,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T021"), issue("T022")],
    listSessions: async () => ({
      data: [{
        id: "sample-t021-account-settings-frontend",
        projectId: "sample",
        issueId: "T021",
        status: "killed",
        workspacePath: "/tmp/t021",
      }],
    }),
    observabilityState: {
      tasks: {
        T021: { status: "failed" },
      },
    },
    restoreSessions: async (issues) => ({
      restored: issues.map((item) => ({ issueId: item.id, sessionId: item.sessionId, stdout: "", stderr: "" })),
      errors: [],
    }),
    runWorkspaceGit: async () => "",
    spawnIssues: async (issues) => ({
      spawned: issues.map((item) => ({ issueId: item.id, sessionId: `sample-${item.id.toLowerCase()}` })),
    }),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const events = await readEvents({ eventLogPath });

  assert.deepEqual(events.map((event) => [event.type, event.taskId, event.sessionId, event.status]), [
    ["task.resumed", "T021", "sample-t021-account-settings-frontend", "resumed"],
    ["task.started", "T022", "sample-t022", "started"],
  ]);
});

test("runOnce writes merge lifecycle events when finalization succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-events-"));
  const statePath = join(dir, "state.json");
  const eventLogPath = join(dir, "events.jsonl");
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
    ]),
  };

  await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    eventLogPath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002", pr: { number: 36 } }],
        },
      },
    },
    assertWorkspaceReady: async () => null,
    finalizeIssue: async () => undefined,
    recordMergedIssue: async () => ({ updated: true }),
    reconcileAfterMerge: async () => ({ taskPlan }),
    spawnIssues: async () => ({ spawned: [] }),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const events = await readEvents({ eventLogPath });

  assert.deepEqual(events.map((event) => [event.type, event.taskId, event.status]), [
    ["pr.merge.started", "T002", "started"],
    ["pr.merged", "T002", "merged"],
  ]);
  assert.equal(events[0].metadata.phase, "finalize");
});

test("runOnce writes task.blocked events when merge finalization fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-blocked-events-"));
  const statePath = join(dir, "state.json");
  const eventLogPath = join(dir, "events.jsonl");
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
    ]),
  };

  await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    eventLogPath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002", pr: { number: 36 } }],
        },
      },
    },
    assertWorkspaceReady: async () => null,
    finalizeIssue: async () => {
      throw new Error("merge API unavailable");
    },
    spawnIssues: async () => ({ spawned: [] }),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const events = await readEvents({ eventLogPath });

  assert.deepEqual(events.map((event) => [event.type, event.taskId, event.status]), [
    ["task.blocked", "T002", "blocked"],
  ]);
  assert.equal(events[0].metadata.phase, "finalize");
  assert.equal(events[0].metadata.reason, "merge API unavailable");
});

test("runOnce writes CI recovery events when pending checks require merge prepare retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-ci-recovery-events-"));
  const statePath = join(dir, "state.json");
  const eventLogPath = join(dir, "events.jsonl");
  const taskPlan = {
    tasks: new Map([
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    eventLogPath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{
            id: "sample-2",
            issueId: "T002",
            workspacePath: "/tmp/t002",
            pr: { number: 36, url: "https://github.com/acme/sample/pull/36" },
          }],
        },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => {
      throw new Error(`Cannot merge ${mergeIssue.id}: PR checks are still pending (ci).`);
    },
    prepareIssue: async () => {
      throw new Error("Cannot merge T002: PR checks are still pending (ci).");
    },
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const events = await readEvents({ eventLogPath });
  const ciEvents = events.filter((event) => event.type.startsWith("ci.recovery."));

  assert.deepEqual(ciEvents.map((event) => [event.type, event.taskId, event.prNumber, event.status]), [
    ["ci.recovery.started", "T002", "36", "started"],
    ["ci.recovery.blocked", "T002", "36", "blocked"],
  ]);
  assert.equal(ciEvents[0].metadata.reason, "pending_checks");
  assert.equal(ciEvents[0].metadata.action, "merge_queue_prepare_finalize");
  assert.equal(ciEvents[1].metadata.reason, "pending_checks");
  assert.equal(ciEvents[1].metadata.action, "resume_worker_session");
  assert.equal(ciEvents[1].metadata.outcome, "worker_resume_required");
  assert.equal(ciEvents[1].metadata.blockedPhase, "worker-prepare");
  assert.equal(ciEvents[1].error, "Cannot merge T002: PR checks are still pending (ci).");
  assert.deepEqual(
    result.mergeQueue.result.actions.filter((action) => action.action === "ci-recovery"),
    [
      {
        action: "ci-recovery",
        phase: "started",
        issueId: "T002",
        sessionId: "sample-2",
        prNumber: 36,
        prUrl: "https://github.com/acme/sample/pull/36",
        workspacePath: "/tmp/t002",
        reason: "pending_checks",
        trigger: "Cannot merge T002: PR checks are still pending (ci).",
        recoveryAction: "merge_queue_prepare_finalize",
      },
      {
        action: "ci-recovery",
        phase: "blocked",
        issueId: "T002",
        sessionId: "sample-2",
        prNumber: 36,
        prUrl: "https://github.com/acme/sample/pull/36",
        workspacePath: "/tmp/t002",
        reason: "pending_checks",
        trigger: "Cannot merge T002: PR checks are still pending (ci).",
        recoveryAction: "resume_worker_session",
        outcome: "worker_resume_required",
        blockedPhase: "worker-prepare",
        error: "Cannot merge T002: PR checks are still pending (ci).",
      },
    ],
  );
  assertWorkerPrepareBlockedWithoutResume(result, {
    issueId: "T002",
    sessionId: "sample-2",
    reasonPattern: /checks are still pending/,
  });
});

test("runOnce writes blocked CI recovery events when failed checks require merge prepare retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-ci-recovery-blocked-events-"));
  const statePath = join(dir, "state.json");
  const eventLogPath = join(dir, "events.jsonl");
  const taskPlan = {
    tasks: new Map([
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    eventLogPath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{
            id: "sample-2",
            issueId: "T002",
            workspacePath: "/tmp/t002",
            pr: { number: 36, url: "https://github.com/acme/sample/pull/36" },
          }],
        },
      },
    },
    assertWorkspaceReady: async () => null,
    finalizeIssue: async () => {
      throw new Error("Cannot merge T002: PR checks are not green (test).");
    },
    prepareIssue: async () => {
      throw new Error("Cannot merge T002: PR checks are not green (test).");
    },
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const events = await readEvents({ eventLogPath });
  const ciEvents = events.filter((event) => event.type.startsWith("ci.recovery."));

  assert.deepEqual(ciEvents.map((event) => [event.type, event.taskId, event.prNumber, event.status]), [
    ["ci.recovery.started", "T002", "36", "started"],
    ["ci.recovery.blocked", "T002", "36", "blocked"],
  ]);
  assert.equal(ciEvents[0].metadata.reason, "failed_checks");
  assert.equal(ciEvents[1].metadata.reason, "failed_checks");
  assert.equal(ciEvents[0].metadata.action, "merge_queue_prepare_finalize");
  assert.equal(ciEvents[1].metadata.action, "resume_worker_session");
  assert.equal(ciEvents[1].metadata.outcome, "worker_resume_required");
  assert.equal(ciEvents[1].metadata.blockedPhase, "worker-prepare");
  assert.equal(ciEvents[1].error, "Cannot merge T002: PR checks are not green (test).");
  assert.deepEqual(
    result.mergeQueue.result.actions.filter((action) => action.action === "ci-recovery"),
    [
      {
        action: "ci-recovery",
        phase: "started",
        issueId: "T002",
        sessionId: "sample-2",
        prNumber: 36,
        prUrl: "https://github.com/acme/sample/pull/36",
        workspacePath: "/tmp/t002",
        reason: "failed_checks",
        trigger: "Cannot merge T002: PR checks are not green (test).",
        recoveryAction: "merge_queue_prepare_finalize",
      },
      {
        action: "ci-recovery",
        phase: "blocked",
        issueId: "T002",
        sessionId: "sample-2",
        prNumber: 36,
        prUrl: "https://github.com/acme/sample/pull/36",
        workspacePath: "/tmp/t002",
        reason: "failed_checks",
        trigger: "Cannot merge T002: PR checks are not green (test).",
        recoveryAction: "resume_worker_session",
        outcome: "worker_resume_required",
        blockedPhase: "worker-prepare",
        error: "Cannot merge T002: PR checks are not green (test).",
      },
    ],
  );
  assertWorkerPrepareBlockedWithoutResume(result, {
    issueId: "T002",
    sessionId: "sample-2",
    reasonPattern: /checks are not green/,
  });
});

test("runOnce dry-run writes durable state without spawning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-"));
  const statePath = join(dir, "state.json");
  const eventLogPath = join(dir, "events.jsonl");
  const spawned = [];

  const result = await runOnce({
    cwd: dir,
    dryRun: true,
    statePath,
    eventLogPath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T004")],
    listSessions: async () => ({ data: [] }),
    spawnIssues: async (ids) => spawned.push(ids),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const state = JSON.parse(await readFile(statePath, "utf8"));
  const events = await readEvents({ eventLogPath });

  assert.deepEqual(spawned, []);
  assert.deepEqual(result.launchPlan.toLaunch.map((item) => item.id), ["T004"]);
  assert.equal(state.version, 1);
  assert.equal(state.dryRun, true);
  assert.equal(state.updatedAt, "2026-06-16T10:00:00.000Z");
  assert.deepEqual(state.controllerPolicy, {
    role: "controller",
    workerWorktreeMutation: "forbidden",
    violationReason: "controller_must_not_mutate_worker_worktree",
    allowedActions: [
      "observe",
      "spawn_worker_session",
      "resume_worker_session",
      "merge_queue_prepare_finalize",
      "cleanup",
    ],
  });
  assert.deepEqual(state.launchPlan.toLaunch, [{ id: "T004", branchName: "feat/t004", title: "T004 task" }]);
  assert.deepEqual(events, []);
});

test("runOnce defaults to a generic project rooted at cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-default-project-"));
  const statePath = join(dir, "state.json");

  const result = await runOnce({
    cwd: dir,
    dryRun: true,
    statePath,
    getRunnableIssues: async () => [issue("T001")],
    listSessions: async () => ({ data: [] }),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.equal(result.project.id, "project");
  assert.equal(result.project.name, "Project");
  assert.equal(result.project.path, dir);
  assert.equal(result.project.tasksPath, "planning/roadmap/tasks.md");
});

test("runOnce reads observability state before planning launches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-"));
  const statePath = join(dir, "state.json");
  const observabilityStatePath = join(dir, "observability.json");
  const spawned = [];

  await writeFile(
    observabilityStatePath,
    JSON.stringify({ tasks: { T004: { status: "done" } } }),
    "utf8",
  );

  const result = await runOnce({
    dryRun: true,
    statePath,
    observabilityStatePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T004")],
    listSessions: async () => ({ data: [] }),
    spawnIssues: async (ids) => spawned.push(ids),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(spawned, []);
  assert.deepEqual(result.launchPlan.toLaunch, []);
  assert.deepEqual(result.launchPlan.skipped, [{ id: "T004", reason: "observed_done" }]);
});

test("runOnce spawns planned issues with task context when not a dry run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-"));
  const statePath = join(dir, "state.json");
  const spawned = [];

  await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    concurrency: 2,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T004"), issue("T005")],
    listSessions: async () => ({ data: [] }),
    spawnIssues: async (issues) => spawned.push(issues),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(spawned, [[
    { id: "T004", branchName: "feat/t004", title: "T004 task" },
    { id: "T005", branchName: "feat/t005", title: "T005 task" },
  ]]);
});

test("runOnce cleans merged local branches and reserves old session ids for fresh failed retries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-failed-retry-"));
  const statePath = join(dir, "state.json");
  const observabilityStatePath = join(dir, "observability.json");
  const gitCalls = [];
  const dockerCalls = [];
  const spawnContexts = [];

  await writeFile(
    observabilityStatePath,
    JSON.stringify({
      tasks: {
        T021: {
          status: "failed",
          sessions: [{
            id: "sample-t021",
            issueId: "T021",
            status: "killed",
            workspacePath: "/tmp/missing-t021",
            pr: null,
            readyArtifact: null,
            lifecycle: {
              pr: { state: "none", reason: "not_created" },
            },
          }],
        },
      },
    }),
    "utf8",
  );

  await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    observabilityStatePath,
    concurrency: 1,
    project: {
      id: "sample",
      path: "/tmp/project",
      defaultBranch: "main",
      tracker: { tasksPath: "planning/roadmap/tasks.md" },
    },
    getRunnableIssues: async () => [issue("T021")],
    listSessions: async () => ({ data: [] }),
    runProjectGit: async (args) => {
      gitCalls.push(args);
      if (args[0] === "branch" && args[1] === "--list") return "feat/t021\n";
      if (args[0] === "branch" && args[1] === "-r") return "";
      if (args[0] === "branch" && args[1] === "--merged") return "feat/t021\n";
      if (args[0] === "worktree") return "worktree /tmp/project\nbranch refs/heads/main\n";
      if (args[0] === "branch" && args[1] === "-d") return "";
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    },
    runDocker: async (args) => {
      dockerCalls.push(args);
      if (args[0] === "ps" && args.includes("label=com.docker.compose.project.working_dir=/tmp/missing-t021")) {
        return "sample-wt-1\n";
      }
      if (args[0] === "ps" && args.includes("label=com.docker.compose.project=sample-wt-1")) {
        return "container-1\n";
      }
      if (args[0] === "volume" && args[1] === "ls") return "volume-1\n";
      if (args[0] === "network" && args[1] === "ls") return "network-1\n";
      if (args[0] === "rm") return "";
      if (args[0] === "volume" && args[1] === "rm") return "";
      if (args[0] === "network" && args[1] === "rm") return "";
      throw new Error(`Unexpected docker call: ${args.join(" ")}`);
    },
    spawnIssues: async (issues, context) => {
      spawnContexts.push({ issues, sessions: context.sessions });
      return {
        spawned: issues.map((item) => ({
          issueId: item.id,
          sessionId: `${item.id.toLowerCase()}-retry`,
          stdout: "",
          stderr: "",
        })),
      };
    },
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(gitCalls, [
    ["branch", "--list", "feat/t021", "--format=%(refname:short)"],
    ["branch", "-r", "--list", "*/feat/t021", "--format=%(refname:short)"],
    ["branch", "--merged", "main", "--list", "feat/t021", "--format=%(refname:short)"],
    ["worktree", "list", "--porcelain"],
    ["branch", "-d", "feat/t021"],
  ]);
  assert.deepEqual(dockerCalls, [
    ["ps", "-a", "--filter", "label=com.docker.compose.project.working_dir=/tmp/missing-t021", "--format", "{{.Label \"com.docker.compose.project\"}}"],
    ["ps", "-a", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.ID}}"],
    ["volume", "ls", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.Name}}"],
    ["network", "ls", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.Name}}"],
    ["rm", "-f", "container-1"],
    ["volume", "rm", "volume-1"],
    ["network", "rm", "network-1"],
  ]);
  assert.deepEqual(spawnContexts.map((item) => item.issues.map((issueItem) => issueItem.id)), [["T021"]]);
  assert.deepEqual(spawnContexts[0].sessions.map((session) => session.id), ["sample-t021"]);
});

test("runOnce uses AO transport for default session listing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-ao-command-"));
  const statePath = join(dir, "state.json");
  const calls = [];

  const result = await runOnce({
    cwd: dir,
    dryRun: true,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getRunnableIssues: async () => [issue("T004")],
    transport: {
      sessionList: async (input) => {
        calls.push(input);
        return { data: [] };
      },
    },
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [{ projectId: "sample", includeTerminated: true }]);
  assert.deepEqual(result.launchPlan.toLaunch.map((item) => item.id), ["T004"]);
});

test("runOnce does not take over a PR worktree while a worker process is live", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-live-worker-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T004", { id: "T004", done: false, priority: 4 }],
    ]),
  };
  const session = {
    id: "sample-4",
    issueId: "T004",
    status: "pr_open",
    workspacePath: "/tmp/t004",
    pr: { number: 44, url: "https://github.com/acme/sample/pull/44", state: "open", mergeStateStatus: "DIRTY" },
    lifecycle: {
      session: { kind: "worker", state: "terminated", reason: "runtime_lost" },
      runtime: { state: "missing", reason: "process_missing" },
      pr: { state: "open", reason: "dirty" },
    },
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [issue("T004")],
    listSessions: async () => ({ data: [session] }),
    observabilityState: {
      tasks: {
        T004: { status: "in_review", sessions: [session] },
      },
    },
    detectLiveWorkerWorkspacePaths: async () => new Set(["/tmp/t004"]),
    finalizeIssue: async () => calls.push("finalize"),
    prepareIssue: async () => calls.push("prepare"),
    restoreSessions: async () => {
      calls.push("restore");
      return { restored: [], errors: [] };
    },
    spawnIssues: async () => {
      calls.push("spawn");
      return { spawned: [], errors: [] };
    },
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result.mergeQueue.finalizeOrder, []);
  assert.deepEqual(result.mergeQueue.skipped, [{ id: "T004", reason: "worker_active" }]);
  assert.deepEqual(result.launchPlan.activeSessions.map((activeSession) => activeSession.issueId), ["T004"]);
  assert.deepEqual(result.launchPlan.toResume, []);
  assert.deepEqual(result.launchPlan.toLaunch, []);
});

test("runOnce finalizes ready PRs sequentially without controller prepare", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-queue-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
      ["T003", { id: "T003", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
        T003: {
          status: "ready",
          sessions: [{ id: "sample-3", issueId: "T003", workspacePath: "/tmp/t003" }],
        },
      },
    },
    assertWorkspaceReady: async () => null,
    finalizeIssue: async (issue) => calls.push(`finalize:${issue.id}:${issue.workspacePath}`),
    reconcileAfterMerge: async ({ issue }) => {
      calls.push(`reconcile:${issue.id}`);
      return { taskPlan };
    },
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "finalize:T002:/tmp/t002",
    "reconcile:T002",
    "finalize:T003:/tmp/t003",
    "reconcile:T003",
  ]);
  assert.deepEqual(result.mergeQueue.finalizeOrder, ["T002", "T003"]);
  assert.deepEqual(result.spawn.issueIds, []);
});

test("runOnce blocks parser-invalid tracker state before merge finalization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-tracker-validation-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => calls.push(`assert:${mergeIssue.id}`),
    validateTrackerCandidate: async (mergeIssue) => {
      calls.push(`validate:${mergeIssue.id}`);
      throw new Error(
        "Cannot merge T002: merged planning tracker is invalid: Duplicate task T002 in tasks.md",
      );
    },
    finalizeIssue: async (mergeIssue) => calls.push(`finalize:${mergeIssue.id}`),
    reconcileAfterMerge: async ({ issue }) => {
      calls.push(`reconcile:${issue.id}`);
      return { taskPlan };
    },
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, ["assert:T002", "validate:T002"]);
  assert.equal(result.mergeQueue.result.blocked.issueId, "T002");
  assert.equal(result.mergeQueue.result.blocked.phase, "tracker-validation");
  assert.match(result.mergeQueue.result.blocked.reason, /Duplicate task T002/);
  assert.deepEqual(result.mergeQueue.result.actions.map((action) => action.action), [
    "workspace-ready",
    "tracker-validation",
  ]);
});

test("runOnce validates the current main and candidate merge tree with tracker parser semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-tracker-merge-tree-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
    ]),
  };
  const duplicateTracker = `# Tasks

| Done | Priority | Task | Depends On | Branch | Context |
| --- | --- | --- | --- | --- | --- |
| [x] | 1 | \`T001\` - Foundation | - | \`chore/t001\` | - |
| [ ] | 2 | \`T002\` - Backend | \`T001\` | \`feat/t002\` | - |
| [x] | 2 | \`T002\` - Backend | \`T001\` | \`feat/t002\` | - |
`;

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: {
      id: "sample",
      path: "/tmp/project",
      defaultBranch: "main",
      tracker: { tasksPath: "planning/roadmap/tasks.md" },
    },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{
            id: "sample-2",
            issueId: "T002",
            branch: "feat/t002",
            workspacePath: "/tmp/t002",
          }],
        },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => calls.push(`assert:${mergeIssue.id}`),
    validateTrackerCandidate: null,
    runProjectGit: async (args) => {
      calls.push(`git:${args.join(" ")}`);
      if (args[0] === "fetch") return "";
      if (args[0] === "merge-tree") return "merged-tree\n";
      if (args[0] === "show") return duplicateTracker;
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    finalizeIssue: async (mergeIssue) => calls.push(`finalize:${mergeIssue.id}`),
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "assert:T002",
    "git:fetch origin --quiet",
    "git:merge-tree --write-tree origin/main origin/feat/t002",
    "git:show merged-tree:planning/roadmap/tasks.md",
  ]);
  assert.equal(result.mergeQueue.result.blocked.phase, "tracker-validation");
  assert.equal(
    result.mergeQueue.result.blocked.reason,
    "Cannot merge T002: merged planning tracker planning/roadmap/tasks.md is invalid: Duplicate task T002 in tasks.md",
  );
});

test("validateTrackerMergeCandidate wraps origin fetch failures with task and remote refs", async () => {
  const calls = [];

  await assert.rejects(
    validateTrackerMergeCandidate({ id: "T002", branch: "feat/t002" }, {
      project: {
        id: "sample",
        path: "/tmp/project",
        defaultBranch: "main",
        tracker: { tasksPath: "planning/roadmap/tasks.md" },
      },
      runProjectGit: async (args) => {
        calls.push(args);
        throw new Error("authentication failed");
      },
    }),
    {
      message: "Cannot merge T002: unable to fetch origin refs origin/main and origin/feat/t002 for tracker validation: authentication failed",
    },
  );

  assert.deepEqual(calls, [["fetch", "origin", "--quiet"]]);
});

test("validateTrackerMergeCandidate accepts a parser-valid merged tracker", async () => {
  const calls = [];
  const validTracker = `# Tasks

| Done | Priority | Task | Depends On | Branch | Context |
| --- | --- | --- | --- | --- | --- |
| [x] | 1 | \`T001\` - Foundation | - | \`chore/t001\` | - |
| [x] | 2 | \`T002\` - Backend | \`T001\` | \`feat/t002\` | - |
`;

  const result = await validateTrackerMergeCandidate({ id: "T002", branch: "feat/t002" }, {
    project: {
      id: "sample",
      path: "/tmp/project",
      defaultBranch: "main",
      tracker: { tasksPath: "planning/roadmap/tasks.md" },
    },
    runProjectGit: async (args) => {
      calls.push(args);
      if (args[0] === "fetch") return "";
      if (args[0] === "merge-tree") return "merged-tree\n";
      if (args[0] === "show") return validTracker;
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
  });

  assert.deepEqual(calls, [
    ["fetch", "origin", "--quiet"],
    ["merge-tree", "--write-tree", "origin/main", "origin/feat/t002"],
    ["show", "merged-tree:planning/roadmap/tasks.md"],
  ]);
  assert.deepEqual(result, {
    checked: true,
    branch: "feat/t002",
    defaultBranch: "main",
    mergedTree: "merged-tree",
    tasksPath: "planning/roadmap/tasks.md",
    taskCount: 2,
  });
});

test("runOnce records the AO worker session after a PR is finalized", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-record-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{
            id: "sample-2",
            issueId: "T002",
            workspacePath: "/tmp/t002",
            pr: { number: 36, url: "https://github.com/acme/sample/pull/36" },
          }],
        },
      },
    },
    assertWorkspaceReady: async () => null,
    finalizeIssue: async (issue) => calls.push(`finalize:${issue.id}:${issue.sessionId}`),
    recordMergedIssue: async (issue, context) => {
      calls.push(`record:${issue.id}:${issue.sessionId}:${context.project.id}`);
      return { updated: true };
    },
    reconcileAfterMerge: async ({ issue }) => {
      calls.push(`reconcile:${issue.id}`);
      return { taskPlan };
    },
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "finalize:T002:sample-2",
    "record:T002:sample-2:sample",
    "reconcile:T002",
  ]);
  assert.deepEqual(result.mergeQueue.result.actions.map((action) => action.action), [
    "workspace-ready",
    "tracker-validation",
    "finalize",
    "record-merged",
    "reconcile",
  ]);
});

test("recordAoSessionMerged updates only the Dark Factory ready artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-ao-session-"));
  const sessionDir = join(dir, "projects", "sample", "sessions");
  const sessionPath = join(sessionDir, "sample-2.json");
  const readyPath = join(sessionDir, "sample-2.ready.json");

  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionPath, JSON.stringify({
    status: "pr_open",
    issue: "T002",
    lifecycle: {
      session: { kind: "worker", state: "detecting", reason: "runtime_lost", completedAt: null },
      pr: {
        state: "open",
        reason: "in_progress",
        number: 36,
        url: "https://github.com/acme/sample/pull/36",
      },
    },
    agentReportedState: "working",
    agentReportedNote: "dark-factory milestone=auto_merge_preparing task=T002 phase=auto_merge",
    pr: "https://github.com/acme/sample/pull/36",
  }, null, 2), "utf8");
  await writeFile(readyPath, JSON.stringify({
    sessionId: "sample-2",
    projectId: "sample",
    issueId: "T002",
    branch: "feat/t002",
    pr: {
      number: 36,
      url: "https://github.com/acme/sample/pull/36",
      state: "open",
      mergedAt: "2026-06-16T09:55:00.000Z",
    },
  }, null, 2), "utf8");
  const originalSession = await readFile(sessionPath, "utf8");

  const result = await recordAoSessionMerged({
    id: "T002",
    sessionId: "sample-2",
    pr: { number: 36, url: "https://github.com/acme/sample/pull/36" },
  }, {
    project: { id: "sample" },
    aoHome: dir,
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const persisted = JSON.parse(await readFile(readyPath, "utf8"));

  assert.equal(result.updated, true);
  assert.equal(persisted.status, "merged");
  assert.equal(persisted.pr.state, "merged");
  assert.equal(persisted.pr.mergedAt, "2026-06-16T09:55:00.000Z");
  assert.equal(persisted.darkFactoryMergedAt, "2026-06-16T10:00:00.000Z");
  assert.equal(await readFile(sessionPath, "utf8"), originalSession);
});

test("runOnce blocks and persists state when post-merge reconciliation fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-reconcile-blocked-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
      ["T003", { id: "T003", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
        T003: {
          status: "ready",
          sessions: [{ id: "sample-3", issueId: "T003", workspacePath: "/tmp/t003" }],
        },
      },
    },
    assertWorkspaceReady: async () => null,
    finalizeIssue: async (issue) => calls.push(`finalize:${issue.id}`),
    prepareIssue: async (issue) => calls.push(`prepare:${issue.id}`),
    reconcileAfterMerge: async () => {
      throw new Error("Cannot refresh sample main: checkout has uncommitted changes");
    },
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const persisted = JSON.parse(await readFile(statePath, "utf8"));

  assert.deepEqual(calls, ["finalize:T002"]);
  assert.equal(result.mergeQueue.result.blocked.reason, "Cannot refresh sample main: checkout has uncommitted changes");
  assert.equal(persisted.mergeQueue.result.blocked.issueId, "T002");
  assert.deepEqual(result.spawn.issueIds, []);
});

test("runOnce blocks and persists state when merge finalization fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-finalize-blocked-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
      },
    },
    assertWorkspaceReady: async () => null,
    finalizeIssue: async () => {
      calls.push("finalize:T002");
      throw new Error("merge API unavailable");
    },
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const persisted = JSON.parse(await readFile(statePath, "utf8"));

  assert.deepEqual(calls, ["finalize:T002"]);
  assert.equal(result.mergeQueue.result.blocked.issueId, "T002");
  assert.equal(result.mergeQueue.result.blocked.phase, "finalize");
  assert.equal(result.mergeQueue.result.blocked.reason, "merge API unavailable");
  assert.deepEqual(result.mergeQueue.result.blocked.recovery, {
    action: "resume_worker_session",
    sessionId: "sample-2",
    workspacePath: "/tmp/t002",
    reason: "controller_must_not_mutate_worker_worktree",
  });
  assert.equal(persisted.mergeQueue.result.blocked.phase, "finalize");
  assert.deepEqual(persisted.mergeQueue.result.blocked.recovery, {
    action: "resume_worker_session",
    sessionId: "sample-2",
    workspacePath: "/tmp/t002",
    reason: "controller_must_not_mutate_worker_worktree",
  });
  assert.deepEqual(result.spawn.issueIds, []);
});

test("runOnce keeps merge prepare blocked when finalize reports failed PR checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-finalize-checks-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => calls.push(`assert:${mergeIssue.id}`),
    finalizeIssue: async (mergeIssue) => {
      calls.push(`finalize:${mergeIssue.id}`);
      throw new Error("PR checks are still failing");
    },
    prepareIssue: async () => {
      throw new Error("PR checks are still failing");
    },
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "assert:T002",
    "finalize:T002",
  ]);
  assertWorkerPrepareBlockedWithoutResume(result, {
    issueId: "T002",
    sessionId: "sample-2",
    reasonPattern: /checks are still failing/,
  });
});

test("runOnce keeps merge prepare blocked when a ready PR is missing its artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-missing-ready-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => {
      calls.push(`assert:${mergeIssue.id}`);
      throw new Error(`Cannot merge ${mergeIssue.id}: missing ready artifact.`);
    },
    prepareIssue: async () => {
      throw new Error("Cannot merge T002: missing ready artifact.");
    },
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const persisted = JSON.parse(await readFile(statePath, "utf8"));

  assert.deepEqual(calls, [
    "assert:T002",
  ]);
  assertWorkerPrepareBlockedWithoutResume(result, {
    issueId: "T002",
    sessionId: "sample-2",
    reasonPattern: /missing ready artifact/,
  });
  assert.equal(persisted.mergeQueue.result.blocked.phase, "worker-prepare");
  assert.deepEqual(result.spawn.issueIds, []);
});

test("runOnce finalizes when a worker readiness artifact appears during the bounded grace period", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-ready-grace-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  let readinessChecks = 0;
  const taskPlan = {
    tasks: new Map([
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => {
      readinessChecks += 1;
      calls.push(`assert:${mergeIssue.id}:${readinessChecks}`);
      if (readinessChecks < 3) {
        throw new Error(`Cannot merge ${mergeIssue.id}: missing ready artifact.`);
      }
    },
    prepareIssue: async () => {
      throw new Error("worker_session_required: merge preparation belongs to the assigned AO worker");
    },
    workerReadyGraceAttempts: 2,
    workerReadyGraceIntervalMs: 0,
    finalizeIssue: async (mergeIssue) => calls.push(`finalize:${mergeIssue.id}`),
    recordMergedIssue: async () => ({ updated: true }),
    reconcileAfterMerge: async () => ({
      taskPlan: { tasks: new Map([["T002", { id: "T002", done: true }]]) },
      observedTasks: { T002: { status: "merged" } },
    }),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.equal(result.mergeQueue.result.blocked, undefined);
  assert.deepEqual(calls, [
    "assert:T002:1",
    "assert:T002:2",
    "assert:T002:3",
    "assert:T002:4",
    "finalize:T002",
  ]);
  assert.ok(result.mergeQueue.result.actions.some((action) => action.action === "worker-ready-grace"));
});

test("runOnce restores the owning worker when the bounded readiness grace expires", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-ready-grace-expired-"));
  const statePath = join(dir, "state.json");
  let readinessChecks = 0;
  const taskPlan = {
    tasks: new Map([
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
      },
    },
    assertWorkspaceReady: async () => {
      readinessChecks += 1;
      throw new Error("Cannot merge T002: missing ready artifact.");
    },
    workerReadyGraceAttempts: 2,
    workerReadyGraceIntervalMs: 0,
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.equal(readinessChecks, 3);
  assertWorkerPrepareResumed(result, {
    issueId: "T002",
    sessionId: "sample-2",
    reasonPattern: /worker_session_required/,
  });
});

test("runOnce keeps merge prepare blocked when PR checks are pending during readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-pending-checks-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => {
      calls.push(`assert:${mergeIssue.id}`);
      throw new Error("Cannot merge T002: PR checks are still pending (ci).");
    },
    prepareIssue: async () => {
      throw new Error("Cannot merge T002: PR checks are still pending (ci).");
    },
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "assert:T002",
  ]);
  assertWorkerPrepareBlockedWithoutResume(result, {
    issueId: "T002",
    sessionId: "sample-2",
    reasonPattern: /checks are still pending/,
  });
});

test("runOnce restores the owning worker when controller merge preparation is required", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-worker-prepare-required-"));
  const statePath = join(dir, "state.json");
  const eventLogPath = join(dir, "events.jsonl");
  const taskPlan = {
    tasks: new Map([
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    eventLogPath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
      },
    },
    assertWorkspaceReady: async () => {
      throw new Error("Cannot merge T002: PR checks are still pending (ci).");
    },
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assertWorkerPrepareResumed(result, {
    issueId: "T002",
    sessionId: "sample-2",
    reasonPattern: /worker_session_required/,
  });
  const events = await readEvents({ eventLogPath });
  assert.deepEqual(events.map((event) => event.type), [
    "task.resumed",
    "ci.recovery.started",
    "ci.recovery.blocked",
    "task.waiting",
  ]);
});

test("runOnce keeps merge prepare blocked when PR checks are not green during readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-not-green-checks-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T002", { id: "T002", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => {
      calls.push(`assert:${mergeIssue.id}`);
      throw new Error("Cannot merge T002: PR checks are not green (test).");
    },
    prepareIssue: async () => {
      throw new Error("Cannot merge T002: PR checks are not green (test).");
    },
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "assert:T002",
  ]);
  assertWorkerPrepareBlockedWithoutResume(result, {
    issueId: "T002",
    sessionId: "sample-2",
    reasonPattern: /checks are not green/,
  });
});

test("runOnce does not run controller prepare refresh for clean follow-up PRs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-prepare-blocked-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
      ["T003", { id: "T003", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
        T003: {
          status: "ready",
          sessions: [{ id: "sample-3", issueId: "T003", workspacePath: "/tmp/t003" }],
        },
      },
    },
    assertWorkspaceReady: async () => null,
    finalizeIssue: async (mergeIssue) => calls.push(`finalize:${mergeIssue.id}`),
    reconcileAfterMerge: async ({ issue }) => {
      calls.push(`reconcile:${issue.id}`);
      return { taskPlan };
    },
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  const persisted = JSON.parse(await readFile(statePath, "utf8"));

  assert.deepEqual(calls, ["finalize:T002", "reconcile:T002", "finalize:T003", "reconcile:T003"]);
  assert.equal(result.mergeQueue.result.blocked, undefined);
  assert.equal(persisted.mergeQueue.result.blocked, undefined);
  assert.deepEqual(result.spawn.issueIds, []);
});

test("runOnce restores dirty follow-up PRs after an earlier merge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-prepare-dirty-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: false }],
      ["T003", { id: "T003", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: {
          status: "ready",
          sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }],
        },
        T003: {
          status: "ready",
          sessions: [{ id: "sample-3", issueId: "T003", workspacePath: "/tmp/t003" }],
        },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => {
      calls.push(`assert:${mergeIssue.id}`);
      if (mergeIssue.id === "T003") throw new Error("Cannot merge T003: PR merge state is DIRTY.");
    },
    finalizeIssue: async (mergeIssue) => calls.push(`finalize:${mergeIssue.id}`),
    prepareIssue: async () => {
      throw new Error("Cannot merge T003: PR merge state is DIRTY.");
    },
    reconcileAfterMerge: async ({ issue }) => {
      calls.push(`reconcile:${issue.id}`);
      return { taskPlan };
    },
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "assert:T002",
    "finalize:T002",
    "reconcile:T002",
    "assert:T003",
  ]);
  assertWorkerPrepareBlockedWithoutResume(result, {
    issueId: "T003",
    sessionId: "sample-3",
    reasonPattern: /DIRTY/,
  });
});

test("runOnce restores the first queued PR when resuming after it became dirty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-resume-dirty-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T001", { id: "T001", done: true }],
      ["T002", { id: "T002", done: true }],
      ["T003", { id: "T003", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T002: { status: "merged", sessions: [{ id: "sample-2", issueId: "T002", workspacePath: "/tmp/t002" }] },
        T003: { status: "ready", sessions: [{ id: "sample-3", issueId: "T003", workspacePath: "/tmp/t003" }] },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => {
      calls.push(`assert:${mergeIssue.id}`);
      throw new Error("Cannot merge T003: PR merge state is DIRTY.");
    },
    prepareIssue: async () => {
      throw new Error("Cannot merge T003: PR merge state is DIRTY.");
    },
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "assert:T003",
  ]);
  assertWorkerPrepareBlockedWithoutResume(result, {
    issueId: "T003",
    sessionId: "sample-3",
    reasonPattern: /DIRTY/,
  });
});

test("runOnce keeps merge prepare blocked without feature resume after dirty readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-refresh-ready-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T003", { id: "T003", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T003: { status: "ready", sessions: [{ id: "sample-3", issueId: "T003", workspacePath: "/tmp/t003" }] },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => {
      calls.push(`assert:${mergeIssue.id}`);
      throw new Error("Cannot merge T003: PR merge state is DIRTY.");
    },
    prepareIssue: async () => {
      throw new Error("Cannot merge T003: PR merge state is DIRTY.");
    },
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "assert:T003",
  ]);
  assertWorkerPrepareBlockedWithoutResume(result, {
    issueId: "T003",
    sessionId: "sample-3",
    reasonPattern: /DIRTY/,
  });
});

test("runOnce resumes worker when merge prepare fails on local conflict-probe leftovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-local-leftovers-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T003", { id: "T003", done: false }],
    ]),
  };

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T003: { status: "ready", sessions: [{ id: "sample-3", issueId: "T003", workspacePath: "/tmp/t003" }] },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => {
      calls.push(`assert:${mergeIssue.id}`);
      throw new Error("Cannot merge T003: PR merge state is DIRTY.");
    },
    prepareIssue: async () => {
      throw new Error("merge-gate exited with status 1 and did not write a recognized merge status: tracked working tree changes exist before conflict merge");
    },
    restoreSessions: async (issues) => restorePlannedSessions(issues),
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "assert:T003",
  ]);
  assertWorkerPrepareResumed(result, {
    issueId: "T003",
    sessionId: "sample-3",
    reasonPattern: /tracked working tree changes exist before conflict merge/,
  });
});

test("runOnce prepares and finalizes a dirty PR without worker babysitting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-prepare-dirty-success-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T003", { id: "T003", done: false }],
    ]),
  };
  let prepared = false;

  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T003: {
          status: "ready",
          sessions: [{ id: "sample-3", issueId: "T003", workspacePath: "/tmp/t003" }],
        },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => {
      calls.push(`assert:${mergeIssue.id}`);
      if (!prepared) throw new Error("Cannot merge T003: PR merge state is DIRTY.");
    },
    prepareIssue: async (mergeIssue) => {
      calls.push(`prepare:${mergeIssue.id}`);
      prepared = true;
    },
    refreshReadyArtifact: async (mergeIssue) => calls.push(`ready:${mergeIssue.id}`),
    finalizeIssue: async (mergeIssue) => calls.push(`finalize:${mergeIssue.id}`),
    reconcileAfterMerge: async ({ issue }) => {
      calls.push(`reconcile:${issue.id}`);
      return { taskPlan };
    },
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "assert:T003",
    "prepare:T003",
    "ready:T003",
    "assert:T003",
    "finalize:T003",
    "reconcile:T003",
  ]);
  assert.equal(result.mergeQueue.result.blocked, undefined);
  assert.deepEqual(result.launchPlan.toResume, []);
});

test("runOnce refreshes a stale ready artifact before finalizing a resumed PR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-merge-stale-ready-"));
  const statePath = join(dir, "state.json");
  const calls = [];
  const taskPlan = {
    tasks: new Map([
      ["T003", { id: "T003", done: false }],
    ]),
  };

  let refreshed = false;
  const result = await runOnce({
    cwd: dir,
    dryRun: false,
    statePath,
    project: { id: "sample", path: "/tmp/project", tracker: { tasksPath: "planning/roadmap/tasks.md" } },
    getTaskPlan: async () => taskPlan,
    getRunnableIssues: async () => [],
    listSessions: async () => ({ data: [] }),
    observabilityState: {
      tasks: {
        T003: { status: "ready", sessions: [{ id: "sample-3", issueId: "T003", workspacePath: "/tmp/t003" }] },
      },
    },
    assertWorkspaceReady: async (mergeIssue) => {
      calls.push(`assert:${mergeIssue.id}`);
      if (!refreshed) {
        throw new Error("Cannot merge T003: ready artifact HEAD old-head does not match local HEAD new-head.");
      }
    },
    prepareWorkspace: async (mergeIssue) => calls.push(`prepare-workspace:${mergeIssue.id}`),
    prepareIssue: async (mergeIssue) => calls.push(`prepare:${mergeIssue.id}`),
    refreshReadyArtifact: async (mergeIssue) => {
      calls.push(`ready:${mergeIssue.id}`);
      refreshed = true;
    },
    finalizeIssue: async (mergeIssue) => calls.push(`finalize:${mergeIssue.id}`),
    reconcileAfterMerge: async ({ issue }) => {
      calls.push(`reconcile:${issue.id}`);
      return { taskPlan };
    },
    spawnIssues: async () => calls.push("spawn"),
    now: () => new Date("2026-06-16T10:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    "assert:T003",
    "prepare-workspace:T003",
    "ready:T003",
    "assert:T003",
    "finalize:T003",
    "reconcile:T003",
  ]);
  assert.equal(result.mergeQueue.result.blocked, undefined);
});

test("refreshReadyArtifactAfterPrepare writes the current branch heads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-ready-artifact-"));
  const artifactPath = join(dir, "projects", "sample", "sessions", "sample-3.ready.json");
  await mkdir(join(dir, "projects", "sample", "sessions"), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify({
    version: 2,
    archonRunId: "archon-run-3",
    qa: { status: "QA_PASSED", result: "browser checks passed" },
    reviewCycle: { signal: "clean" },
    preparedAt: "2026-06-16T09:00:00.000Z",
  })}\n`, "utf8");

  await refreshReadyArtifactAfterPrepare({
    id: "T003",
    sessionId: "sample-3",
    workspacePath: "/tmp/t003",
    pr: { number: 42 },
  }, {
    aoHome: dir,
    project: { id: "sample" },
    now: () => new Date("2026-06-16T10:00:00.000Z"),
    runWorkspaceGit: async (_workspacePath, args) => {
      if (args[0] === "branch") return "feat/t003\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "new-head\n";
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse" && args[1] === "origin/feat/t003") return "new-head\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    runGh: async () => JSON.stringify({
      number: 42,
      url: "https://github.com/acme/sample/pull/42",
      state: "OPEN",
      headRefOid: "new-head",
      mergeStateStatus: "CLEAN",
    }),
  });

  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  assert.equal(artifact.localHead, "new-head");
  assert.equal(artifact.remoteHead, "new-head");
  assert.equal(artifact.pr.headRefOid, "new-head");
  assert.equal(artifact.archonRunId, "archon-run-3");
  assert.deepEqual(artifact.qa, { status: "QA_PASSED", result: "browser checks passed" });
  assert.deepEqual(artifact.reviewCycle, { signal: "clean" });
  assert.equal(artifact.transitionKey, "sample:T003:42:new-head");
  assert.equal(artifact.preparedAt, "2026-06-16T10:00:00.000Z");
});

test("assertWorkspaceReadyForMerge prefers the refreshed durable artifact over a stale observed snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-ready-artifact-race-"));
  const artifactPath = join(dir, "projects", "sample", "sessions", "sample-3.ready.json");
  await mkdir(join(dir, "projects", "sample", "sessions"), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify({
    version: 1,
    issueId: "T003",
    sessionId: "sample-3",
    branch: "feat/t003",
    localHead: "new-head",
    remoteHead: "new-head",
    pr: { number: 42, headRefOid: "new-head", state: "OPEN", mergeStateStatus: "CLEAN" },
  })}\n`, "utf8");

  await assert.doesNotReject(assertWorkspaceReadyForMerge({
    id: "T003",
    sessionId: "sample-3",
    workspacePath: "/tmp/t003",
    readyArtifact: {
      version: 1,
      issueId: "T003",
      sessionId: "sample-3",
      branch: "feat/t003",
      localHead: "old-head",
      remoteHead: "old-head",
      pr: { number: 42, headRefOid: "old-head", state: "OPEN", mergeStateStatus: "CLEAN" },
    },
  }, {
    aoHome: dir,
    project: { id: "sample" },
    runWorkspaceGit: async (_workspacePath, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "new-head\n";
      if (args[0] === "branch") return "feat/t003\n";
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse" && args[1] === "origin/feat/t003") return "new-head\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    getPullRequestReadiness: async () => ({
      number: 42,
      state: "OPEN",
      headRefOid: "new-head",
      mergeStateStatus: "CLEAN",
      currentChecks: [{ name: "validate", state: "SUCCESS", bucket: "pass" }],
    }),
  }));
});

test("assertWorkspaceReadyForMerge verifies ready artifact, remote branch, and PR head", async () => {
  await assert.doesNotReject(assertWorkspaceReadyForMerge({
    id: "T002",
    sessionId: "sample-2",
    workspacePath: "/tmp/t002",
    pr: { number: 36 },
  }, {
    project: { id: "sample" },
    readReadyArtifact: async () => ({
      version: 1,
      issueId: "T002",
      sessionId: "sample-2",
      branch: "feat/t002",
      localHead: "abc123",
      remoteHead: "abc123",
      pr: { number: 36, headRefOid: "abc123", state: "OPEN", mergeStateStatus: "CLEAN" },
    }),
    runWorkspaceGit: async (_workspacePath, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
      if (args[0] === "branch") return "feat/t002\n";
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse" && args[1] === "origin/feat/t002") return "abc123\n";
      if (args[0] === "status") return " M local-only-note.md\n?? pr.md\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    getPullRequestReadiness: async () => ({
      number: 36,
      state: "OPEN",
      headRefOid: "abc123",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [
        { name: "validate", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    }),
  }));

  await assert.rejects(
    assertWorkspaceReadyForMerge({
      id: "T002",
      sessionId: "sample-2",
      workspacePath: "/tmp/t002",
      pr: { number: 36 },
    }, {
      project: { id: "sample" },
      readReadyArtifact: async () => ({
        version: 1,
        issueId: "T002",
        sessionId: "sample-2",
        branch: "feat/t002",
        localHead: "abc123",
        remoteHead: "abc123",
        pr: { number: 36, headRefOid: "abc123", state: "OPEN", mergeStateStatus: "CLEAN" },
      }),
      runWorkspaceGit: async (_workspacePath, args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
        if (args[0] === "branch") return "feat/t002\n";
        if (args[0] === "fetch") return "";
        if (args[0] === "rev-parse" && args[1] === "origin/feat/t002") return "abc123\n";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
      getPullRequestReadiness: async () => ({
        number: 36,
        state: "OPEN",
        headRefOid: "def456",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { name: "validate", conclusion: "SUCCESS", status: "COMPLETED" },
        ],
      }),
    }),
    /PR head def456 does not match remote branch abc123/,
  );
});

test("assertWorkspaceReadyForMerge allows cleaned stale worktrees when ready artifact and remote PR match", async () => {
  await assert.doesNotReject(assertWorkspaceReadyForMerge({
    id: "T002",
    sessionId: "sample-2",
    workspacePath: "/tmp/missing-t002",
    pr: { number: 36 },
  }, {
    project: { id: "sample", path: "/repo/sample" },
    readReadyArtifact: async () => ({
      version: 1,
      issueId: "T002",
      sessionId: "sample-2",
      branch: "feat/t002",
      localHead: "abc123",
      remoteHead: "abc123",
      pr: { number: 36, headRefOid: "abc123", state: "OPEN", mergeStateStatus: "CLEAN" },
    }),
    runWorkspaceGit: async (workspacePath, args) => {
      if (workspacePath === "/tmp/missing-t002" && args[0] === "rev-parse" && args[1] === "HEAD") {
        throw new Error("fatal: cannot change to '/tmp/missing-t002': No such file or directory");
      }
      if (workspacePath === "/repo/sample") {
        if (args[0] === "fetch") return "";
        if (args[0] === "rev-parse" && args[1] === "origin/feat/t002") return "abc123\n";
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    runGh: async (workspacePath, args) => {
      assert.equal(workspacePath, "/repo/sample");
      assert.deepEqual(args.slice(0, 3), ["pr", "view", "36"]);
      return JSON.stringify({
        number: 36,
        state: "OPEN",
        headRefOid: "abc123",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { name: "validate", conclusion: "SUCCESS", status: "COMPLETED" },
        ],
      });
    },
  }));
});

test("assertWorkspaceReadyForMerge trusts current gh checks over stale status rollup failures", async () => {
  await assert.doesNotReject(assertWorkspaceReadyForMerge({
    id: "T006",
    sessionId: "sample-6",
    workspacePath: "/tmp/t006",
    pr: { number: 64 },
  }, {
    project: { id: "sample" },
    readReadyArtifact: async () => ({
      version: 1,
      issueId: "T006",
      sessionId: "sample-6",
      branch: "chore/t006-submission-readiness",
      localHead: "abc123",
      remoteHead: "abc123",
      pr: { number: 64, headRefOid: "abc123", state: "OPEN", mergeStateStatus: "CLEAN" },
    }),
    runWorkspaceGit: async (_workspacePath, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
      if (args[0] === "branch") return "chore/t006-submission-readiness\n";
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse" && args[1] === "origin/chore/t006-submission-readiness") return "abc123\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    runGh: async (_workspacePath, args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          number: 64,
          state: "OPEN",
          headRefOid: "abc123",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [
            { name: "Conventional PR Title", conclusion: "FAILURE", status: "COMPLETED" },
          ],
        });
      }

      if (args[0] === "pr" && args[1] === "checks") {
        return JSON.stringify([
          { name: "Conventional PR Title", state: "SUCCESS", bucket: "pass" },
          { name: "Test", state: "SUCCESS", bucket: "pass" },
        ]);
      }

      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  }));
});

test("assertWorkspaceReadyForMerge reports pending PR checks before failed-check handling", async () => {
  await assert.rejects(
    () => assertWorkspaceReadyForMerge({
      id: "T033",
      title: "T033 task",
      branchName: "feat/t033",
    }, {
      project: { id: "sample", path: "/tmp/sample" },
      readReadyArtifact: async () => ({
        issueId: "T033",
        sessionId: "sample-33",
        branch: "feat/t033",
        localHead: "head",
        remoteHead: "head",
        pr: { number: 33 },
      }),
      runWorkspaceGit: async (_workspacePath, args) => {
        if (args[0] === "branch") return "feat/t033\n";
        if (args[0] === "fetch") return "";
        if (args[0] === "rev-parse" && args[1] === "origin/feat/t033") return "head\n";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
      getPullRequestReadiness: async () => ({
        number: 33,
        state: "OPEN",
        headRefOid: "head",
        mergeStateStatus: "CLEAN",
        currentChecks: [{ name: "ci", bucket: "pending" }],
      }),
    }),
    /PR checks are still pending \(ci\)/,
  );
});

test("ensureIssueWorkspace recreates cleaned worker worktrees from the ready artifact branch", async () => {
  const calls = [];

  const result = await ensureIssueWorkspace({
    id: "T002",
    sessionId: "sample-2",
    workspacePath: "/tmp/missing-t002",
  }, {
    project: { id: "sample", path: "/repo/sample" },
    readReadyArtifact: async () => ({
      issueId: "T002",
      sessionId: "sample-2",
      branch: "feat/t002",
    }),
    runWorkspaceGit: async (workspacePath, args) => {
      calls.push(["workspace", workspacePath, ...args]);
      throw new Error("fatal: cannot change to '/tmp/missing-t002': No such file or directory");
    },
    runProjectGit: async (args) => {
      calls.push(["project", ...args]);
      return "";
    },
    mkdir: async (path, options) => calls.push(["mkdir", path, options]),
  });

  assert.deepEqual(result, {
    workspacePath: "/tmp/missing-t002",
    branch: "feat/t002",
    created: true,
  });
  assert.deepEqual(calls, [
    ["workspace", "/tmp/missing-t002", "rev-parse", "--show-toplevel"],
    ["mkdir", "/tmp", { recursive: true }],
    ["project", "fetch", "origin", "feat/t002", "--quiet"],
    ["project", "worktree", "add", "/tmp/missing-t002", "feat/t002"],
  ]);
});

test("ensureIssueWorkspace recreates legacy ready worktrees from a verified AO session branch", async () => {
  const calls = [];

  const result = await ensureIssueWorkspace({
    id: "T035",
    sessionId: "sample-35",
    branch: "feat/t035",
    workspacePath: "/tmp/missing-t035",
    pr: { number: 72 },
  }, {
    project: { id: "sample", path: "/repo/sample" },
    readReadyArtifact: async () => null,
    runWorkspaceGit: async () => {
      throw new Error("fatal: cannot change to '/tmp/missing-t035': No such file or directory");
    },
    runProjectGit: async (args) => {
      calls.push(["project", ...args]);
      if (args[0] === "rev-parse") return "abc123\n";
      return "";
    },
    getPullRequestReadiness: async () => ({
      number: 72,
      state: "OPEN",
      headRefOid: "abc123",
      mergeStateStatus: "CLEAN",
      currentChecks: [{ name: "CI", bucket: "pass" }],
    }),
    mkdir: async (path, options) => calls.push(["mkdir", path, options]),
  });

  assert.deepEqual(result, {
    workspacePath: "/tmp/missing-t035",
    branch: "feat/t035",
    created: true,
  });
  assert.deepEqual(calls, [
    ["project", "fetch", "origin", "feat/t035", "--quiet"],
    ["project", "rev-parse", "origin/feat/t035"],
    ["mkdir", "/tmp", { recursive: true }],
    ["project", "worktree", "add", "/tmp/missing-t035", "feat/t035"],
  ]);
});

test("refreshProjectMain refuses dirty main checkouts", async () => {
  const calls = [];

  await assert.rejects(
    refreshProjectMain({
      id: "sample",
      path: "/tmp/project",
      defaultBranch: "main",
    }, {
      runGit: async (args) => {
        calls.push(args);
        if (args[0] === "branch") return "main\n";
        if (args[0] === "status") return " M planning/roadmap/tasks.md\n";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    }),
    /Cannot refresh sample main: checkout has uncommitted changes/,
  );

  assert.deepEqual(calls, [
    ["branch", "--show-current"],
    ["status", "--porcelain"],
  ]);
});

test("refreshProjectMain ignores generated review artifacts", async () => {
  const calls = [];

  const result = await refreshProjectMain({
    id: "sample",
    path: "/tmp/project",
    defaultBranch: "main",
  }, {
    runGit: async (args) => {
      calls.push(args);
      if (args[0] === "branch") return "main\n";
      if (args[0] === "status") return "?? pr.md\n?? codex.review.md\n?? .superpowers/\n";
      if (args[0] === "remote") return "git@example.test:sample.git\n";
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "same\n";
      if (args[0] === "rev-parse" && args[1] === "origin/main") return "same\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
  });

  assert.equal(result.checked, true);
  assert.equal(result.mode, "remote");
  assert.deepEqual(calls, [
    ["branch", "--show-current"],
    ["status", "--porcelain"],
    ["remote", "get-url", "origin"],
    ["fetch", "origin", "--quiet"],
    ["rev-parse", "HEAD"],
    ["rev-parse", "origin/main"],
  ]);
});

test("refreshProjectMain refuses non-fast-forward remotes", async () => {
  const calls = [];

  await assert.rejects(
    refreshProjectMain({
      id: "sample",
      path: "/tmp/project",
      defaultBranch: "main",
    }, {
      runGit: async (args) => {
        calls.push(args);
        if (args[0] === "branch") return "main\n";
        if (args[0] === "status") return "";
        if (args[0] === "remote") return "git@example.test:sample.git\n";
        if (args[0] === "fetch") return "";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "local\n";
        if (args[0] === "rev-parse" && args[1] === "origin/main") return "remote\n";
        if (args[0] === "merge-base") throw new Error("not ancestor");
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    }),
    /Cannot refresh sample main: cannot fast-forward main from origin\/main/,
  );

  assert.deepEqual(calls, [
    ["branch", "--show-current"],
    ["status", "--porcelain"],
    ["remote", "get-url", "origin"],
    ["fetch", "origin", "--quiet"],
    ["rev-parse", "HEAD"],
    ["rev-parse", "origin/main"],
    ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
  ]);
});
