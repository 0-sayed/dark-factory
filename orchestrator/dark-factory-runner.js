import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, readlink, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import tasksMdTracker, { parsePlanningContent, parsePlanningFile } from "../ao-plugins/tasks-md-tracker/index.js";
import { appendEvent, appendEventIfChanged } from "./dark-factory-events.js";
import { createAoTransport } from "./ao-command.js";
import { openRunLedger, recordRunnerCharges } from "./dark-factory-run-state.js";

const execFileAsync = promisify(execFile);
const GITHUB_CLI_TIMEOUT_MS = 30000;
const DEFAULT_SPAWN_STAGGER_MS = 60000;
const DEFAULT_WORKER_READY_GRACE_ATTEMPTS = 15;
const DEFAULT_WORKER_READY_GRACE_INTERVAL_MS = 1000;
const AO_DISPLAY_NAME_MAX_CHARACTERS = 20;
const QA_RESULT_PATH = ".archon/state/qa-result.md";
const QA_STATUS_PATH = ".archon/state/qa-status.txt";
const FRONTEND_QA_RESULT_PATH = ".archon/state/frontend-qa-result.md";
const FRONTEND_QA_STATUS_PATH = ".archon/state/frontend-qa-status.txt";
const QA_RESULT_PATHS = [QA_RESULT_PATH, FRONTEND_QA_RESULT_PATH];
const QA_STATUS_PATHS = [QA_STATUS_PATH, FRONTEND_QA_STATUS_PATH];
const FRONTEND_QA_RESUME_RESET_STEPS = new Set([
  "start-dev",
  "ensure-dev-for-QA",
  "QA",
  "check-QA-passed",
]);

export const TERMINAL_STATUSES = new Set([
  "done",
  "merged",
  "killed",
  "errored",
  "exited",
  "terminated",
  "cleanup",
  "verified",
  "failed",
  "needs_input",
]);

const RECOVERABLE_SESSION_STATUSES = new Set(["failed", "killed", "errored", "exited", "terminated", "needs_input"]);
const RECOVERABLE_PR_SESSION_STATUSES = new Set([
  "pr_open",
  "review_pending",
  "mergeable",
  "approved",
  "ci_failed",
  "changes_requested",
]);
const READY_SESSION_STATUSES = new Set(["ready", "ready_to_merge", "ready_for_review"]);
export const DEFAULT_MAX_CONCURRENCY = 4;
const NON_LAUNCHABLE_OBSERVED_STATUSES = new Set(["blocked", "failed", "stale"]);
const IGNORED_REFRESH_STATUS_PATHS = new Set(["pr.md", "codex.review.md"]);
const IGNORED_REFRESH_STATUS_DIRS = [".superpowers/"];
const CONTROLLER_WORKTREE_MUTATION_VIOLATION = "controller_must_not_mutate_worker_worktree";
const WORKER_SESSION_REQUIRED = "worker_session_required";
const LIVE_WORKER_PROCESS_PATTERN = /\b(?:archon|codex|claude|opencode|cursor-agent|auto-merge|auto-squash|review-cycle|wait-review-bots|review-bots)\b/i;
const CONTROLLER_POLICY = Object.freeze({
  role: "controller",
  workerWorktreeMutation: "forbidden",
  violationReason: CONTROLLER_WORKTREE_MUTATION_VIOLATION,
  allowedActions: Object.freeze([
    "observe",
    "spawn_worker_session",
    "resume_worker_session",
    "merge_queue_prepare_finalize",
    "cleanup",
  ]),
});

function defaultProject(cwd = process.cwd()) {
  return {
    id: "project",
    name: "Project",
    path: cwd,
    tracker: {
      tasksPath: "planning/roadmap/tasks.md",
    },
  };
}

function normalizeTaskId(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function issueSummary(issue) {
  return {
    id: issue.id,
    branchName: issue.branchName,
    title: issue.title,
  };
}

function runnerEventMetadata(metadata = {}) {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

function issuePrNumber(issue) {
  return issue?.pr?.number ?? issue?.readyArtifact?.pr?.number ?? null;
}

function issuePrUrl(issue) {
  return issue?.pr?.url ?? issue?.readyArtifact?.pr?.url ?? null;
}

function ciRecoveryReason(reason) {
  const message = String(reason ?? "");
  if (/checks?.*(pending)/i.test(message) || /(pending).*checks?/i.test(message)) {
    return "pending_checks";
  }
  if (/checks?.*(fail(?:ed|ing)?|not[-\s]?green)/i.test(message) || /(fail(?:ed|ing)?|not[-\s]?green).*checks?/i.test(message)) {
    return "failed_checks";
  }
  return null;
}

function ciRecoveryAction(issue, details = {}) {
  return runnerEventMetadata({
    action: "ci-recovery",
    issueId: issue?.id,
    sessionId: issue?.sessionId,
    prNumber: issuePrNumber(issue),
    prUrl: issuePrUrl(issue),
    workspacePath: issue?.workspacePath,
    ...details,
  });
}

function ciRecoveryRunFields(...sources) {
  const fields = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    if (fields.workflowRunId === undefined && source.workflowRunId !== undefined) {
      fields.workflowRunId = source.workflowRunId;
    }
    if (fields.runId === undefined && source.runId !== undefined) {
      fields.runId = source.runId;
    }
  }
  return runnerEventMetadata(fields);
}

function spawnEvent(issue, spawnedIssue) {
  return {
    type: "task.started",
    projectId: spawnedIssue.projectId,
    taskId: spawnedIssue.issueId ?? issue.id,
    sessionId: spawnedIssue.sessionId,
    status: "started",
    metadata: runnerEventMetadata({
      branchName: issue.branchName,
      title: issue.title,
    }),
  };
}

function resumeEvent(issue, restoredIssue) {
  return {
    type: "task.resumed",
    projectId: restoredIssue.projectId,
    taskId: restoredIssue.issueId ?? issue.id,
    sessionId: restoredIssue.sessionId ?? issue.sessionId,
    status: "resumed",
    metadata: runnerEventMetadata({
      branchName: issue.branchName,
      title: issue.title,
      previousStatus: issue.previousStatus,
    }),
  };
}

function mergeStartedEvent(project, issue) {
  return {
    type: "pr.merge.started",
    projectId: project.id,
    taskId: issue.id,
    sessionId: issue.sessionId,
    status: "started",
    metadata: runnerEventMetadata({
      phase: "finalize",
      prNumber: issue.pr?.number,
      workspacePath: issue.workspacePath,
    }),
  };
}

function mergedEvent(project, issue) {
  return {
    type: "pr.merged",
    projectId: project.id,
    taskId: issue.id,
    sessionId: issue.sessionId,
    status: "merged",
    metadata: runnerEventMetadata({
      phase: "finalize",
      prNumber: issue.pr?.number,
      workspacePath: issue.workspacePath,
    }),
  };
}

function blockedEvent(project, issue, blocked) {
  return {
    type: "task.blocked",
    projectId: project.id,
    taskId: issue.id,
    sessionId: issue.sessionId,
    status: "blocked",
    error: blocked.reason,
    metadata: runnerEventMetadata({
      phase: blocked.phase,
      reason: blocked.reason,
      recoveryAction: blocked.recovery?.action,
      workspacePath: issue.workspacePath,
    }),
  };
}

function waitingEvent(project, issue, waiting) {
  return {
    type: "task.waiting",
    projectId: project.id,
    taskId: issue.id,
    sessionId: issue.sessionId,
    status: "waiting",
    error: waiting.reason,
    metadata: runnerEventMetadata({
      phase: waiting.phase,
      reason: waiting.reason,
      recoveryAction: waiting.recovery?.action,
      workspacePath: issue.workspacePath,
    }),
  };
}

function ciRecoveryEvent(project, action) {
  const phase = String(action?.phase ?? "").trim().toLowerCase();
  const type = phase === "blocked"
    ? "ci.recovery.blocked"
    : phase === "completed"
      ? "ci.recovery.completed"
      : "ci.recovery.started";
  const status = phase === "blocked"
    ? "blocked"
    : phase === "completed"
      ? "completed"
      : "started";

  return {
    type,
    projectId: project.id,
    taskId: action.issueId,
    sessionId: action.sessionId,
    prNumber: action.prNumber,
    runId: action.runId,
    workflowRunId: action.workflowRunId,
    status,
    error: action.error,
    metadata: runnerEventMetadata({
      action: action.recoveryAction,
      reason: action.reason,
      trigger: action.trigger,
      outcome: action.outcome,
      prUrl: action.prUrl,
      workspacePath: action.workspacePath,
      blockedPhase: action.blockedPhase,
    }),
  };
}

async function appendRunnerEvents(eventLogPath, events, options = {}) {
  if (!eventLogPath) return;

  for (const event of events) {
    try {
      const append = event.type === "task.waiting" ? appendEventIfChanged : appendEvent;
      await append(event, { eventLogPath, now: options.now });
    } catch {
      // Event observability should never break the runner.
    }
  }
}

function sanitizeWorkerSessionPart(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/^(feat|fix|chore|test|docs|refactor)\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildWorkerSessionId(project, issue) {
  const prefix = sanitizeWorkerSessionPart(project?.sessionPrefix ?? project?.id ?? project?.name ?? "project") || "project";
  const taskId = sanitizeWorkerSessionPart(issue?.id);
  const branchTail = sanitizeWorkerSessionPart(issue?.branchName);
  const titleTail = sanitizeWorkerSessionPart(issue?.title);
  const detail = branchTail || titleTail;
  const suffix = detail && taskId && (detail === taskId || detail.startsWith(`${taskId}-`))
    ? detail
    : [taskId, detail].filter(Boolean).join("-") || "task";

  return `${prefix}-${suffix}`
    .replace(/-+/g, "-")
    .slice(0, 96)
    .replace(/-+$/g, "") || `${prefix}-task`;
}

function buildAoDisplayName(issue) {
  const title = String(issue?.title ?? "").trim();
  const fallback = String(issue?.id ?? "Worker").trim() || "Worker";
  return Array.from(title || fallback)
    .slice(0, AO_DISPLAY_NAME_MAX_CHARACTERS)
    .join("")
    .trimEnd();
}

export function buildAvailableWorkerSessionId(project, issue, sessions = []) {
  const baseId = buildWorkerSessionId(project, issue);
  const existingIds = new Set(normalizeSessionsPayload(sessions).map((session) => String(session.id ?? "")));
  if (!existingIds.has(baseId)) return baseId;

  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = `${baseId}-retry${attempt}`;
    if (!existingIds.has(candidate)) return candidate;
  }

  throw new Error(`Cannot allocate session id for ${issue?.id ?? "task"}: too many retries for ${baseId}`);
}

function observedStatus(observedTasks, issueId) {
  return String(observedTasks?.[normalizeTaskId(issueId)]?.status ?? "").toLowerCase();
}

function isMergeQueueReadyStatus(status) {
  return ["ready", "ready_to_merge", "in_review"].includes(String(status ?? "").toLowerCase());
}

function isEffectivelyDone(taskPlan, observedTasks, issueId) {
  const task = taskPlan?.tasks?.get(normalizeTaskId(issueId));
  if (task?.done) return true;
  return ["done", "merged"].includes(observedStatus(observedTasks, issueId));
}

function sessionForIssue(observedTasks, issueId) {
  const sessions = observedTasks?.[normalizeTaskId(issueId)]?.sessions ?? [];
  return sessions.find((session) => session.workspacePath) ?? sessions[0] ?? null;
}

function mergeQueueIssue(observedTasks, issueId) {
  const session = sessionForIssue(observedTasks, issueId);
  return {
    id: normalizeTaskId(issueId),
    sessionId: session?.id ?? null,
    workspacePath: session?.workspacePath ?? null,
    pr: session?.pr ?? null,
    branch: session?.branch ?? session?.readyArtifact?.branch ?? null,
    readyArtifact: session?.readyArtifact ?? null,
  };
}

function sessionSummary(session) {
  return {
    id: session.id,
    issueId: normalizeTaskId(session.issueId ?? session.issue),
    status: session.status,
    branch: session.branch,
    workspacePath: session.workspacePath,
    lifecycle: session.lifecycle,
  };
}

function normalizeWorkspacePath(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function hasLiveWorkspaceProcess(session, liveWorkspacePaths) {
  const workspacePath = normalizeWorkspacePath(session?.workspacePath);
  if (!workspacePath || !liveWorkspacePaths) return false;
  const paths = liveWorkspacePaths instanceof Set ? liveWorkspacePaths : new Set(liveWorkspacePaths);
  return paths.has(workspacePath);
}

function isRuntimeDetached(session, liveWorkspacePaths) {
  if (hasLiveWorkspaceProcess(session, liveWorkspacePaths)) return false;

  const lifecycle = session?.lifecycle ?? {};
  const runtimeState = String(lifecycle.runtime?.state ?? session?.runtimeState ?? "").toLowerCase();
  const runtimeReason = String(lifecycle.runtime?.reason ?? session?.runtimeReason ?? "").toLowerCase();
  const sessionState = String(lifecycle.session?.state ?? session?.sessionState ?? "").toLowerCase();
  const sessionReason = String(lifecycle.session?.reason ?? session?.sessionReason ?? "").toLowerCase();

  return runtimeState === "missing"
    || runtimeState === "exited"
    || runtimeReason === "process_missing"
    || runtimeReason === "tmux_missing"
    || (sessionReason === "runtime_lost" && (sessionState === "terminated" || sessionState === "detecting"));
}

function hasLiveRuntime(session, liveWorkspacePaths) {
  if (hasLiveWorkspaceProcess(session, liveWorkspacePaths)) return true;

  const lifecycle = session?.lifecycle ?? {};
  const runtimeState = String(lifecycle.runtime?.state ?? session?.runtimeState ?? "").toLowerCase();
  const runtimeReason = String(lifecycle.runtime?.reason ?? session?.runtimeReason ?? "").toLowerCase();
  const sessionState = String(lifecycle.session?.state ?? session?.sessionState ?? "").toLowerCase();

  return ["active", "alive", "running"].includes(runtimeState)
    || runtimeReason === "process_running"
    || (["active", "running", "working"].includes(sessionState) && !isRuntimeDetached(session, liveWorkspacePaths));
}

function isActiveWorkerSession(session, liveWorkspacePaths) {
  const status = String(session?.status ?? "").toLowerCase();
  if (RECOVERABLE_PR_SESSION_STATUSES.has(status)) return hasLiveRuntime(session, liveWorkspacePaths);
  return !TERMINAL_STATUSES.has(status) && !isRuntimeDetached(session, liveWorkspacePaths);
}

function isReadyWorkerSession(session) {
  return READY_SESSION_STATUSES.has(String(session?.status ?? "").toLowerCase());
}

function isWorkerOwnedMergeCandidate(session, liveWorkspacePaths) {
  if (!hasLiveRuntime(session, liveWorkspacePaths)) return false;
  const status = String(session?.status ?? "").toLowerCase();
  return !READY_SESSION_STATUSES.has(status);
}

function isRecoverableWorkerSession(session) {
  const status = String(session?.status ?? "").toLowerCase();
  return RECOVERABLE_SESSION_STATUSES.has(status)
    || RECOVERABLE_PR_SESSION_STATUSES.has(status);
}

function sessionWorkspacePaths(sessions = []) {
  return normalizeSessionsPayload(sessions)
    .map((session) => normalizeWorkspacePath(session.workspacePath))
    .filter(Boolean);
}

function observedWorkspacePaths(observedTasks = {}) {
  const paths = [];
  for (const task of Object.values(observedTasks ?? {})) {
    if (task?.currentSession) paths.push(...sessionWorkspacePaths([task.currentSession]));
    if (Array.isArray(task?.sessions)) paths.push(...sessionWorkspacePaths(task.sessions));
    if (Array.isArray(task?.sessionHistory)) paths.push(...sessionWorkspacePaths(task.sessionHistory));
  }
  return paths;
}

function candidateWorkspacePaths({ observedTasks = {}, sessions = [] } = {}) {
  return new Set([
    ...observedWorkspacePaths(observedTasks),
    ...sessionWorkspacePaths(sessions),
  ]);
}

export function commandLooksLikeLiveWorkerProcess(commandLine) {
  return LIVE_WORKER_PROCESS_PATTERN.test(String(commandLine ?? ""));
}

export async function detectLiveWorkerWorkspacePaths({ observedTasks = {}, sessions = [] } = {}) {
  const candidates = candidateWorkspacePaths({ observedTasks, sessions });
  if (process.platform !== "linux" || candidates.size === 0) return new Set();

  let procEntries;
  try {
    procEntries = await readdir("/proc");
  } catch {
    return new Set();
  }

  const liveWorkspacePaths = new Set();
  await Promise.all(procEntries
    .filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)
    .map(async (pid) => {
      let cwd;
      try {
        cwd = await readlink(`/proc/${pid}/cwd`);
      } catch {
        return;
      }

      if (!candidates.has(cwd)) return;

      let commandLine = "";
      try {
        commandLine = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ");
      } catch {
        return;
      }

      if (commandLooksLikeLiveWorkerProcess(commandLine)) {
        liveWorkspacePaths.add(cwd);
      }
    }));

  return liveWorkspacePaths;
}

function filterCleanedTerminalWorkspaceSessions(sessions, issues, { runWorkspaceGit } = {}) {
  const runnableIssueIds = new Set((issues ?? []).map((issue) => normalizeTaskId(issue.id)));
  const runGit = runWorkspaceGit ?? ((workspacePath, args) => defaultRunGit(workspacePath, args));

  return Promise.all(normalizeSessionsPayload(sessions).map(async (session) => {
    const issueId = normalizeTaskId(session.issueId ?? session.issue);
    const status = String(session.status ?? "").toLowerCase();
    if (
      !runnableIssueIds.has(issueId)
      || !TERMINAL_STATUSES.has(status)
      || !session.workspacePath
    ) {
      return session;
    }

    try {
      await runGit(session.workspacePath, ["rev-parse", "--show-toplevel"]);
      return session;
    } catch (error) {
      return isMissingWorkspaceError(error) ? null : session;
    }
  })).then((items) => items.filter(Boolean));
}

function recoverableSessionForIssue(sessions, issueId) {
  const normalizedIssueId = normalizeTaskId(issueId);
  return [...normalizeSessionsPayload(sessions)]
    .reverse()
    .find((session) => {
      return normalizeTaskId(session.issueId ?? session.issue) === normalizedIssueId
        && isRecoverableWorkerSession(session);
    }) ?? null;
}

function hasPrEvidence(session = {}) {
  const lifecyclePr = session.lifecycle?.pr ?? {};
  const lifecyclePrState = String(lifecyclePr.state ?? "").toLowerCase();
  return Boolean(
    session.pr
    || session.prReadiness
    || session.readyArtifact
    || session.agentReportedPrUrl
    || session.agentReportedPrNumber
    || (lifecyclePrState && lifecyclePrState !== "none")
    || lifecyclePr.number
    || lifecyclePr.url,
  );
}

function canFreshLaunchObservedFailure(observedTask) {
  if (String(observedTask?.status ?? "").toLowerCase() !== "failed") return false;

  const sessions = normalizeSessionsPayload(observedTask?.sessions);
  if (sessions.length === 0) return false;

  return sessions.every((session) => !hasPrEvidence(session));
}

function outputLines(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseWorktreeBranches(output) {
  return new Set(outputLines(output)
    .filter((line) => line.startsWith("branch refs/heads/"))
    .map((line) => line.slice("branch refs/heads/".length)));
}

function observedTaskWorkspacePath(observedTask) {
  const currentPath = String(observedTask?.currentSession?.workspacePath ?? "").trim();
  if (currentPath) return currentPath;

  for (const session of normalizeSessionsPayload(observedTask?.sessions)) {
    const workspacePath = String(session?.workspacePath ?? "").trim();
    if (workspacePath) return workspacePath;
  }

  return "";
}

function observedSessionReservationsForIssues(issues, observedTasks = {}) {
  const reservations = [];
  const seen = new Set();

  for (const issue of issues ?? []) {
    const observedTask = observedTasks[normalizeTaskId(issue.id)];
    if (!canFreshLaunchObservedFailure(observedTask)) continue;

    for (const session of normalizeSessionsPayload(observedTask?.sessions)) {
      const id = String(session?.id ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      reservations.push({ id });
    }
  }

  return reservations;
}

async function defaultRunDocker(args) {
  const result = await execFileAsync("docker", args, { maxBuffer: 1024 * 1024 * 10 });
  return result.stdout ?? "";
}

async function listDockerComposeProjectResources(runDocker, composeProject, kind) {
  const argsByKind = {
    containers: ["ps", "-a", "--filter", `label=com.docker.compose.project=${composeProject}`, "--format", "{{.ID}}"],
    volumes: ["volume", "ls", "--filter", `label=com.docker.compose.project=${composeProject}`, "--format", "{{.Name}}"],
    networks: ["network", "ls", "--filter", `label=com.docker.compose.project=${composeProject}`, "--format", "{{.Name}}"],
  };
  return outputLines(await runDocker(argsByKind[kind]));
}

async function cleanupFreshLaunchResources(issue, observedTask, {
  runDocker = defaultRunDocker,
} = {}) {
  const issueId = normalizeTaskId(issue?.id);
  const workspacePath = observedTaskWorkspacePath(observedTask);
  if (!workspacePath) return null;

  let composeProjects;
  try {
    composeProjects = [...new Set(outputLines(await runDocker([
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project.working_dir=${workspacePath}`,
      "--format",
      "{{.Label \"com.docker.compose.project\"}}",
    ])))];
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return {
      id: issueId,
      reason: "retry_resource_cleanup_failed",
      workspacePath,
      error: errorMessage(error),
    };
  }

  for (const composeProject of composeProjects) {
    try {
      const containers = await listDockerComposeProjectResources(runDocker, composeProject, "containers");
      const volumes = await listDockerComposeProjectResources(runDocker, composeProject, "volumes");
      const networks = await listDockerComposeProjectResources(runDocker, composeProject, "networks");

      if (containers.length > 0) await runDocker(["rm", "-f", ...containers]);
      if (volumes.length > 0) await runDocker(["volume", "rm", ...volumes]);
      if (networks.length > 0) await runDocker(["network", "rm", ...networks]);
    } catch (error) {
      return {
        id: issueId,
        reason: "retry_resource_cleanup_failed",
        workspacePath,
        composeProject,
        error: errorMessage(error),
      };
    }
  }

  return null;
}

function resolveLaunchConcurrency(concurrency, runnableIssues) {
  if (concurrency !== undefined && concurrency !== null && concurrency !== "auto") {
    return Math.max(0, Number.parseInt(String(concurrency), 10) || 0);
  }

  return Math.min(DEFAULT_MAX_CONCURRENCY, Math.max(0, runnableIssues.length));
}

function normalizeTaskLimit(taskLimit) {
  if (taskLimit === undefined || taskLimit === null || taskLimit === "") return null;
  if (typeof taskLimit === "number") {
    if (taskLimit === 0) return 0;
    if (Number.isInteger(taskLimit) && taskLimit > 0) return taskLimit;
    throw new Error("taskLimit must be a positive integer when provided");
  }

  const normalized = String(taskLimit).trim();
  if (normalized === "") return null;
  if (/^[1-9]\d*$/.test(normalized)) return Number.parseInt(normalized, 10);

  throw new Error("taskLimit must be a positive integer when provided");
}

function parsePositiveIntegerOption(value, optionName) {
  const normalized = String(value ?? "").trim();
  if (/^[1-9]\d*$/.test(normalized)) return Number.parseInt(normalized, 10);
  throw new Error(`${optionName} must be a positive integer`);
}

export function selectMergeQueuePlan({ taskPlan, observedTasks = {}, liveWorkspacePaths } = {}) {
  if (!taskPlan?.tasks) {
    return {
      finalizeOrder: [],
      refreshAfterMerge: [],
      skipped: [],
    };
  }

  const finalizeOrder = [];
  const skipped = [];
  const readyTaskIds = [...taskPlan.tasks.keys()]
    .filter((taskId) => !isEffectivelyDone(taskPlan, observedTasks, taskId))
    .filter((taskId) => isMergeQueueReadyStatus(observedStatus(observedTasks, taskId)))
    .sort((left, right) => {
      const leftTask = taskPlan.tasks.get(normalizeTaskId(left));
      const rightTask = taskPlan.tasks.get(normalizeTaskId(right));
      const leftPriority = leftTask?.priority ?? Number.POSITIVE_INFINITY;
      const rightPriority = rightTask?.priority ?? Number.POSITIVE_INFINITY;
      return leftPriority - rightPriority || normalizeTaskId(left).localeCompare(normalizeTaskId(right));
    });

  for (const taskId of readyTaskIds) {
    if (isEffectivelyDone(taskPlan, observedTasks, taskId)) continue;

    const taskStatus = String(observedStatus(observedTasks, taskId) ?? "").toLowerCase();
    const session = sessionForIssue(observedTasks, taskId);
    if (!session?.workspacePath && !session?.readyArtifact) {
      skipped.push({ id: normalizeTaskId(taskId), reason: "ready_missing_workspace" });
      continue;
    }
    if (taskStatus === "in_review" && isWorkerOwnedMergeCandidate(session, liveWorkspacePaths)) {
      skipped.push({ id: normalizeTaskId(taskId), reason: "worker_active" });
      continue;
    }

    finalizeOrder.push(normalizeTaskId(taskId));
  }

  return {
    finalizeOrder,
    refreshAfterMerge: finalizeOrder.map((taskId) => {
      const taskIndex = finalizeOrder.findIndex((currentTaskId) => normalizeTaskId(currentTaskId) === taskId);
      return {
        after: taskId,
        issueIds: finalizeOrder
          .slice(taskIndex + 1)
          .map(normalizeTaskId),
      };
    }),
    skipped,
  };
}

export function normalizeSessionsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export function selectLaunchPlan({
  runnableIssues,
  sessions,
  observedTasks = {},
  concurrency,
  recoverOnly = false,
  taskLimit,
  chargedTaskIds = [],
  liveWorkspacePaths,
}) {
  const normalizedConcurrency = resolveLaunchConcurrency(concurrency, runnableIssues);
  const normalizedTaskLimit = normalizeTaskLimit(taskLimit);
  const normalizedChargedTaskIds = [...new Set(chargedTaskIds.map(normalizeTaskId).filter(Boolean))];
  const chargedIssueIds = new Set(normalizedChargedTaskIds);
  const activeSessions = normalizeSessionsPayload(sessions)
    .filter((session) => isActiveWorkerSession(session, liveWorkspacePaths))
    .map(sessionSummary)
    .filter((session) => session.issueId);
  const activeIssueIds = new Set(activeSessions.map((session) => session.issueId));
  const readyIssueIds = new Set(normalizeSessionsPayload(sessions)
    .filter(isReadyWorkerSession)
    .map((session) => normalizeTaskId(session.issueId ?? session.issue))
    .filter(Boolean));
  const availableSlots = Math.max(0, normalizedConcurrency - activeSessions.length);
  const availableTaskSlots = normalizedTaskLimit === null
    ? availableSlots
    : Math.min(availableSlots, Math.max(0, normalizedTaskLimit - chargedIssueIds.size));
  const toLaunch = [];
  const toResume = [];
  const newlyChargedIssueIds = new Set();
  const skipped = [];

  for (const issue of runnableIssues) {
    const issueId = normalizeTaskId(issue.id);
    const observedTask = observedTasks[issueId];
    const observedStatus = String(observedTask?.status ?? "").toLowerCase();
    const scheduledCount = () => toLaunch.length + toResume.length;
    const consumesTaskBudget = () => !chargedIssueIds.has(issueId) && !newlyChargedIssueIds.has(issueId);
    const taskBudgetExhausted = () => normalizedTaskLimit !== null
      && consumesTaskBudget()
      && newlyChargedIssueIds.size >= availableTaskSlots;

    if (observedStatus === "done" || observedStatus === "merged") {
      skipped.push({ id: issueId, reason: `observed_${observedStatus}` });
      continue;
    }

    if (activeIssueIds.has(issueId)) {
      skipped.push({ id: issueId, reason: "already_active" });
      continue;
    }

    if (readyIssueIds.has(issueId)) {
      skipped.push({ id: issueId, reason: "already_ready" });
      continue;
    }

    const recoverableSession = recoverableSessionForIssue(sessions, issueId);
    if (recoverableSession) {
      if (!recoverableSession.workspacePath) {
        skipped.push({
          id: issueId,
          reason: "resume_missing_workspace",
          sessionId: recoverableSession.id ?? null,
          status: recoverableSession.status ?? null,
        });
        continue;
      }

      if (scheduledCount() >= availableSlots) {
        skipped.push({ id: issueId, reason: "concurrency_limit" });
        continue;
      }

      if (taskBudgetExhausted()) {
        skipped.push({ id: issueId, reason: "task_limit" });
        continue;
      }

      toResume.push({
        ...issueSummary(issue),
        sessionId: recoverableSession.id,
        workspacePath: recoverableSession.workspacePath,
        previousStatus: recoverableSession.status,
      });
      if (!chargedIssueIds.has(issueId)) newlyChargedIssueIds.add(issueId);
      continue;
    }

    if (NON_LAUNCHABLE_OBSERVED_STATUSES.has(observedStatus) && !canFreshLaunchObservedFailure(observedTask)) {
      skipped.push({ id: issueId, reason: `observed_${observedStatus}` });
      continue;
    }

    if (recoverOnly) {
      skipped.push({ id: issueId, reason: "recover_only" });
      continue;
    }

    if (scheduledCount() >= availableSlots) {
      skipped.push({ id: issueId, reason: "concurrency_limit" });
      continue;
    }

    if (taskBudgetExhausted()) {
      skipped.push({ id: issueId, reason: "task_limit" });
      continue;
    }

    toLaunch.push(issueSummary(issue));
    if (!chargedIssueIds.has(issueId)) newlyChargedIssueIds.add(issueId);
  }

  return {
    concurrency: normalizedConcurrency,
    availableSlots,
    taskLimit: normalizedTaskLimit,
    chargedTaskIds: normalizedChargedTaskIds,
    availableTaskSlots,
    activeSessions,
    toLaunch,
    toResume,
    skipped,
  };
}

export function isProjectComplete({ observabilityState, launchPlan } = {}) {
  const summary = observabilityState?.summary ?? {};
  const activeCount = [
    "ready",
    "ready_to_merge",
    "running",
    "blocked",
    "stale",
    "failed",
    "queued",
  ].reduce((total, key) => total + (summary[key] ?? 0), 0);

  return (summary.total ?? 0) > 0
    && activeCount === 0
    && (launchPlan?.toLaunch?.length ?? 0) === 0
    && (launchPlan?.toResume?.length ?? 0) === 0
    && (launchPlan?.activeSessions?.length ?? 0) === 0
    && (launchPlan?.mergeQueue?.finalizeOrder?.length ?? 0) === 0;
}

export function reconcileRunnerSnapshot(state, observabilityState, options = {}) {
  const now = options.now ?? (() => new Date());
  const summary = observabilityState?.summary ?? {};
  const total = Number(summary.total ?? 0);
  const merged = Number(summary.merged ?? 0);
  const complete = total > 0 && merged === total;
  const launchPlan = state?.launchPlan ?? {};
  const mergeQueue = launchPlan.mergeQueue ?? state?.mergeQueue ?? {};

  return {
    ...state,
    updatedAt: now().toISOString(),
    complete,
    runnable: complete ? [] : [...(state?.runnable ?? [])],
    launchPlan: complete
      ? {
          ...launchPlan,
          toLaunch: [],
          toResume: [],
          activeSessions: [],
          mergeQueue: {
            ...mergeQueue,
            finalizeOrder: [],
            refreshAfterMerge: [],
          },
        }
      : launchPlan,
    mergeQueue: complete
      ? {
          ...(state?.mergeQueue ?? mergeQueue),
          finalizeOrder: [],
          refreshAfterMerge: [],
        }
      : state?.mergeQueue,
    finalObservation: {
      total,
      merged,
      queued: Number(summary.queued ?? 0),
      running: Number(summary.running ?? 0),
      inReview: Number(summary.in_review ?? 0),
      readyToMerge: Number(summary.ready_to_merge ?? 0),
      merging: Number(summary.merging ?? 0),
      failed: Number(summary.failed ?? 0),
      needsInput: Number(summary.needs_input ?? 0),
    },
  };
}

async function defaultListSessions({ project, transport }) {
  const payload = await transport.sessionList({ projectId: project.id, includeTerminated: true });
  return enrichSessionsWithLocalLifecycle(payload);
}

async function readSessionReadyArtifact(session) {
  if (!session?.id || !session?.projectId) return null;

  try {
    return JSON.parse(await readFile(readyArtifactPath(session.projectId, session.id), "utf8"));
  } catch {
    return null;
  }
}

async function enrichSessionsWithLocalLifecycle(payload) {
  const sessions = normalizeSessionsPayload(payload);
  const enrichedSessions = await Promise.all(sessions.map(async (session) => {
    const readyArtifact = await readSessionReadyArtifact(session);
    const status = String(session.status ?? "").toLowerCase();

    return {
      ...session,
      ...(readyArtifact && !["done", "merged"].includes(status)
        ? { status: "ready_to_merge", readyArtifact }
        : {}),
    };
  }));

  if (Array.isArray(payload)) return enrichedSessions;
  return { ...payload, data: enrichedSessions };
}

export async function spawnAoIssues(
  issues,
  {
    cwd,
    aoCommand,
    project,
    sessions = [],
    transport,
    spawnDelayMs = 0,
    sleep: wait = sleep,
  } = {},
) {
  if (issues.length === 0) return null;
  const ao = transport ?? createAoTransport({ cwd, aoCommand });
  const reservedSessions = [...normalizeSessionsPayload(sessions)];
  const spawned = [];

  for (const [index, issue] of issues.entries()) {
    if (index > 0 && spawnDelayMs > 0) {
      await wait(spawnDelayMs);
    }

    const sessionId = buildAvailableWorkerSessionId(project, issue, reservedSessions);
    reservedSessions.push({ id: sessionId });
    const result = await ao.spawn({
      projectId: project.id,
      issueId: issue.id,
      sessionId,
      harness: "external",
      branch: issue.branchName,
      prompt: issue.prompt,
      displayName: buildAoDisplayName(issue),
    });
    spawned.push({
      issueId: issue.id,
      sessionId: result?.id ?? sessionId,
      stdout: "",
      stderr: "",
    });
  }

  return { spawned };
}

async function readTextIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function archonHome() {
  return process.env.ARCHON_HOME || join(process.env.HOME || "", ".archon");
}

function archonDbPath() {
  return process.env.ARCHON_DB_PATH || join(archonHome(), "archon.db");
}

function sqliteLiteral(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function timestampSlug(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function defaultRunSqlite(args, { dbPath = archonDbPath() } = {}) {
  const { stdout } = await execFileAsync("sqlite3", [dbPath, ...args], { encoding: "utf8" });
  return stdout;
}

function isSqliteBusyError(error) {
  const text = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
  return /\bdatabase is locked\b|\bSQLITE_BUSY\b/i.test(text);
}

async function runSqliteWithBusyRetry(runSqlite, args, { retries = 5, delayMs = 100 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runSqlite(args);
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= retries) throw error;
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}

async function resetArchonLogCheckpoints({ workspacePath, runId, backupDir }) {
  const logPath = join(workspacePath, ".archon/logs", `${runId}.jsonl`);
  const logText = await readTextIfExists(logPath);
  if (logText == null) return { logPath, removedLogEvents: 0 };

  await copyFile(logPath, join(backupDir, `${runId}.jsonl`));

  let removedLogEvents = 0;
  const retainedLines = logText.split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return true;
    }
    const step = event.step ?? event.step_name;
    if (FRONTEND_QA_RESUME_RESET_STEPS.has(step)) {
      removedLogEvents += 1;
      return false;
    }
    return true;
  });

  await writeFile(logPath, `${retainedLines.join("\n")}${retainedLines.length > 0 ? "\n" : ""}`, "utf8");
  return { logPath, removedLogEvents };
}

async function readFirstExistingText(workspacePath, relativePaths) {
  for (const relativePath of relativePaths) {
    const absolutePath = join(workspacePath, relativePath);
    const text = await readTextIfExists(absolutePath);
    if (text != null) return { relativePath, absolutePath, text };
  }
  return null;
}

export async function resetStaleFrontendQaResumeState(issue, options = {}) {
  const workspacePath = issue?.workspacePath;
  if (!workspacePath) return null;

  const [resultArtifact, statusArtifact] = await Promise.all([
    readFirstExistingText(workspacePath, QA_RESULT_PATHS),
    readFirstExistingText(workspacePath, QA_STATUS_PATHS),
  ]);

  if (!/^(QA_BLOCKED\b|QA blocked\b)/im.test(String(resultArtifact?.text ?? ""))) return null;
  if (/^QA_PASSED\s*$/m.test(String(statusArtifact?.text ?? ""))) return null;

  const dbPath = options.dbPath ?? archonDbPath();
  const runSqlite = options.runSqlite ?? ((args) => defaultRunSqlite(args, { dbPath }));
  const backupRoot = options.backupRoot ?? join(archonHome(), "backups");
  const backupDir = join(backupRoot, `dark-factory-qa-retry-${timestampSlug(options.now?.() ?? new Date())}`);
  const workflowName = options.workflowName ?? "auto-feature";
  const latestRunQuery = [
    "-noheader",
    "-batch",
    `select id from remote_agent_workflow_runs
       where workflow_name=${sqliteLiteral(workflowName)}
         and working_path=${sqliteLiteral(workspacePath)}
         and status in ('failed','needs_input','blocked','waiting','paused')
       order by started_at desc
       limit 1;`,
  ];
  const sqliteRetryOptions = {
    retries: options.sqliteBusyRetries ?? 5,
    delayMs: options.sqliteBusyRetryDelayMs ?? 100,
  };
  const runId = String(await runSqliteWithBusyRetry(runSqlite, latestRunQuery, sqliteRetryOptions)).trim();
  if (!runId) return null;

  const qaCompletedCount = Number.parseInt(String(await runSqliteWithBusyRetry(runSqlite, [
    "-noheader",
    "-batch",
    `select count(*) from remote_agent_workflow_events
       where workflow_run_id=${sqliteLiteral(runId)}
         and event_type in ('node_completed','node_complete','node_skipped_prior_success')
         and step_name='QA';`,
  ], sqliteRetryOptions)).trim(), 10) || 0;
  if (qaCompletedCount === 0) return null;

  await mkdir(backupDir, { recursive: true });
  await Promise.all([
    copyFile(dbPath, join(backupDir, "archon.db")).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    }),
    copyFile(resultArtifact.absolutePath, join(backupDir, basename(resultArtifact.relativePath))).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    }),
    statusArtifact
      ? copyFile(statusArtifact.absolutePath, join(backupDir, basename(statusArtifact.relativePath))).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        })
      : Promise.resolve(),
  ]);

  const resetStepList = [...FRONTEND_QA_RESUME_RESET_STEPS].map(sqliteLiteral).join(",");
  await runSqliteWithBusyRetry(runSqlite, [
    "-batch",
    `delete from remote_agent_workflow_events
       where workflow_run_id=${sqliteLiteral(runId)}
         and step_name in (${resetStepList});`,
  ], sqliteRetryOptions);
  const logReset = await resetArchonLogCheckpoints({ workspacePath, runId, backupDir });

  await rename(resultArtifact.absolutePath, `${resultArtifact.absolutePath}.stale-${timestampSlug(options.now?.() ?? new Date())}`).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });

  return {
    issueId: issue.id,
    sessionId: issue.sessionId,
    workspacePath,
    workflowRunId: runId,
    backupDir,
    removedLogEvents: logReset.removedLogEvents,
    action: "reset_stale_frontend_qa",
  };
}

export async function restoreAoSessions(
  issues,
  {
    cwd,
    aoCommand,
    transport,
    prepareSessionRestore = resetStaleFrontendQaResumeState,
    detectLiveWorkerPaths = detectLiveWorkerWorkspacePaths,
  } = {},
) {
  if (issues.length === 0) return null;
  const ao = transport ?? createAoTransport({ cwd, aoCommand });

  const results = await Promise.all(issues.map(async (issue) => {
    try {
      const preflight = await prepareSessionRestore(issue);
      let recovery = null;
      try {
        await ao.sessionRestore(issue.sessionId);
      } catch (error) {
        if (error?.code !== "SESSION_NOT_RESTORABLE") throw error;

        const liveWorkerPaths = await detectLiveWorkerPaths({ sessions: [issue] });
        if (hasLiveWorkspaceProcess(issue, liveWorkerPaths)) throw error;

        const suspended = await ao.sessionSuspend(issue.sessionId);
        await ao.sessionRestore(issue.sessionId);
        recovery = {
          action: "suspend_then_restore",
          suspended: Boolean(suspended?.suspended),
          preserved: Boolean(suspended?.preserved),
        };
      }
      return {
        ok: true,
        issueId: issue.id,
        sessionId: issue.sessionId,
        stdout: "",
        stderr: "",
        ...(preflight ? { preflight } : {}),
        ...(recovery ? { recovery } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        issueId: issue.id,
        sessionId: issue.sessionId,
        message: errorMessage(error),
      };
    }
  }));

  const restored = results.filter((result) => result.ok).map(({ ok, ...result }) => result);
  const errors = results.filter((result) => !result.ok).map(({ ok, ...result }) => result);

  return { restored, errors };
}

async function readTaskPlan(project) {
  try {
    return parsePlanningFile(project);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function defaultRunGit(projectPath, args) {
  const { stdout } = await execFileAsync("git", ["-C", projectPath, ...args], { encoding: "utf8" });
  return stdout;
}

async function defaultRunGh(workspacePath, args) {
  const { stdout } = await execFileAsync("gh", args, {
    cwd: workspacePath,
    encoding: "utf8",
    timeout: GITHUB_CLI_TIMEOUT_MS,
  });
  return stdout;
}

function trimOutput(value) {
  return String(value ?? "").trim();
}

export async function findStaleLaunchWorkspaces(issues, { sessions = [], project = {}, runWorkspaceGit } = {}) {
  if (!issues?.length) return [];

  const runGit = runWorkspaceGit ?? ((workspacePath, args) => defaultRunGit(workspacePath, args));
  const defaultBranch = project.defaultBranch ?? "main";
  const stale = [];

  for (const issue of issues) {
    const issueId = normalizeTaskId(issue.id);
    const matchingSessions = normalizeSessionsPayload(sessions)
      .filter((session) => normalizeTaskId(session.issueId ?? session.issue) === issueId)
      .filter((session) => TERMINAL_STATUSES.has(String(session.status ?? "").toLowerCase()))
      .filter((session) => session.workspacePath);

    for (const session of matchingSessions) {
      try {
        await runGit(session.workspacePath, ["fetch", "origin", defaultBranch, "--quiet"]);
        await runGit(session.workspacePath, ["merge-base", "--is-ancestor", `origin/${defaultBranch}`, "HEAD"]);
      } catch (error) {
        if (isMissingWorkspaceError(error)) continue;
        stale.push({
          id: issueId,
          reason: "stale_existing_workspace",
          sessionId: session.id ?? null,
          workspacePath: session.workspacePath,
        });
        break;
      }
    }
  }

  return stale;
}

async function prepareFreshLaunchBranches(issues, {
  observedTasks = {},
  project = {},
  dryRun = true,
  runProjectGit,
  runDocker,
} = {}) {
  if (!issues?.length || dryRun || !project?.path) {
    return { issues: issues ?? [], skipped: [] };
  }

  const runGit = runProjectGit ?? ((args) => defaultRunGit(project.path, args));
  const defaultBranch = project.defaultBranch ?? "main";
  const prepared = [];
  const skipped = [];

  for (const issue of issues) {
    const issueId = normalizeTaskId(issue.id);
    const observedTask = observedTasks[issueId];
    const branch = String(issue.branchName ?? "").trim();

    if (!branch || !canFreshLaunchObservedFailure(observedTask)) {
      prepared.push(issue);
      continue;
    }

    try {
      const localBranches = new Set(outputLines(await runGit([
        "branch",
        "--list",
        branch,
        "--format=%(refname:short)",
      ])));

      const remoteBranches = outputLines(await runGit([
        "branch",
        "-r",
        "--list",
        `*/${branch}`,
        "--format=%(refname:short)",
      ]));
      if (remoteBranches.length > 0) {
        skipped.push({ id: issueId, reason: "retry_branch_has_remote", branchName: branch });
        continue;
      }

      if (localBranches.has(branch)) {
        const mergedBranches = new Set(outputLines(await runGit([
          "branch",
          "--merged",
          defaultBranch,
          "--list",
          branch,
          "--format=%(refname:short)",
        ])));
        if (!mergedBranches.has(branch)) {
          skipped.push({ id: issueId, reason: "retry_branch_not_merged", branchName: branch });
          continue;
        }

        const activeBranches = parseWorktreeBranches(await runGit(["worktree", "list", "--porcelain"]));
        if (activeBranches.has(branch)) {
          skipped.push({ id: issueId, reason: "retry_branch_checked_out", branchName: branch });
          continue;
        }

        await runGit(["branch", "-d", branch]);
      }

      const resourceCleanupError = await cleanupFreshLaunchResources(issue, observedTask, { runDocker });
      if (resourceCleanupError) {
        skipped.push(resourceCleanupError);
        continue;
      }

      prepared.push(issue);
    } catch (error) {
      skipped.push({
        id: issueId,
        reason: "retry_branch_cleanup_failed",
        branchName: branch,
        error: errorMessage(error),
      });
    }
  }

  return { issues: prepared, skipped };
}

function readyArtifactPath(projectId, sessionId, options = {}) {
  const compatibilityRoot = options.compatibilityStatePath
    ?? options.aoHome
    ?? process.env.DARK_FACTORY_COMPAT_STATE_PATH
    ?? resolve(".dark-factory/compat/agent-orchestrator");
  return join(compatibilityRoot, "projects", projectId, "sessions", `${sessionId}.ready.json`);
}

async function defaultReadReadyArtifact(issue, options = {}) {
  const observedArtifact = issue?.readyArtifact ?? null;
  const projectId = options.project?.id ?? issue?.projectId;
  if (!projectId) {
    if (observedArtifact) return observedArtifact;
    throw new Error(`Cannot verify ${issue?.id ?? "issue"} readiness: missing Dark Factory project id.`);
  }
  if (!issue?.sessionId) {
    if (observedArtifact) return observedArtifact;
    throw new Error(`Cannot verify ${issue?.id ?? "issue"} readiness: missing AO session id.`);
  }

  try {
    return JSON.parse(await readFile(readyArtifactPath(projectId, issue.sessionId, options), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return observedArtifact;
    throw error;
  }
}

export async function refreshReadyArtifactAfterPrepare(issue, options = {}) {
  const projectId = options.project?.id ?? issue?.projectId;
  if (!projectId) throw new Error(`Cannot refresh ${issue?.id ?? "issue"} ready artifact: missing Dark Factory project id.`);
  if (!issue?.sessionId) throw new Error(`Cannot refresh ${issue?.id ?? "issue"} ready artifact: missing AO session id.`);
  if (!issue?.workspacePath) throw new Error(`Cannot refresh ${issue?.id ?? "issue"} ready artifact: missing AO workspace path.`);

  const runGit = options.runWorkspaceGit ?? ((workspacePath, args) => defaultRunGit(workspacePath, args));
  const branch = trimOutput(await runGit(issue.workspacePath, ["branch", "--show-current"]))
    || trimOutput(issue.branchName)
    || trimOutput(issue.branch);
  if (!branch) throw new Error(`Cannot refresh ${issue.id} ready artifact: missing branch.`);

  const localHead = trimOutput(await runGit(issue.workspacePath, ["rev-parse", "HEAD"]));
  await runGit(issue.workspacePath, ["fetch", "origin", branch, "--quiet"]);
  const remoteHead = trimOutput(await runGit(issue.workspacePath, ["rev-parse", `origin/${branch}`]));
  const pr = await defaultGetPullRequestReadiness({ ...issue, branchName: branch }, { branch, pr: issue.pr }, options);
  const readyPath = readyArtifactPath(projectId, issue.sessionId, options);
  const now = options.now ?? (() => new Date());
  let previousArtifact = {};
  try {
    previousArtifact = JSON.parse(await readFile(readyPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const prNumber = pr.number ?? issue.pr?.number ?? previousArtifact.pr?.number ?? null;
  const transitionKey = [projectId, issue.id, prNumber ?? "no-pr", remoteHead].join(":");
  const artifact = {
    ...previousArtifact,
    version: Math.max(2, Number(previousArtifact.version ?? 0)),
    projectId,
    sessionId: issue.sessionId,
    issueId: issue.id,
    transitionKey,
    branch,
    localHead,
    remoteHead,
    pr: {
      ...(previousArtifact.pr ?? {}),
      number: prNumber,
      url: pr.url ?? issue.pr?.url ?? previousArtifact.pr?.url ?? null,
      state: pr.state ?? previousArtifact.pr?.state ?? null,
      headRefOid: pr.headRefOid ?? previousArtifact.pr?.headRefOid ?? null,
      mergeStateStatus: pr.mergeStateStatus ?? previousArtifact.pr?.mergeStateStatus ?? null,
    },
    preparedAt: previousArtifact.transitionKey === transitionKey && previousArtifact.preparedAt
      ? previousArtifact.preparedAt
      : now().toISOString(),
  };

  await mkdir(dirname(readyPath), { recursive: true });
  await writeFile(readyPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

function prReference(issue, readyArtifact) {
  return issue?.pr?.url
    ?? issue?.pr?.number
    ?? readyArtifact?.pr?.url
    ?? readyArtifact?.pr?.number
    ?? readyArtifact?.branch
    ?? null;
}

async function defaultGetPullRequestReadiness(issue, readyArtifact, options = {}) {
  const reference = prReference(issue, readyArtifact);
  if (!reference) throw new Error(`Cannot verify ${issue.id} readiness: missing PR reference.`);

  const runGh = options.runGh ?? ((workspacePath, args) => defaultRunGh(workspacePath, args));
  const ghCwd = issue.workspacePath ?? options.project?.path ?? process.cwd();
  const stdout = await runGh(ghCwd, [
    "pr",
    "view",
    String(reference),
    "--json",
    "number,url,state,headRefOid,mergeStateStatus,statusCheckRollup",
  ]);
  const pr = JSON.parse(stdout);
  const currentChecks = await currentPullRequestChecks(runGh, ghCwd, reference);
  return currentChecks ? { ...pr, currentChecks } : pr;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function currentPullRequestChecks(runGh, ghCwd, reference) {
  const args = [
    "pr",
    "checks",
    String(reference),
    "--json",
    "bucket,name,state,workflow,link",
  ];

  try {
    return parseJsonArray(await runGh(ghCwd, args));
  } catch (error) {
    return parseJsonArray(error?.stdout);
  }
}

function successfulCheck(check) {
  const bucket = String(check?.bucket ?? "").toLowerCase();
  if (bucket) return bucket === "pass" || bucket === "skipping";

  const conclusion = String(check?.conclusion ?? "").toUpperCase();
  if (conclusion) return ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conclusion);

  const state = String(check?.state ?? "").toUpperCase();
  if (state) return state === "SUCCESS";

  const status = String(check?.status ?? "").toUpperCase();
  if (status) return ["COMPLETED", "SUCCESS"].includes(status);

  return true;
}

function pendingCheck(check) {
  const bucket = String(check?.bucket ?? "").toLowerCase();
  if (bucket) return ["pending", "waiting"].includes(bucket);

  const conclusion = String(check?.conclusion ?? "").toUpperCase();
  if (conclusion) return false;

  const state = String(check?.state ?? "").toUpperCase();
  if (["EXPECTED", "PENDING"].includes(state)) return true;

  const status = String(check?.status ?? "").toUpperCase();
  return ["EXPECTED", "IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"].includes(status);
}

function checkLabel(check) {
  return check?.name ?? check?.context ?? check?.workflowName ?? check?.__typename ?? "unknown check";
}

function blockingChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.filter((check) => !successfulCheck(check) && !pendingCheck(check));
}

function pendingChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.filter(pendingCheck);
}

function assertReadyArtifact(issue, readyArtifact) {
  if (!readyArtifact || typeof readyArtifact !== "object") {
    throw new Error(`Cannot merge ${issue.id}: missing ready artifact.`);
  }

  if (readyArtifact.issueId && normalizeTaskId(readyArtifact.issueId) !== issue.id) {
    throw new Error(`Cannot merge ${issue.id}: ready artifact belongs to ${readyArtifact.issueId}.`);
  }

  if (readyArtifact.sessionId && issue.sessionId && readyArtifact.sessionId !== issue.sessionId) {
    throw new Error(`Cannot merge ${issue.id}: ready artifact belongs to session ${readyArtifact.sessionId}.`);
  }
}

function assertPullRequestReady(issue, pr, remoteHead) {
  if (!pr || typeof pr !== "object") {
    throw new Error(`Cannot merge ${issue.id}: missing PR readiness data.`);
  }

  const state = String(pr.state ?? "").toUpperCase();
  if (state && state !== "OPEN") {
    throw new Error(`Cannot merge ${issue.id}: PR state is ${state}.`);
  }

  if (pr.headRefOid && trimOutput(pr.headRefOid) !== remoteHead) {
    throw new Error(`Cannot merge ${issue.id}: PR head ${trimOutput(pr.headRefOid)} does not match remote branch ${remoteHead}.`);
  }

  const mergeState = String(pr.mergeStateStatus ?? "").toUpperCase();
  if (mergeState && !["CLEAN", "HAS_HOOKS"].includes(mergeState)) {
    throw new Error(`Cannot merge ${issue.id}: PR merge state is ${mergeState}.`);
  }

  const pending = pendingChecks(pr.currentChecks ?? pr.statusCheckRollup);
  if (pending.length > 0) {
    throw new Error(`Cannot merge ${issue.id}: PR checks are still pending (${pending.slice(0, 3).map(checkLabel).join(", ")}).`);
  }

  const failedChecks = blockingChecks(pr.currentChecks ?? pr.statusCheckRollup);
  if (failedChecks.length > 0) {
    throw new Error(`Cannot merge ${issue.id}: PR checks are not green (${failedChecks.slice(0, 3).map(checkLabel).join(", ")}).`);
  }
}

function branchFromIssueOrArtifact(issue, readyArtifact) {
  return trimOutput(
    readyArtifact?.branch
      ?? issue?.branchName
      ?? issue?.branch
      ?? issue?.headRefName
      ?? "",
  );
}

export async function validateTrackerMergeCandidate(issue, options = {}) {
  const project = options.project;
  if (!project?.path) {
    throw new Error(`Cannot merge ${issue?.id ?? "issue"}: missing project path for tracker validation.`);
  }

  const branch = branchFromIssueOrArtifact(issue, issue?.readyArtifact);
  if (!branch) {
    throw new Error(`Cannot merge ${issue?.id ?? "issue"}: missing candidate branch for tracker validation.`);
  }

  const defaultBranch = project.defaultBranch ?? "main";
  const tasksPath = String(project.tracker?.tasksPath ?? "planning/roadmap/tasks.md");
  const runGit = options.runProjectGit ?? ((args) => defaultRunGit(project.path, args));

  try {
    await runGit(["fetch", "origin", "--quiet"]);
  } catch (error) {
    throw new Error(
      `Cannot merge ${issue.id}: unable to fetch origin refs origin/${defaultBranch} and origin/${branch} for tracker validation: ${errorMessage(error)}`,
    );
  }

  let mergedTree;
  try {
    mergedTree = outputLines(await runGit([
      "merge-tree",
      "--write-tree",
      `origin/${defaultBranch}`,
      `origin/${branch}`,
    ]))[0];
  } catch (error) {
    throw new Error(
      `Cannot merge ${issue.id}: unable to synthesize ${defaultBranch} with ${branch} for tracker validation: ${errorMessage(error)}`,
    );
  }

  if (!mergedTree) {
    throw new Error(`Cannot merge ${issue.id}: Git returned no merged tree for tracker validation.`);
  }

  let content;
  try {
    content = await runGit(["show", `${mergedTree}:${tasksPath}`]);
  } catch (error) {
    throw new Error(
      `Cannot merge ${issue.id}: cannot read merged planning tracker ${tasksPath}: ${errorMessage(error)}`,
    );
  }

  try {
    const taskPlan = parsePlanningContent(content, {
      tasksPath,
      absoluteTasksPath: resolve(project.path, tasksPath),
    });
    return {
      checked: true,
      branch,
      defaultBranch,
      mergedTree,
      tasksPath,
      taskCount: taskPlan.tasks.size,
    };
  } catch (error) {
    throw new Error(
      `Cannot merge ${issue.id}: merged planning tracker ${tasksPath} is invalid: ${errorMessage(error)}`,
    );
  }
}

function isMissingWorkspaceError(error) {
  const message = String(error?.message ?? error ?? "");
  return /cannot change to|No such file or directory|ENOENT/i.test(message);
}

export async function assertWorkspaceReadyForMerge(issue, options = {}) {
  const readReadyArtifact = options.readReadyArtifact ?? ((currentIssue) => defaultReadReadyArtifact(currentIssue, options));
  const readyArtifact = await readReadyArtifact(issue, options);
  assertReadyArtifact(issue, readyArtifact);

  const runGit = options.runWorkspaceGit ?? ((workspacePath, args) => defaultRunGit(workspacePath, args));
  let localHead = null;
  let branch = branchFromIssueOrArtifact(issue, readyArtifact);
  let workspaceChecked = false;

  if (issue?.workspacePath) {
    try {
      localHead = trimOutput(await runGit(issue.workspacePath, ["rev-parse", "HEAD"]));
      branch = trimOutput(await runGit(issue.workspacePath, ["branch", "--show-current"])) || branch;
      workspaceChecked = true;
    } catch (error) {
      if (!isMissingWorkspaceError(error)) throw error;
    }
  }

  if (!branch) {
    throw new Error(`Cannot merge ${issue.id}: workspace is detached and ready artifact has no branch.`);
  }

  const remoteGitCwd = workspaceChecked ? issue.workspacePath : options.project?.path;
  if (!remoteGitCwd) {
    throw new Error(`Cannot inspect ${issue?.id ?? "issue"} remote branch: missing AO workspace path and project path.`);
  }

  await runGit(remoteGitCwd, ["fetch", "origin", branch, "--quiet"]);
  const remoteHead = trimOutput(await runGit(remoteGitCwd, ["rev-parse", `origin/${branch}`]));

  if (workspaceChecked && localHead !== remoteHead) {
    throw new Error(`Cannot merge ${issue.id}: local HEAD ${localHead} does not match remote branch ${remoteHead}.`);
  }

  if (readyArtifact.localHead && trimOutput(readyArtifact.localHead) !== (workspaceChecked ? localHead : remoteHead)) {
    throw new Error(`Cannot merge ${issue.id}: ready artifact HEAD ${trimOutput(readyArtifact.localHead)} does not match ${workspaceChecked ? `local HEAD ${localHead}` : `remote branch ${remoteHead}`}.`);
  }

  if (readyArtifact.remoteHead && trimOutput(readyArtifact.remoteHead) !== remoteHead) {
    throw new Error(`Cannot merge ${issue.id}: ready artifact remote HEAD ${trimOutput(readyArtifact.remoteHead)} does not match remote branch ${remoteHead}.`);
  }

  if (readyArtifact.pr?.headRefOid && trimOutput(readyArtifact.pr.headRefOid) !== remoteHead) {
    throw new Error(`Cannot merge ${issue.id}: ready artifact PR head ${trimOutput(readyArtifact.pr.headRefOid)} does not match remote branch ${remoteHead}.`);
  }

  const getPullRequestReadiness = options.getPullRequestReadiness
    ?? ((currentIssue, currentReadyArtifact) => defaultGetPullRequestReadiness(currentIssue, currentReadyArtifact, options));
  const readinessIssue = workspaceChecked ? issue : { ...issue, workspacePath: remoteGitCwd };
  const pr = await getPullRequestReadiness(readinessIssue, readyArtifact, options);
  assertPullRequestReady(issue, pr, remoteHead);

  return {
    checked: true,
    workspacePath: issue.workspacePath,
    workspaceChecked,
    branch,
    localHead,
    remoteHead,
    pr: {
      number: pr.number ?? readyArtifact.pr?.number ?? issue.pr?.number ?? null,
      url: pr.url ?? readyArtifact.pr?.url ?? issue.pr?.url ?? null,
      headRefOid: pr.headRefOid ?? null,
      mergeStateStatus: pr.mergeStateStatus ?? null,
    },
  };
}

function projectLabel(project) {
  return project?.id ?? project?.name ?? project?.path ?? "project";
}

async function hasOriginRemote(runGit) {
  try {
    await runGit(["remote", "get-url", "origin"]);
    return true;
  } catch {
    return false;
  }
}

function normalizePorcelainPath(path) {
  return String(path ?? "")
    .trim()
    .replace(/^"|"$/g, "");
}

function isIgnoredRefreshStatusLine(line) {
  const status = String(line ?? "").slice(0, 2);
  if (status !== "??") return false;

  const path = normalizePorcelainPath(String(line ?? "").slice(3));
  return IGNORED_REFRESH_STATUS_PATHS.has(path)
    || IGNORED_REFRESH_STATUS_DIRS.some((dir) => path === dir || path.startsWith(dir));
}

function actionableStatusLines(statusOutput) {
  return String(statusOutput ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !isIgnoredRefreshStatusLine(line));
}

export async function refreshProjectMain(project, options = {}) {
  if (!project?.path) throw new Error("Cannot refresh project main: missing project.path");

  const defaultBranch = project.defaultBranch ?? "main";
  const projectId = projectLabel(project);
  const runGit = options.runGit ?? ((args) => defaultRunGit(project.path, args));
  const currentBranch = String(await runGit(["branch", "--show-current"])).trim();

  if (currentBranch !== defaultBranch) {
    throw new Error(`Cannot refresh ${projectId} ${defaultBranch}: checkout is on ${currentBranch || "detached HEAD"}`);
  }

  const dirty = actionableStatusLines(await runGit(["status", "--porcelain"]));
  if (dirty.length) {
    throw new Error(`Cannot refresh ${projectId} ${defaultBranch}: checkout has uncommitted changes`);
  }

  if (!await hasOriginRemote(runGit)) {
    return {
      checked: true,
      mode: "local",
      projectId,
      defaultBranch,
    };
  }

  const remoteRef = `origin/${defaultBranch}`;
  await runGit(["fetch", "origin", "--quiet"]);
  const localHead = String(await runGit(["rev-parse", "HEAD"])).trim();
  const remoteHead = String(await runGit(["rev-parse", remoteRef])).trim();

  if (localHead !== remoteHead) {
    try {
      await runGit(["merge-base", "--is-ancestor", "HEAD", remoteRef]);
      await runGit(["merge", "--ff-only", remoteRef]);
    } catch {
      throw new Error(`Cannot refresh ${projectId} ${defaultBranch}: cannot fast-forward ${defaultBranch} from ${remoteRef}`);
    }
  }

  return {
    checked: true,
    mode: "remote",
    projectId,
    defaultBranch,
    remoteRef,
  };
}

async function reconcileProjectAfterMerge({ project }, options = {}) {
  const refresh = await refreshProjectMain(project, options);
  const readPlan = options.readTaskPlan ?? readTaskPlan;
  return {
    refresh,
    taskPlan: await readPlan(project),
  };
}

function autoMergeScriptPath(options = {}) {
  if (options.autoMergeScriptPath) return options.autoMergeScriptPath;
  const skillsDir = process.env.AGENTS_SKILLS_DIR || `${process.env.HOME}/.agents/skills`;
  return resolve(skillsDir, "auto-merge/scripts/auto-merge.mjs");
}

async function runAutoMergeMode(mode, issue, options = {}) {
  const workspace = await ensureIssueWorkspace(issue, options);

  await execFileAsync("node", [autoMergeScriptPath(options), "--mode", mode], {
    cwd: workspace.workspacePath,
    encoding: "utf8",
  });
}

async function defaultFinalizeIssue(issue, options = {}) {
  return runAutoMergeMode("finalize", issue, options);
}

async function defaultPrepareIssue(issue, options = {}) {
  throw new Error(`${WORKER_SESSION_REQUIRED}: merge preparation belongs to the assigned AO worker`);
}

export async function ensureIssueWorkspace(issue, options = {}) {
  if (!issue?.workspacePath) {
    throw new Error(`Cannot restore ${issue?.id ?? "issue"} workspace: missing AO workspace path.`);
  }

  const runWorkspaceGit = options.runWorkspaceGit ?? ((workspacePath, args) => defaultRunGit(workspacePath, args));
  try {
    await runWorkspaceGit(issue.workspacePath, ["rev-parse", "--show-toplevel"]);
    return {
      workspacePath: issue.workspacePath,
      branch: null,
      created: false,
    };
  } catch (error) {
    if (!isMissingWorkspaceError(error)) throw error;
  }

  const readReadyArtifact = options.readReadyArtifact ?? ((currentIssue) => defaultReadReadyArtifact(currentIssue, options));
  const readyArtifact = await readReadyArtifact(issue, options);
  if (readyArtifact) assertReadyArtifact(issue, readyArtifact);

  const branch = branchFromIssueOrArtifact(issue, readyArtifact);
  if (!branch) {
    throw new Error(`Cannot restore ${issue.id} workspace: no ready artifact or persisted session branch.`);
  }

  const projectPath = options.project?.path;
  if (!projectPath) {
    throw new Error(`Cannot restore ${issue.id} workspace: missing project path.`);
  }

  const makeDirectory = options.mkdir ?? mkdir;
  const runProjectGit = options.runProjectGit ?? ((args) => defaultRunGit(projectPath, args));
  let fetched = false;

  if (!readyArtifact) {
    await runProjectGit(["fetch", "origin", branch, "--quiet"]);
    fetched = true;
    const remoteHead = trimOutput(await runProjectGit(["rev-parse", `origin/${branch}`]));
    const getPullRequestReadiness = options.getPullRequestReadiness
      ?? ((currentIssue, currentReadyArtifact) => defaultGetPullRequestReadiness(currentIssue, currentReadyArtifact, options));
    const pr = await getPullRequestReadiness(
      { ...issue, workspacePath: projectPath },
      null,
      options,
    );
    assertPullRequestReady(issue, pr, remoteHead);
  }

  await makeDirectory(dirname(issue.workspacePath), { recursive: true });
  if (!fetched) await runProjectGit(["fetch", "origin", branch, "--quiet"]);
  await runProjectGit(["worktree", "add", issue.workspacePath, branch]);

  return {
    workspacePath: issue.workspacePath,
    branch,
    created: true,
  };
}

function markObservedMerged(observedTasks, issueId) {
  const id = normalizeTaskId(issueId);
  return {
    ...observedTasks,
    [id]: {
      ...(observedTasks?.[id] ?? {}),
      status: "merged",
    },
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function controllerRecovery(issue) {
  return {
    action: "resume_worker_session",
    sessionId: issue?.sessionId ?? null,
    workspacePath: issue?.workspacePath ?? null,
    reason: CONTROLLER_WORKTREE_MUTATION_VIOLATION,
  };
}

function blockedState(issue, phase, reason) {
  return {
    issueId: normalizeTaskId(issue?.id ?? issue?.issueId),
    phase,
    reason,
    recovery: controllerRecovery(issue),
  };
}

function needsWorkerWorkspaceResume(reason) {
  return /tracked working tree changes exist before conflict merge/i.test(String(reason ?? ""))
    || String(reason ?? "").includes(WORKER_SESSION_REQUIRED);
}

function workerPrepareBlockedResult(issue, reason, actions, { ciReason = null, trigger = reason, ciStarted = false } = {}) {
  const issueId = normalizeTaskId(issue?.id ?? issue?.issueId);
  const recovery = {
    ...controllerRecovery(issue),
    ...(needsWorkerWorkspaceResume(reason) ? { allowFullFeatureResume: true } : {}),
  };

  if (ciReason && !ciStarted) {
    actions.push(ciRecoveryAction(issue, {
      phase: "started",
      reason: ciReason,
      trigger,
      recoveryAction: "resume_worker_session",
    }));
  }

  actions.push({
    action: "worker-prepare",
    issueId,
    workspacePath: issue?.workspacePath ?? null,
    blocked: true,
    reason,
    recovery,
  });

  if (ciReason) {
    actions.push(ciRecoveryAction(issue, {
      phase: "blocked",
      reason: ciReason,
      trigger,
      recoveryAction: "resume_worker_session",
      outcome: "worker_resume_required",
      blockedPhase: "worker-prepare",
      error: reason,
    }));
  }

  return {
    attempted: true,
    actions,
    waiting: {
      ...blockedState(issue, "worker-prepare", reason),
      recovery,
    },
    blocked: {
      ...blockedState(issue, "worker-prepare", reason),
      recovery,
    },
  };
}

function mergeQueueRecoveryResumeIssue(blocked, observedTasks = {}) {
  if (!blocked || blocked.phase !== "worker-prepare") return null;
  if (blocked.recovery?.action !== "resume_worker_session") return null;
  if (blocked.recovery?.allowFullFeatureResume !== true) return null;

  const issueId = normalizeTaskId(blocked.issueId);
  const sessionId = blocked.recovery?.sessionId;
  if (!issueId || !sessionId) return null;

  const session = sessionForIssue(observedTasks, issueId);
  return {
    id: issueId,
    sessionId,
    workspacePath: blocked.recovery?.workspacePath ?? session?.workspacePath ?? null,
    previousStatus: session?.status ?? "merge_queue_blocked",
    branchName: session?.branch ?? session?.readyArtifact?.branch ?? null,
    title: session?.title ?? `${issueId} merge recovery`,
    recoveryReason: blocked.reason,
  };
}

function canPrepareBeforeFinalize(reason) {
  const message = String(reason ?? "");
  return /PR merge state is (DIRTY|UNKNOWN|BEHIND|BLOCKED)/i.test(message)
    || /missing ready artifact/i.test(message)
    || /checks?.*(pending|fail(?:ed|ing)?|not[-\s]?green)/i.test(message)
    || /(pending|fail(?:ed|ing)?|not[-\s]?green).*checks?/i.test(message);
}

function canRefreshReadyArtifactBeforeFinalize(reason) {
  return /ready artifact (HEAD|remote HEAD|PR head) .*does not match/i.test(String(reason ?? ""));
}

async function waitForWorkerReadyArtifact(issue, options = {}) {
  const assertWorkspaceReady = options.assertWorkspaceReady;
  if (typeof assertWorkspaceReady !== "function") return false;

  const attempts = Number.isInteger(options.attempts) && options.attempts > 0
    ? options.attempts
    : DEFAULT_WORKER_READY_GRACE_ATTEMPTS;
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 0
    ? options.intervalMs
    : DEFAULT_WORKER_READY_GRACE_INTERVAL_MS;
  const wait = options.sleep ?? sleep;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (intervalMs > 0) await wait(intervalMs);

    try {
      await assertWorkspaceReady(issue);
      return true;
    } catch {
      // Readiness remains unavailable during the bounded worker handoff grace period.
    }
  }

  return false;
}

async function prepareBeforeFinalize(issue, reason, actions, {
  prepareIssue,
  refreshReadyArtifact,
  waitForReadyArtifact,
  ciReason = null,
} = {}) {
  const issueId = normalizeTaskId(issue?.id ?? issue?.issueId);

  if (ciReason) {
    actions.push(ciRecoveryAction(issue, {
      phase: "started",
      reason: ciReason,
      trigger: reason,
      recoveryAction: "merge_queue_prepare_finalize",
    }));
  }

  try {
    await prepareIssue(issue);
    actions.push({ action: "prepare", issueId, workspacePath: issue?.workspacePath ?? null, reason });
  } catch (error) {
    const prepareReason = errorMessage(error);
    if (
      /missing ready artifact/i.test(reason)
      && prepareReason.includes(WORKER_SESSION_REQUIRED)
      && await waitForReadyArtifact(issue)
    ) {
      actions.push({
        action: "worker-ready-grace",
        issueId,
        workspacePath: issue?.workspacePath ?? null,
      });
      return null;
    }
    return workerPrepareBlockedResult(issue, prepareReason, actions, {
      ciReason,
      trigger: reason,
      ciStarted: Boolean(ciReason),
    });
  }

  try {
    const refreshResult = await refreshReadyArtifact(issue);
    actions.push({ action: "ready-artifact", issueId, workspacePath: issue?.workspacePath ?? null, reason: "prepare_before_finalize", ...(refreshResult ?? {}) });
  } catch (error) {
    const refreshReason = errorMessage(error);
    return workerPrepareBlockedResult(issue, refreshReason, actions, {
      ciReason,
      trigger: reason,
      ciStarted: Boolean(ciReason),
    });
  }

  if (ciReason) {
    actions.push(ciRecoveryAction(issue, {
      phase: "completed",
      reason: ciReason,
      trigger: reason,
      recoveryAction: "merge_queue_prepare_finalize",
      outcome: "prepare_completed",
    }));
  }

  return null;
}

function prNumberValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return null;
}

function prUrlValue(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) ?? null;
}

export async function recordAoSessionMerged(issue, options = {}) {
  const projectId = options.project?.id;
  if (!projectId) return { updated: false, reason: "missing_project_id" };
  if (!issue?.sessionId) return { updated: false, reason: "missing_session_id" };

  const path = readyArtifactPath(projectId, issue.sessionId, options);
  let artifact;
  try {
    artifact = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { updated: false, reason: "missing_ready_artifact" };
    throw error;
  }

  const now = options.now ?? (() => new Date());
  const reconciledAt = now().toISOString();
  const mergedAt = issue.pr?.mergedAt ?? artifact.pr?.mergedAt ?? null;
  const prNumber = prNumberValue(issue.pr?.number, artifact.pr?.number);
  const prUrl = prUrlValue(issue.pr?.url, artifact.pr?.url);
  const next = {
    ...artifact,
    status: "merged",
    pr: {
      ...(artifact.pr ?? {}),
      ...(prNumber !== null ? { number: prNumber } : {}),
      ...(prUrl ? { url: prUrl } : {}),
      state: "merged",
      ...(mergedAt ? { mergedAt } : {}),
    },
    darkFactoryMergedAt: reconciledAt,
    darkFactoryMergedIssueId: issue.id,
  };

  await writeRunnerState(path, next);
  return { updated: true, sessionId: issue.sessionId };
}

async function runMergeQueue({
  mergeQueuePlan,
  project,
  taskPlan,
  observedTasks,
  dryRun,
  finalizeIssue,
  assertWorkspaceReady,
  validateTrackerCandidate,
  prepareIssue,
  waitForReadyArtifact,
  prepareWorkspace,
  refreshReadyArtifact,
  recordMergedIssue,
  reconcileAfterMerge,
}) {
  const actions = [];

  if (!mergeQueuePlan.finalizeOrder.length) {
    return {
      attempted: false,
      actions,
    };
  }

  if (dryRun) {
    return {
      attempted: false,
      actions,
    };
  }

  let currentTaskPlan = taskPlan;
  let currentObservedTasks = observedTasks;
  let currentPlan = mergeQueuePlan;
  const preparedBeforeFinalize = new Set();
  const refreshedBeforeFinalize = new Set();

  while (currentPlan.finalizeOrder.length > 0) {
    const issueId = currentPlan.finalizeOrder[0];
    const issue = mergeQueueIssue(currentObservedTasks, issueId);

    try {
      await assertWorkspaceReady(issue);
      actions.push({ action: "workspace-ready", issueId, workspacePath: issue.workspacePath });
    } catch (error) {
      const reason = errorMessage(error);
      const ciReason = ciRecoveryReason(reason);

      if (canRefreshReadyArtifactBeforeFinalize(reason) && !refreshedBeforeFinalize.has(issueId)) {
        refreshedBeforeFinalize.add(issueId);

        try {
          await prepareWorkspace(issue);
          actions.push({ action: "workspace-ready", issueId, workspacePath: issue.workspacePath, reason: "refresh_before_finalize" });
        } catch (refreshWorkspaceError) {
          const refreshWorkspaceReason = errorMessage(refreshWorkspaceError);
          actions.push({
            action: "workspace-ready",
            issueId,
            workspacePath: issue.workspacePath,
            blocked: true,
            reason: refreshWorkspaceReason,
          });
          return {
            attempted: true,
            actions,
            blocked: blockedState(issue, "workspace-ready", refreshWorkspaceReason),
          };
        }

        try {
          const refreshResult = await refreshReadyArtifact(issue);
          actions.push({ action: "ready-artifact", issueId, workspacePath: issue.workspacePath, reason: "refresh_before_finalize", ...(refreshResult ?? {}) });
        } catch (refreshError) {
          const refreshReason = errorMessage(refreshError);
          actions.push({ action: "ready-artifact", issueId, workspacePath: issue.workspacePath, blocked: true, reason: refreshReason });
          return {
            attempted: true,
            actions,
            blocked: blockedState(issue, "ready-artifact", refreshReason),
          };
        }

        continue;
      }

      if (canPrepareBeforeFinalize(reason) && !preparedBeforeFinalize.has(issueId)) {
        preparedBeforeFinalize.add(issueId);
        const blocked = await prepareBeforeFinalize(issue, reason, actions, {
          prepareIssue,
          refreshReadyArtifact,
          waitForReadyArtifact,
          ciReason,
        });
        if (blocked) return blocked;
        continue;
      }

      actions.push({ action: "workspace-ready", issueId, workspacePath: issue.workspacePath, blocked: true, reason });
      return {
        attempted: true,
        actions,
        blocked: blockedState(issue, "workspace-ready", reason),
      };
    }

    try {
      await validateTrackerCandidate(issue);
      actions.push({ action: "tracker-validation", issueId, workspacePath: issue.workspacePath });
    } catch (error) {
      const reason = errorMessage(error);
      actions.push({ action: "tracker-validation", issueId, workspacePath: issue.workspacePath, blocked: true, reason });
      return {
        attempted: true,
        actions,
        blocked: blockedState(issue, "tracker-validation", reason),
      };
    }

    try {
      await finalizeIssue(issue);
      actions.push({ action: "finalize", issueId, workspacePath: issue.workspacePath });
    } catch (error) {
      const reason = errorMessage(error);
      const ciReason = ciRecoveryReason(reason);

      if (canPrepareBeforeFinalize(reason) && !preparedBeforeFinalize.has(issueId)) {
        preparedBeforeFinalize.add(issueId);
        const blocked = await prepareBeforeFinalize(issue, reason, actions, {
          prepareIssue,
          refreshReadyArtifact,
          waitForReadyArtifact,
          ciReason,
        });
        if (blocked) return blocked;
        continue;
      }

      actions.push({ action: "finalize", issueId, workspacePath: issue.workspacePath, blocked: true, reason });
      return {
        attempted: true,
        actions,
        blocked: blockedState(issue, "finalize", reason),
      };
    }

    currentObservedTasks = markObservedMerged(currentObservedTasks, issueId);

    try {
      const recordResult = await recordMergedIssue(issue, {
        issueId,
        project,
        observedTasks: currentObservedTasks,
        taskPlan: currentTaskPlan,
      });
      actions.push({ action: "record-merged", issueId, ...(recordResult ?? {}) });
    } catch (error) {
      actions.push({ action: "record-merged", issueId, error: errorMessage(error) });
    }

    try {
      const reconciliation = await reconcileAfterMerge({
        issue,
        issueId,
        project,
        observedTasks: currentObservedTasks,
        taskPlan: currentTaskPlan,
      });
      actions.push({ action: "reconcile", issueId });
      if (reconciliation?.taskPlan) currentTaskPlan = reconciliation.taskPlan;
    } catch (error) {
      const reason = errorMessage(error);
      actions.push({ action: "reconcile", issueId, blocked: true, reason });
      return {
        attempted: true,
        actions,
        blocked: blockedState(issue, "reconcile", reason),
      };
    }

    currentPlan = selectMergeQueuePlan({ taskPlan: currentTaskPlan, observedTasks: currentObservedTasks });
  }

  return {
    attempted: true,
    actions,
  };
}

async function readPreviousState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeRunnerState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = resolve(dirname(statePath), `.${basename(statePath)}.${process.pid}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, statePath);
}

function makeState({
  project,
  dryRun,
  runnableIssues,
  launchPlan,
  observabilityState,
  previousState,
  statePath,
  observabilityStatePath,
  spawnResult,
  resumeResult,
  mergeQueueResult,
  now,
}) {
  return {
    version: 1,
    updatedAt: now().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
      tasksPath: project.tracker?.tasksPath,
    },
    dryRun,
    controllerPolicy: {
      ...CONTROLLER_POLICY,
      allowedActions: [...CONTROLLER_POLICY.allowedActions],
    },
    complete: isProjectComplete({ observabilityState, launchPlan }),
    statePath,
    observabilityStatePath,
    previousUpdatedAt: previousState?.updatedAt ?? null,
    runnable: runnableIssues.map(issueSummary),
    launchPlan,
    mergeQueue: {
      ...launchPlan.mergeQueue,
      result: mergeQueueResult,
    },
    spawn: spawnResult
      ? {
          attempted: true,
          issueIds: launchPlan.toLaunch.map((issue) => issue.id),
        }
      : {
          attempted: false,
          issueIds: [],
        },
    resume: resumeResult
      ? {
          attempted: true,
          issueIds: launchPlan.toResume.map((issue) => issue.id),
          restored: resumeResult.restored ?? [],
          errors: resumeResult.errors ?? [],
        }
      : {
          attempted: false,
          issueIds: [],
          restored: [],
          errors: [],
        },
  };
}

export async function runOnce(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun ?? true;
  const project = options.project ?? defaultProject(cwd);
  const aoCommand = options.aoCommand;
  const transport = options.transport ?? (options.createTransport ?? createAoTransport)({
    cwd,
    aoCommand,
    env: options.env,
  });
  const eventLogPath = options.eventLogPath ? resolve(cwd, options.eventLogPath) : null;
  const statePath = resolve(cwd, options.statePath ?? `.dark-factory/state/${project.id}.json`);
  const runLedgerPath = resolve(options.runLedgerPath ?? join(dirname(statePath), "run.json"));
  const observabilityStatePath = resolve(
    cwd,
    options.observabilityStatePath ?? `.dark-factory/observability/${project.id}.json`,
  );
  const tracker = options.tracker ?? tasksMdTracker.create();
  const getRunnableIssues = options.getRunnableIssues ?? ((context = {}) =>
    tracker.listIssues({ state: "open", observedTasks: context.observedTasks ?? {} }, project));
  const getTaskPlan = options.getTaskPlan ?? (() => readTaskPlan(project));
  const listSessions = options.listSessions ?? (() => defaultListSessions({ project, transport }));
  const spawnIssues = options.spawnIssues
    ?? ((issues, context = {}) => spawnAoIssues(issues, {
      cwd,
      project,
      transport,
      sessions: context.sessions,
      spawnDelayMs: options.spawnDelayMs ?? DEFAULT_SPAWN_STAGGER_MS,
      sleep: options.sleep ?? sleep,
    }));
  const restoreSessions = options.restoreSessions
    ?? ((issues) => restoreAoSessions(issues, { cwd, project, transport }));
  const now = options.now ?? (() => new Date());
  let runLedger = options.runLedger ?? null;
  if (!dryRun && options.taskLimit !== 0) {
    const openLedger = options.openRunLedger ?? openRunLedger;
    runLedger = await openLedger({
      path: runLedgerPath,
      projectId: project.id,
      taskLimit: options.taskLimit,
      invocation: options.runInvocation ?? "run",
      runId: options.runId,
      invocationId: options.invocationId,
      now,
    });
  }
  const finalizeIssue = options.finalizeIssue ?? ((issue) => defaultFinalizeIssue(issue, options));
  const prepareIssue = options.prepareIssue ?? ((issue) => defaultPrepareIssue(issue, options));
  const assertWorkspaceReady = options.assertWorkspaceReady
    ?? ((issue) => assertWorkspaceReadyForMerge(issue, { ...options, project }));
  const waitForReadyArtifact = options.waitForWorkerReadyArtifact
    ?? ((issue) => waitForWorkerReadyArtifact(issue, {
      assertWorkspaceReady,
      attempts: options.workerReadyGraceAttempts,
      intervalMs: options.workerReadyGraceIntervalMs,
      sleep: options.sleep,
    }));
  const validateTrackerCandidate = options.validateTrackerCandidate
    ?? ((issue) => validateTrackerMergeCandidate(issue, { ...options, project }));
  const prepareWorkspace = options.prepareWorkspace
    ?? (options.assertWorkspaceReady
      ? assertWorkspaceReady
      : ((issue) => ensureIssueWorkspace(issue, { ...options, project })));
  const refreshReadyArtifact = options.refreshReadyArtifact
    ?? (options.assertWorkspaceReady
      ? (async () => null)
      : ((issue) => refreshReadyArtifactAfterPrepare(issue, { ...options, project, now })));
  const recordMergedIssue = options.recordMergedIssue
    ?? ((issue, context) => recordAoSessionMerged(issue, { ...options, ...context, project, now }));
  const reconcileAfterMerge = options.reconcileAfterMerge ?? ((context) => reconcileProjectAfterMerge(context, options));
  const sessionsPayload = await listSessions();
  const observabilityState = options.observabilityState ?? await readPreviousState(observabilityStatePath);
  const observedTasks = observabilityState?.tasks ?? {};
  const taskPlan = await getTaskPlan({ observedTasks });
  const runnableIssues = await getRunnableIssues({ observedTasks, taskPlan });
  const projectSessions = normalizeSessionsPayload(sessionsPayload).filter(
    (session) => !session.projectId || !project.id || session.projectId === project.id,
  );
  const reconciledProjectSessions = await filterCleanedTerminalWorkspaceSessions(projectSessions, runnableIssues, {
    runWorkspaceGit: options.runWorkspaceGit,
  });
  const liveWorkspacePaths = await (options.detectLiveWorkerWorkspacePaths ?? detectLiveWorkerWorkspacePaths)({
    observedTasks,
    sessions: reconciledProjectSessions,
  });
  const mergeQueuePlan = selectMergeQueuePlan({ taskPlan, observedTasks, liveWorkspacePaths });
  const mergeQueueIssueIds = new Set(mergeQueuePlan.finalizeOrder.map(normalizeTaskId));
  const recoverableIssueIds = new Set(runnableIssues
    .filter((issue) => recoverableSessionForIssue(reconciledProjectSessions, normalizeTaskId(issue.id))?.workspacePath)
    .map((issue) => normalizeTaskId(issue.id)));
  const staleLaunchWorkspaces = await findStaleLaunchWorkspaces(runnableIssues.filter(
    (issue) => {
      const issueId = normalizeTaskId(issue.id);
      return !mergeQueueIssueIds.has(issueId) && !recoverableIssueIds.has(issueId);
    },
  ), {
    sessions: reconciledProjectSessions,
    project,
    runWorkspaceGit: options.runWorkspaceGit,
  });
  const staleIssueIds = new Set(staleLaunchWorkspaces.map((item) => normalizeTaskId(item.id)));
  let launchPlan = selectLaunchPlan({
    runnableIssues: runnableIssues.filter((issue) => !staleIssueIds.has(normalizeTaskId(issue.id))),
    sessions: reconciledProjectSessions,
    observedTasks,
    concurrency: options.concurrency,
    recoverOnly: options.recoverOnly === true,
    taskLimit: options.taskLimit,
    chargedTaskIds: runLedger?.chargedTaskIds ?? options.chargedTaskIds ?? [],
    liveWorkspacePaths,
  });
  launchPlan = {
    ...launchPlan,
    skipped: [
      ...launchPlan.skipped,
      ...staleLaunchWorkspaces,
    ],
    mergeQueue: mergeQueuePlan,
  };

  if (mergeQueuePlan.finalizeOrder.length > 0) {
    launchPlan = {
      ...launchPlan,
      skipped: [
        ...launchPlan.skipped,
        ...launchPlan.toLaunch.map((issue) => ({ id: issue.id, reason: "merge_queue_active" })),
        ...launchPlan.toResume.map((issue) => ({ id: issue.id, reason: "merge_queue_active", sessionId: issue.sessionId })),
      ],
      toLaunch: [],
      toResume: [],
    };
  }

  const mergeQueueResult = await runMergeQueue({
    mergeQueuePlan,
    project,
    taskPlan,
    observedTasks,
    dryRun,
    finalizeIssue,
    assertWorkspaceReady,
    validateTrackerCandidate,
    prepareIssue,
    waitForReadyArtifact,
    prepareWorkspace,
    refreshReadyArtifact,
    recordMergedIssue,
    reconcileAfterMerge,
  });
  const mergeQueueRecoveryIssue = mergeQueueRecoveryResumeIssue(mergeQueueResult?.blocked, observedTasks);
  if (mergeQueueRecoveryIssue && !launchPlan.toResume.some((issue) => issue.sessionId === mergeQueueRecoveryIssue.sessionId)) {
    launchPlan = {
      ...launchPlan,
      toResume: [...launchPlan.toResume, mergeQueueRecoveryIssue],
    };
  }

  const freshLaunchPreparation = await prepareFreshLaunchBranches(launchPlan.toLaunch, {
    observedTasks,
    project,
    dryRun,
    runProjectGit: options.runProjectGit,
    runDocker: options.runDocker,
  });
  if (freshLaunchPreparation.skipped.length > 0 || freshLaunchPreparation.issues.length !== launchPlan.toLaunch.length) {
    launchPlan = {
      ...launchPlan,
      toLaunch: freshLaunchPreparation.issues,
      skipped: [
        ...launchPlan.skipped,
        ...freshLaunchPreparation.skipped,
      ],
    };
  }

  let spawnResult = null;
  let resumeResult = null;

  if (!dryRun && launchPlan.toResume.length > 0) {
    resumeResult = await restoreSessions(launchPlan.toResume, { sessions: reconciledProjectSessions });
  }

  if (!dryRun && launchPlan.toLaunch.length > 0) {
    const reservedObservedSessions = observedSessionReservationsForIssues(launchPlan.toLaunch, observedTasks);
    spawnResult = await spawnIssues(launchPlan.toLaunch, {
      sessions: [
        ...reconciledProjectSessions,
        ...reservedObservedSessions,
      ],
    });
  }

  const previousState = await readPreviousState(statePath);
  const state = makeState({
    project,
    dryRun,
    runnableIssues,
    launchPlan,
    observabilityState,
    previousState,
    statePath,
    observabilityStatePath,
    spawnResult,
    resumeResult,
    mergeQueueResult,
    now,
  });

  if (!dryRun && runLedger) {
    const recordCharges = options.recordRunnerCharges ?? recordRunnerCharges;
    runLedger = await recordCharges(runLedgerPath, runLedger, state, { now });
  }
  state.runLedger = runLedger;

  await writeRunnerState(statePath, state);

  if (!dryRun && eventLogPath) {
    const events = [];

    for (const issue of resumeResult?.restored ?? []) {
      const plannedIssue = launchPlan.toResume.find((item) => item.id === issue.issueId) ?? issue;
      events.push(resumeEvent(plannedIssue, { ...issue, projectId: project.id }));
    }

    for (const issue of spawnResult?.spawned ?? []) {
      const plannedIssue = launchPlan.toLaunch.find((item) => item.id === issue.issueId) ?? issue;
      events.push(spawnEvent(plannedIssue, { ...issue, projectId: project.id }));
    }

    for (const action of mergeQueueResult?.actions ?? []) {
      if (action.action === "ci-recovery") {
        events.push(ciRecoveryEvent(project, action));
      } else if (action.action === "finalize" && !action.blocked) {
        const issue = mergeQueueIssue(observedTasks, action.issueId);
        events.push(mergeStartedEvent(project, issue));
      } else if (action.action === "reconcile" && !action.blocked) {
        const issue = mergeQueueIssue(observedTasks, action.issueId);
        events.push(mergedEvent(project, issue));
      }
    }

    if (mergeQueueResult?.blocked) {
      const blockedIssue = mergeQueueIssue(observedTasks, mergeQueueResult.blocked.issueId);
      events.push(mergeQueueResult.waiting
        ? waitingEvent(project, blockedIssue, mergeQueueResult.waiting)
        : blockedEvent(project, blockedIssue, mergeQueueResult.blocked));
    }

    await appendRunnerEvents(eventLogPath, events, { now });
  }

  return state;
}

function parseArgs(argv) {
  const options = {
    project: defaultProject(process.cwd()),
    dryRun: true,
    watch: false,
    intervalMs: 60_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];

    if (arg === "--run") options.dryRun = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--project-id") options.project.id = next();
    else if (arg === "--project-name") options.project.name = next();
    else if (arg === "--project-path") options.project.path = next();
    else if (arg === "--tasks-path") options.project.tracker.tasksPath = next();
    else if (arg === "--state-path") options.statePath = next();
    else if (arg === "--ao-command") options.aoCommand = next();
    else if (arg === "--concurrency") {
      const value = next();
      options.concurrency = value === "auto" ? undefined : Number.parseInt(value, 10);
    }
    else if (arg === "--task-limit") options.taskLimit = parsePositiveIntegerOption(next(), "task-limit");
    else if (arg === "--interval-ms") options.intervalMs = Number.parseInt(next(), 10);
    else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node orchestrator/dark-factory-runner.js [options]

Options:
  --dry-run              Plan and persist state without spawning AO sessions (default)
  --run                  Execute AO spawn for planned tasks
  --watch                Keep polling and launching as slots open
  --interval-ms <ms>     Watch polling interval (default: 60000)
  --concurrency <n>      Maximum active AO sessions for the project (default: auto, capped at 4)
  --task-limit <n>       Maximum tasks to start or resume in this run (default: unlimited)
  --project-id <id>      AO project id (default: project)
  --project-name <name>  Project display name (default: Project)
  --project-path <path>  Source project path (default: cwd)
  --tasks-path <path>    Roadmap path inside project
  --state-path <path>    Durable state file (default: .dark-factory/state/<project>.json)
  --ao-command <cmd>     AO command for session listing and spawning (default: ao)
`);
}

async function sleep(ms) {
  await new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  do {
    const state = await runOnce(options);
    console.log(JSON.stringify({
      updatedAt: state.updatedAt,
      projectId: state.project.id,
      dryRun: state.dryRun,
      toLaunch: state.launchPlan.toLaunch.map((issue) => issue.id),
      toResume: state.launchPlan.toResume.map((issue) => issue.id),
      skipped: state.launchPlan.skipped,
      activeSessions: state.launchPlan.activeSessions.length,
      complete: state.complete,
      statePath: state.statePath,
    }, null, 2));

    if (options.watch) {
      await sleep(options.intervalMs);
    }
  } while (options.watch);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
