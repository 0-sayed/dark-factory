import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  cleanupAoSessions,
  cleanupMergedBranches,
  cleanupObservedCompletedAoSessions,
  cleanupStaleAoOrchestratorSessions,
  cleanupCompletedWorkspaceBrowsers,
  cleanupCompletedWorkspaceResources,
  cleanupTerminalWorkspaceProcesses,
  createLeaseHeartbeatGuard,
  ensureAoLifecycleStarted,
  initDarkFactoryProject,
  normalizeLeaseHeartbeatTimeoutMs,
  recoverDarkFactory,
  runDarkFactory,
  runDarkFactoryCleanup,
  setDarkFactoryControl,
  stopDarkFactory,
  writeDarkFactoryDashboards,
} from "./dark-factory.js";

const execFile = promisify(execFileCallback);

const testProject = {
  id: "sample",
  name: "Sample",
  path: "/tmp/sample",
  tracker: { tasksPath: "planning/roadmap/tasks.md" },
};
const verifiedPlanningFresh = async () => ({ checked: true, mode: "test" });

function activeRunLedger(...chargedTaskIds) {
  return {
    version: 1,
    runId: `test-${chargedTaskIds.join("-").toLowerCase()}`,
    projectId: testProject.id,
    status: "active",
    taskLimit: chargedTaskIds.length,
    chargedTaskIds,
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushPromises() {
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

test("initDarkFactoryProject forwards envFiles to project registration", async () => {
  const calls = [];

  await initDarkFactoryProject({
    projectId: "sample",
    planningPath: "/tmp/sample/planning",
    envFiles: [".env.example -> .env"],
    registerProject: async (options) => {
      calls.push(options);
      return {
        registry: { projects: { sample: { id: "sample" } } },
        project: { id: "sample" },
        registryPath: "/tmp/projects.json",
      };
    },
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
  });

  assert.deepEqual(calls[0].envFiles, [".env.example -> .env"]);
});

test("initDarkFactoryProject requires an already-running AO daemon without desktop start guidance", async () => {
  const result = await initDarkFactoryProject({
    projectId: "sample",
    planningPath: "/tmp/sample/planning",
    registerProject: async () => ({
      registry: { projects: { sample: { id: "sample", name: "Sample", path: "/tmp/sample" } } },
      project: { id: "sample", name: "Sample", path: "/tmp/sample" },
      registryPath: "/tmp/projects.json",
    }),
    writeAoConfig: async () => ({ registered: ["sample"], updated: ["sample"] }),
  });

  assert.match(result.next.aoDaemon, /AO daemon must already be running/i);
  assert.doesNotMatch(JSON.stringify(result.next), /ao start|AO_CONFIG_PATH|no-orchestrator/i);
});

test("ensureAoLifecycleStarted only verifies the running Go AO daemon", async () => {
  const calls = [];
  const result = await ensureAoLifecycleStarted({
    project: testProject,
    transport: {
      status: async () => {
        calls.push("status");
        return { available: true, ready: true, state: "ready", pid: 321 };
      },
    },
  });

  assert.deepEqual(calls, ["status"]);
  assert.deepEqual(result, {
    attempted: false,
    projectId: "sample",
    status: "daemon_ready",
    pid: 321,
  });
});

test("cleanupAoSessions delegates scoped preview and execution to AO transport", async () => {
  const calls = [];
  const transport = {
    cleanup: async (input) => {
      calls.push(input);
      return { ...input, candidates: ["sample-1"] };
    },
  };

  const preview = await cleanupAoSessions({ project: testProject, dryRun: true, transport });
  const execute = await cleanupAoSessions({ project: testProject, dryRun: false, transport });

  assert.deepEqual(calls, [
    { projectId: "sample", execute: false },
    { projectId: "sample", execute: true },
  ]);
  assert.deepEqual(preview.candidates, ["sample-1"]);
  assert.equal(execute.execute, true);
});

test("cleanupObservedCompletedAoSessions kills only observed done, merged, or closed sessions", async () => {
  const calls = [];
  const restamped = [];
  const terminationChecks = new Map();

  const result = await cleanupObservedCompletedAoSessions({
    project: testProject,
    dryRun: false,
    observability: {
      sessions: [
        { id: "sample-7", issueId: "T007", observableStatus: "merged", pr: { number: 7 } },
        { id: "sample-8", issueId: "T008", observableStatus: "ready" },
        { id: "sample-9", issueId: "T009", observableStatus: "failed" },
        { id: "sample-10", issueId: "T010", observableStatus: "done" },
        { id: "sample-11", issueId: "T011", observableStatus: "closed" },
      ],
    },
    transport: {
      sessionKill: async (sessionId) => calls.push(sessionId),
      sessionGet: async (sessionId) => {
        const checks = (terminationChecks.get(sessionId) ?? 0) + 1;
        terminationChecks.set(sessionId, checks);
        return { id: sessionId, isTerminated: checks > 1 };
      },
      cleanup: async (input) => {
        calls.push(input);
        return { cleaned: ["sample-7", "sample-10", "sample-11"], skipped: [] };
      },
    },
    cleanupTerminationPollMs: 1,
    recordMergedSession: async (issue) => {
      restamped.push(issue);
      return { updated: true };
    },
  });

  assert.deepEqual(calls, [
    "sample-7",
    "sample-10",
    "sample-11",
    {
      projectId: "sample",
      execute: true,
      sessionIds: ["sample-7", "sample-10", "sample-11"],
    },
  ]);
  assert.deepEqual(result.killed, ["sample-7", "sample-10", "sample-11"]);
  assert.deepEqual(result.cleaned, ["sample-7", "sample-10", "sample-11"]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(restamped, [{
    id: "T007",
    sessionId: "sample-7",
    pr: { number: 7 },
  }]);
});

test("cleanupObservedCompletedAoSessions restamps killed sessions reconciled as merged", async () => {
  const restamped = [];

  const result = await cleanupObservedCompletedAoSessions({
    project: testProject,
    observability: {
      sessions: [
        { id: "sample-31", issueId: "T031", status: "killed", observableStatus: "merged", pr: { number: 36 } },
      ],
    },
    transport: { sessionKill: async () => null },
    recordMergedSession: async (issue) => {
      restamped.push(issue);
      return { updated: true };
    },
  });

  assert.deepEqual(result.killed, ["sample-31"]);
  assert.deepEqual(restamped, [{
    id: "T031",
    sessionId: "sample-31",
    pr: { number: 36 },
  }]);
});

test("cleanupMergedBranches prunes origin and deletes only merged inactive completed branches", async () => {
  const calls = [];

  const result = await cleanupMergedBranches({
    project: { id: "sample", path: "/tmp/sample", defaultBranch: "main" },
    observability: {
      sessions: [
        { id: "sample-10", issueId: "T010", observableStatus: "merged", branch: "feat/t010-sse-realtime" },
        { id: "sample-11", issueId: "T011", observableStatus: "merged", branch: "feat/t011-grace-window" },
        { id: "sample-12", issueId: "T012", observableStatus: "running", branch: "feat/t012-audience-guard" },
      ],
    },
    runGit: async (args) => {
      calls.push(args);
      if (args[0] === "remote") return { stdout: "origin\nupstream\n", stderr: "" };
      if (args[0] === "fetch") return { stdout: "", stderr: "" };
      if (args[0] === "branch" && args[1] === "--merged") {
        return { stdout: "main\nfeat/t010-sse-realtime\nfeat/t011-grace-window\n", stderr: "" };
      }
      if (args[0] === "worktree") {
        return {
          stdout: [
            "worktree /tmp/sample",
            "HEAD abc",
            "branch refs/heads/main",
            "",
            "worktree /tmp/worktrees/sample-11",
            "HEAD def",
            "branch refs/heads/feat/t011-grace-window",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (args[0] === "branch" && args[1] === "-d") return { stdout: "", stderr: "" };
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  });

  assert.deepEqual(calls, [
    ["remote"],
    ["fetch", "--prune", "origin", "--quiet"],
    ["branch", "--merged", "main", "--format=%(refname:short)"],
    ["worktree", "list", "--porcelain"],
    ["branch", "-d", "feat/t010-sse-realtime"],
  ]);
  assert.deepEqual(result.deleted, [
    { issueId: "T010", sessionId: "sample-10", branch: "feat/t010-sse-realtime" },
  ]);
  assert.deepEqual(result.skipped, [
    { issueId: "T011", sessionId: "sample-11", branch: "feat/t011-grace-window", reason: "checked_out_worktree" },
  ]);
  assert.deepEqual(result.errors, []);
});

test("cleanupMergedBranches dry-run does not prune origin or delete branches", async () => {
  const calls = [];

  const result = await cleanupMergedBranches({
    project: { id: "sample", path: "/tmp/sample", defaultBranch: "main" },
    dryRun: true,
    observability: {
      sessions: [
        { id: "sample-10", issueId: "T010", observableStatus: "merged", branch: "feat/t010-sse-realtime" },
      ],
    },
    runGit: async (args) => {
      calls.push(args);
      if (args[0] === "remote") return { stdout: "origin\n", stderr: "" };
      if (args[0] === "branch" && args[1] === "--merged") {
        return { stdout: "main\nfeat/t010-sse-realtime\n", stderr: "" };
      }
      if (args[0] === "worktree") return { stdout: "worktree /tmp/sample\nbranch refs/heads/main\n", stderr: "" };
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  });

  assert.deepEqual(calls, [
    ["remote"],
    ["branch", "--merged", "main", "--format=%(refname:short)"],
    ["worktree", "list", "--porcelain"],
  ]);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.skipped, [
    { issueId: "T010", sessionId: "sample-10", branch: "feat/t010-sse-realtime", reason: "dry_run" },
  ]);
  assert.deepEqual(result.errors, []);
});

test("cleanupStaleAoOrchestratorSessions previews the fixed orchestrator session", async () => {
  const result = await cleanupStaleAoOrchestratorSessions({
    project: { ...testProject, sessionPrefix: "sample" },
    dryRun: true,
    transport: {
      sessionList: async () => ({
        data: [{ id: "sample-orchestrator", role: "orchestrator" }],
      }),
    },
  });

  assert.deepEqual(result, {
    projectId: "sample",
    dryRun: true,
    killed: ["sample-orchestrator"],
    skipped: [],
  });
});

test("runDarkFactory observes before planning and passes fresh state to runner", async () => {
  const calls = [];
  const observabilityState = {
    tasks: {
      T004: { status: "done" },
    },
    summary: { total: 1, done: 1 },
  };

  const result = await runDarkFactory({
    project: testProject,
    dryRun: true,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => {
      calls.push("observer");
      return observabilityState;
    },
    runRunner: async (options) => {
      calls.push("runner");
      return {
        dryRun: options.dryRun,
        observabilityState: options.observabilityState,
        launchPlan: { toLaunch: [], skipped: [{ id: "T004", reason: "observed_done" }] },
      };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, ["observer", "runner", "observer"]);
  assert.equal(result.runner.dryRun, true);
  assert.equal(result.runner.observabilityState, observabilityState);
  assert.deepEqual(result.runner.launchPlan.skipped, [{ id: "T004", reason: "observed_done" }]);
});

test("runDarkFactory refreshes observability after runner writes state before rendering dashboard", async () => {
  const calls = [];
  const beforeRunner = {
    tasks: { T004: { status: "queued" } },
    summary: { total: 1, queued: 1 },
    runnerState: null,
  };
  const runnerState = {
    dryRun: true,
    launchPlan: { toLaunch: [{ id: "T004" }], skipped: [] },
  };
  const afterRunner = {
    tasks: { T004: { status: "queued" } },
    summary: { total: 1, queued: 1 },
    runnerState,
  };

  const result = await runDarkFactory({
    project: testProject,
    dryRun: true,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => {
      calls.push("observer");
      return calls.filter((call) => call === "observer").length === 1 ? beforeRunner : afterRunner;
    },
    runRunner: async () => {
      calls.push("runner");
      return runnerState;
    },
    writeDashboard: async ({ observability }) => {
      calls.push(`dashboard:${observability.runnerState === runnerState}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, ["observer", "runner", "observer", "dashboard:true"]);
  assert.equal(result.observability, afterRunner);
});

test("runDarkFactory leaves concurrency automatic unless explicitly configured", async () => {
  const calls = [];

  await runDarkFactory({
    project: testProject,
    dryRun: true,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({ tasks: {}, summary: { total: 0 } }),
    runRunner: async ({ concurrency }) => {
      calls.push(concurrency);
      return { dryRun: true, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, [undefined]);
});

test("runDarkFactory passes explicit concurrency through as a manual cap", async () => {
  const calls = [];

  await runDarkFactory({
    project: testProject,
    dryRun: true,
    concurrency: 2,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({ tasks: {}, summary: { total: 0 } }),
    runRunner: async ({ concurrency }) => {
      calls.push(concurrency);
      return { dryRun: true, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, [2]);
});

test("runDarkFactory treats recovering control state as runnable", async () => {
  const calls = [];

  await runDarkFactory({
    project: testProject,
    dryRun: true,
    concurrency: 3,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    readControlState: async () => ({ mode: "recovering" }),
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({ tasks: {}, summary: { total: 0 } }),
    runRunner: async ({ concurrency }) => {
      calls.push(concurrency);
      return { dryRun: true, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, [3]);
});

test("runDarkFactory keeps the taskLimit stable across runner invocations", async () => {
  const taskLimitCalls = [];
  const beforeRunner = {
    tasks: { T004: { status: "queued" } },
    summary: { total: 1, queued: 1 },
    runnerState: null,
  };
  const afterCleanup = {
    tasks: { T004: { status: "ready" } },
    summary: { total: 1, ready: 1 },
    runnerState: null,
  };
  const afterRerun = {
    tasks: { T004: { status: "queued" } },
    summary: { total: 1, queued: 1 },
    runnerState: null,
  };

  await runDarkFactory({
    project: testProject,
    dryRun: false,
    taskLimit: 1,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => {
      const callNumber = taskLimitCalls.length;
      if (callNumber === 0) return beforeRunner;
      if (callNumber === 1) return afterCleanup;
      return afterRerun;
    },
    runRunner: async ({ taskLimit }) => {
      taskLimitCalls.push(taskLimit);
      return taskLimitCalls.length === 1
        ? {
          dryRun: false,
          launchPlan: { toLaunch: [{ id: "T004" }], skipped: [] },
          spawn: { attempted: true, issueIds: ["T004"] },
          mergeQueue: { result: { attempted: false } },
        }
        : {
          dryRun: false,
          launchPlan: { toLaunch: [], skipped: [] },
          spawn: { attempted: false, issueIds: [] },
          mergeQueue: { result: { attempted: false } },
        };
    },
    runWorkspaceCleanup: async () => ({ attempted: true, dryRun: false, workspaceCount: 1, killed: [], skipped: [], errors: [] }),
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(taskLimitCalls, [1, 1]);
});

test("runDarkFactory delegates unique task charging to the durable runner ledger", async () => {
  const taskLimitCalls = [];

  await runDarkFactory({
    project: testProject,
    dryRun: false,
    taskLimit: 2,
    maxAutonomousSupervisionPasses: 1,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({
      tasks: {
        T038: { status: "failed" },
        T040: { status: "failed" },
      },
      summary: { total: 2, failed: 2 },
      runnerState: null,
    }),
    runRunner: async ({ taskLimit }) => {
      taskLimitCalls.push(taskLimit);
      return taskLimitCalls.length === 1
        ? {
          dryRun: false,
          launchPlan: {
            toResume: [{ id: "T038" }, { id: "T040" }],
            skipped: [],
          },
          resume: {
            attempted: true,
            issueIds: ["T038", "T040"],
            restored: [{ issueId: "T040", sessionId: "sample-t040" }],
            errors: [{ issueId: "T038", sessionId: "sample-t038", message: "database is locked" }],
          },
          mergeQueue: { result: { attempted: false } },
        }
        : {
          dryRun: false,
          launchPlan: { toResume: [], skipped: [] },
          resume: { attempted: false, issueIds: [], restored: [], errors: [] },
          mergeQueue: { result: { attempted: false } },
        };
    },
    runWorkspaceCleanup: async () => ({ attempted: true, dryRun: false, workspaceCount: 0, killed: [], skipped: [], errors: [] }),
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(taskLimitCalls, [2, 2]);
});

test("dark-factory CLI help accepts and documents --task-limit", async () => {
  const { stdout } = await execFile(process.execPath, [
    "dark-factory.js",
    "run",
    "--task-limit",
    "10",
    "--help",
  ], {
    cwd: new URL(".", import.meta.url),
  });

  assert.match(stdout, /--task-limit <n>/);
});

test("dark-factory-runner CLI help accepts and documents --task-limit", async () => {
  const { stdout } = await execFile(process.execPath, [
    "dark-factory-runner.js",
    "--task-limit",
    "10",
    "--help",
  ], {
    cwd: new URL(".", import.meta.url),
  });

  assert.match(stdout, /--task-limit <n>/);
});

test("dark-factory CLI rejects non-integer --task-limit values", async () => {
  await assert.rejects(
    execFile(process.execPath, [
      "dark-factory.js",
      "run",
      "--task-limit",
      "1.5",
      "--help",
    ], {
      cwd: new URL(".", import.meta.url),
    }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /task-limit must be a positive integer/i);
      return true;
    },
  );
});

test("dark-factory-runner CLI rejects non-integer --task-limit values", async () => {
  await assert.rejects(
    execFile(process.execPath, [
      "dark-factory-runner.js",
      "--task-limit",
      "2abc",
      "--help",
    ], {
      cwd: new URL(".", import.meta.url),
    }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /task-limit must be a positive integer/i);
      return true;
    },
  );
});

test("runDarkFactory pause mode stops new launches by forcing concurrency to zero", async () => {
  const calls = [];

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    concurrency: 3,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    readControlState: async () => ({ mode: "paused" }),
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({ tasks: {}, summary: { total: 0 } }),
    runRunner: async ({ concurrency }) => {
      calls.push(concurrency);
      return { dryRun: false, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, [0]);
  assert.equal(result.supervision.exitReason, "paused");
});

test("setDarkFactoryControl writes durable pause state", async () => {
  let written = null;

  const result = await setDarkFactoryControl({
    project: testProject,
    mode: "paused",
    now: () => new Date("2026-06-16T10:00:00.000Z"),
    writeControlState: async (path, state) => {
      written = { path, state };
    },
  });

  assert.equal(written.path, ".dark-factory/projects/sample/control.json");
  assert.deepEqual(result.control, {
    version: 1,
    projectId: "sample",
    mode: "paused",
    updatedAt: "2026-06-16T10:00:00.000Z",
  });
});

test("stopDarkFactory suspends active Go AO workers and preserves their workspaces", async () => {
  let written = null;
  const suspended = [];
  const processCleanupCalls = [];

  const result = await stopDarkFactory({
    project: testProject,
    dryRun: false,
    now: () => new Date("2026-06-27T10:00:00.000Z"),
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({
      tasks: {},
      summary: { total: 2 },
      sessions: [
        { id: "sample-t001", projectId: "sample", issueId: "T001", status: "running", observableStatus: "working", workspacePath: "/tmp/sample-t001" },
        { id: "sample-t004", projectId: "sample", issueId: "T004", status: "running", observableStatus: "working", workspacePath: "/tmp/sample-t004" },
        { id: "sample-t005", projectId: "sample", issueId: "T005", status: "pr_open", observableStatus: "ready", workspacePath: "/tmp/sample-t005" },
        { id: "foreign-t001", projectId: "foreign", issueId: "T001", status: "running", observableStatus: "working" },
        { id: "sample-t002", issueId: "T002", status: "killed", observableStatus: "failed" },
        { id: "sample-t003", issueId: "T003", status: "done", observableStatus: "done" },
        { id: "sample-orchestrator", role: "orchestrator", status: "running", observableStatus: "working" },
      ],
    }),
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
    cleanupWorkspaceProcesses: async (input) => {
      processCleanupCalls.push(input);
      return { attempted: true, killed: [{ pid: 42 }], skipped: [], errors: [] };
    },
    writeControlState: async (path, state) => {
      written = { path, state };
    },
    transport: {
      sessionKill: async () => assert.fail("stop must not call destructive AO session kill"),
      sessionSuspend: async (sessionId) => {
        suspended.push(sessionId);
        if (sessionId === "sample-t004") {
          return { sessionId, suspended: false, preserved: true };
        }
        return { sessionId, suspended: true, preserved: true };
      },
    },
  });

  assert.equal(written.path, ".dark-factory/projects/sample/control.json");
  assert.equal(written.state.mode, "stopped");
  assert.deepEqual(suspended, ["sample-t001", "sample-t004"]);
  assert.deepEqual(result.stopped.suspended, ["sample-t001"]);
  assert.deepEqual(result.stopped.preserved, ["sample-t001", "sample-t004"]);
  assert.deepEqual(result.stopped.skipped, [{
    sessionId: "sample-t004",
    issueId: "T004",
    status: "working",
    reason: "already_terminated",
  }]);
  assert.equal(processCleanupCalls.length, 1);
  assert.equal(processCleanupCalls[0].includeNonTerminal, true);
  assert.deepEqual(processCleanupCalls[0].sessionIds, ["sample-t001", "sample-t004", "sample-t005"]);
  assert.deepEqual(result.workspaceCleanup.killed, [{ pid: 42 }]);
});

test("stopDarkFactory dry-run previews stopped state without writing control", async () => {
  let wroteControl = false;
  let wroteDashboard = false;

  const result = await stopDarkFactory({
    project: testProject,
    dryRun: true,
    now: () => new Date("2026-06-27T10:00:00.000Z"),
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({ tasks: {}, summary: { total: 0 }, sessions: [] }),
    writeDashboard: async () => {
      wroteDashboard = true;
      return { outputPath: "/tmp/sample.html" };
    },
    writeControlState: async () => {
      wroteControl = true;
    },
  });

  assert.equal(result.control.mode, "stopped");
  assert.equal(wroteControl, false);
  assert.equal(wroteDashboard, false);
  assert.equal(result.dashboard, null);
  assert.deepEqual(result.stopped.suspended, []);
});

test("recoverDarkFactory restores recoverable sessions without spawning new tasks", async () => {
  const runnerCalls = [];
  let written = null;

  const result = await recoverDarkFactory({
    project: testProject,
    dryRun: false,
    maxAutonomousSupervisionPasses: 0,
    now: () => new Date("2026-06-27T11:00:00.000Z"),
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({ tasks: { T021: { status: "failed" } }, summary: { total: 1 } }),
    runRunner: async (options) => {
      runnerCalls.push({ dryRun: options.dryRun, recoverOnly: options.recoverOnly });
      return {
        dryRun: options.dryRun,
        launchPlan: {
          toResume: [{ id: "T021", sessionId: "sample-t021" }],
          toLaunch: [],
          skipped: [],
        },
        resume: { attempted: true, issueIds: ["T021"] },
        spawn: { attempted: false, issueIds: [] },
        mergeQueue: { result: { attempted: false } },
      };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
    writeControlState: async (path, state) => {
      written = { path, state };
    },
  });

  assert.equal(written.path, ".dark-factory/projects/sample/control.json");
  assert.equal(written.state.mode, "recovering");
  assert.deepEqual(runnerCalls, [{ dryRun: false, recoverOnly: true }]);
  assert.deepEqual(result.runner.launchPlan.toResume.map((issue) => issue.id), ["T021"]);
});

test("recoverDarkFactory passes taskLimit to runner", async () => {
  const runnerCalls = [];

  await recoverDarkFactory({
    project: testProject,
    dryRun: false,
    taskLimit: 2,
    maxAutonomousSupervisionPasses: 0,
    now: () => new Date("2026-06-27T11:00:00.000Z"),
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({ tasks: { T021: { status: "failed" } }, summary: { total: 1 } }),
    runRunner: async (options) => {
      runnerCalls.push({
        dryRun: options.dryRun,
        recoverOnly: options.recoverOnly,
        taskLimit: options.taskLimit,
      });
      return {
        dryRun: options.dryRun,
        launchPlan: {
          toResume: [{ id: "T021", sessionId: "sample-t021" }],
          toLaunch: [],
          skipped: [],
        },
        resume: { attempted: true, issueIds: ["T021"] },
        spawn: { attempted: false, issueIds: [] },
        mergeQueue: { result: { attempted: false } },
      };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
    writeControlState: async () => {},
  });

  assert.deepEqual(runnerCalls, [{
    dryRun: false,
    recoverOnly: true,
    taskLimit: 2,
  }]);
});

test("recoverDarkFactory closes the run ledger from the final merged observation", async () => {
  const ledger = {
    version: 1,
    runId: "run-1",
    projectId: "sample",
    status: "active",
    taskLimit: 1,
    chargedTaskIds: ["T021"],
  };
  let completedLedgerInput = null;
  let persistedRunner = null;

  const result = await recoverDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    maxAutonomousSupervisionPasses: 0,
    now: () => new Date("2026-06-27T11:00:00.000Z"),
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    writeControlState: async () => {},
    readControlState: async () => ({ mode: "recovering", updatedAt: "another-controller" }),
    runObserver: async () => ({
      tasks: { T021: { status: "merged" } },
      summary: { total: 1, merged: 1 },
    }),
    runRunner: async () => ({
      dryRun: false,
      runLedger: ledger,
      launchPlan: { toResume: [], toLaunch: [], skipped: [] },
      resume: { attempted: false, issueIds: [] },
      spawn: { attempted: false, issueIds: [] },
      mergeQueue: { result: { attempted: false, actions: [] } },
    }),
    completeRunLedger: async (path, value, options) => {
      completedLedgerInput = { path, value, options };
      return { ...value, status: options.status };
    },
    persistRunnerState: async (path, value) => {
      persistedRunner = { path, value };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.equal(result.runner.complete, true);
  assert.equal(result.runner.runLedger.status, "completed");
  assert.equal(completedLedgerInput.path, ".dark-factory/projects/sample/run.json");
  assert.equal(completedLedgerInput.options.status, "completed");
  assert.equal(persistedRunner.path, ".dark-factory/projects/sample/state.json");
  assert.equal(persistedRunner.value.complete, true);
});

test("recoverDarkFactory keeps supervising resumed workers until the merge queue runs", async () => {
  const calls = [];
  const beforeRecovery = { tasks: { T029: { status: "failed" } }, summary: { total: 1, failed: 1 } };
  const ready = {
    tasks: { T029: { status: "ready_to_merge" } },
    sessions: [{ id: "sample-29", issueId: "T029", observableStatus: "ready_to_merge", workspacePath: "/tmp/t029" }],
    summary: { total: 1, ready_to_merge: 1 },
  };
  const afterMerge = { tasks: { T029: { status: "merged" } }, summary: { total: 1, merged: 1 } };

  const result = await recoverDarkFactory({
    project: testProject,
    dryRun: false,
    taskLimit: 1,
    supervisionIntervalMs: 25,
    maxAutonomousSupervisionPasses: 2,
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`);
    },
    now: () => new Date("2026-06-27T11:00:00.000Z"),
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => {
      calls.push("observer");
      const count = calls.filter((call) => call === "observer").length;
      if (count === 1) return beforeRecovery;
      if (count === 2) return ready;
      return afterMerge;
    },
    runRunner: async ({ observabilityState, recoverOnly, taskLimit }) => {
      calls.push(`runner:${observabilityState.summary.ready_to_merge ?? 0}:${observabilityState.summary.failed ?? 0}:recover=${recoverOnly}:limit=${taskLimit}`);
      if ((observabilityState.summary.failed ?? 0) > 0) {
        return {
          dryRun: false,
          runLedger: activeRunLedger("T029"),
          resume: { attempted: true, issueIds: ["T029"] },
          spawn: { attempted: false, issueIds: [] },
          mergeQueue: { result: { attempted: false, actions: [] } },
          launchPlan: { toResume: [{ id: "T029", sessionId: "sample-29" }], toLaunch: [], skipped: [] },
        };
      }

      return {
        dryRun: false,
        resume: { attempted: false, issueIds: [] },
        spawn: { attempted: false, issueIds: [] },
        mergeQueue: {
          result: {
            attempted: true,
            actions: [{ action: "finalize", issueId: "T029" }],
          },
        },
        launchPlan: { toResume: [], toLaunch: [], skipped: [] },
      };
    },
    writeDashboard: async ({ runner }) => {
      calls.push(`dashboard:${runner.mergeQueue.result.attempted}`);
      return { outputPath: "/tmp/sample.html" };
    },
    writeControlState: async () => {},
  });

  assert.deepEqual(calls, [
    "observer",
    "runner:0:1:recover=true:limit=1",
    "sleep:25",
    "observer",
    "runner:1:0:recover=true:limit=1",
    "sleep:25",
    "observer",
    "runner:0:0:recover=true:limit=1",
    "observer",
    "dashboard:true",
  ]);
  assert.equal(result.observability, afterMerge);
  assert.equal(result.runner.mergeQueue.result.attempted, true);
});

test("recoverDarkFactory resumes preserved workers exposed after a successful merge", async () => {
  const calls = [];
  const readyAndPreserved = {
    tasks: {
      T039: { status: "failed" },
      T041: { status: "ready_to_merge" },
    },
    summary: { total: 2, failed: 1, ready_to_merge: 1 },
  };
  const mergedAndPreserved = {
    tasks: {
      T039: { status: "failed" },
      T041: { status: "merged" },
    },
    summary: { total: 2, failed: 1, merged: 1 },
  };

  const result = await recoverDarkFactory({
    project: testProject,
    dryRun: false,
    taskLimit: 1,
    maxAutonomousSupervisionPasses: 1,
    supervisionIntervalMs: 0,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    writeControlState: async () => {},
    readControlState: async () => ({ mode: "recovering", updatedAt: "different-run" }),
    runObserver: async () => {
      calls.push("observer");
      return calls.filter((call) => call === "observer").length === 1
        ? readyAndPreserved
        : mergedAndPreserved;
    },
    runRunner: async ({ observabilityState, recoverOnly, taskLimit }) => {
      const ready = observabilityState.summary.ready_to_merge ?? 0;
      calls.push(`runner:ready=${ready}:recover=${recoverOnly}:limit=${taskLimit}`);
      if (ready > 0) {
        return {
          dryRun: false,
          resume: { attempted: false, issueIds: [] },
          spawn: { attempted: false, issueIds: [] },
          mergeQueue: {
            result: {
              attempted: true,
              actions: [{ action: "finalize", issueId: "T041" }],
            },
          },
          launchPlan: { toResume: [], toLaunch: [], skipped: [] },
        };
      }

      return {
        dryRun: false,
        resume: { attempted: true, issueIds: ["T039"] },
        spawn: { attempted: false, issueIds: [] },
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: {
          toResume: [{ id: "T039", sessionId: "sample-39" }],
          toLaunch: [],
          skipped: [],
        },
      };
    },
    cleanupWorkspaceProcesses: async () => ({ attempted: true, killed: [], errors: [] }),
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, [
    "observer",
    "runner:ready=1:recover=true:limit=1",
    "observer",
    "runner:ready=0:recover=true:limit=1",
  ]);
  assert.deepEqual(result.runner.resume.issueIds, ["T039"]);
  assert.equal(result.supervision.exitReason, "budget_exhausted");
});

test("recoverDarkFactory cleans completed sessions after recovered work merges", async () => {
  const calls = [];
  const beforeRecovery = { tasks: { T029: { status: "failed" } }, summary: { total: 1, failed: 1 } };
  const afterMerge = {
    tasks: {
      T029: {
        status: "merged",
        sessions: [{
          id: "sample-29",
          issueId: "T029",
          observableStatus: "merged",
          branch: "feat/t029",
          workspacePath: "/tmp/t029",
        }],
      },
    },
    sessions: [{
      id: "sample-29",
      issueId: "T029",
      observableStatus: "merged",
      branch: "feat/t029",
      workspacePath: "/tmp/t029",
    }],
    summary: { total: 1, merged: 1 },
  };
  const afterCleanup = { tasks: { T029: { status: "done" } }, sessions: [], summary: { total: 1, done: 1 } };
  let observerCalls = 0;

  const result = await recoverDarkFactory({
    project: testProject,
    dryRun: false,
    maxAutonomousSupervisionPasses: 1,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    writeControlState: async () => {},
    readControlState: async () => ({ mode: "recovering", updatedAt: "different-run" }),
    runObserver: async () => {
      calls.push("observer");
      observerCalls += 1;
      if (observerCalls === 1) return beforeRecovery;
      if (observerCalls <= 3) return afterMerge;
      return afterCleanup;
    },
    runRunner: async ({ observabilityState }) => {
      calls.push(`runner:${observabilityState.summary.failed ?? 0}`);
      if ((observabilityState.summary.failed ?? 0) > 0) {
        return {
          dryRun: false,
          runLedger: activeRunLedger("T029"),
          resume: { attempted: true, issueIds: ["T029"] },
          spawn: { attempted: false, issueIds: [] },
          mergeQueue: { result: { attempted: false, actions: [] } },
          launchPlan: { toResume: [{ id: "T029", sessionId: "sample-29" }], toLaunch: [], skipped: [] },
        };
      }
      return {
        dryRun: false,
        resume: { attempted: false, issueIds: [] },
        spawn: { attempted: false, issueIds: [] },
        mergeQueue: { result: { attempted: true, actions: [{ action: "finalize", issueId: "T029" }] } },
        launchPlan: { toResume: [], toLaunch: [], skipped: [] },
      };
    },
    cleanupWorkspaceProcesses: async ({ sessionIds }) => {
      assert.deepEqual(sessionIds, ["sample-29"]);
      calls.push("process-cleanup");
      return { attempted: true, killed: [], skipped: [], errors: [] };
    },
    cleanupWorkspaceBrowsers: async ({ sessionIds }) => {
      assert.deepEqual(sessionIds, ["sample-29"]);
      calls.push("browser-cleanup");
      return { attempted: true, cleaned: [], skipped: [], errors: [] };
    },
    cleanupWorkspaceResources: async ({ sessionIds }) => {
      assert.deepEqual(sessionIds, ["sample-29"]);
      calls.push("resource-cleanup");
      return { attempted: true, cleaned: [], skipped: [], errors: [] };
    },
    cleanupMergedBranches: async ({ sessionIds }) => {
      assert.deepEqual(sessionIds, ["sample-29"]);
      calls.push("branch-cleanup");
      return { attempted: true, deleted: [], skipped: [], errors: [] };
    },
    cleanupAoSessions: async ({ sessionIds }) => {
      assert.deepEqual(sessionIds, ["sample-29"]);
      calls.push("ao-cleanup");
      return { projectId: "sample", killed: ["sample-29"], cleaned: ["sample-29"], skipped: [], errors: [] };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, [
    "observer",
    "runner:1",
    "observer",
    "process-cleanup",
    "runner:0",
    "observer",
    "process-cleanup",
    "browser-cleanup",
    "resource-cleanup",
    "branch-cleanup",
    "ao-cleanup",
    "observer",
  ]);
  assert.equal(result.observability, afterCleanup);
  assert.equal(result.cleanup.cleaned[0], "sample-29");
});

test("recoverDarkFactory restores active control after recovery completes", async () => {
  const writes = [];
  let currentControl = null;
  let observerCalls = 0;
  const beforeRecovery = { tasks: { T029: { status: "failed" } }, summary: { total: 1, failed: 1 } };
  const afterRecovery = { tasks: { T029: { status: "merged" } }, summary: { total: 1, merged: 1 } };

  const result = await recoverDarkFactory({
    project: testProject,
    dryRun: false,
    supervisionIntervalMs: 25,
    maxAutonomousSupervisionPasses: 1,
    sleep: async () => {},
    now: () => new Date("2026-06-27T11:00:00.000Z"),
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    readControlState: async () => currentControl,
    runObserver: async () => {
      observerCalls += 1;
      return observerCalls === 1 ? beforeRecovery : afterRecovery;
    },
    runRunner: async ({ observabilityState }) => {
      if ((observabilityState.summary.failed ?? 0) > 0) {
        return {
          dryRun: false,
          resume: { attempted: true, issueIds: ["T029"] },
          spawn: { attempted: false, issueIds: [] },
          mergeQueue: { result: { attempted: false, actions: [] } },
          launchPlan: { toResume: [{ id: "T029", sessionId: "sample-29" }], toLaunch: [], skipped: [] },
        };
      }

      return {
        dryRun: false,
        resume: { attempted: false, issueIds: [] },
        spawn: { attempted: false, issueIds: [] },
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: { toResume: [], toLaunch: [], skipped: [] },
      };
    },
    writeDashboard: async ({ control }) => {
      assert.equal(control.mode, "active");
      return { outputPath: "/tmp/sample.html" };
    },
    writeControlState: async (path, state) => {
      currentControl = state;
      writes.push({ path, state });
    },
  });

  assert.deepEqual(writes.map((write) => write.state.mode), ["recovering", "active"]);
  assert.equal(result.control.mode, "active");
});

test("recoverDarkFactory does not restore active over a later pause", async () => {
  const writes = [];
  let observerCalls = 0;
  const beforeRecovery = { tasks: { T029: { status: "failed" } }, summary: { total: 1, failed: 1 } };
  const afterRecovery = { tasks: { T029: { status: "merged" } }, summary: { total: 1, merged: 1 } };

  const result = await recoverDarkFactory({
    project: testProject,
    dryRun: false,
    supervisionIntervalMs: 25,
    maxAutonomousSupervisionPasses: 1,
    sleep: async () => {},
    now: () => new Date("2026-06-27T11:00:00.000Z"),
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    readControlState: async () => ({
      version: 1,
      projectId: "sample",
      mode: "paused",
      updatedAt: "2026-06-27T11:00:01.000Z",
    }),
    runObserver: async () => {
      observerCalls += 1;
      return observerCalls === 1 ? beforeRecovery : afterRecovery;
    },
    runRunner: async ({ observabilityState }) => {
      if ((observabilityState.summary.failed ?? 0) > 0) {
        return {
          dryRun: false,
          resume: { attempted: true, issueIds: ["T029"] },
          spawn: { attempted: false, issueIds: [] },
          mergeQueue: { result: { attempted: false, actions: [] } },
          launchPlan: { toResume: [{ id: "T029", sessionId: "sample-29" }], toLaunch: [], skipped: [] },
        };
      }

      return {
        dryRun: false,
        resume: { attempted: false, issueIds: [] },
        spawn: { attempted: false, issueIds: [] },
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: { toResume: [], toLaunch: [], skipped: [] },
      };
    },
    writeDashboard: async ({ control }) => {
      assert.equal(control.mode, "paused");
      return { outputPath: "/tmp/sample.html" };
    },
    writeControlState: async (path, state) => {
      writes.push({ path, state });
    },
  });

  assert.deepEqual(writes.map((write) => write.state.mode), ["recovering"]);
  assert.equal(result.control.mode, "paused");
});

for (const mode of ["paused", "stopped"]) {
  test(`recoverDarkFactory honors live ${mode} control before the next supervision side effect`, async () => {
    const calls = [];
    let currentControl = {
      version: 1,
      projectId: "sample",
      mode: "recovering",
      updatedAt: "2026-07-13T18:00:00.000Z",
    };

    const result = await recoverDarkFactory({
      project: testProject,
      dryRun: false,
      supervisionIntervalMs: 25,
      maxAutonomousSupervisionPasses: 2,
      sleep: async () => {
        calls.push("sleep");
        currentControl = {
          version: 1,
          projectId: "sample",
          mode,
          updatedAt: "2026-07-13T18:00:01.000Z",
        };
      },
      now: () => new Date("2026-07-13T18:00:00.000Z"),
      verifyPlanningFresh: verifiedPlanningFresh,
      writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
      writeControlState: async (path, state) => {
        currentControl = state;
        calls.push(`write:${state.mode}`);
      },
      readControlState: async () => {
        calls.push(`control:${currentControl.mode}`);
        return currentControl;
      },
      runObserver: async () => {
        calls.push("observer");
        return {
          tasks: { T099: { status: "running" } },
          summary: { total: 1, running: 1 },
        };
      },
      runRunner: async () => {
        calls.push("runner");
        return {
          dryRun: false,
          resume: { attempted: true, issueIds: ["T099"] },
          spawn: { attempted: false, issueIds: [] },
          mergeQueue: { result: { attempted: false, actions: [] } },
          launchPlan: {
            toResume: [{ id: "T099", sessionId: "sample-99" }],
            toLaunch: [],
            skipped: [],
          },
        };
      },
      cleanupWorkspaceProcesses: async () => {
        calls.push("workspace-cleanup");
        return { attempted: true, killed: [], skipped: [], errors: [] };
      },
      cleanupWorkspaceBrowsers: async () => {
        calls.push("browser-cleanup");
        return { attempted: true, cleaned: [], skipped: [], errors: [] };
      },
      cleanupWorkspaceResources: async () => {
        calls.push("resource-cleanup");
        return { attempted: true, cleaned: [], skipped: [], errors: [] };
      },
      cleanupMergedBranches: async () => {
        calls.push("branch-cleanup");
        return { attempted: true, deleted: [], skipped: [], errors: [] };
      },
      cleanupAoSessions: async () => {
        calls.push("ao-cleanup");
        return { killed: [], cleaned: [], skipped: [], errors: [] };
      },
      writeDashboard: async ({ control, supervision }) => {
        calls.push(`dashboard:${control.mode}:${supervision?.exitReason ?? "missing"}`);
        return { outputPath: "/tmp/sample.html" };
      },
    });

    assert.deepEqual(calls, [
      "write:recovering",
      "observer",
      "control:recovering",
      "runner",
      "sleep",
      `control:${mode}`,
      `dashboard:${mode}:${mode}`,
    ]);
    assert.equal(result.control.mode, mode);
    assert.equal(result.supervision.exitReason, mode);
  });
}

test("recoverDarkFactory dry-run previews recovering state without writing control", async () => {
  let wroteControl = false;
  let wroteDashboard = false;

  const result = await recoverDarkFactory({
    project: testProject,
    dryRun: true,
    now: () => new Date("2026-06-27T11:00:00.000Z"),
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({ tasks: {}, summary: { total: 0 } }),
    runRunner: async (options) => ({
      dryRun: options.dryRun,
      launchPlan: { toResume: [], toLaunch: [], skipped: [] },
    }),
    writeDashboard: async () => {
      wroteDashboard = true;
      return { outputPath: "/tmp/sample.html" };
    },
    writeControlState: async () => {
      wroteControl = true;
    },
  });

  assert.equal(result.control.mode, "recovering");
  assert.equal(wroteControl, false);
  assert.equal(wroteDashboard, false);
  assert.equal(result.dashboard, null);
});

test("runDarkFactory does not run worker AO cleanup before observing", async () => {
  const calls = [];
  const transport = {};

  const result = await runDarkFactory({
    project: testProject,
    dryRun: true,
    aoCommand: "ao-custom",
    transport,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    cleanupAoSessions: async ({ project, dryRun, aoConfigPath, aoCommand }) => {
      calls.push(`cleanup:${project.id}:${dryRun}:${aoConfigPath}:${aoCommand}`);
      return { projectId: project.id, dryRun, stdout: "Would kill sample-1", stderr: "" };
    },
    cleanupStaleAoOrchestrators: async ({ project, dryRun, transport: received, aoCommand }) => {
      calls.push(`orchestrator-cleanup:${project.id}:${dryRun}:${received === transport}:${aoCommand}`);
      return { projectId: project.id, dryRun, killed: ["sample-orchestrator"], skipped: [] };
    },
    runObserver: async () => {
      calls.push("observer");
      return { tasks: {}, summary: { total: 0 } };
    },
    runRunner: async () => {
      calls.push("runner");
      return { dryRun: true, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, [
    "ao",
    "orchestrator-cleanup:sample:true:true:ao-custom",
    "observer",
    "runner",
    "observer",
  ]);
  assert.deepEqual(result.orchestratorCleanup, {
    projectId: "sample",
    dryRun: true,
    killed: ["sample-orchestrator"],
    skipped: [],
  });
  assert.deepEqual(result.cleanup, {
    enabled: true,
    orchestrator: {
      status: "skipped",
      reason: "dry_run",
      result: {
        projectId: "sample",
        dryRun: true,
        killed: ["sample-orchestrator"],
        skipped: [],
      },
    },
    postMerge: {
      browserCleanup: { status: "skipped", reason: "dry_run", blockedBy: [] },
      resourceCleanup: { status: "skipped", reason: "dry_run", blockedBy: [] },
      branchCleanup: { status: "skipped", reason: "dry_run", blockedBy: [] },
      completedSessionCleanup: { status: "skipped", reason: "dry_run", blockedBy: [] },
    },
    observedCompletion: {
      browserCleanup: { status: "skipped", reason: "dry_run", blockedBy: [] },
      resourceCleanup: { status: "skipped", reason: "dry_run", blockedBy: [] },
      branchCleanup: { status: "skipped", reason: "dry_run", blockedBy: [] },
      completedSessionCleanup: { status: "skipped", reason: "dry_run", blockedBy: [] },
    },
  });
});

test("runDarkFactoryCleanup cleans completed workspaces without launching workers", async () => {
  const calls = [];
  const observability = {
    sessions: [
      { id: "sample-10", issueId: "T010", observableStatus: "merged", workspacePath: "/tmp/worktrees/sample-10" },
    ],
    summary: { total: 1, merged: 1 },
  };

  const result = await runDarkFactoryCleanup({
    project: testProject,
    dryRun: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao-config");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      return observability;
    },
    cleanupWorkspaceProcesses: async () => {
      calls.push("workspace-processes");
      return { attempted: true, dryRun: false, workspaceCount: 1, killed: [], skipped: [], errors: [] };
    },
    cleanupWorkspaceBrowsers: async () => {
      calls.push("browsers");
      return { attempted: true, dryRun: false, workspaceCount: 1, cleaned: [], skipped: [], errors: [] };
    },
    cleanupWorkspaceResources: async () => {
      calls.push("resources");
      return { attempted: true, dryRun: false, workspaceCount: 1, commandCount: 0, cleaned: [], skipped: [], errors: [] };
    },
    cleanupMergedBranches: async () => {
      calls.push("branch-cleanup");
      return { attempted: true, dryRun: false, deleted: [], skipped: [], errors: [] };
    },
    cleanupAoSessions: async () => {
      calls.push("ao-cleanup");
      return { projectId: "sample", dryRun: false, stdout: "", stderr: "" };
    },
    cleanupStaleAoOrchestrators: async () => {
      calls.push("orchestrator-cleanup");
      return { projectId: "sample", dryRun: false, killed: [], skipped: [] };
    },
    runRunner: async () => {
      calls.push("runner");
      return {};
    },
    writeDashboard: async () => {
      calls.push("dashboard");
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao-config",
    "observer",
    "workspace-processes",
    "browsers",
    "resources",
    "branch-cleanup",
    "ao-cleanup",
    "orchestrator-cleanup",
    "observer",
    "dashboard",
  ]);
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.branchCleanup, { attempted: true, dryRun: false, deleted: [], skipped: [], errors: [] });
});

test("runDarkFactoryCleanup scopes every cleanup stage to selected sessions", async () => {
  const received = [];
  const selected = ["sample-10"];
  const observability = {
    sessions: [{
      id: "sample-10",
      issueId: "T010",
      observableStatus: "merged",
      workspacePath: "/tmp/worktrees/sample-10",
    }],
    summary: { total: 1, merged: 1 },
  };
  const capture = (stage, result) => async ({ sessionIds }) => {
    received.push([stage, sessionIds]);
    return result;
  };

  await runDarkFactoryCleanup({
    project: testProject,
    sessionIds: selected,
    dryRun: true,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => observability,
    cleanupWorkspaceProcesses: capture("processes", { attempted: true, killed: [], skipped: [], errors: [] }),
    cleanupWorkspaceBrowsers: capture("browsers", { attempted: true, cleaned: [], skipped: [], errors: [] }),
    cleanupWorkspaceResources: capture("resources", { attempted: true, cleaned: [], skipped: [], errors: [] }),
    cleanupMergedBranches: capture("branches", { attempted: true, deleted: [], skipped: [], errors: [] }),
    cleanupAoSessions: capture("ao", { projectId: "sample", killed: selected, skipped: [], errors: [] }),
    cleanupStaleAoOrchestrators: async () => ({ projectId: "sample", killed: [], skipped: [] }),
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(received, [
    ["processes", selected],
    ["browsers", selected],
    ["resources", selected],
    ["branches", selected],
    ["ao", selected],
  ]);
});

test("runDarkFactoryCleanup reruns branch cleanup after AO removes checked-out worktrees", async () => {
  const calls = [];
  const observability = {
    sessions: [
      {
        id: "sample-29",
        issueId: "T029",
        observableStatus: "merged",
        branch: "feat/t029-continuity-admin",
        workspacePath: "/tmp/worktrees/sample-29",
      },
    ],
    summary: { total: 1, merged: 1 },
  };

  const result = await runDarkFactoryCleanup({
    project: testProject,
    dryRun: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao-config");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      return observability;
    },
    cleanupWorkspaceProcesses: async () => {
      calls.push("workspace-processes");
      return { attempted: true, dryRun: false, workspaceCount: 1, killed: [], skipped: [], errors: [] };
    },
    cleanupWorkspaceBrowsers: async () => {
      calls.push("browsers");
      return { attempted: true, dryRun: false, workspaceCount: 1, cleaned: [], skipped: [], errors: [] };
    },
    cleanupWorkspaceResources: async () => {
      calls.push("resources");
      return { attempted: true, dryRun: false, workspaceCount: 1, commandCount: 0, cleaned: [], skipped: [], errors: [] };
    },
    cleanupMergedBranches: async () => {
      calls.push("branch-cleanup");
      if (calls.filter((call) => call === "branch-cleanup").length === 1) {
        return {
          attempted: true,
          dryRun: false,
          deleted: [],
          skipped: [{
            issueId: "T029",
            sessionId: "sample-29",
            branch: "feat/t029-continuity-admin",
            reason: "checked_out_worktree",
          }],
          errors: [],
        };
      }
      return {
        attempted: true,
        dryRun: false,
        deleted: [{ issueId: "T029", sessionId: "sample-29", branch: "feat/t029-continuity-admin" }],
        skipped: [],
        errors: [],
      };
    },
    cleanupAoSessions: async () => {
      calls.push("ao-cleanup");
      return { projectId: "sample", dryRun: false, killed: ["sample-29"], skipped: [], errors: [] };
    },
    cleanupStaleAoOrchestrators: async () => {
      calls.push("orchestrator-cleanup");
      return { projectId: "sample", dryRun: false, killed: [], skipped: [] };
    },
    writeDashboard: async () => {
      calls.push("dashboard");
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao-config",
    "observer",
    "workspace-processes",
    "browsers",
    "resources",
    "branch-cleanup",
    "ao-cleanup",
    "branch-cleanup",
    "orchestrator-cleanup",
    "observer",
    "dashboard",
  ]);
  assert.deepEqual(result.cleanup.killed, ["sample-29"]);
  assert.deepEqual(result.branchCleanup.deleted, [
    { issueId: "T029", sessionId: "sample-29", branch: "feat/t029-continuity-admin" },
  ]);
  assert.deepEqual(result.branchCleanup.skipped, [{
    issueId: "T029",
    sessionId: "sample-29",
    branch: "feat/t029-continuity-admin",
    reason: "checked_out_worktree",
  }]);
});

test("runDarkFactoryCleanup skips AO worktree cleanup when resource cleanup fails", async () => {
  const calls = [];

  const result = await runDarkFactoryCleanup({
    project: testProject,
    dryRun: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({ sessions: [], summary: { total: 0 } }),
    cleanupWorkspaceProcesses: async () => ({ attempted: false, dryRun: false, workspaceCount: 0, killed: [], skipped: [], errors: [] }),
    cleanupWorkspaceBrowsers: async () => ({ attempted: false, dryRun: false, workspaceCount: 0, cleaned: [], skipped: [], errors: [] }),
    cleanupWorkspaceResources: async () => ({ attempted: true, dryRun: false, workspaceCount: 1, commandCount: 1, cleaned: [], skipped: [], errors: [{ issueId: "T010", error: "docker failed" }] }),
    cleanupMergedBranches: async () => {
      calls.push("branch-cleanup");
      return {};
    },
    cleanupAoSessions: async () => {
      calls.push("ao-cleanup");
      return {};
    },
    cleanupStaleAoOrchestrators: async () => {
      calls.push("orchestrator-cleanup");
      return {};
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, []);
  assert.equal(result.branchCleanup, null);
  assert.deepEqual(result.blocked, { reason: "cleanup_errors_before_worktree_removal" });
});

test("runDarkFactory does not run worker AO cleanup in run mode before completion is observed", async () => {
  const calls = [];

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: true,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    cleanupAoSessions: async ({ project, dryRun, aoConfigPath }) => {
      calls.push(`cleanup:${project.id}:${dryRun}:${aoConfigPath}`);
      return { projectId: project.id, dryRun };
    },
    runObserver: async () => {
      calls.push("observer");
      return { tasks: {}, summary: { total: 0 } };
    },
    runRunner: async () => {
      calls.push("runner");
      return { dryRun: false, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, ["ao", "observer", "runner", "observer"]);
  assert.equal(result.cleanup.postMerge.completedSessionCleanup.reason, "merge_not_finalized");
  assert.equal(result.cleanup.observedCompletion.completedSessionCleanup.reason, "no_completed_sessions");
});

test("runDarkFactory performs post-merge AO cleanup and refreshes observability", async () => {
  const calls = [];
  const transport = {};
  const beforeCleanup = { tasks: { T007: { status: "ready" } }, summary: { total: 1, ready: 1 } };
  const afterMerge = {
    tasks: {
      T007: {
        status: "merged",
        sessions: [
          {
            id: "sample-7",
            issueId: "T007",
            observableStatus: "merged",
            workspacePath: "/tmp/worktrees/sample-7",
          },
        ],
      },
    },
    sessions: [
      {
        id: "sample-7",
        issueId: "T007",
        observableStatus: "merged",
        workspacePath: "/tmp/worktrees/sample-7",
      },
    ],
    summary: { total: 1, merged: 1 },
  };
  const afterCleanup = { tasks: { T007: { status: "done" } }, summary: { total: 1, done: 1 } };

  const result = await runDarkFactory({
    project: {
      ...testProject,
      cleanup: { commands: ["pnpm wtc down --volumes"] },
    },
    dryRun: false,
    transport,
    cleanupCompletedSessions: true,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      const count = calls.filter((call) => call === "observer").length;
      if (count === 1) return beforeCleanup;
      if (count === 2) return afterMerge;
      return afterCleanup;
    },
    runRunner: async () => {
      calls.push("runner");
      return {
        dryRun: false,
        runLedger: activeRunLedger("T007"),
        mergeQueue: {
          result: {
            attempted: true,
            actions: [{ action: "finalize", issueId: "T007" }],
          },
        },
        launchPlan: { toLaunch: [], skipped: [] },
      };
    },
    cleanupAoSessions: async ({ project, dryRun, transport: received }) => {
      calls.push(`cleanup:${project.id}:${dryRun}:${received === transport}`);
      return { projectId: project.id, dryRun };
    },
    cleanupWorkspaceResources: async ({ observability, dryRun }) => {
      calls.push(`resource-cleanup:${observability.summary.merged ?? 0}:${dryRun}`);
      return { attempted: true, dryRun, cleaned: [{ issueId: "T007" }], skipped: [], errors: [] };
    },
    cleanupMergedBranches: async ({ observability, dryRun }) => {
      calls.push(`branch-cleanup:${observability.summary.merged ?? 0}:${dryRun}`);
      return { attempted: true, dryRun, deleted: [{ issueId: "T007" }], skipped: [], errors: [] };
    },
    writeDashboard: async ({ observability }) => {
      calls.push(`dashboard:${observability.summary.done ?? 0}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao",
    "observer",
    "runner",
    "observer",
    "resource-cleanup:1:false",
    "branch-cleanup:1:false",
    "cleanup:sample:false:true",
    "observer",
    "dashboard:1",
  ]);
  assert.equal(result.observability, afterCleanup);
  assert.equal(result.cleanup.postMerge.resourceCleanup.status, "completed");
  assert.deepEqual(result.cleanup.postMerge.resourceCleanup.result.cleaned, [{ issueId: "T007" }]);
  assert.equal(result.cleanup.postMerge.branchCleanup.status, "completed");
  assert.equal(result.cleanup.postMerge.completedSessionCleanup.status, "completed");
  assert.equal(result.cleanup.observedCompletion.completedSessionCleanup.reason, "post_merge_cleanup_completed");
  assert.deepEqual(result.postMergeCleanup, { projectId: "sample", dryRun: false });
  assert.deepEqual(result.postMergeBranchCleanup, { attempted: true, dryRun: false, deleted: [{ issueId: "T007" }], skipped: [], errors: [] });
  assert.deepEqual(result.resourceCleanup.cleaned, [{ issueId: "T007" }]);
});

test("runDarkFactory scopes automatic cleanup to sessions charged to the active run", async () => {
  const cleanupCalls = [];
  let observerCalls = 0;
  const runLedger = {
    version: 1,
    runId: "run-scoped-cleanup",
    projectId: "sample",
    status: "active",
    taskLimit: 1,
    chargedTaskIds: ["T007"],
  };
  const beforeMerge = {
    tasks: { T007: { status: "ready_to_merge" } },
    sessions: [],
    summary: { total: 1, ready_to_merge: 1 },
  };
  const afterMerge = {
    tasks: {
      T007: { status: "merged" },
      T099: { status: "merged" },
    },
    sessions: [
      {
        id: "sample-7",
        issueId: "T007",
        observableStatus: "merged",
        workspacePath: "/tmp/worktrees/sample-7",
      },
      {
        id: "sample-99",
        issueId: "T099",
        observableStatus: "merged",
        workspacePath: "/tmp/worktrees/sample-99",
      },
    ],
    summary: { total: 2, merged: 2 },
  };
  const capture = (stage, result) => async ({ sessionIds }) => {
    cleanupCalls.push([stage, sessionIds]);
    return result;
  };

  await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: true,
    maxAutonomousSupervisionPasses: 0,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => {
      observerCalls += 1;
      return observerCalls === 1 ? beforeMerge : afterMerge;
    },
    runRunner: async () => ({
      dryRun: false,
      runLedger,
      launchPlan: { toLaunch: [], toResume: [], skipped: [] },
      mergeQueue: {
        result: {
          attempted: true,
          actions: [{ action: "finalize", issueId: "T007" }],
        },
      },
    }),
    cleanupWorkspaceProcesses: capture("workspace", {
      attempted: true,
      dryRun: false,
      killed: [],
      skipped: [],
      errors: [],
    }),
    cleanupWorkspaceBrowsers: capture("browser", {
      attempted: true,
      dryRun: false,
      cleaned: [],
      skipped: [],
      errors: [],
    }),
    cleanupWorkspaceResources: capture("resource", {
      attempted: true,
      dryRun: false,
      cleaned: [],
      skipped: [],
      errors: [],
    }),
    cleanupMergedBranches: capture("branch", {
      attempted: true,
      dryRun: false,
      deleted: [{ sessionId: "sample-7", issueId: "T007" }],
      skipped: [],
      errors: [],
    }),
    cleanupAoSessions: capture("ao", {
      projectId: "sample",
      dryRun: false,
      killed: ["sample-7"],
      cleaned: ["sample-7"],
      skipped: [],
      errors: [],
    }),
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.ok(cleanupCalls.length >= 5);
  for (const [stage, sessionIds] of cleanupCalls) {
    assert.deepEqual(sessionIds, ["sample-7"], `${stage} cleanup must be run-scoped`);
  }
});

test("runDarkFactory keeps AO worktrees when completed resource cleanup fails", async () => {
  const calls = [];
  let persistedRunner = null;
  const observedMerged = {
    tasks: {
      T014: {
        status: "merged",
        sessions: [
          {
            id: "sample-14",
            issueId: "T014",
            observableStatus: "merged",
            workspacePath: "/tmp/worktrees/sample-14",
          },
        ],
      },
    },
    sessions: [
      {
        id: "sample-14",
        issueId: "T014",
        observableStatus: "merged",
        workspacePath: "/tmp/worktrees/sample-14",
      },
    ],
    summary: { total: 1, merged: 1 },
  };

  const result = await runDarkFactory({
    project: {
      ...testProject,
      cleanup: { commands: ["pnpm wtc down --volumes"] },
    },
    dryRun: false,
    cleanupCompletedSessions: true,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      return observedMerged;
    },
    runRunner: async () => {
      calls.push("runner");
      return {
        dryRun: false,
        runLedger: activeRunLedger("T014"),
        mergeQueue: {
          result: {
            attempted: false,
            actions: [],
          },
        },
        launchPlan: { toLaunch: [], skipped: [] },
      };
    },
    cleanupWorkspaceResources: async () => {
      calls.push("resource-cleanup");
      return {
        attempted: true,
        dryRun: false,
        cleaned: [],
        skipped: [],
        errors: [{ issueId: "T014", error: "cleanup failed" }],
      };
    },
    cleanupMergedBranches: async () => {
      calls.push("branch-cleanup");
      return {};
    },
    cleanupAoSessions: async () => {
      calls.push("cleanup");
      return { projectId: "sample", dryRun: false };
    },
    persistRunnerState: async (_path, state) => {
      persistedRunner = state;
    },
    writeDashboard: async () => {
      calls.push("dashboard");
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, ["ao", "observer", "runner", "observer", "resource-cleanup", "dashboard"]);
  assert.deepEqual(result.resourceCleanup.errors, [{ issueId: "T014", error: "cleanup failed" }]);
  assert.equal(result.cleanup.observedCompletion.resourceCleanup.status, "failed");
  assert.equal(result.runner.complete, true);
  assert.equal(result.runner.cleanup.observedCompletion.resourceCleanup.status, "failed");
  assert.equal(persistedRunner.cleanup.observedCompletion.resourceCleanup.status, "failed");
  assert.deepEqual(result.cleanup.observedCompletion.resourceCleanup.result.errors, [{ issueId: "T014", error: "cleanup failed" }]);
  assert.equal(result.cleanup.observedCompletion.branchCleanup.reason, "pre_cleanup_errors");
  assert.deepEqual(result.cleanup.observedCompletion.branchCleanup.blockedBy, ["workspace_resources"]);
  assert.equal(result.cleanup.observedCompletion.completedSessionCleanup.reason, "pre_cleanup_errors");
  assert.equal(result.observedCompletionBranchCleanup, null);
  assert.equal(result.observedCompletionCleanup, null);
});

test("runDarkFactory blocks observed-completion cleanup after post-merge branch cleanup errors", async () => {
  const calls = [];
  const beforeCleanup = { tasks: { T014: { status: "ready" } }, summary: { total: 1, ready: 1 } };
  const observedMerged = {
    tasks: {
      T014: {
        status: "merged",
        sessions: [
          {
            id: "sample-14",
            issueId: "T014",
            observableStatus: "merged",
            workspacePath: "/tmp/worktrees/sample-14",
          },
        ],
      },
    },
    sessions: [
      {
        id: "sample-14",
        issueId: "T014",
        observableStatus: "merged",
        workspacePath: "/tmp/worktrees/sample-14",
      },
    ],
    summary: { total: 1, merged: 1 },
  };

  const result = await runDarkFactory({
    project: {
      ...testProject,
      cleanup: { commands: ["pnpm wtc down --volumes"] },
    },
    dryRun: false,
    cleanupCompletedSessions: true,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      const count = calls.filter((call) => call === "observer").length;
      return count === 1 ? beforeCleanup : observedMerged;
    },
    runRunner: async () => {
      calls.push("runner");
      return {
        dryRun: false,
        mergeQueue: {
          result: {
            attempted: true,
            actions: [{ action: "finalize", issueId: "T014" }],
          },
        },
        launchPlan: { toLaunch: [], skipped: [] },
      };
    },
    cleanupWorkspaceResources: async () => {
      calls.push("resource-cleanup");
      return { attempted: true, dryRun: false, cleaned: [{ issueId: "T014" }], skipped: [], errors: [] };
    },
    cleanupMergedBranches: async () => {
      calls.push("branch-cleanup");
      return {
        attempted: true,
        dryRun: false,
        deleted: [],
        skipped: [],
        errors: [{ issueId: "T014", error: "branch delete failed" }],
      };
    },
    cleanupAoSessions: async () => {
      calls.push("cleanup");
      return { projectId: "sample", dryRun: false };
    },
    writeDashboard: async () => {
      calls.push("dashboard");
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao",
    "observer",
    "runner",
    "observer",
    "resource-cleanup",
    "branch-cleanup",
    "dashboard",
  ]);
  assert.equal(result.cleanup.postMerge.resourceCleanup.status, "completed");
  assert.equal(result.cleanup.postMerge.branchCleanup.status, "failed");
  assert.deepEqual(result.cleanup.postMerge.branchCleanup.result.errors, [{ issueId: "T014", error: "branch delete failed" }]);
  assert.equal(result.cleanup.postMerge.completedSessionCleanup.reason, "branch_cleanup_errors");
  assert.deepEqual(result.cleanup.postMerge.completedSessionCleanup.blockedBy, ["branches"]);
  assert.equal(result.cleanup.observedCompletion.completedSessionCleanup.reason, "post_merge_branch_cleanup_errors");
  assert.deepEqual(result.postMergeBranchCleanup.errors, [{ issueId: "T014", error: "branch delete failed" }]);
  assert.equal(result.postMergeCleanup, null);
  assert.equal(result.observedCompletionBranchCleanup, null);
  assert.equal(result.observedCompletionCleanup, null);
});

test("runDarkFactory cleans observed completed sessions before rendering dashboard", async () => {
  const calls = [];
  const transport = {};
  const beforeRunner = { tasks: { T014: { status: "running" } }, sessions: [], summary: { total: 1, running: 1 } };
  const observedMerged = {
    tasks: {
      T014: {
        status: "merged",
        sessions: [
          {
            id: "sample-14",
            issueId: "T014",
            observableStatus: "merged",
            workspacePath: "/tmp/worktrees/sample-14",
          },
        ],
      },
    },
    sessions: [
      {
        id: "sample-14",
        issueId: "T014",
        observableStatus: "merged",
        workspacePath: "/tmp/worktrees/sample-14",
      },
    ],
    summary: { total: 1, merged: 1 },
  };
  const afterCleanup = { tasks: { T014: { status: "done" } }, sessions: [], summary: { total: 1, done: 1 } };
  let cleanupRan = false;

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    transport,
    cleanupCompletedSessions: true,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      const count = calls.filter((call) => call === "observer").length;
      if (count === 1) return beforeRunner;
      return cleanupRan ? afterCleanup : observedMerged;
    },
    runRunner: async () => {
      calls.push("runner");
      return {
        dryRun: false,
        runLedger: activeRunLedger("T014"),
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: { toLaunch: [], skipped: [] },
      };
    },
    cleanupAoSessions: async ({ project, dryRun, transport: received }) => {
      calls.push(`cleanup:${project.id}:${dryRun}:${received === transport}`);
      cleanupRan = true;
      return { projectId: project.id, dryRun };
    },
    cleanupMergedBranches: async ({ observability, dryRun }) => {
      calls.push(`branch-cleanup:${observability.summary.merged ?? 0}:${dryRun}`);
      return { attempted: true, dryRun, deleted: [{ issueId: "T014" }], skipped: [], errors: [] };
    },
    writeDashboard: async ({ observability }) => {
      calls.push(`dashboard:${observability.summary.done ?? 0}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao",
    "observer",
    "runner",
    "observer",
    "runner",
    "observer",
    "branch-cleanup:1:false",
    "cleanup:sample:false:true",
    "observer",
    "dashboard:1",
  ]);
  assert.equal(result.observability, afterCleanup);
  assert.equal(result.cleanup.postMerge.completedSessionCleanup.reason, "merge_not_finalized");
  assert.equal(result.cleanup.observedCompletion.branchCleanup.status, "completed");
  assert.equal(result.cleanup.observedCompletion.completedSessionCleanup.status, "completed");
  assert.deepEqual(result.observedCompletionBranchCleanup, { attempted: true, dryRun: false, deleted: [{ issueId: "T014" }], skipped: [], errors: [] });
  assert.deepEqual(result.observedCompletionCleanup, { projectId: "sample", dryRun: false });
});

test("runDarkFactory reruns observed branch cleanup after AO removes checked-out worktrees", async () => {
  const calls = [];
  const beforeRunner = { tasks: { T014: { status: "ready" } }, summary: { total: 1, ready: 1 } };
  const observedMerged = {
    tasks: {
      T014: {
        status: "merged",
        sessions: [
          {
            id: "sample-14",
            issueId: "T014",
            observableStatus: "merged",
            branch: "feat/t014-payables-admin",
            workspacePath: "/tmp/worktrees/sample-14",
          },
        ],
      },
    },
    sessions: [
      {
        id: "sample-14",
        issueId: "T014",
        observableStatus: "merged",
        branch: "feat/t014-payables-admin",
        workspacePath: "/tmp/worktrees/sample-14",
      },
    ],
    summary: { total: 1, merged: 1 },
  };
  const afterCleanup = { tasks: { T014: { status: "done" } }, sessions: [], summary: { total: 1, done: 1 } };

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: true,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      const count = calls.filter((call) => call === "observer").length;
      if (count === 1) return beforeRunner;
      if (count === 2) return observedMerged;
      return afterCleanup;
    },
    runRunner: async () => {
      calls.push("runner");
      return {
        dryRun: false,
        runLedger: activeRunLedger("T014"),
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: { toLaunch: [], skipped: [] },
      };
    },
    cleanupAoSessions: async () => {
      calls.push("cleanup");
      return { projectId: "sample", dryRun: false, killed: ["sample-14"], skipped: [], errors: [] };
    },
    cleanupMergedBranches: async () => {
      calls.push("branch-cleanup");
      if (calls.filter((call) => call === "branch-cleanup").length === 1) {
        return {
          attempted: true,
          dryRun: false,
          deleted: [],
          skipped: [{
            issueId: "T014",
            sessionId: "sample-14",
            branch: "feat/t014-payables-admin",
            reason: "checked_out_worktree",
          }],
          errors: [],
        };
      }
      return {
        attempted: true,
        dryRun: false,
        deleted: [{ issueId: "T014", sessionId: "sample-14", branch: "feat/t014-payables-admin" }],
        skipped: [],
        errors: [],
      };
    },
    writeDashboard: async () => {
      calls.push("dashboard");
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao",
    "observer",
    "runner",
    "observer",
    "branch-cleanup",
    "cleanup",
    "branch-cleanup",
    "observer",
    "dashboard",
  ]);
  assert.deepEqual(result.observedCompletionBranchCleanup.deleted, [
    { issueId: "T014", sessionId: "sample-14", branch: "feat/t014-payables-admin" },
  ]);
  assert.equal(result.cleanup.observedCompletion.branchCleanup.status, "completed");
  assert.equal(result.cleanup.observedCompletion.completedSessionCleanup.status, "completed");
});

test("runDarkFactory reruns runner after cleanup clears stale workspace metadata", async () => {
  const calls = [];
  const transport = {};
  const observedMerged = {
    tasks: {
      T021: {
        status: "merged",
        sessions: [
          {
            id: "sample-t021-retry1",
            issueId: "T021",
            observableStatus: "merged",
            workspacePath: "/tmp/missing-t021",
          },
        ],
      },
    },
    sessions: [
      {
        id: "sample-t021-retry1",
        issueId: "T021",
        observableStatus: "merged",
        workspacePath: "/tmp/missing-t021",
      },
    ],
    summary: { total: 1, merged: 1 },
  };
  const afterCleanup = { tasks: { T022: { status: "queued" } }, sessions: [], summary: { total: 1, queued: 1 } };

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    transport,
    cleanupCompletedSessions: true,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      const count = calls.filter((call) => call === "observer").length;
      return count < 3 ? observedMerged : afterCleanup;
    },
    runRunner: async ({ observabilityState }) => {
      calls.push(`runner:${observabilityState.summary.merged ?? 0}:${observabilityState.summary.queued ?? 0}`);
      if ((observabilityState.summary.merged ?? 0) > 0) {
        return {
          dryRun: false,
          runLedger: activeRunLedger("T021", "T022"),
          mergeQueue: { result: { attempted: false, actions: [] } },
          launchPlan: {
            toLaunch: [],
            skipped: [{
              id: "T021",
              reason: "stale_existing_workspace",
              sessionId: "sample-t021-retry1",
              workspacePath: "/tmp/missing-t021",
            }],
          },
        };
      }
      return {
        dryRun: false,
        runLedger: activeRunLedger("T021", "T022"),
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: { toLaunch: [{ id: "T022" }], skipped: [] },
      };
    },
    cleanupAoSessions: async ({ project, dryRun, transport: received }) => {
      calls.push(`cleanup:${project.id}:${dryRun}:${received === transport}`);
      return { projectId: project.id, dryRun };
    },
    cleanupMergedBranches: async ({ observability, dryRun }) => {
      calls.push(`branch-cleanup:${observability.summary.merged ?? 0}:${dryRun}`);
      return { attempted: true, dryRun, deleted: [], skipped: [], errors: [] };
    },
    writeDashboard: async ({ runner }) => {
      calls.push(`dashboard:${runner.launchPlan.toLaunch.map((item) => item.id).join(",")}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao",
    "observer",
    "runner:1:0",
    "observer",
    "branch-cleanup:1:false",
    "cleanup:sample:false:true",
    "observer",
    "runner:0:1",
    "dashboard:T022",
  ]);
  assert.deepEqual(result.runner.launchPlan.toLaunch.map((item) => item.id), ["T022"]);
  assert.deepEqual(result.runner.launchPlan.skipped, []);
});

test("runDarkFactory re-observes after worker completion and lets the merge queue run", async () => {
  const calls = [];
  const beforeWorkers = { tasks: { T009: { status: "running" } }, summary: { total: 1, running: 1 } };
  const afterWorkers = {
    tasks: { T009: { status: "ready" } },
    sessions: [{ id: "sample-9", issueId: "T009", observableStatus: "ready", workspacePath: "/tmp/t009" }],
    summary: { total: 1, ready: 1 },
  };
  const afterMerge = { tasks: { T009: { status: "merged" } }, summary: { total: 1, merged: 1 } };

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      const count = calls.filter((call) => call === "observer").length;
      if (count === 1) return beforeWorkers;
      if (count === 2) return afterWorkers;
      return afterMerge;
    },
    runRunner: async ({ observabilityState }) => {
      calls.push(`runner:${observabilityState.summary.ready ?? 0}`);
      if ((observabilityState.summary.ready ?? 0) === 0) {
        return {
          dryRun: false,
          spawn: { attempted: true, issueIds: ["T009"] },
          mergeQueue: { result: { attempted: false, actions: [] } },
          launchPlan: { toLaunch: [{ id: "T009" }], skipped: [] },
        };
      }

      return {
        dryRun: false,
        spawn: { attempted: false, issueIds: [] },
        mergeQueue: {
          result: {
            attempted: true,
            actions: [{ action: "finalize", issueId: "T009" }],
          },
        },
        launchPlan: { toLaunch: [], skipped: [] },
      };
    },
    cleanupWorkspaceProcesses: async ({ observability }) => {
      calls.push(`workspace-cleanup:${observability.summary.ready ?? 0}`);
      return {
        attempted: true,
        killed: observability.summary.ready ? [{ pid: 123, workspacePath: "/tmp/t009" }] : [],
        errors: [],
      };
    },
    cleanupAoSessions: async () => {
      calls.push("cleanup");
      return { projectId: "sample", dryRun: false };
    },
    writeDashboard: async ({ observability, runner }) => {
      calls.push(`dashboard:${observability.summary.merged ?? 0}:${runner.mergeQueue.result.attempted}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao",
    "observer",
    "runner:0",
    "observer",
    "workspace-cleanup:1",
    "runner:1",
    "observer",
    "workspace-cleanup:0",
    "dashboard:1:true",
  ]);
  assert.equal(result.observability, afterMerge);
  assert.equal(result.runner.mergeQueue.result.attempted, true);
  assert.equal(result.workspaceCleanup.killed.length, 1);
});

test("runDarkFactory continues supervising launched workers until they become ready", async () => {
  const calls = [];
  const beforeWorkers = { tasks: { T035: { status: "queued" } }, summary: { total: 1, queued: 1 } };
  const stillRunning = { tasks: { T035: { status: "running" } }, summary: { total: 1, running: 1 } };
  const inReview = { tasks: { T035: { status: "in_review" } }, summary: { total: 1, in_review: 1 } };
  const ready = {
    tasks: { T035: { status: "ready_to_merge" } },
    sessions: [{ id: "sample-35", issueId: "T035", observableStatus: "ready_to_merge", workspacePath: "/tmp/t035" }],
    summary: { total: 1, ready_to_merge: 1 },
  };
  const afterMerge = { tasks: { T035: { status: "merged" } }, summary: { total: 1, merged: 1 } };

  const observations = [beforeWorkers, stillRunning, inReview, ready, afterMerge];
  let runnerCalls = 0;
  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    taskLimit: 1,
    supervisionIntervalMs: 25,
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`);
    },
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      return observations.shift() ?? afterMerge;
    },
    runRunner: async ({ observabilityState, taskLimit }) => {
      runnerCalls += 1;
      calls.push(`runner:${observabilityState.summary.ready_to_merge ?? 0}:${observabilityState.summary.running ?? 0}:limit=${taskLimit}`);
      if ((observabilityState.summary.ready_to_merge ?? 0) > 0) {
        return {
          dryRun: false,
          spawn: { attempted: false, issueIds: [] },
          mergeQueue: {
            result: {
              attempted: true,
              actions: [{ action: "finalize", issueId: "T035" }],
            },
          },
          launchPlan: { toLaunch: [], toResume: [], skipped: [] },
        };
      }

      return {
        dryRun: false,
        spawn: runnerCalls === 1
          ? { attempted: true, issueIds: ["T035"] }
          : { attempted: false, issueIds: [] },
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: { toLaunch: runnerCalls === 1 ? [{ id: "T035" }] : [], skipped: [] },
      };
    },
    cleanupWorkspaceProcesses: async ({ observability }) => {
      calls.push(`workspace-cleanup:${observability.summary.ready_to_merge ?? 0}:${observability.summary.running ?? 0}`);
      return { attempted: true, killed: [], errors: [] };
    },
    writeDashboard: async ({ observability, runner }) => {
      calls.push(`dashboard:${observability.summary.merged ?? 0}:${runner.mergeQueue.result.attempted}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao",
    "observer",
    "runner:0:0:limit=1",
    "sleep:25",
    "observer",
    "workspace-cleanup:0:1",
    "runner:0:1:limit=1",
    "sleep:25",
    "observer",
    "workspace-cleanup:0:0",
    "runner:0:0:limit=1",
    "sleep:25",
    "observer",
    "workspace-cleanup:1:0",
    "runner:1:0:limit=1",
    "observer",
    "workspace-cleanup:0:0",
    "dashboard:1:true",
  ]);
  assert.equal(result.observability, afterMerge);
  assert.equal(result.runner.mergeQueue.result.attempted, true);
});

test("runDarkFactory honors live pause control before the next supervision side effect", async () => {
  const calls = [];
  const controls = [
    { mode: "active", updatedAt: "2026-07-10T10:00:00.000Z" },
    { mode: "active", updatedAt: "2026-07-10T10:00:00.500Z" },
    { mode: "paused", updatedAt: "2026-07-10T10:00:01.000Z" },
  ];

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    maxAutonomousSupervisionPasses: 2,
    leaseOwnerId: "controller-a",
    verifyPlanningFresh: verifiedPlanningFresh,
    acquireProjectLease: async ({ ownerId, projectId }) => {
      calls.push(`lease:acquire:${projectId}:${ownerId}`);
      return { ownerId, leaseId: "lease-a" };
    },
    heartbeatProjectLease: async ({ ownerId, leaseId }) => {
      calls.push(`lease:heartbeat:${ownerId}:${leaseId}`);
    },
    releaseProjectLease: async ({ ownerId, leaseId }) => {
      calls.push(`lease:release:${ownerId}:${leaseId}`);
      return true;
    },
    readControlState: async () => {
      const control = controls.shift() ?? { mode: "paused" };
      calls.push(`control:${control.mode}`);
      return control;
    },
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      return { tasks: { T035: { status: "running" } }, summary: { total: 1, running: 1 } };
    },
    runRunner: async () => {
      calls.push("runner");
      return {
        dryRun: false,
        spawn: { attempted: true, issueIds: ["T035"] },
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: { toLaunch: [{ id: "T035" }], skipped: [] },
      };
    },
    writeDashboard: async ({ supervision }) => {
      calls.push(`dashboard:${supervision.exitReason}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.equal(calls.filter((call) => call === "runner").length, 1);
  assert.deepEqual(calls, [
    "control:active",
    "lease:acquire:sample:controller-a",
    "ao",
    "observer",
    "control:active",
    "runner",
    "lease:heartbeat:controller-a:lease-a",
    "control:paused",
    "observer",
    "dashboard:paused",
    "lease:release:controller-a:lease-a",
  ]);
  assert.equal(result.supervision.exitReason, "paused");
  assert.equal(result.control.mode, "paused");
});

test("runDarkFactory re-reads control immediately before the initial runner", async () => {
  const runnerCalls = [];
  const controls = [{ mode: "active" }, { mode: "paused" }];

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    concurrency: 3,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    acquireProjectLease: async ({ ownerId }) => ({ ownerId, leaseId: "lease-initial" }),
    releaseProjectLease: async () => true,
    readControlState: async () => controls.shift() ?? { mode: "paused" },
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({ tasks: {}, summary: { total: 0 } }),
    runRunner: async (options) => {
      runnerCalls.push({ concurrency: options.concurrency, dryRun: options.dryRun });
      return {
        dryRun: options.dryRun,
        spawn: { attempted: false, issueIds: [] },
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: { toLaunch: [], skipped: [] },
      };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(runnerCalls, [{ concurrency: 0, dryRun: true }]);
  assert.equal(result.supervision.exitReason, "paused");
});

test("runDarkFactory honors a pause introduced after cleanup and before the next runner", async () => {
  const runnerCalls = [];
  let cleanupFinished = false;

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    concurrency: 3,
    cleanupCompletedSessions: false,
    maxAutonomousSupervisionPasses: 1,
    verifyPlanningFresh: verifiedPlanningFresh,
    acquireProjectLease: async ({ ownerId }) => ({ ownerId, leaseId: "lease-late-pause" }),
    heartbeatProjectLease: async () => true,
    releaseProjectLease: async () => true,
    readControlState: async () => ({ mode: cleanupFinished ? "paused" : "active" }),
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({
      tasks: { T035: { status: "running" } },
      summary: { total: 1, running: 1 },
    }),
    cleanupWorkspaceProcesses: async () => {
      cleanupFinished = true;
      return { attempted: true, killed: [], errors: [] };
    },
    runRunner: async (options) => {
      runnerCalls.push({ concurrency: options.concurrency, dryRun: options.dryRun });
      return {
        dryRun: options.dryRun,
        spawn: runnerCalls.length === 1
          ? { attempted: true, issueIds: ["T035"] }
          : { attempted: false, issueIds: [] },
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: { toLaunch: runnerCalls.length === 1 ? [{ id: "T035" }] : [], skipped: [] },
      };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(runnerCalls, [
    { concurrency: 3, dryRun: false },
    { concurrency: 0, dryRun: true },
  ]);
  assert.equal(result.supervision.exitReason, "paused");
});

test("runDarkFactory reports budget exhaustion when active work outlives the supervision limit", async () => {
  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    maxAutonomousSupervisionPasses: 0,
    verifyPlanningFresh: verifiedPlanningFresh,
    acquireProjectLease: async ({ ownerId }) => ({ ownerId, leaseId: "lease-a" }),
    releaseProjectLease: async () => true,
    readControlState: async () => ({ mode: "active" }),
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => ({
      tasks: { T035: { status: "running" } },
      summary: { total: 1, running: 1 },
    }),
    runRunner: async () => ({
      dryRun: false,
      spawn: { attempted: true, issueIds: ["T035"] },
      mergeQueue: { result: { attempted: false, actions: [] } },
      launchPlan: { toLaunch: [{ id: "T035" }], skipped: [] },
    }),
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.equal(result.supervision.exitReason, "budget_exhausted");
  assert.equal(result.runner.supervision, result.supervision);
});

test("runDarkFactory releases its lease and reports failed when orchestration throws", async () => {
  const calls = [];
  let persistedFailure = null;

  await assert.rejects(
    runDarkFactory({
      project: testProject,
      dryRun: false,
      cleanupCompletedSessions: false,
      leaseOwnerId: "controller-a",
      verifyPlanningFresh: verifiedPlanningFresh,
      acquireProjectLease: async ({ ownerId }) => {
        calls.push("acquire");
        return { ownerId, leaseId: "lease-a" };
      },
      releaseProjectLease: async ({ ownerId, leaseId }) => {
        calls.push(`release:${ownerId}:${leaseId}`);
        return true;
      },
      readControlState: async () => ({ mode: "active" }),
      writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
      runObserver: async () => ({ tasks: {}, summary: { total: 0 } }),
      runRunner: async () => {
        throw new Error("runner failed");
      },
      writeSupervisionFailureState: async (path, state) => {
        calls.push("persist-failure");
        persistedFailure = { path, state };
      },
    }),
    (error) => error?.message === "runner failed" && error?.supervision?.exitReason === "failed",
  );

  assert.deepEqual(calls, ["acquire", "persist-failure", "release:controller-a:lease-a"]);
  assert.equal(persistedFailure.state.projectId, "sample");
  assert.equal(persistedFailure.state.exitReason, "failed");
  assert.match(persistedFailure.path, /supervision-failure\.json$/);
});

test("runDarkFactory does not mask orchestration failures when failure persistence fails", async () => {
  await assert.rejects(
    runDarkFactory({
      project: testProject,
      dryRun: false,
      cleanupCompletedSessions: false,
      verifyPlanningFresh: verifiedPlanningFresh,
      acquireProjectLease: async ({ ownerId }) => ({ ownerId, leaseId: "lease-failure" }),
      releaseProjectLease: async () => true,
      readControlState: async () => ({ mode: "active" }),
      writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
      runObserver: async () => ({ tasks: {}, summary: { total: 0 } }),
      runRunner: async () => {
        throw new Error("original runner failure");
      },
      writeSupervisionFailureState: async () => {
        throw new Error("failure state disk error");
      },
    }),
    (error) => error?.message === "original runner failure"
      && error?.failureStatePersistenceError?.message === "failure state disk error",
  );
});

test("lease heartbeat guard coalesces timer pressure to one in-flight heartbeat and one pending heartbeat", async () => {
  const heartbeats = [];
  const timeoutCallbacks = new Map();
  let intervalCallback;
  let intervalClears = 0;
  let nextTimerId = 0;

  const guard = createLeaseHeartbeatGuard({
    leasePath: "/tmp/lease.json",
    lease: { ownerId: "controller-a", leaseId: "lease-a" },
    intervalMs: 10,
    timeoutMs: 30,
    heartbeatLease: async () => {
      const heartbeat = createDeferred();
      heartbeats.push(heartbeat);
      return heartbeat.promise;
    },
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn: () => {
      intervalClears += 1;
    },
    setTimeoutFn: (callback) => {
      const timerId = ++nextTimerId;
      timeoutCallbacks.set(timerId, callback);
      return timerId;
    },
    clearTimeoutFn: (timerId) => timeoutCallbacks.delete(timerId),
  });

  for (let index = 0; index < 100; index += 1) intervalCallback();
  await flushPromises();
  assert.equal(heartbeats.length, 1);

  heartbeats[0].resolve();
  await flushPromises();
  assert.equal(heartbeats.length, 2);

  for (let index = 0; index < 100; index += 1) intervalCallback();
  await flushPromises();
  assert.equal(heartbeats.length, 2);

  heartbeats[1].resolve();
  await flushPromises();
  assert.equal(heartbeats.length, 3);
  heartbeats[2].resolve();
  await guard.assertOwned();

  assert.equal(await guard.stop(), null);
  assert.equal(intervalClears, 1);
  assert.equal(timeoutCallbacks.size, 0);
});

test("lease heartbeat ownership assertion awaits one in-flight snapshot under sustained timer pressure", async () => {
  const heartbeats = [];
  const timeoutCallbacks = new Map();
  let intervalCallback;
  let nextTimerId = 0;

  const guard = createLeaseHeartbeatGuard({
    leasePath: "/tmp/lease.json",
    lease: { ownerId: "controller-a", leaseId: "lease-a" },
    intervalMs: 10,
    timeoutMs: 100,
    heartbeatLease: async () => {
      const heartbeat = createDeferred();
      heartbeats.push(heartbeat);
      return heartbeat.promise;
    },
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn: () => {},
    setTimeoutFn: (callback) => {
      const timerId = ++nextTimerId;
      timeoutCallbacks.set(timerId, callback);
      return timerId;
    },
    clearTimeoutFn: (timerId) => timeoutCallbacks.delete(timerId),
  });

  intervalCallback();
  for (let index = 0; index < 50; index += 1) intervalCallback();
  await flushPromises();
  assert.equal(heartbeats.length, 1);

  let assertionSettled = false;
  const ownershipAssertion = guard.assertOwned().then(() => {
    assertionSettled = true;
  });
  heartbeats[0].resolve();
  await flushPromises();
  assert.equal(heartbeats.length, 2);

  for (let index = 0; index < 50; index += 1) intervalCallback();
  await flushPromises();
  assert.equal(assertionSettled, true);
  await ownershipAssertion;

  heartbeats[1].resolve();
  await flushPromises();
  assert.equal(heartbeats.length, 3);
  heartbeats[2].resolve();
  assert.equal(await guard.stop(), null);
  assert.equal(timeoutCallbacks.size, 0);
});

test("lease heartbeat timeout normalization always stays below the stale lease threshold", () => {
  assert.equal(normalizeLeaseHeartbeatTimeoutMs(undefined, 120), 40);
  assert.equal(normalizeLeaseHeartbeatTimeoutMs(500, 120), 119);
  assert.throws(
    () => normalizeLeaseHeartbeatTimeoutMs(10, 1),
    /greater than one millisecond/,
  );
});

test("lease heartbeat guard stops within its heartbeat timeout when the heartbeat never settles", async () => {
  const timeoutCallbacks = new Map();
  let intervalCallback;
  let intervalClears = 0;
  let nextTimerId = 0;
  const heartbeat = createDeferred();

  const guard = createLeaseHeartbeatGuard({
    leasePath: "/tmp/lease.json",
    lease: { ownerId: "controller-a", leaseId: "lease-a" },
    intervalMs: 10,
    timeoutMs: 30,
    heartbeatLease: () => heartbeat.promise,
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn: () => {
      intervalClears += 1;
    },
    setTimeoutFn: (callback) => {
      const timerId = ++nextTimerId;
      timeoutCallbacks.set(timerId, callback);
      return timerId;
    },
    clearTimeoutFn: (timerId) => timeoutCallbacks.delete(timerId),
  });

  intervalCallback();
  await flushPromises();
  let stopSettled = false;
  const stopPromise = guard.stop().then((error) => {
    stopSettled = true;
    return error;
  });
  await flushPromises();
  assert.equal(stopSettled, false);
  assert.equal(timeoutCallbacks.size, 1);

  [...timeoutCallbacks.values()][0]();
  const timeoutError = await stopPromise;
  assert.equal(timeoutError?.code, "DARK_FACTORY_LEASE_HEARTBEAT_TIMEOUT");
  assert.equal(intervalClears, 1);
  assert.equal(timeoutCallbacks.size, 0);

  heartbeat.reject(new Error("late heartbeat rejection"));
  await flushPromises();
});

test("runDarkFactory keeps orchestration failure primary when a heartbeat times out", async () => {
  const originalError = new Error("observer failed");
  const timeoutCallbacks = new Map();
  let intervalCallback;
  let nextTimerId = 0;

  await assert.rejects(
    runDarkFactory({
      project: testProject,
      dryRun: false,
      cleanupCompletedSessions: false,
      leaseStaleAfterMs: 100,
      leaseHeartbeatIntervalMs: 10,
      leaseHeartbeatTimeoutMs: 30,
      verifyPlanningFresh: verifiedPlanningFresh,
      acquireProjectLease: async ({ ownerId }) => ({ ownerId, leaseId: "lease-timeout-precedence" }),
      heartbeatProjectLease: () => new Promise(() => {}),
      releaseProjectLease: async () => true,
      readControlState: async () => ({ mode: "active" }),
      writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
      runObserver: async () => {
        intervalCallback();
        await flushPromises();
        throw originalError;
      },
      runRunner: async () => ({ dryRun: false, launchPlan: { toLaunch: [], skipped: [] } }),
      writeSupervisionFailureState: async () => {},
      setLeaseHeartbeatInterval: (callback) => {
        intervalCallback = callback;
        return { unref() {} };
      },
      clearLeaseHeartbeatInterval: () => {},
      setLeaseHeartbeatTimeout: (callback) => {
        const timerId = ++nextTimerId;
        timeoutCallbacks.set(timerId, callback);
        queueMicrotask(callback);
        return timerId;
      },
      clearLeaseHeartbeatTimeout: (timerId) => timeoutCallbacks.delete(timerId),
    }),
    (error) => error === originalError
      && error.leaseOwnershipError?.code === "DARK_FACTORY_LEASE_HEARTBEAT_TIMEOUT",
  );
});

test("runDarkFactory heartbeats throughout a long external operation and stops the timer on exit", async () => {
  let observerActive = false;
  let heartbeatCount = 0;
  let heartbeatsDuringObserver = 0;

  await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    leaseHeartbeatIntervalMs: 5,
    verifyPlanningFresh: verifiedPlanningFresh,
    acquireProjectLease: async ({ ownerId }) => ({ ownerId, leaseId: "lease-long-operation" }),
    heartbeatProjectLease: async () => {
      heartbeatCount += 1;
      if (observerActive) heartbeatsDuringObserver += 1;
    },
    releaseProjectLease: async () => true,
    readControlState: async () => ({ mode: "active" }),
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => {
      observerActive = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      observerActive = false;
      return { tasks: {}, summary: { total: 0 } };
    },
    runRunner: async () => ({
      dryRun: false,
      spawn: { attempted: false, issueIds: [] },
      mergeQueue: { result: { attempted: false, actions: [] } },
      launchPlan: { toLaunch: [], skipped: [] },
    }),
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.ok(heartbeatsDuringObserver >= 2);
  const countAfterExit = heartbeatCount;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(heartbeatCount, countAfterExit);
});

test("runDarkFactory aborts subsequent external side effects after lease ownership is lost", async () => {
  let observerActive = false;
  let runnerCalls = 0;
  let dashboardCalls = 0;
  let failureWrites = 0;
  const ownershipError = Object.assign(new Error("lease replaced"), {
    code: "DARK_FACTORY_LEASE_NOT_OWNER",
  });

  await assert.rejects(
    runDarkFactory({
      project: testProject,
      dryRun: false,
      cleanupCompletedSessions: false,
      leaseHeartbeatIntervalMs: 5,
      verifyPlanningFresh: verifiedPlanningFresh,
      acquireProjectLease: async ({ ownerId }) => ({ ownerId, leaseId: "lease-lost" }),
      heartbeatProjectLease: async () => {
        if (observerActive) throw ownershipError;
      },
      releaseProjectLease: async () => true,
      readControlState: async () => ({ mode: "active" }),
      writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
      runObserver: async () => {
        observerActive = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
        observerActive = false;
        return { tasks: {}, summary: { total: 0 } };
      },
      runRunner: async () => {
        runnerCalls += 1;
        return { dryRun: false, launchPlan: { toLaunch: [], skipped: [] } };
      },
      writeDashboard: async () => {
        dashboardCalls += 1;
        return { outputPath: "/tmp/sample.html" };
      },
      writeSupervisionFailureState: async () => {
        failureWrites += 1;
      },
    }),
    (error) => error === ownershipError,
  );

  assert.equal(runnerCalls, 0);
  assert.equal(dashboardCalls, 0);
  assert.equal(failureWrites, 0);
});

test("runDarkFactory keeps the original failure primary when heartbeat ownership and release also fail", async () => {
  let observerActive = false;
  const originalError = new Error("observer failed");
  const ownershipError = Object.assign(new Error("lease replaced"), {
    code: "DARK_FACTORY_LEASE_NOT_OWNER",
  });
  const releaseError = new Error("release failed");

  await assert.rejects(
    runDarkFactory({
      project: testProject,
      dryRun: false,
      cleanupCompletedSessions: false,
      leaseHeartbeatIntervalMs: 5,
      verifyPlanningFresh: verifiedPlanningFresh,
      acquireProjectLease: async ({ ownerId }) => ({ ownerId, leaseId: "lease-original-error" }),
      heartbeatProjectLease: async () => {
        if (observerActive) throw ownershipError;
      },
      releaseProjectLease: async () => {
        throw releaseError;
      },
      readControlState: async () => ({ mode: "active" }),
      writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
      runObserver: async () => {
        observerActive = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw originalError;
      },
      runRunner: async () => ({ dryRun: false, launchPlan: { toLaunch: [], skipped: [] } }),
      writeSupervisionFailureState: async () => {},
    }),
    (error) => error === originalError
      && error.leaseOwnershipError === ownershipError
      && error.leaseReleaseError === releaseError,
  );
});

test("runDarkFactory continues autonomously after resuming a failed worker", async () => {
  const calls = [];
  const beforeRecovery = { tasks: { T026: { status: "failed" } }, summary: { total: 1, failed: 1 } };
  const afterRecovery = {
    tasks: { T026: { status: "ready" } },
    sessions: [{ id: "sample-26", issueId: "T026", observableStatus: "ready", workspacePath: "/tmp/t026" }],
    summary: { total: 1, ready: 1 },
  };
  const afterMerge = { tasks: { T026: { status: "merged" } }, summary: { total: 1, merged: 1 } };

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    maxAutonomousRecoveryPasses: 2,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      const count = calls.filter((call) => call === "observer").length;
      if (count === 1) return beforeRecovery;
      if (count === 2) return afterRecovery;
      return afterMerge;
    },
    runRunner: async ({ observabilityState }) => {
      calls.push(`runner:${observabilityState.summary.ready ?? 0}:${observabilityState.summary.failed ?? 0}`);
      if ((observabilityState.summary.failed ?? 0) > 0) {
        return {
          dryRun: false,
          resume: { attempted: true, issueIds: ["T026"] },
          spawn: { attempted: false, issueIds: [] },
          mergeQueue: { result: { attempted: false, actions: [] } },
          launchPlan: { toResume: [{ id: "T026", sessionId: "sample-26" }], toLaunch: [], skipped: [] },
        };
      }

      return {
        dryRun: false,
        resume: { attempted: false, issueIds: [] },
        spawn: { attempted: false, issueIds: [] },
        mergeQueue: {
          result: {
            attempted: true,
            actions: [{ action: "finalize", issueId: "T026" }],
          },
        },
        launchPlan: { toResume: [], toLaunch: [], skipped: [] },
      };
    },
    cleanupWorkspaceProcesses: async ({ observability }) => {
      calls.push(`workspace-cleanup:${observability.summary.ready ?? 0}`);
      return {
        attempted: true,
        killed: observability.summary.ready ? [{ pid: 123, workspacePath: "/tmp/t026" }] : [],
        errors: [],
      };
    },
    writeDashboard: async ({ observability, runner }) => {
      calls.push(`dashboard:${observability.summary.merged ?? 0}:${runner.mergeQueue.result.attempted}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao",
    "observer",
    "runner:0:1",
    "observer",
    "workspace-cleanup:1",
    "runner:1:0",
    "observer",
    "workspace-cleanup:0",
    "dashboard:1:true",
  ]);
  assert.equal(result.observability, afterMerge);
  assert.equal(result.runner.mergeQueue.result.attempted, true);
  assert.equal(result.workspaceCleanup.killed.length, 1);
});

test("runDarkFactory keeps supervising active workers after a successful merge queue pass", async () => {
  const calls = [];
  const readyAndRunning = {
    tasks: {
      T029: { status: "ready_to_merge" },
      T036: { status: "running" },
    },
    sessions: [
      { id: "sample-29", issueId: "T029", observableStatus: "ready_to_merge", workspacePath: "/tmp/t029" },
      { id: "sample-36", issueId: "T036", observableStatus: "running", workspacePath: "/tmp/t036" },
    ],
    summary: { total: 2, ready_to_merge: 1, running: 1 },
  };
  const mergedAndRunning = {
    tasks: {
      T029: { status: "merged" },
      T036: { status: "running" },
    },
    sessions: [{ id: "sample-36", issueId: "T036", observableStatus: "running", workspacePath: "/tmp/t036" }],
    summary: { total: 2, merged: 1, running: 1 },
  };
  const mergedAndReady = {
    tasks: {
      T029: { status: "merged" },
      T036: { status: "ready_to_merge" },
    },
    sessions: [{ id: "sample-36", issueId: "T036", observableStatus: "ready_to_merge", workspacePath: "/tmp/t036" }],
    summary: { total: 2, merged: 1, ready_to_merge: 1 },
  };
  const allMerged = {
    tasks: {
      T029: { status: "merged" },
      T036: { status: "merged" },
    },
    summary: { total: 2, merged: 2 },
  };
  const observations = [readyAndRunning, mergedAndRunning, mergedAndReady, allMerged];

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => {
      calls.push("observer");
      return observations.shift() ?? allMerged;
    },
    runRunner: async ({ observabilityState }) => {
      calls.push(`runner:${observabilityState.summary.ready_to_merge ?? 0}:${observabilityState.summary.running ?? 0}`);
      if ((observabilityState.summary.ready_to_merge ?? 0) > 0) {
        return {
          dryRun: false,
          spawn: { attempted: false, issueIds: [] },
          resume: { attempted: false, issueIds: [] },
          mergeQueue: {
            result: {
              attempted: true,
              actions: [{ action: "finalize", issueId: observabilityState.tasks.T029?.status === "ready_to_merge" ? "T029" : "T036" }],
            },
          },
          launchPlan: { toLaunch: [], toResume: [], skipped: [] },
        };
      }

      return {
        dryRun: false,
        spawn: { attempted: false, issueIds: [] },
        resume: { attempted: false, issueIds: [] },
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: { toLaunch: [], toResume: [], skipped: [] },
      };
    },
    cleanupWorkspaceProcesses: async ({ observability }) => {
      calls.push(`workspace-cleanup:${observability.summary.ready_to_merge ?? 0}:${observability.summary.running ?? 0}`);
      return { attempted: true, killed: [], errors: [] };
    },
    writeDashboard: async ({ observability, runner }) => {
      calls.push(`dashboard:${observability.summary.merged ?? 0}:${runner.mergeQueue.result.attempted}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "observer",
    "runner:1:1",
    "observer",
    "workspace-cleanup:0:1",
    "runner:0:1",
    "observer",
    "workspace-cleanup:1:0",
    "runner:1:0",
    "observer",
    "workspace-cleanup:0:0",
    "dashboard:2:true",
  ]);
  assert.equal(result.observability, allMerged);
  assert.equal(result.runner.mergeQueue.result.actions[0].issueId, "T036");
});

test("runDarkFactory runs a terminal merge pass when the final observation discovers ready work", async () => {
  const calls = [];
  const running = { tasks: { T036: { status: "running" } }, summary: { total: 1, running: 1 } };
  const ready = {
    tasks: { T036: { status: "ready_to_merge" } },
    sessions: [{ id: "sample-36", issueId: "T036", observableStatus: "ready_to_merge", workspacePath: "/tmp/t036" }],
    summary: { total: 1, ready_to_merge: 1 },
  };
  const afterMerge = { tasks: { T036: { status: "merged" } }, summary: { total: 1, merged: 1 } };

  const observations = [running, ready, afterMerge];
  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      return observations.shift() ?? afterMerge;
    },
    runRunner: async ({ observabilityState, recoverOnly, taskLimit }) => {
      calls.push(`runner:${observabilityState.summary.ready_to_merge ?? 0}:${observabilityState.summary.running ?? 0}:recover=${recoverOnly}:limit=${taskLimit}`);
      if ((observabilityState.summary.ready_to_merge ?? 0) > 0) {
        return {
          dryRun: false,
          spawn: { attempted: false, issueIds: [] },
          resume: { attempted: false, issueIds: [] },
          mergeQueue: {
            result: {
              attempted: true,
              actions: [{ action: "finalize", issueId: "T036" }],
            },
          },
          launchPlan: { toLaunch: [], toResume: [], skipped: [] },
        };
      }

      return {
        dryRun: false,
        spawn: { attempted: false, issueIds: [] },
        resume: { attempted: false, issueIds: [] },
        mergeQueue: { result: { attempted: false, actions: [] } },
        launchPlan: { toLaunch: [], toResume: [], skipped: [] },
      };
    },
    cleanupWorkspaceProcesses: async ({ observability }) => {
      calls.push(`workspace-cleanup:${observability.summary.ready_to_merge ?? 0}:${observability.summary.merged ?? 0}`);
      return { attempted: true, killed: [], errors: [] };
    },
    writeDashboard: async ({ observability, runner }) => {
      calls.push(`dashboard:${observability.summary.merged ?? 0}:${runner.mergeQueue.result.attempted}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao",
    "observer",
    "runner:0:1:recover=undefined:limit=undefined",
    "observer",
    "workspace-cleanup:1:0",
    "runner:1:0:recover=undefined:limit=undefined",
    "observer",
    "workspace-cleanup:0:1",
    "dashboard:1:true",
  ]);
  assert.equal(result.observability, afterMerge);
  assert.equal(result.runner.mergeQueue.result.attempted, true);
});

test("runDarkFactory terminal merge pass handles in_review work without launching or resuming", async () => {
  const calls = [];
  const running = { tasks: { T037: { status: "running" } }, summary: { total: 1, running: 1 } };
  const inReview = {
    tasks: { T037: { status: "in_review" } },
    sessions: [{ id: "sample-37", issueId: "T037", observableStatus: "in_review", workspacePath: "/tmp/t037" }],
    summary: { total: 1, in_review: 1 },
  };

  await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    maxAutonomousSupervisionPasses: 1,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => {
      calls.push("observer");
      return calls.filter((call) => call === "observer").length === 1 ? running : inReview;
    },
    runRunner: async ({ observabilityState, recoverOnly, taskLimit }) => {
      calls.push(`runner:${observabilityState.summary.in_review ?? 0}:${observabilityState.summary.running ?? 0}:recover=${recoverOnly}:limit=${taskLimit}`);
      return {
        dryRun: false,
        spawn: { attempted: false, issueIds: [] },
        resume: { attempted: false, issueIds: [] },
        mergeQueue: {
          result: {
            attempted: (observabilityState.summary.in_review ?? 0) > 0,
            actions: (observabilityState.summary.in_review ?? 0) > 0
              ? [{ action: "prepare", issueId: "T037" }]
              : [],
          },
        },
        launchPlan: { toLaunch: [], toResume: [], skipped: [] },
      };
    },
    cleanupWorkspaceProcesses: async ({ observability }) => {
      calls.push(`workspace-cleanup:${observability.summary.in_review ?? 0}`);
      return { attempted: true, killed: [], errors: [] };
    },
    writeDashboard: async ({ runner }) => {
      calls.push(`dashboard:${runner.mergeQueue.result.attempted}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "observer",
    "runner:0:1:recover=undefined:limit=undefined",
    "observer",
    "workspace-cleanup:1",
    "runner:1:0:recover=undefined:limit=undefined",
    "observer",
    "workspace-cleanup:1",
    "dashboard:true",
  ]);
});

test("cleanupTerminalWorkspaceProcesses stops processes inside terminal worker workspaces", async () => {
  const killed = [];
  const result = await cleanupTerminalWorkspaceProcesses({
    observability: {
      sessions: [
        { id: "sample-8", issueId: "T008", observableStatus: "failed", workspacePath: "/tmp/worktrees/easygen-8" },
        { id: "sample-9", issueId: "T009", observableStatus: "running", workspacePath: "/tmp/worktrees/easygen-9" },
        { id: "sample-10", issueId: "T010", observableStatus: "ready", workspacePath: "/tmp/worktrees/easygen-10" },
        { id: "sample-11", issueId: "T011", observableStatus: "killed", workspacePath: "/tmp/worktrees/easygen-11" },
      ],
    },
    listWorkspaceProcesses: async (workspacePath) => {
      if (workspacePath.endsWith("easygen-8")) {
        return [{ pid: 111, cwd: "/tmp/worktrees/easygen-8/apps/api", command: "tsx watch src/main.ts" }];
      }
      if (workspacePath.endsWith("easygen-11")) {
        return [{ pid: 333, cwd: "/tmp/worktrees/easygen-11/apps/web", command: "vite" }];
      }
      return [{ pid: 222, cwd: "/tmp/worktrees/easygen-10/apps/web", command: "vite" }];
    },
    killProcess: async (pid, signal) => killed.push(`${pid}:${signal}`),
  });

  assert.deepEqual(killed, ["111:SIGTERM", "222:SIGTERM", "333:SIGTERM"]);
  assert.deepEqual(
    result.killed.map((processInfo) => [processInfo.sessionId, processInfo.pid]),
    [
      ["sample-8", 111],
      ["sample-10", 222],
      ["sample-11", 333],
    ],
  );
});

test("cleanupTerminalWorkspaceProcesses keeps scoped active sessions running by default", async () => {
  const killed = [];
  const result = await cleanupTerminalWorkspaceProcesses({
    sessionIds: ["sample-9"],
    observability: {
      sessions: [
        { id: "sample-8", issueId: "T008", observableStatus: "failed", workspacePath: "/tmp/worktrees/sample-8" },
        { id: "sample-9", issueId: "T009", observableStatus: "working", workspacePath: "/tmp/worktrees/sample-9" },
      ],
    },
    listWorkspaceProcesses: async () => [{ pid: 222, cwd: "/tmp/worktrees/sample-9/apps/web", command: "vite" }],
    killProcess: async (pid, signal) => killed.push(`${pid}:${signal}`),
  });

  assert.deepEqual(killed, []);
  assert.equal(result.workspaceCount, 0);
  assert.deepEqual(result.killed, []);
});

test("cleanupTerminalWorkspaceProcesses can explicitly target preserved sessions regardless of status", async () => {
  const killed = [];
  const result = await cleanupTerminalWorkspaceProcesses({
    sessionIds: ["sample-9"],
    includeNonTerminal: true,
    observability: {
      sessions: [
        { id: "sample-8", issueId: "T008", observableStatus: "failed", workspacePath: "/tmp/worktrees/sample-8" },
        { id: "sample-9", issueId: "T009", observableStatus: "working", workspacePath: "/tmp/worktrees/sample-9" },
      ],
    },
    listWorkspaceProcesses: async () => [{ pid: 222, cwd: "/tmp/worktrees/sample-9/apps/web", command: "vite" }],
    killProcess: async (pid, signal) => killed.push(`${pid}:${signal}`),
  });

  assert.deepEqual(killed, ["222:SIGTERM"]);
  assert.equal(result.workspaceCount, 1);
  assert.equal(result.killed[0].sessionId, "sample-9");
});

test("cleanupCompletedWorkspaceResources previews configured commands for completed workspaces", async () => {
  const calls = [];

  const result = await cleanupCompletedWorkspaceResources({
    project: {
      ...testProject,
      cleanup: { commands: ["pnpm wtc down --volumes"] },
    },
    dryRun: true,
    observability: {
      sessions: [
        { id: "sample-8", issueId: "T008", observableStatus: "running", workspacePath: "/tmp/worktrees/sample-8" },
        { id: "sample-9", issueId: "T009", observableStatus: "ready", workspacePath: "/tmp/worktrees/sample-9" },
        { id: "sample-10", issueId: "T010", observableStatus: "merged", workspacePath: "/tmp/worktrees/sample-10" },
        { id: "sample-11", issueId: "T011", observableStatus: "done", workspacePath: "/tmp/worktrees/sample-11" },
        { id: "sample-12", issueId: "T012", observableStatus: "killed", workspacePath: "/tmp/worktrees/sample-12" },
      ],
    },
    execFileAsync: async (file, args) => {
      calls.push(`${file}:${args[0]}`);
      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(calls, ["docker:ps", "docker:ps", "docker:ps"]);
  assert.equal(result.attempted, true);
  assert.equal(result.workspaceCount, 3);
  assert.deepEqual(
    result.skipped
      .filter((entry) => entry.command)
      .map((entry) => [entry.issueId, entry.command, entry.reason]),
    [
      ["T010", "pnpm wtc down --volumes", "dry_run"],
      ["T011", "pnpm wtc down --volumes", "dry_run"],
      ["T012", "pnpm wtc down --volumes", "dry_run"],
    ],
  );
});

test("runDarkFactory preserves ready PR worktrees and resources", async () => {
  const calls = [];
  const readyObservability = {
    tasks: {
      T022: {
        status: "ready",
        sessions: [
          {
            id: "sample-22",
            issueId: "T022",
            observableStatus: "ready",
            workspacePath: "/tmp/worktrees/sample-22",
          },
        ],
      },
    },
    sessions: [
      {
        id: "sample-22",
        issueId: "T022",
        observableStatus: "ready",
        workspacePath: "/tmp/worktrees/sample-22",
      },
    ],
    summary: { total: 1, ready: 1 },
  };

  const result = await runDarkFactory({
    project: {
      ...testProject,
      cleanup: { commands: ["pnpm wtc down --volumes"] },
    },
    dryRun: false,
    cleanupCompletedSessions: true,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    cleanupStaleAoOrchestrators: async () => {
      calls.push("orchestrator-cleanup");
      return { projectId: "sample", dryRun: false, killed: [], skipped: [] };
    },
    runObserver: async () => {
      calls.push("observer");
      return readyObservability;
    },
    runRunner: async () => {
      calls.push("runner");
      return {
        dryRun: false,
        mergeQueue: {
          result: {
            attempted: true,
            actions: [],
            blocked: { issueId: "T022", reason: "waiting for merge window" },
          },
        },
        launchPlan: { toLaunch: [], skipped: [] },
      };
    },
    cleanupWorkspaceProcesses: async ({ observability }) => {
      calls.push(`process-cleanup:${observability.summary.ready}`);
      return { attempted: true, dryRun: false, workspaceCount: 1, killed: [], skipped: [], errors: [] };
    },
    cleanupWorkspaceBrowsers: async () => {
      calls.push("browser-cleanup");
      return { attempted: false, dryRun: false, workspaceCount: 0, cleaned: [], skipped: [], errors: [] };
    },
    cleanupWorkspaceResources: async () => {
      calls.push("resource-cleanup");
      return { attempted: false, dryRun: false, workspaceCount: 0, commandCount: 0, cleaned: [], skipped: [], errors: [] };
    },
    cleanupAoSessions: async () => {
      calls.push("ao-cleanup");
      return { projectId: "sample", dryRun: false };
    },
    writeDashboard: async () => {
      calls.push("dashboard");
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "ao",
    "orchestrator-cleanup",
    "observer",
    "runner",
    "observer",
    "process-cleanup:1",
    "browser-cleanup",
    "resource-cleanup",
    "dashboard",
  ]);
  assert.equal(result.observedCompletionCleanup, null);
});

test("runDarkFactory cleans browser and resource residue for failed or killed sessions without AO cleanup", async () => {
  const calls = [];
  const terminalObservability = {
    tasks: {
      T023: { status: "failed" },
      T024: { status: "killed" },
    },
    sessions: [
      {
        id: "sample-23",
        issueId: "T023",
        observableStatus: "failed",
        workspacePath: "/tmp/worktrees/sample-23",
      },
      {
        id: "sample-24",
        issueId: "T024",
        observableStatus: "killed",
        workspacePath: "/tmp/worktrees/sample-24",
      },
    ],
    summary: { total: 2, failed: 1, killed: 1 },
  };

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: true,
    verifyPlanningFresh: verifiedPlanningFresh,
    readControlState: async () => ({ mode: "active" }),
    acquireProjectLease: async ({ ownerId }) => ({ ownerId, leaseId: "lease-terminal-cleanup" }),
    heartbeatProjectLease: async () => true,
    releaseProjectLease: async () => true,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    cleanupStaleAoOrchestrators: async () => ({ killed: [], skipped: [], errors: [] }),
    runObserver: async () => terminalObservability,
    runRunner: async () => ({
      dryRun: false,
      runLedger: activeRunLedger("T023", "T024"),
      launchPlan: { toLaunch: [], skipped: [] },
    }),
    cleanupWorkspaceBrowsers: async ({ observability }) => {
      calls.push(`browser:${observability.summary.failed}:${observability.summary.killed}`);
      return {
        attempted: true,
        dryRun: false,
        workspaceCount: 2,
        cleaned: [{ issueId: "T023" }],
        skipped: [],
        errors: [{ issueId: "T024", kind: "browser", error: "browser still running" }],
      };
    },
    cleanupWorkspaceResources: async ({ observability }) => {
      calls.push(`resource:${observability.summary.failed}:${observability.summary.killed}`);
      return {
        attempted: true,
        dryRun: false,
        workspaceCount: 2,
        commandCount: 0,
        cleaned: [{ issueId: "T024" }],
        skipped: [],
        errors: [{ issueId: "T023", kind: "docker_compose", error: "volume is busy" }],
      };
    },
    cleanupMergedBranches: async () => {
      calls.push("branch-cleanup");
      return { deleted: [], skipped: [], errors: [] };
    },
    cleanupAoSessions: async () => {
      calls.push("ao-cleanup");
      return { killed: [], skipped: [], errors: [] };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, ["browser:1:1", "resource:1:1"]);
  assert.deepEqual(result.browserCleanup.errors, [
    { issueId: "T024", kind: "browser", error: "browser still running" },
  ]);
  assert.deepEqual(result.resourceCleanup.errors, [
    { issueId: "T023", kind: "docker_compose", error: "volume is busy" },
  ]);
  assert.equal(result.observedCompletionCleanup, null);
  assert.equal(result.observedCompletionBranchCleanup, null);
});

test("runDarkFactory retries failed terminal cleanup on a later invocation of the active run", async () => {
  const terminalObservability = {
    tasks: { T025: { status: "failed" } },
    sessions: [
      {
        id: "sample-25",
        issueId: "T025",
        observableStatus: "failed",
        workspacePath: "/tmp/worktrees/sample-25",
      },
    ],
    summary: { total: 1, failed: 1 },
  };
  let browserAttempts = 0;
  let resourceAttempts = 0;
  const options = {
    project: testProject,
    runLedger: activeRunLedger("T025"),
    dryRun: false,
    cleanupCompletedSessions: true,
    verifyPlanningFresh: verifiedPlanningFresh,
    readControlState: async () => ({ mode: "active" }),
    acquireProjectLease: async ({ ownerId }) => ({ ownerId, leaseId: `lease-${ownerId}` }),
    heartbeatProjectLease: async () => true,
    releaseProjectLease: async () => true,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    cleanupStaleAoOrchestrators: async () => ({ killed: [], skipped: [], errors: [] }),
    runObserver: async () => terminalObservability,
    runRunner: async () => ({ dryRun: false, launchPlan: { toLaunch: [], skipped: [] } }),
    cleanupWorkspaceProcesses: async () => ({ attempted: false, killed: [], skipped: [], errors: [] }),
    cleanupWorkspaceBrowsers: async () => {
      browserAttempts += 1;
      return {
        attempted: true,
        dryRun: false,
        workspaceCount: 1,
        cleaned: browserAttempts > 1 ? [{ issueId: "T025" }] : [],
        skipped: [],
        errors: browserAttempts === 1 ? [{ issueId: "T025", reason: "browser_busy", error: "busy" }] : [],
      };
    },
    cleanupWorkspaceResources: async () => {
      resourceAttempts += 1;
      return {
        attempted: true,
        dryRun: false,
        workspaceCount: 1,
        commandCount: 0,
        cleaned: resourceAttempts > 1 ? [{ issueId: "T025" }] : [],
        skipped: [],
        errors: resourceAttempts === 1 ? [{ issueId: "T025", reason: "resources_remaining", error: "busy" }] : [],
      };
    },
    cleanupMergedBranches: async () => {
      throw new Error("failed-only cleanup must not delete branches");
    },
    cleanupAoSessions: async () => {
      throw new Error("failed-only cleanup must not delete AO worktrees");
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  };

  const first = await runDarkFactory(options);
  const second = await runDarkFactory(options);

  assert.equal(browserAttempts, 2);
  assert.equal(resourceAttempts, 2);
  assert.equal(first.browserCleanup.errors[0].reason, "browser_busy");
  assert.equal(first.resourceCleanup.errors[0].reason, "resources_remaining");
  assert.deepEqual(second.browserCleanup.errors, []);
  assert.deepEqual(second.resourceCleanup.errors, []);
  assert.deepEqual(second.browserCleanup.cleaned, [{ issueId: "T025" }]);
  assert.deepEqual(second.resourceCleanup.cleaned, [{ issueId: "T025" }]);
});

test("cleanupCompletedWorkspaceResources keeps long Compose identities unique by session", async () => {
  const composeNames = [];
  const longProject = {
    ...testProject,
    id: `project-${"same-prefix".repeat(10)}`,
  };

  const result = await cleanupCompletedWorkspaceResources({
    project: longProject,
    observability: {
      sessions: [
        { id: "sample-10", issueId: "T010", observableStatus: "failed", workspacePath: "/tmp/worktrees/sample-10" },
        { id: "sample-11", issueId: "T011", observableStatus: "killed", workspacePath: "/tmp/worktrees/sample-11" },
      ],
    },
    execFileAsync: async (_file, args) => {
      const filter = args.find((arg) => arg.startsWith("label=com.docker.compose.project="));
      if (args[0] === "ps" && filter) composeNames.push(filter.slice("label=com.docker.compose.project=".length));
      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(composeNames.length, 2);
  assert.equal(new Set(composeNames).size, 2);
  assert.ok(composeNames.every((name) => name.length <= 63));
  assert.match(composeNames[0], /-sample-10-[a-f0-9]{10}$/);
  assert.match(composeNames[1], /-sample-11-[a-f0-9]{10}$/);
});

test("cleanupCompletedWorkspaceResources reports failed post-compose verification as errors only", async () => {
  let removing = false;

  const result = await cleanupCompletedWorkspaceResources({
    project: testProject,
    observability: {
      sessions: [
        { id: "sample-10", issueId: "T010", observableStatus: "failed", workspacePath: "/tmp/worktrees/sample-10" },
      ],
    },
    execFileAsync: async (_file, args) => {
      if (args.includes("label=com.docker.compose.project.working_dir=/tmp/worktrees/sample-10")) {
        return { stdout: "legacy-compose\n", stderr: "" };
      }
      if (args[0] === "compose") return { stdout: "removed", stderr: "" };
      if (args.includes("label=com.docker.compose.project=legacy-compose")) {
        if (removing && args[0] === "ps") throw new Error("verification unavailable");
        return { stdout: args[0] === "ps" ? "container-1\n" : "", stderr: "" };
      }
      if (args[0] === "rm") {
        removing = true;
        return { stdout: "removed", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(result.cleaned, []);
  assert.deepEqual(result.errors.map((error) => error.reason), ["resource_verification_failed"]);
  assert.equal(result.errors[0].issueId, "T010");
  assert.equal(result.errors[0].composeProject, "legacy-compose");
});

test("cleanupCompletedWorkspaceResources preserves structured retry errors for every resource failure stage", async (t) => {
  const candidate = {
    id: "sample-10",
    issueId: "T010",
    observableStatus: "failed",
    workspacePath: "/tmp/worktrees/sample-10",
  };
  const runCleanup = (execFileAsync) => cleanupCompletedWorkspaceResources({
    project: testProject,
    observability: { sessions: [candidate] },
    execFileAsync,
  });

  await t.test("discovery", async () => {
    const result = await runCleanup(async (_file, args) => {
      if (args.includes("label=com.docker.compose.project.working_dir=/tmp/worktrees/sample-10")) {
        throw new Error("Docker unavailable");
      }
      return { stdout: "", stderr: "" };
    });

    assert.deepEqual(result.cleaned, []);
    assert.equal(result.errors[0].reason, "compose_discovery_failed");
    assert.equal(result.errors[0].issueId, "T010");
    assert.equal(result.errors[0].workspacePath, candidate.workspacePath);
  });

  await t.test("removal", async () => {
    let removalAttempted = false;
    const result = await runCleanup(async (_file, args) => {
      if (args.includes("label=com.docker.compose.project.working_dir=/tmp/worktrees/sample-10")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("label=com.docker.compose.project=df-sample-sample-10")) {
        return { stdout: !removalAttempted && args[0] === "ps" ? "container-1\n" : "", stderr: "" };
      }
      if (args[0] === "rm") {
        removalAttempted = true;
        throw new Error("container busy");
      }
      return { stdout: "", stderr: "" };
    });

    assert.deepEqual(result.cleaned, []);
    assert.equal(result.errors[0].reason, "resource_removal_failed");
    assert.equal(result.errors[0].resource, "containers");
    assert.deepEqual(result.errors[0].resources, ["container-1"]);
  });

  await t.test("verification", async () => {
    let verifying = false;
    const result = await runCleanup(async (_file, args) => {
      if (args.includes("label=com.docker.compose.project.working_dir=/tmp/worktrees/sample-10")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("label=com.docker.compose.project=df-sample-sample-10")) {
        if (verifying && args[0] === "ps") throw new Error("verification unavailable");
        return { stdout: args[0] === "ps" ? "container-1\n" : "", stderr: "" };
      }
      if (args[0] === "rm") {
        verifying = true;
        return { stdout: "removed", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    assert.deepEqual(result.cleaned, []);
    assert.equal(result.errors[0].reason, "resource_verification_failed");
  });

  await t.test("remaining residue", async () => {
    const result = await runCleanup(async (_file, args) => {
      if (args.includes("label=com.docker.compose.project.working_dir=/tmp/worktrees/sample-10")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("label=com.docker.compose.project=df-sample-sample-10")) {
        return { stdout: args[0] === "network" ? "network-1\n" : "", stderr: "" };
      }
      return { stdout: "removed", stderr: "" };
    });

    assert.deepEqual(result.cleaned, []);
    assert.equal(result.errors[0].reason, "resources_remaining");
    assert.deepEqual(result.errors[0].remaining.networks, ["network-1"]);
  });
});

test("cleanupCompletedWorkspaceResources tears down docker compose projects by working_dir label", async () => {
  const calls = [];

  const result = await cleanupCompletedWorkspaceResources({
    project: testProject,
    observability: {
      sessions: [
        { id: "sample-10", issueId: "T010", observableStatus: "merged", workspacePath: "/tmp/worktrees/sample-10" },
      ],
    },
    execFileAsync: async (file, args, options = {}) => {
      calls.push({ file, args, cwd: options.cwd });
      if (args[0] === "ps" && args.includes("label=com.docker.compose.project.working_dir=/tmp/worktrees/sample-10")) {
        return { stdout: "sample-wt-1\n", stderr: "" };
      }
      return { stdout: args[0] === "compose" ? "removed" : "", stderr: "" };
    },
  });

  assert.deepEqual(calls, [
    {
      file: "docker",
      args: ["ps", "-a", "--filter", "label=com.docker.compose.project.working_dir=/tmp/worktrees/sample-10", "--format", "{{.Label \"com.docker.compose.project\"}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["compose", "-p", "sample-wt-1", "down", "-v", "--remove-orphans"],
      cwd: "/tmp/worktrees/sample-10",
    },
    {
      file: "docker",
      args: ["ps", "-a", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.ID}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["volume", "ls", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.Name}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["network", "ls", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.Name}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["ps", "-a", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.ID}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["volume", "ls", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.Name}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["network", "ls", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.Name}}"],
      cwd: undefined,
    },
  ]);
  assert.deepEqual(result.cleaned.map((entry) => [entry.issueId, entry.kind, entry.composeProject]), [
    ["T010", "docker_compose", "sample-wt-1"],
  ]);
});

test("cleanupCompletedWorkspaceResources falls back to compose labels when the worktree is gone", async () => {
  const calls = [];
  let removed = false;

  const result = await cleanupCompletedWorkspaceResources({
    project: testProject,
    observability: {
      sessions: [
        { id: "sample-10", issueId: "T010", observableStatus: "merged", workspacePath: "/tmp/worktrees/sample-10" },
      ],
    },
    execFileAsync: async (file, args, options = {}) => {
      calls.push({ file, args, cwd: options.cwd });
      if (args[0] === "ps" && args.includes("label=com.docker.compose.project.working_dir=/tmp/worktrees/sample-10")) {
        return { stdout: "sample-wt-1\n", stderr: "" };
      }
      if (args[0] === "compose") {
        const error = new Error("compose file not found");
        error.stderr = "no configuration file provided";
        throw error;
      }
      if (args[0] === "ps" && args.includes("label=com.docker.compose.project=sample-wt-1")) {
        return { stdout: removed ? "" : "container-1\n", stderr: "" };
      }
      if (args[0] === "volume" && args[1] === "ls" && args.includes("label=com.docker.compose.project=sample-wt-1")) {
        return { stdout: removed ? "" : "volume-1\n", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "ls" && args.includes("label=com.docker.compose.project=sample-wt-1")) {
        return { stdout: removed ? "" : "network-1\n", stderr: "" };
      }
      if (args.includes("label=com.docker.compose.project=df-sample-sample-10")) {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "rm" || args[1] === "rm") removed = true;
      return { stdout: "removed", stderr: "" };
    },
  });

  assert.deepEqual(calls, [
    {
      file: "docker",
      args: ["ps", "-a", "--filter", "label=com.docker.compose.project.working_dir=/tmp/worktrees/sample-10", "--format", "{{.Label \"com.docker.compose.project\"}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["compose", "-p", "sample-wt-1", "down", "-v", "--remove-orphans"],
      cwd: "/tmp/worktrees/sample-10",
    },
    {
      file: "docker",
      args: ["ps", "-a", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.ID}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["volume", "ls", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.Name}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["network", "ls", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.Name}}"],
      cwd: undefined,
    },
    { file: "docker", args: ["rm", "-f", "container-1"], cwd: undefined },
    { file: "docker", args: ["volume", "rm", "volume-1"], cwd: undefined },
    { file: "docker", args: ["network", "rm", "network-1"], cwd: undefined },
    {
      file: "docker",
      args: ["ps", "-a", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.ID}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["volume", "ls", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.Name}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["network", "ls", "--filter", "label=com.docker.compose.project=sample-wt-1", "--format", "{{.Name}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["ps", "-a", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.ID}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["volume", "ls", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.Name}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["network", "ls", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.Name}}"],
      cwd: undefined,
    },
  ]);
  assert.deepEqual(result.cleaned.map((entry) => [entry.issueId, entry.kind, entry.composeProject]), [
    ["T010", "docker_compose_labels", "sample-wt-1"],
  ]);
  assert.deepEqual(result.errors, []);
});

test("cleanupCompletedWorkspaceResources discovers and verifies deterministic Compose residue without containers", async () => {
  const calls = [];
  let removed = false;

  const result = await cleanupCompletedWorkspaceResources({
    project: testProject,
    observability: {
      sessions: [
        { id: "sample-10", issueId: "T010", observableStatus: "failed", workspacePath: "/tmp/worktrees/sample-10" },
      ],
    },
    execFileAsync: async (file, args, options = {}) => {
      calls.push({ file, args, cwd: options.cwd });
      if (args[0] === "ps" && args.includes("label=com.docker.compose.project.working_dir=/tmp/worktrees/sample-10")) {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "ps" && args.includes("label=com.docker.compose.project=df-sample-sample-10")) {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "volume" && args[1] === "ls") {
        return { stdout: removed ? "" : "orphan-volume\n", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "ls") {
        return { stdout: removed ? "" : "orphan-network\n", stderr: "" };
      }
      if ((args[0] === "volume" || args[0] === "network") && args[1] === "rm") {
        removed = true;
        return { stdout: "removed", stderr: "" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    },
  });

  assert.deepEqual(calls, [
    {
      file: "docker",
      args: ["ps", "-a", "--filter", "label=com.docker.compose.project.working_dir=/tmp/worktrees/sample-10", "--format", "{{.Label \"com.docker.compose.project\"}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["ps", "-a", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.ID}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["volume", "ls", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.Name}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["network", "ls", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.Name}}"],
      cwd: undefined,
    },
    { file: "docker", args: ["volume", "rm", "orphan-volume"], cwd: undefined },
    { file: "docker", args: ["network", "rm", "orphan-network"], cwd: undefined },
    {
      file: "docker",
      args: ["ps", "-a", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.ID}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["volume", "ls", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.Name}}"],
      cwd: undefined,
    },
    {
      file: "docker",
      args: ["network", "ls", "--filter", "label=com.docker.compose.project=df-sample-sample-10", "--format", "{{.Name}}"],
      cwd: undefined,
    },
  ]);
  assert.deepEqual(result.cleaned.map((entry) => [entry.issueId, entry.kind, entry.composeProject]), [
    ["T010", "docker_compose_labels", "df-sample-sample-10"],
  ]);
  assert.deepEqual(result.errors, []);
});

test("cleanupCompletedWorkspaceResources runs commands with session resource identity", async () => {
  const calls = [];

  const result = await cleanupCompletedWorkspaceResources({
    project: {
      ...testProject,
      cleanup: { commands: ["pnpm wtc down --volumes"] },
    },
    observability: {
      sessions: [
        { id: "sample-10", issueId: "T010", observableStatus: "merged", workspacePath: "/tmp/worktrees/sample-10" },
      ],
    },
    execFileAsync: async (file, args, options) => {
      if (file === "docker") return { stdout: "", stderr: "" };

      calls.push({
        file,
        args,
        cwd: options.cwd,
        projectId: options.env.DARK_FACTORY_PROJECT_ID,
        sessionId: options.env.DARK_FACTORY_SESSION_ID,
        issueId: options.env.DARK_FACTORY_ISSUE_ID,
        workspacePath: options.env.DARK_FACTORY_WORKSPACE_PATH,
        composeProjectName: options.env.COMPOSE_PROJECT_NAME,
      });
      return { stdout: "stopped", stderr: "" };
    },
  });

  assert.deepEqual(calls, [{
    file: "sh",
    args: ["-lc", "pnpm wtc down --volumes"],
    cwd: "/tmp/worktrees/sample-10",
    projectId: "sample",
    sessionId: "sample-10",
    issueId: "T010",
    workspacePath: "/tmp/worktrees/sample-10",
    composeProjectName: "df-sample-sample-10",
  }]);
  assert.deepEqual(result.cleaned.map((entry) => [entry.issueId, entry.stdout]), [["T010", "stopped"]]);
  assert.deepEqual(result.errors, []);
});

test("cleanupCompletedWorkspaceBrowsers closes worker Chrome and removes only temp profiles", async () => {
  const killed = [];
  const removed = [];

  const result = await cleanupCompletedWorkspaceBrowsers({
    observability: {
      sessions: [
        { id: "sample-10", issueId: "T010", observableStatus: "merged", workspacePath: "/tmp/worktrees/sample-10" },
        { id: "sample-11", issueId: "T011", observableStatus: "done", workspacePath: "/tmp/worktrees/sample-11" },
        { id: "sample-12", issueId: "T012", observableStatus: "killed", workspacePath: "/tmp/worktrees/sample-12" },
      ],
    },
    getBrowserSessionForWorkspace: async (workspacePath) => {
      if (workspacePath.endsWith("sample-10")) return {
        session: "wt2",
        debugPort: 9224,
        statePath: "/tmp/state/vercel-browser/wt2.env",
        stateDir: "/tmp/state/vercel-browser",
      };
      if (workspacePath.endsWith("sample-12")) return {
        session: "wt4",
        debugPort: 9226,
        statePath: "/tmp/state/vercel-browser/wt4.env",
        stateDir: "/tmp/state/vercel-browser",
      };
      return {
        session: "wt3",
        debugPort: 9225,
        statePath: "/tmp/state/vercel-browser/wt3.env",
        stateDir: "/tmp/state/vercel-browser",
      };
    },
    readBrowserState: async (statePath) => {
      if (statePath.endsWith("wt2.env")) return [
        "PID_OLD=321",
        "PROFILE_OLD=/tmp/state/vercel-browser/wt2-profile-abcd",
        "PROFILE_MODE_OLD=temp",
      ].join("\n");
      if (statePath.endsWith("wt4.env")) return [
        "PID_OLD=777",
        "PROFILE_OLD=/tmp/state/vercel-browser/wt4-profile-dead",
        "PROFILE_MODE_OLD=temp",
      ].join("\n");
      return [
        "PID_OLD=654",
        "PROFILE_OLD=/tmp/cache/vercel-browser/profiles/wt3",
        "PROFILE_MODE_OLD=worktree",
      ].join("\n");
    },
    listBrowserProcesses: async ({ profilePath }) => [
      {
        pid: profilePath.includes("wt2-profile")
          ? 321
          : profilePath.includes("wt4-profile")
            ? 777
            : 654,
        command: `google-chrome --user-data-dir=${profilePath}`,
      },
    ],
    killProcess: async (pid, signal) => killed.push(`${pid}:${signal}`),
    removePath: async (targetPath) => removed.push(targetPath),
  });

  assert.deepEqual(killed, ["321:SIGTERM", "654:SIGTERM", "777:SIGTERM"]);
  assert.deepEqual(removed, [
    "/tmp/state/vercel-browser/wt2-profile-abcd",
    "/tmp/state/vercel-browser/wt2.env",
    "/tmp/state/vercel-browser/wt3.env",
    "/tmp/state/vercel-browser/wt4-profile-dead",
    "/tmp/state/vercel-browser/wt4.env",
  ]);
  assert.deepEqual(result.cleaned.map((entry) => [entry.issueId, entry.profileMode]), [
    ["T010", "temp"],
    ["T011", "worktree"],
    ["T012", "temp"],
  ]);
  assert.equal(result.cleaned.find((entry) => entry.issueId === "T010")?.removedProfile, true);
  assert.equal(result.cleaned.find((entry) => entry.issueId === "T011")?.removedProfile, false);
});

test("cleanupCompletedWorkspaceBrowsers retries temp profile removal while Chrome exits", async () => {
  const removals = [];
  const waits = [];

  const result = await cleanupCompletedWorkspaceBrowsers({
    observability: {
      sessions: [{
        id: "sample-10",
        issueId: "T010",
        observableStatus: "merged",
        workspacePath: "/tmp/worktrees/sample-10",
      }],
    },
    getBrowserSessionForWorkspace: async () => ({
      session: "wt1",
      stateDir: "/tmp/state/vercel-browser",
      statePath: "/tmp/state/vercel-browser/wt1.env",
    }),
    readBrowserState: async () => [
      "PROFILE_OLD=/tmp/state/vercel-browser/wt1-profile-abcd",
      "PROFILE_MODE_OLD=temp",
    ].join("\n"),
    listBrowserProcesses: async () => [],
    removePath: async (path) => {
      removals.push(path);
      if (path.endsWith("wt1-profile-abcd") && removals.filter((item) => item === path).length === 1) {
        const error = new Error("profile is busy");
        error.code = "EBUSY";
        throw error;
      }
    },
    sleep: async (ms) => waits.push(ms),
    browserProfileRemoveRetryMs: 25,
  });

  assert.deepEqual(removals, [
    "/tmp/state/vercel-browser/wt1-profile-abcd",
    "/tmp/state/vercel-browser/wt1-profile-abcd",
    "/tmp/state/vercel-browser/wt1.env",
  ]);
  assert.deepEqual(waits, [25]);
  assert.equal(result.cleaned.length, 1);
  assert.deepEqual(result.errors, []);
});

test("runDarkFactory skips post-merge cleanup when merge queue is blocked", async () => {
  const calls = [];

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      return { tasks: {}, summary: { total: 0 } };
    },
    runRunner: async () => {
      calls.push("runner");
      return {
        dryRun: false,
        mergeQueue: {
          result: {
            attempted: true,
            actions: [{ action: "finalize", issueId: "T007" }],
            blocked: { issueId: "T007", reason: "cannot refresh main" },
          },
        },
        launchPlan: { toLaunch: [], skipped: [] },
      };
    },
    cleanupAoSessions: async () => {
      calls.push("cleanup");
      return {};
    },
    writeDashboard: async () => {
      calls.push("dashboard");
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, ["ao", "observer", "runner", "observer", "dashboard"]);
  assert.equal(result.postMergeCleanup, null);
});

test("runDarkFactory cleans workspace processes after blocked merge queue attempts", async () => {
  const calls = [];
  const readyObservability = {
    tasks: {
      T009: {
        status: "ready",
        sessions: [
          {
            id: "sample-9",
            issueId: "T009",
            observableStatus: "ready",
            workspacePath: "/tmp/worktrees/sample-9",
          },
        ],
      },
    },
    summary: { total: 1, ready: 1 },
  };

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async () => {
      calls.push("observer");
      return readyObservability;
    },
    runRunner: async () => {
      calls.push("runner");
      return {
        dryRun: false,
        mergeQueue: {
          result: {
            attempted: true,
            actions: [
              { action: "prepare", issueId: "T009", workspacePath: "/tmp/worktrees/sample-9" },
            ],
            blocked: { issueId: "T009", reason: "PR did not become ready: CONFLICT" },
          },
        },
        launchPlan: { toLaunch: [], skipped: [] },
      };
    },
    cleanupWorkspaceProcesses: async ({ observability }) => {
      calls.push(`workspace-cleanup:${observability.summary.ready}`);
      return { attempted: true, killed: [{ pid: 123 }], errors: [] };
    },
    cleanupAoSessions: async () => {
      calls.push("cleanup");
      return {};
    },
    writeDashboard: async () => {
      calls.push("dashboard");
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, ["ao", "observer", "runner", "observer", "workspace-cleanup:1", "dashboard"]);
  assert.equal(result.workspaceCleanup.killed.length, 1);
  assert.equal(result.postMergeCleanup, null);
});

test("runDarkFactory can skip AO cleanup when disabled", async () => {
  const calls = [];

  const result = await runDarkFactory({
    project: testProject,
    dryRun: false,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => {
      calls.push("ao");
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    cleanupAoSessions: async () => {
      calls.push("cleanup");
      return {};
    },
    runObserver: async () => {
      calls.push("observer");
      return { tasks: {}, summary: { total: 0 } };
    },
    runRunner: async () => {
      calls.push("runner");
      return { dryRun: false, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, ["ao", "observer", "runner", "observer"]);
  assert.equal(result.cleanup.enabled, false);
  assert.equal(result.cleanup.orchestrator.reason, "cleanup_disabled");
  assert.equal(result.cleanup.postMerge.completedSessionCleanup.reason, "cleanup_disabled");
  assert.equal(result.cleanup.observedCompletion.completedSessionCleanup.reason, "cleanup_disabled");
});

test("runDarkFactory writes a dashboard from the observed and planned state", async () => {
  const calls = [];
  const observabilityState = {
    tasks: {
      T004: { status: "done" },
    },
    summary: { total: 1, done: 1 },
  };
  const runnerState = {
    dryRun: true,
    launchPlan: { toLaunch: [], skipped: [{ id: "T004", reason: "observed_done" }] },
  };

  const result = await runDarkFactory({
    project: testProject,
    dryRun: true,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async () => ({ outputPath: "/tmp/agent-orchestrator.yaml" }),
    runObserver: async () => {
      calls.push("observer");
      return observabilityState;
    },
    runRunner: async () => {
      calls.push("runner");
      return runnerState;
    },
    writeDashboard: async (options) => {
      calls.push("dashboard");
      assert.equal(options.observability, observabilityState);
      assert.deepEqual(options.runner.launchPlan, runnerState.launchPlan);
      assert.equal(options.runner.dryRun, runnerState.dryRun);
      assert.equal(options.runner.complete, false);
      assert.equal(options.outputPath, ".dark-factory/projects/sample/dashboard.html");
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, ["observer", "runner", "observer", "dashboard"]);
  assert.deepEqual(result.dashboard, { outputPath: "/tmp/sample.html" });
});

test("runDarkFactory can load a project config and sync AO config first", async () => {
  const calls = [];
  const configuredProject = {
    id: "sample",
    name: "Sample",
    path: "/tmp/sample",
    tracker: { tasksPath: "planning/tasks.md" },
  };

  const result = await runDarkFactory({
    dryRun: true,
    projectConfigPath: "configs/sample.yaml",
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    loadProjectConfig: async (path) => {
      calls.push(`load:${path}`);
      return configuredProject;
    },
    writeAoConfig: async ({ project }) => {
      calls.push(`ao:${project.id}`);
      return { outputPath: "/tmp/agent-orchestrator.yaml" };
    },
    runObserver: async ({ project }) => {
      calls.push(`observer:${project.id}`);
      return { tasks: {}, summary: { total: 0 } };
    },
    runRunner: async ({ project }) => {
      calls.push(`runner:${project.id}`);
      return { dryRun: true, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async ({ outputPath }) => {
      calls.push(`dashboard:${outputPath}`);
      return { outputPath: "/tmp/sample.html" };
    },
  });

  assert.deepEqual(calls, [
    "load:configs/sample.yaml",
    "ao:sample",
    "observer:sample",
    "runner:sample",
    "observer:sample",
    "dashboard:.dark-factory/projects/sample/dashboard.html",
  ]);
  assert.equal(result.project.id, "sample");
  assert.deepEqual(result.aoConfig, { outputPath: "/tmp/agent-orchestrator.yaml" });
});

test("runDarkFactory selects a registered project and uses project-scoped runtime paths", async () => {
  const calls = [];
  const apiProject = {
    id: "api",
    name: "API",
    path: "/tmp/api",
    tracker: { tasksPath: "planning/roadmap/tasks.md" },
  };
  const webProject = {
    id: "web",
    name: "Web",
    path: "/tmp/web",
    tracker: { tasksPath: "planning/roadmap/tasks.md" },
  };

  const result = await runDarkFactory({
    projectId: "api",
    dryRun: true,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    loadProjectRegistry: async (path) => {
      calls.push(`registry:${path}`);
      return { version: 1, projects: { api: apiProject, web: webProject } };
    },
    writeAoConfig: async ({ projects }) => {
      calls.push(`ao:${projects.map((project) => project.id).join(",")}`);
      return { outputPath: "/tmp/generated-agent-orchestrator.yaml" };
    },
    runObserver: async ({ project, statePath, runnerStatePath, eventLogPath }) => {
      calls.push(`observer:${project.id}:${statePath}:${runnerStatePath}:${eventLogPath}`);
      return { tasks: {}, summary: { total: 0 } };
    },
    runRunner: async ({ project, statePath, observabilityStatePath, eventLogPath }) => {
      calls.push(`runner:${project.id}:${statePath}:${observabilityStatePath}:${eventLogPath}`);
      return { dryRun: true, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async ({ outputPath }) => {
      calls.push(`dashboard:${outputPath}`);
      return { outputPath: "/tmp/api.html" };
    },
  });

  assert.deepEqual(calls, [
    "registry:.dark-factory/projects.json",
    "ao:api,web",
    "observer:api:.dark-factory/projects/api/observability.json:.dark-factory/projects/api/state.json:.dark-factory/projects/api/events.jsonl",
    "runner:api:.dark-factory/projects/api/state.json:.dark-factory/projects/api/observability.json:.dark-factory/projects/api/events.jsonl",
    "observer:api:.dark-factory/projects/api/observability.json:.dark-factory/projects/api/state.json:.dark-factory/projects/api/events.jsonl",
    "dashboard:.dark-factory/projects/api/dashboard.html",
  ]);
  assert.equal(result.project.id, "api");
});

test("runDarkFactory defaults to the local config and syncs the Go AO project registry", async () => {
  const calls = [];
  const configuredProject = {
    id: "sample",
    name: "Sample",
    path: "/tmp/sample",
    tracker: { tasksPath: "planning/roadmap/tasks.md" },
  };

  await runDarkFactory({
    dryRun: true,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    loadProjectConfig: async (path) => {
      calls.push(`load:${path}`);
      return configuredProject;
    },
    writeAoConfig: async ({ registryPath }) => {
      calls.push(`aoRegistry:${registryPath}`);
      return { updated: ["sample"] };
    },
    runObserver: async ({ aoConfigPath }) => {
      calls.push(`observerConfig:${aoConfigPath}`);
      return { tasks: {}, summary: { total: 0 } };
    },
    runRunner: async ({ aoConfigPath }) => {
      calls.push(`runnerConfig:${aoConfigPath}`);
      return { dryRun: true, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, [
    "load:dark-factory.yaml",
    "aoRegistry:.dark-factory/projects.json",
    "observerConfig:undefined",
    "runnerConfig:undefined",
    "observerConfig:undefined",
  ]);
});

test("runDarkFactory passes configured AO command to generated config, observer, and runner", async () => {
  const calls = [];
  const configuredProject = {
    id: "sample",
    name: "Sample",
    path: "/tmp/sample",
    tracker: { tasksPath: "planning/roadmap/tasks.md" },
  };

  await runDarkFactory({
    dryRun: true,
    project: configuredProject,
    aoCommand: "ao-custom",
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async ({ aoCommand }) => {
      calls.push(`aoConfigCommand:${aoCommand}`);
      return { outputPath: "/tmp/generated-agent-orchestrator.yaml" };
    },
    runObserver: async ({ aoCommand }) => {
      calls.push(`observerCommand:${aoCommand}`);
      return { tasks: {}, summary: { total: 0 } };
    },
    runRunner: async ({ aoCommand }) => {
      calls.push(`runnerCommand:${aoCommand}`);
      return { dryRun: true, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, [
    "aoConfigCommand:ao-custom",
    "observerCommand:ao-custom",
    "runnerCommand:ao-custom",
    "observerCommand:ao-custom",
  ]);
});

test("runDarkFactory uses the registered project AO command when no CLI override is passed", async () => {
  const calls = [];
  const configuredProject = {
    id: "sample",
    name: "Sample",
    path: "/tmp/sample",
    tracker: { tasksPath: "planning/roadmap/tasks.md" },
    agentConfig: { aoCommand: "node /tmp/ao.js" },
  };

  await runDarkFactory({
    dryRun: true,
    project: configuredProject,
    cleanupCompletedSessions: false,
    verifyPlanningFresh: verifiedPlanningFresh,
    writeAoConfig: async ({ aoCommand }) => {
      calls.push(`aoConfigCommand:${aoCommand}`);
      return { outputPath: "/tmp/generated-agent-orchestrator.yaml" };
    },
    runObserver: async ({ aoCommand }) => {
      calls.push(`observerCommand:${aoCommand}`);
      return { tasks: {}, summary: { total: 0 } };
    },
    runRunner: async ({ aoCommand }) => {
      calls.push(`runnerCommand:${aoCommand}`);
      return { dryRun: true, launchPlan: { toLaunch: [], skipped: [] } };
    },
    writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
  });

  assert.deepEqual(calls, [
    "aoConfigCommand:undefined",
    "observerCommand:node /tmp/ao.js",
    "runnerCommand:node /tmp/ao.js",
    "observerCommand:node /tmp/ao.js",
  ]);
});

test("runDarkFactory runs planning freshness preflight before observer and runner", async () => {
  const calls = [];

  await assert.rejects(
    runDarkFactory({
      project: testProject,
      writeAoConfig: async () => {
        calls.push("ao");
        return { outputPath: "/tmp/generated-agent-orchestrator.yaml" };
      },
      verifyPlanningFresh: async ({ project }) => {
        calls.push(`preflight:${project.id}`);
        throw new Error("planning is stale");
      },
      runObserver: async () => {
        calls.push("observer");
        return { tasks: {}, summary: { total: 0 } };
      },
      runRunner: async () => {
        calls.push("runner");
        return { dryRun: true, launchPlan: { toLaunch: [], skipped: [] } };
      },
      writeSupervisionFailureState: async () => {},
      writeDashboard: async () => ({ outputPath: "/tmp/sample.html" }),
    }),
    /planning is stale/,
  );

  assert.deepEqual(calls, ["preflight:sample"]);
});

test("writeDarkFactoryDashboards writes project pages from state and an all-project index", async () => {
  const calls = [];
  const apiProject = {
    id: "api",
    name: "API",
    path: "/tmp/api",
    tracker: { tasksPath: "planning/roadmap/tasks.md" },
  };
  const webProject = {
    id: "web",
    name: "Web",
    path: "/tmp/web",
    tracker: { tasksPath: "planning/roadmap/tasks.md" },
  };
  const states = {
    ".dark-factory/projects/api/observability.json": {
      project: { id: "api", name: "API" },
      observedAt: "2026-06-16T10:00:00.000Z",
      tasks: {},
      summary: { total: 0 },
    },
    ".dark-factory/projects/api/state.json": {
      launchPlan: { toLaunch: [], skipped: [], activeSessions: [] },
    },
  };

  const result = await writeDarkFactoryDashboards({
    loadProjectRegistry: async () => ({ version: 1, projects: { api: apiProject, web: webProject } }),
    readJsonIfExists: async (path) => states[path] ?? null,
    writeDashboard: async ({ outputPath }) => {
      calls.push(`project:${outputPath}`);
      return { outputPath };
    },
    writeDashboardIndex: async ({ projects, outputPath }) => {
      calls.push(`index:${outputPath}:${projects.map((project) => `${project.id}:${project.observedAt ?? "none"}`).join(",")}`);
      return { outputPath };
    },
  });

  assert.deepEqual(calls, [
    "project:.dark-factory/projects/api/dashboard.html",
    "index:.dark-factory/dashboard/index.html:api:2026-06-16T10:00:00.000Z,web:none",
  ]);
  assert.deepEqual(result.projectDashboards, [{ projectId: "api", outputPath: ".dark-factory/projects/api/dashboard.html" }]);
  assert.deepEqual(result.index, { outputPath: ".dark-factory/dashboard/index.html" });
});
