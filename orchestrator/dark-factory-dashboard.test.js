import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildDashboardModel,
  renderDashboardHtml,
  renderDashboardIndexHtml,
  writeDashboard,
  writeDashboardIndex,
} from "./dark-factory-dashboard.js";

const observability = {
  observedAt: "2026-06-16T10:00:00.000Z",
  project: {
    id: "sample",
    name: "Sample",
    path: "/tmp/sample",
    tasksPath: "planning/roadmap/tasks.md",
  },
  summary: {
    total: 2,
    queued: 0,
    running: 0,
    in_review: 0,
    ready_to_merge: 1,
    merging: 0,
    merged: 1,
    failed: 0,
    needs_input: 0,
    cleanup_failed: 0,
  },
  events: [
    {
      id: "evt-1",
      type: "task.started",
      taskId: "T004",
      timestamp: "2026-06-16T09:00:00.000Z",
    },
    {
      id: "evt-2",
      type: "pr.opened",
      taskId: "T004",
      timestamp: "2026-06-16T09:10:00.000Z",
      metadata: { durationMs: 300000, reason: "waiting on checks" },
    },
    {
      id: "evt-3",
      type: "task.blocked",
      taskId: "T004",
      timestamp: "2026-06-16T09:20:00.000Z",
      error: "merge conflict in generated client",
      metadata: {
        phase: "finalize",
        workspacePath: "/tmp/worktrees/sample-3",
      },
    },
  ],
  eventSummary: {
    total: 3,
    byType: {
      "task.started": 1,
      "pr.opened": 1,
      "task.blocked": 1,
    },
    latestByTask: {
      T004: {
        id: "evt-3",
        type: "task.blocked",
        taskId: "T004",
        timestamp: "2026-06-16T09:20:00.000Z",
      },
    },
  },
  tasks: {
    T004: {
      id: "T004",
      title: "AO orchestration compatibility spike",
      branchName: "chore/t004-ao-orchestration-spike",
      sourceState: "open",
      status: "merged",
      timeline: [
        {
          id: "evt-1",
          type: "task.started",
          timestamp: "2026-06-16T09:00:00.000Z",
        },
        {
          id: "evt-2",
          type: "pr.opened",
          timestamp: "2026-06-16T09:10:00.000Z",
          metadata: { durationMs: 300000, reason: "waiting on checks" },
        },
        {
          id: "evt-3",
          type: "task.blocked",
          timestamp: "2026-06-16T09:20:00.000Z",
          error: "merge conflict in generated client",
        },
      ],
      sessions: [
        {
          id: "sample-3",
          issueId: "T004",
          status: "merged",
          observableStatus: "merged",
          branch: "chore/t004-ao-orchestration-spike",
          workspacePath: "/tmp/worktrees/sample-3",
        },
      ],
    },
    T005: {
      id: "T005",
      title: "Next real task",
      branchName: "feat/t005-next",
      sourceState: "open",
      status: "ready_to_merge",
      sessions: [],
    },
  },
  sessions: [],
};

const observabilityWithHistory = {
  ...observability,
  summary: {
    total: 1,
    queued: 0,
    running: 0,
    in_review: 0,
    ready_to_merge: 1,
    merging: 0,
    merged: 0,
    failed: 0,
    needs_input: 0,
    cleanup_failed: 0,
  },
  tasks: {
    T007: {
      id: "T007",
      title: "Current task with stale history",
      branchName: "feat/t007-current",
      sourceState: "open",
      status: "ready_to_merge",
      currentSession: {
        id: "sample-7-current",
        issueId: "T007",
        status: "idle",
        observableStatus: "ready_to_merge",
        branch: "feat/t007-current",
        workspacePath: "/tmp/worktrees/sample-7-current",
      },
      sessionHistory: [
        {
          id: "sample-7-old",
          issueId: "T007",
          status: "killed",
          observableStatus: "failed",
          branch: "feat/t007-old",
          workspacePath: "/tmp/worktrees/sample-7-old",
        },
      ],
      sessions: [
        {
          id: "sample-7-current",
          issueId: "T007",
          status: "idle",
          observableStatus: "ready_to_merge",
          branch: "feat/t007-current",
          workspacePath: "/tmp/worktrees/sample-7-current",
        },
        {
          id: "sample-7-old",
          issueId: "T007",
          status: "killed",
          observableStatus: "failed",
          branch: "feat/t007-old",
          workspacePath: "/tmp/worktrees/sample-7-old",
        },
      ],
    },
  },
};

const runner = {
  dryRun: true,
  launchPlan: {
    toLaunch: [{ id: "T005", title: "Next real task", branchName: "feat/t005-next" }],
    skipped: [{ id: "T004", reason: "observed_done" }],
    activeSessions: [],
  },
  spawn: {
    attempted: false,
    issueIds: [],
  },
};

test("buildDashboardModel groups tasks by status and carries runner context", () => {
  const model = buildDashboardModel({ observability, runner });

  assert.equal(model.projectName, "Sample");
  assert.equal(model.controlMode, "active");
  assert.deepEqual(model.events, observability.events);
  assert.deepEqual(model.eventSummary, observability.eventSummary);
  assert.deepEqual(model.columns.merged.map((task) => task.id), ["T004"]);
  assert.deepEqual(model.columns.ready_to_merge.map((task) => task.id), ["T005"]);
  assert.equal(model.columns.merged[0].lastEvent.type, "pr.opened");
  assert.equal(model.columns.merged[0].lastError.type, "task.blocked");
  assert.deepEqual(model.skipped, [{ id: "T004", reason: "observed_done" }]);
  assert.deepEqual(model.toLaunch.map((task) => task.id), ["T005"]);
});

test("buildDashboardModel exposes only deterministic lifecycle columns", () => {
  const model = buildDashboardModel({
    observability: {
      ...observability,
      summary: {
        total: 2,
        queued: 1,
        running: 0,
        in_review: 0,
        ready_to_merge: 0,
        merging: 0,
        merged: 0,
        failed: 0,
        needs_input: 0,
        cleanup_failed: 0,
      },
      tasks: {
        T004: { id: "T004", title: "Known lifecycle", status: "merged", sessions: [] },
        T005: { id: "T005", title: "Unknown lifecycle", status: "weird", sessions: [] },
      },
    },
    runner,
  });

  assert.deepEqual(Object.keys(model.columns), [
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
  assert.deepEqual(model.columns.merged.map((task) => task.id), ["T004"]);
  assert.deepEqual(model.columns.queued.map((task) => task.id), ["T005"]);
  assert.equal(model.columns.ready, undefined);
  assert.equal(model.columns.blocked, undefined);
  assert.equal(model.columns.stale, undefined);
  assert.equal(model.columns.done, undefined);
});

test("buildDashboardModel exposes project completion from runner state", () => {
  const model = buildDashboardModel({
    observability: {
      ...observability,
      summary: { total: 1, queued: 0, running: 0, in_review: 0, ready_to_merge: 0, merging: 0, merged: 1, failed: 0, needs_input: 0, cleanup_failed: 0 },
    },
    runner: {
      ...runner,
      complete: true,
      launchPlan: { toLaunch: [], skipped: [], activeSessions: [] },
    },
  });

  assert.equal(model.complete, true);
});

test("buildDashboardModel carries the deterministic supervision exit reason", () => {
  const model = buildDashboardModel({
    observability,
    runner: {
      ...runner,
      supervision: { passes: 2, exitReason: "paused", controlMode: "paused" },
    },
  });

  assert.equal(model.supervisionExitReason, "paused");
});

test("renderDashboardHtml includes status counts, task detail, sessions, and commands", () => {
  const html = renderDashboardHtml({ observability, runner });

  assert.match(html, /Dark Factory/);
  assert.match(html, /Sample/);
  assert.match(html, /ready_to_merge/);
  assert.match(html, /merged/);
  assert.match(html, /T004/);
  assert.match(html, /AO orchestration compatibility spike/);
  assert.match(html, /observed_done/);
  assert.match(html, /sample-3/);
  assert.match(html, /\/tmp\/worktrees\/sample-3/);
  assert.match(html, /Control: active/);
  assert.match(html, /node orchestrator\/dark-factory\.js run --project sample --run/);
  assert.match(html, /node orchestrator\/dark-factory\.js pause --project sample/);
  assert.match(html, /node orchestrator\/dark-factory\.js resume --project sample/);
  assert.match(html, /node orchestrator\/dark-factory\.js status --project sample/);
});

test("renderDashboardHtml shows when the project is complete", () => {
  const html = renderDashboardHtml({
    observability: {
      ...observability,
      summary: { total: 1, queued: 0, running: 0, in_review: 0, ready_to_merge: 0, merging: 0, merged: 1, failed: 0, needs_input: 0, cleanup_failed: 0 },
    },
    runner: {
      ...runner,
      complete: true,
      launchPlan: { toLaunch: [], skipped: [], activeSessions: [] },
    },
  });

  assert.match(html, /Project complete/);
});

test("renderDashboardHtml persists the supervision exit reason in output", () => {
  const html = renderDashboardHtml({
    observability,
    runner: {
      ...runner,
      supervision: { passes: 2, exitReason: "budget_exhausted", controlMode: "active" },
    },
  });

  assert.match(html, /data-supervision-exit-reason="budget_exhausted"/);
  assert.match(html, /Supervision: budget_exhausted/);
});

test("renderDashboardHtml renders compact task timelines when present", () => {
  const html = renderDashboardHtml({ observability, runner });

  assert.match(html, /Timeline/);
  assert.match(html, /task\.started/);
  assert.match(html, /pr\.opened/);
  assert.match(html, /2026-06-16T09:10:00.000Z/);
  assert.match(html, /300000ms/);
  assert.match(html, /waiting on checks/);
});

test("renderDashboardHtml includes debugging filters, task summaries, and raw events", () => {
  const html = renderDashboardHtml({ observability, runner });

  assert.match(html, /data-filter-status="all"/);
  assert.match(html, /data-filter-status="failed"/);
  assert.match(html, /data-task-status="merged"/);
  assert.match(html, /Last event/);
  assert.match(html, /Last error/);
  assert.match(html, /merge conflict in generated client/);
  assert.match(html, /Task details/);
  assert.match(html, /evt-1/);
  assert.match(html, /task\.started/);
  assert.match(html, /Raw Events/);
  assert.match(html, /&quot;id&quot;:\s*&quot;evt-1&quot;/);
  assert.match(html, /&quot;type&quot;:\s*&quot;task\.started&quot;/);
  assert.match(html, /&quot;phase&quot;:\s*&quot;finalize&quot;/);
  assert.match(html, /\/tmp\/worktrees\/sample-3/);
});

test("renderDashboardHtml renders only the current session on task cards", () => {
  const html = renderDashboardHtml({ observability: observabilityWithHistory, runner });

  assert.match(html, /sample-7-current/);
  assert.match(html, /1 older session hidden/);
  assert.doesNotMatch(html, /sample-7-old/);
  assert.doesNotMatch(html, /\/tmp\/worktrees\/sample-7-old/);
});

test("writeDashboard writes a static html file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-dashboard-"));
  const outputPath = join(dir, "sample.html");

  const result = await writeDashboard({ observability, runner, outputPath });
  const html = await readFile(outputPath, "utf8");

  assert.equal(result.outputPath, outputPath);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /Next real task/);
});

test("renderDashboardIndexHtml includes every registered project", () => {
  const html = renderDashboardIndexHtml({
    projects: [
      {
        id: "api",
        name: "API",
        path: "/workspace/api",
        dashboardPath: ".dark-factory/projects/api/dashboard.html",
        summary: { total: 2, ready_to_merge: 1, running: 1 },
        observedAt: "2026-06-16T10:00:00.000Z",
      },
      {
        id: "web",
        name: "Web",
        path: "/workspace/web",
        dashboardPath: ".dark-factory/projects/web/dashboard.html",
        summary: null,
        observedAt: null,
      },
    ],
  });

  assert.match(html, /Dark Factory Projects/);
  assert.match(html, /API/);
  assert.match(html, /Web/);
  assert.match(html, /ready_to_merge: 1/);
  assert.match(html, /Not observed yet/);
  assert.match(html, /\.dark-factory\/projects\/api\/dashboard\.html/);
});

test("writeDashboardIndex writes the all-project dashboard", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-dashboard-index-"));
  const outputPath = join(dir, "index.html");

  const result = await writeDashboardIndex({
    projects: [{ id: "api", name: "API", path: "/workspace/api", dashboardPath: "api.html" }],
    outputPath,
  });
  const html = await readFile(outputPath, "utf8");

  assert.equal(result.outputPath, outputPath);
  assert.match(html, /Dark Factory Projects/);
  assert.match(html, /api\.html/);
});
