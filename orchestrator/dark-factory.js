import { mkdir, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createAoTransport } from "./ao-command.js";
import { writeDashboard, writeDashboardIndex } from "./dark-factory-dashboard.js";
import {
  acquireProjectLease,
  heartbeatProjectLease,
  releaseProjectLease,
} from "./dark-factory-lease.js";
import { runObservabilityOnce } from "./dark-factory-observability.js";
import { verifyProjectPlanningFresh } from "./dark-factory-preflight.js";
import {
  DEFAULT_PROJECT_CONFIG_PATH,
  DEFAULT_REGISTRY_PATH,
  getProjectRuntimePaths,
  getRegisteredProjects,
  loadProjectConfig,
  loadProjectRegistry,
  registerProject,
  resolveRegisteredProject,
  writeAoConfig,
} from "./dark-factory-project.js";
import { completeRunLedger, updateRunLedger } from "./dark-factory-run-state.js";
import {
  reconcileRunnerSnapshot,
  recordAoSessionMerged,
  runOnce,
  writeRunnerState,
} from "./dark-factory-runner.js";

const execFileAsync = promisify(execFile);

const CONTROL_MODES = new Set(["active", "paused", "stopped", "recovering"]);

function allowsWorkerProgress(controlMode) {
  return controlMode === "active" || controlMode === "recovering";
}

function parsePositiveIntegerOption(value, optionName) {
  const normalized = String(value ?? "").trim();
  if (/^[1-9]\d*$/.test(normalized)) return Number.parseInt(normalized, 10);
  throw new Error(`${optionName} must be a positive integer`);
}

function parseNonNegativeIntegerOption(value, optionName) {
  const normalized = String(value ?? "").trim();
  if (/^(0|[1-9]\d*)$/.test(normalized)) return Number.parseInt(normalized, 10);
  throw new Error(`${optionName} must be a non-negative integer`);
}

async function sleep(ms) {
  await new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function aoTransport(options = {}) {
  return options.transport ?? (options.createTransport ?? createAoTransport)({
    cwd: options.cwd,
    aoCommand: options.aoCommand,
    env: options.env,
  });
}

export async function ensureAoLifecycleStarted(options = {}) {
  const projectId = options.project?.id ?? options.projectId;
  if (!projectId) throw new Error("AO lifecycle startup requires a project id");

  const status = await aoTransport(options).status();
  if (!status.available || !status.ready) {
    throw new Error(`AO daemon must already be running and ready (state: ${status.state ?? "unknown"})`);
  }
  return {
    attempted: false,
    projectId,
    status: "daemon_ready",
    pid: status.pid ?? null,
  };
}

async function resolveRunTarget(options) {
  if (options.project) {
    return {
      project: options.project,
      projects: options.projects ?? [options.project],
    };
  }

  if (options.projectConfigPath || options.loadProjectConfig) {
    const loadProject = options.loadProjectConfig ?? loadProjectConfig;
    const project = await loadProject(options.projectConfigPath ?? DEFAULT_PROJECT_CONFIG_PATH);
    return {
      project,
      projects: [project],
    };
  }

  const loadRegistry = options.loadProjectRegistry ?? loadProjectRegistry;
  const registry = options.registry ?? await loadRegistry(options.registryPath ?? DEFAULT_REGISTRY_PATH);
  return {
    registry,
    project: resolveRegisteredProject(registry, options.projectId),
    projects: getRegisteredProjects(registry),
  };
}

async function readControlStateFile(path) {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { mode: "active" };
    throw error;
  }
}

async function writeControlStateFile(path, state) {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function cleanupAoSessions(options = {}) {
  const projectId = options.project?.id ?? options.projectId;
  if (!projectId) throw new Error("AO cleanup requires a project id");

  const result = await aoTransport(options).cleanup({
    projectId,
    execute: !options.dryRun,
  });
  return { projectId, dryRun: Boolean(options.dryRun), ...result };
}

export async function cleanupStaleAoOrchestratorSessions(options = {}) {
  const projectId = options.project?.id ?? options.projectId;
  if (!projectId) throw new Error("AO orchestrator cleanup requires a project id");

  const sessionPrefix = options.project?.sessionPrefix ?? projectId;
  const sessionId = `${sessionPrefix}-orchestrator`;
  const dryRun = Boolean(options.dryRun);
  const transport = aoTransport(options);
  const payload = await transport.sessionList({
    projectId,
    includeTerminated: false,
    includeOrchestrators: true,
  });
  const sessionExists = payload.data?.some((session) => session.id === sessionId && session.role === "orchestrator");

  if (!sessionExists) {
    return {
      projectId,
      dryRun,
      killed: [],
      skipped: [{ sessionId, reason: "missing_session" }],
    };
  }

  if (dryRun) {
    return {
      projectId,
      dryRun,
      killed: [sessionId],
      skipped: [],
    };
  }

  await transport.sessionKill(sessionId);

  return {
    projectId,
    dryRun,
    killed: [sessionId],
    skipped: [],
  };
}

function skippedGoAoOrchestratorCleanup({ project, projectId, dryRun } = {}) {
  return {
    projectId: project?.id ?? projectId,
    dryRun: Boolean(dryRun),
    killed: [],
    skipped: [{ reason: "go_daemon_has_no_dark_factory_orchestrator" }],
  };
}

function hasSuccessfulMergeQueueRun(runner) {
  const result = runner?.mergeQueue?.result;
  if (!result?.attempted || result.blocked) return false;
  return Array.isArray(result.actions)
    && result.actions.some((action) => action?.action === "finalize");
}

function hasMergeQueueAttempt(runner) {
  return runner?.mergeQueue?.result?.attempted === true;
}

function hasSpawnedWorkers(runner) {
  return runner?.spawn?.attempted === true
    && Array.isArray(runner.spawn.issueIds)
    && runner.spawn.issueIds.length > 0;
}

function hasResumedWorkers(runner) {
  return runner?.resume?.attempted === true
    && Array.isArray(runner.resume.issueIds)
    && runner.resume.issueIds.length > 0;
}

function hasRecoverableMergeQueueBlock(runner) {
  return runner?.mergeQueue?.result?.blocked?.recovery?.action === "resume_worker_session";
}

function shouldContinueAutonomousRecovery(runner) {
  return hasResumedWorkers(runner) || hasRecoverableMergeQueueBlock(runner);
}

const MERGE_QUEUE_TASK_STATUSES = new Set(["ready", "ready_to_merge", "in_review"]);
const DEFAULT_AUTONOMOUS_SUPERVISION_PASSES = 240;

function hasActiveWorkers(observability) {
  const summary = observability?.summary ?? {};
  const activeSummaryCount = [...ACTIVE_WORKER_STATUSES]
    .reduce((total, status) => total + (summary[status] ?? 0), 0);
  if (activeSummaryCount > 0) return true;

  const tasks = Object.values(observability?.tasks ?? {});
  if (tasks.some((task) => ACTIVE_WORKER_STATUSES.has(String(task?.status ?? "").toLowerCase()))) {
    return true;
  }

  const sessions = Array.isArray(observability?.sessions)
    ? observability.sessions
    : tasks.flatMap((task) => task?.sessions ?? []);
  return sessions.some((session) => ACTIVE_WORKER_STATUSES.has(
    String(session?.observableStatus ?? session?.status ?? "").toLowerCase(),
  ));
}

function shouldContinueAutonomousSupervision({ runner, observability, supervisingStartedWorkers = false } = {}) {
  return hasSpawnedWorkers(runner)
    || shouldContinueAutonomousRecovery(runner)
    || (supervisingStartedWorkers && hasActiveWorkers(observability));
}

function shouldContinueRecoverySupervision({ runner, observability, supervisingStartedWorkers = false } = {}) {
  return hasSuccessfulMergeQueueRun(runner)
    || shouldContinueAutonomousSupervision({ runner, observability, supervisingStartedWorkers });
}

function shouldRestoreActiveControlAfterRecovery({ runner, observability, supervisingStartedWorkers = false } = {}) {
  if (shouldContinueAutonomousSupervision({ runner, observability, supervisingStartedWorkers })) return false;

  const summary = observability?.summary ?? {};
  return [
    "running",
    "failed",
    "needs_input",
    "in_review",
    "ready_to_merge",
    "merging",
    "cleanup_failed",
  ].every((status) => (summary[status] ?? 0) === 0);
}

function normalizeAutonomousRecoveryPasses(value) {
  if (value === undefined || value === null || value === "") return 1;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw new Error("maxAutonomousRecoveryPasses must be a non-negative integer");
}

function normalizeAutonomousSupervisionPasses(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_AUTONOMOUS_SUPERVISION_PASSES;
  return normalizeAutonomousRecoveryPasses(value);
}

function normalizeAutonomousSupervisionIntervalMs(value) {
  if (value === undefined || value === null || value === "") return 0;
  return parseNonNegativeIntegerOption(value, "supervisionIntervalMs");
}

function hasMergeQueueCandidateTasks(observability) {
  if ((observability?.summary?.ready ?? 0) > 0) return true;
  if ((observability?.summary?.ready_to_merge ?? 0) > 0) return true;
  if ((observability?.summary?.in_review ?? 0) > 0) return true;

  const tasks = Object.values(observability?.tasks ?? {});
  if (tasks.some((task) => MERGE_QUEUE_TASK_STATUSES.has(String(task?.status ?? "").toLowerCase()))) {
    return true;
  }

  const sessions = Array.isArray(observability?.sessions)
    ? observability.sessions
    : tasks.flatMap((task) => task?.sessions ?? []);
  return sessions.some((session) => MERGE_QUEUE_TASK_STATUSES.has(
    String(session?.observableStatus ?? session?.status ?? "").toLowerCase(),
  ));
}

function shouldRunTerminalMergePass({ dryRun, runner, observability } = {}) {
  if (dryRun) return false;
  if (hasMergeQueueAttempt(runner)) return false;
  return hasMergeQueueCandidateTasks(observability);
}

function hasStaleWorkspaceSkips(runner) {
  const skipped = runner?.launchPlan?.skipped;
  return Array.isArray(skipped)
    && skipped.some((item) => item?.reason === "stale_existing_workspace");
}

const TERMINAL_WORKSPACE_STATUSES = new Set(["ready", "done", "merged", "failed", "killed", "terminated"]);
const OBSERVED_COMPLETED_STATUSES = new Set(["done", "merged", "closed"]);
const RESOURCE_CLEANUP_STATUSES = new Set(["done", "merged", "closed", "failed", "killed", "terminated"]);
const ACTIVE_WORKER_STATUSES = new Set(["working", "running", "queued", "pending", "in_review"]);

function terminalWorkspaceSessions(observability, sessionIds = null, options = {}) {
  const sessions = Array.isArray(observability?.sessions)
    ? observability.sessions
    : Object.values(observability?.tasks ?? {}).flatMap((task) => task?.sessions ?? []);
  const seen = new Set();
  const candidates = [];
  const selectedSessionIds = sessionIds == null ? null : new Set(sessionIds);

  for (const session of sessions) {
    const workspacePath = session?.workspacePath;
    if (!workspacePath) continue;

    const sessionId = session.id ?? null;
    const status = String(session.observableStatus ?? session.status ?? "").toLowerCase();
    if (selectedSessionIds && (!sessionId || !selectedSessionIds.has(sessionId))) continue;
    if (!options.includeNonTerminal && !TERMINAL_WORKSPACE_STATUSES.has(status)) continue;

    const key = `${sessionId ?? ""}:${workspacePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      sessionId,
      issueId: session.issueId ?? session.issue ?? null,
      status,
      workspacePath,
    });
  }

  return candidates;
}

function hasObservedCompletedSessions(observability, sessionIds = null) {
  return observedCompletedAoSessions(observability, sessionIds).length > 0;
}

function hasTerminalResourceCleanupCandidates(observability, sessionIds = null) {
  return completedResourceWorkspaceSessions(observability, sessionIds).length > 0;
}

function observedCompletedAoSessions(observability, sessionIds = null) {
  const sessions = Array.isArray(observability?.sessions)
    ? observability.sessions
    : Object.values(observability?.tasks ?? {}).flatMap((task) => task?.sessions ?? []);
  const selectedSessionIds = sessionIds == null ? null : new Set(sessionIds);
  const seen = new Set();
  const candidates = [];

  for (const session of sessions) {
    const sessionId = String(session?.id ?? "").trim();
    const status = String(session?.observableStatus ?? session?.status ?? "").toLowerCase();
    if (selectedSessionIds && !selectedSessionIds.has(sessionId)) continue;
    if (!sessionId || !OBSERVED_COMPLETED_STATUSES.has(status) || seen.has(sessionId)) continue;
    seen.add(sessionId);
    candidates.push({
      sessionId,
      issueId: session.issueId ?? session.issue ?? null,
      status,
      pr: session.pr ?? null,
    });
  }

  return candidates;
}

function completedBranchCandidates(observability, sessionIds = null) {
  const sessions = Array.isArray(observability?.sessions)
    ? observability.sessions
    : Object.values(observability?.tasks ?? {}).flatMap((task) => task?.sessions ?? []);
  const selectedSessionIds = sessionIds == null ? null : new Set(sessionIds);
  const seen = new Set();
  const candidates = [];

  for (const session of sessions) {
    const sessionId = String(session?.id ?? "").trim();
    if (selectedSessionIds && !selectedSessionIds.has(sessionId)) continue;
    const status = String(session?.observableStatus ?? session?.status ?? "").toLowerCase();
    if (!OBSERVED_COMPLETED_STATUSES.has(status)) continue;

    const branch = String(
      session?.branch
        ?? session?.branchName
        ?? session?.metadata?.branch
        ?? session?.metadata?.branchName
        ?? "",
    ).trim();
    if (!branch || seen.has(branch)) continue;

    seen.add(branch);
    candidates.push({
      issueId: session?.issueId ?? session?.issue ?? null,
      sessionId: session?.id ?? null,
      branch,
    });
  }

  return candidates;
}

function commandStdout(result) {
  if (typeof result === "string") return result;
  return String(result?.stdout ?? "");
}

function outputLines(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseActiveWorktreeBranches(output) {
  return new Set(
    outputLines(output)
      .filter((line) => line.startsWith("branch refs/heads/"))
      .map((line) => line.slice("branch refs/heads/".length)),
  );
}

export async function cleanupMergedBranches(options = {}) {
  const project = options.project ?? null;
  const projectPath = project?.path;
  const dryRun = Boolean(options.dryRun);
  const defaultBranch = project?.defaultBranch ?? "main";
  const result = {
    attempted: Boolean(projectPath),
    dryRun,
    projectId: project?.id ?? options.projectId ?? null,
    defaultBranch,
    deleted: [],
    skipped: [],
    errors: [],
  };

  if (!projectPath) {
    result.skipped.push({
      issueId: null,
      sessionId: null,
      branch: null,
      reason: "missing_project_path",
    });
    return result;
  }

  const candidates = completedBranchCandidates(options.observability, options.sessionIds ?? null);
  const runGit = options.runGit ?? (async (args) =>
    execFileAsync("git", ["-C", projectPath, ...args], { cwd: projectPath }));

  try {
    const remotes = new Set(outputLines(commandStdout(await runGit(["remote"]))));
    if (remotes.has("origin") && !dryRun) {
      await runGit(["fetch", "--prune", "origin", "--quiet"]);
    }

    const mergedBranches = new Set(outputLines(commandStdout(await runGit([
      "branch",
      "--merged",
      defaultBranch,
      "--format=%(refname:short)",
    ]))));
    const activeWorktreeBranches = parseActiveWorktreeBranches(commandStdout(await runGit([
      "worktree",
      "list",
      "--porcelain",
    ])));

    for (const candidate of candidates) {
      if (!mergedBranches.has(candidate.branch)) {
        result.skipped.push({ ...candidate, reason: "not_merged" });
        continue;
      }

      if (activeWorktreeBranches.has(candidate.branch)) {
        result.skipped.push({ ...candidate, reason: "checked_out_worktree" });
        continue;
      }

      if (dryRun) {
        result.skipped.push({ ...candidate, reason: "dry_run" });
        continue;
      }

      try {
        await runGit(["branch", "-d", candidate.branch]);
        result.deleted.push(candidate);
      } catch (error) {
        result.errors.push({
          ...candidate,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    result.errors.push({
      issueId: null,
      sessionId: null,
      branch: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

function activeWorkerSessions(observability, projectId) {
  const sessions = Array.isArray(observability?.sessions)
    ? observability.sessions
    : Object.values(observability?.tasks ?? {}).flatMap((task) => task?.sessions ?? []);
  const seen = new Set();
  const candidates = [];

  for (const session of sessions) {
    const sessionId = String(session?.id ?? "").trim();
    const sessionProjectId = String(
      session?.projectId ?? session?.lifecycle?.session?.projectId ?? "",
    ).trim();
    const status = String(session?.observableStatus ?? session?.status ?? "").toLowerCase();
    const isOrchestrator = session?.role === "orchestrator"
      || session?.lifecycle?.session?.kind === "orchestrator"
      || sessionId.endsWith("-orchestrator");

    if (
      !sessionId
      || seen.has(sessionId)
      || isOrchestrator
      || (sessionProjectId && sessionProjectId !== projectId)
      || !ACTIVE_WORKER_STATUSES.has(status)
    ) continue;

    seen.add(sessionId);
    candidates.push({
      sessionId,
      issueId: session.issueId ?? session.issue ?? null,
      status,
    });
  }

  return candidates;
}

function projectWorkerWorkspaceSessionIds(observability, projectId) {
  const sessions = Array.isArray(observability?.sessions)
    ? observability.sessions
    : Object.values(observability?.tasks ?? {}).flatMap((task) => task?.sessions ?? []);
  const seen = new Set();
  const sessionIds = [];

  for (const session of sessions) {
    const sessionId = String(session?.id ?? "").trim();
    const sessionProjectId = String(
      session?.projectId ?? session?.lifecycle?.session?.projectId ?? "",
    ).trim();
    const isOrchestrator = session?.role === "orchestrator"
      || session?.lifecycle?.session?.kind === "orchestrator"
      || sessionId.endsWith("-orchestrator");

    if (
      !sessionId
      || !session?.workspacePath
      || seen.has(sessionId)
      || isOrchestrator
      || (sessionProjectId && sessionProjectId !== projectId)
    ) continue;

    seen.add(sessionId);
    sessionIds.push(sessionId);
  }

  return sessionIds;
}

function sessionIdsForTaskIds(observability, taskIds = []) {
  const selectedTaskIds = new Set(
    taskIds.map((taskId) => String(taskId ?? "").trim().toUpperCase()).filter(Boolean),
  );
  if (selectedTaskIds.size === 0) return [];

  const sessions = Array.isArray(observability?.sessions)
    ? observability.sessions
    : Object.values(observability?.tasks ?? {}).flatMap((task) => task?.sessions ?? []);
  const seen = new Set();
  const sessionIds = [];

  for (const session of sessions) {
    const sessionId = String(session?.id ?? "").trim();
    const issueId = String(session?.issueId ?? session?.issue ?? "").trim().toUpperCase();
    if (!sessionId || seen.has(sessionId) || !selectedTaskIds.has(issueId)) continue;
    seen.add(sessionId);
    sessionIds.push(sessionId);
  }

  return sessionIds;
}

async function preserveActiveAoWorkerSessions(options = {}) {
  const projectId = options.project?.id ?? options.projectId;
  if (!projectId) throw new Error("AO stop requires a project id");

  const dryRun = Boolean(options.dryRun);
  const candidates = activeWorkerSessions(options.observability, projectId);

  if (dryRun) {
    return {
      projectId,
      dryRun,
      suspended: [],
      preserved: candidates.map((candidate) => candidate.sessionId),
      skipped: candidates.map((candidate) => ({ ...candidate, reason: "dry_run" })),
      errors: [],
    };
  }

  const transport = aoTransport(options);
  const suspended = [];
  const preserved = [];
  const skipped = [];
  const errors = [];

  for (const candidate of candidates) {
    try {
      const result = await transport.sessionSuspend(candidate.sessionId);
      if (result?.suspended) suspended.push(candidate.sessionId);
      if (result?.preserved) preserved.push(candidate.sessionId);
      if (!result?.suspended) {
        skipped.push({
          ...candidate,
          reason: result?.preserved ? "already_terminated" : "missing_session",
        });
      }
    } catch (error) {
      errors.push({
        ...candidate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    projectId,
    dryRun,
    suspended,
    preserved,
    skipped,
    errors,
  };
}

export async function cleanupObservedCompletedAoSessions(options = {}) {
  const projectId = options.project?.id ?? options.projectId;
  if (!projectId) throw new Error("Observed AO cleanup requires a project id");

  const dryRun = Boolean(options.dryRun);
  const candidates = observedCompletedAoSessions(options.observability, options.sessionIds ?? null);

  if (dryRun) {
    return {
      projectId,
      dryRun,
      killed: candidates.map((candidate) => candidate.sessionId),
      skipped: [],
    };
  }

  const killed = [];
  const errors = [];
  const restamped = [];
  const recordMergedSession = options.recordMergedSession
    ?? ((issue) => recordAoSessionMerged(issue, options));
  const transport = aoTransport(options);
  const waitForTermination = async (sessionId) => {
    if (typeof transport.sessionGet !== "function") return true;

    const pollMs = options.cleanupTerminationPollMs ?? 1_000;
    const timeoutMs = options.cleanupTerminationTimeoutMs ?? 60_000;
    const wait = options.sleep ?? sleep;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const session = await transport.sessionGet(sessionId);
      const status = String(session?.status ?? "").toLowerCase();
      if (session?.isTerminated === true
        || (session?.isTerminated == null && TERMINAL_WORKSPACE_STATUSES.has(status))) {
        return true;
      }
      if (Date.now() >= deadline) return false;
      await wait(pollMs);
    }
  };

  for (const candidate of candidates) {
    try {
      await transport.sessionKill(candidate.sessionId);
      killed.push(candidate.sessionId);

      if (candidate.status === "merged") {
        const result = await recordMergedSession({
          id: candidate.issueId,
          sessionId: candidate.sessionId,
          pr: candidate.pr,
        });
        restamped.push({ sessionId: candidate.sessionId, ...(result ?? {}) });
      }
    } catch (error) {
      errors.push({
        sessionId: candidate.sessionId,
        issueId: candidate.issueId,
        status: candidate.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const terminated = [];
  for (const sessionId of killed) {
    try {
      if (await waitForTermination(sessionId)) terminated.push(sessionId);
      else errors.push({ sessionId, error: "Timed out waiting for AO session termination before cleanup" });
    } catch (error) {
      errors.push({
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let reclaimed = { cleaned: [], skipped: [] };
  if (terminated.length > 0 && typeof transport.cleanup === "function") {
    try {
      reclaimed = await transport.cleanup({ projectId, execute: true, sessionIds: terminated });
    } catch (error) {
      errors.push({
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    projectId,
    dryRun,
    killed,
    cleaned: reclaimed.cleaned ?? [],
    restamped,
    skipped: reclaimed.skipped ?? [],
    errors,
  };
}

function completedResourceWorkspaceSessions(observability, sessionIds = null) {
  const sessions = Array.isArray(observability?.sessions)
    ? observability.sessions
    : Object.values(observability?.tasks ?? {}).flatMap((task) => task?.sessions ?? []);
  const selectedSessionIds = sessionIds == null ? null : new Set(sessionIds);
  const seen = new Set();
  const candidates = [];

  for (const session of sessions) {
    const workspacePath = session?.workspacePath;
    if (!workspacePath) continue;

    const sessionId = String(session?.id ?? "").trim();
    if (selectedSessionIds && !selectedSessionIds.has(sessionId)) continue;
    const status = String(session.observableStatus ?? session.status ?? "").toLowerCase();
    if (!RESOURCE_CLEANUP_STATUSES.has(status)) continue;

    const key = `${session.id ?? ""}:${workspacePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      sessionId: session.id ?? null,
      issueId: session.issueId ?? session.issue ?? null,
      status,
      workspacePath,
    });
  }

  return candidates;
}

function normalizeCleanupCommands(project) {
  const commands = project?.cleanup?.commands;
  if (Array.isArray(commands)) return commands.map((command) => String(command).trim()).filter(Boolean);
  const text = String(commands ?? "").trim();
  if (!text) return [];
  return text
    .split(/\r?\n|,/)
    .map((command) => command.trim())
    .filter(Boolean);
}

function sanitizeResourcePart(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function composeProjectName(projectId, sessionId) {
  const projectPart = sanitizeResourcePart(projectId) || "project";
  const sessionPart = sanitizeResourcePart(sessionId) || "session";
  const name = `df-${projectPart}-${sessionPart}`.replace(/-+/g, "-");
  if (name.length <= 63) return name;

  const hash = createHash("sha256")
    .update(`${String(projectId ?? "")}\0${String(sessionId ?? "")}`)
    .digest("hex")
    .slice(0, 10);
  const sessionSuffix = `${sessionPart.slice(-20)}-${hash}`;
  const projectLength = Math.max(1, 63 - `df--${sessionSuffix}`.length);
  return `df-${projectPart.slice(0, projectLength)}-${sessionSuffix}`;
}

function resourceCleanupEnv(project, candidate, extraEnv = {}) {
  return {
    ...process.env,
    ...extraEnv,
    DARK_FACTORY_PROJECT_ID: project.id,
    DARK_FACTORY_SESSION_ID: candidate.sessionId ?? "",
    DARK_FACTORY_ISSUE_ID: candidate.issueId ?? "",
    DARK_FACTORY_WORKSPACE_PATH: candidate.workspacePath,
    DARK_FACTORY_CLEANUP_PHASE: "completed-workspace",
    COMPOSE_PROJECT_NAME: composeProjectName(project.id, candidate.sessionId ?? candidate.issueId ?? "session"),
  };
}

async function cleanupDockerComposeProjectsForWorkspace(candidate, options = {}) {
  const execCommand = options.execFileAsync ?? execFileAsync;
  const dryRun = options.dryRun === true;
  const cleaned = [];
  const skipped = [];
  const errors = [];

  let listResult;
  try {
    listResult = await execCommand("docker", [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project.working_dir=${candidate.workspacePath}`,
      "--format",
      "{{.Label \"com.docker.compose.project\"}}",
    ]);
  } catch (error) {
    errors.push({
      sessionId: candidate.sessionId,
      issueId: candidate.issueId,
      status: candidate.status,
      workspacePath: candidate.workspacePath,
      kind: "docker_compose",
      reason: "compose_discovery_failed",
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error: error instanceof Error ? error.message : String(error),
    });
    return { cleaned, skipped, errors };
  }

  const discoveredComposeProjects = new Set(String(listResult.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean));
  const deterministicComposeProject = composeProjectName(
    options.project?.id,
    candidate.sessionId ?? candidate.issueId ?? "session",
  );
  const composeProjects = [...new Set([
    ...discoveredComposeProjects,
    deterministicComposeProject,
  ].filter(Boolean))];

  if (!composeProjects.length) {
    skipped.push({
      sessionId: candidate.sessionId,
      issueId: candidate.issueId,
      status: candidate.status,
      workspacePath: candidate.workspacePath,
      kind: "docker_compose",
      reason: "no_compose_project",
    });
    return { cleaned, skipped, errors };
  }

  for (const composeProject of composeProjects) {
    const record = {
      sessionId: candidate.sessionId,
      issueId: candidate.issueId,
      status: candidate.status,
      workspacePath: candidate.workspacePath,
      kind: "docker_compose",
      composeProject,
    };

    if (dryRun) {
      skipped.push({ ...record, reason: "dry_run" });
      continue;
    }

    if (!discoveredComposeProjects.has(composeProject)) {
      const deterministicCleanup = await cleanupDockerComposeProjectByLabels(record, {
        ...options,
        execFileAsync: execCommand,
      });
      cleaned.push(...deterministicCleanup.cleaned);
      skipped.push(...deterministicCleanup.skipped);
      errors.push(...deterministicCleanup.errors);
      continue;
    }

    try {
      const result = await execCommand("docker", [
        "compose",
        "-p",
        composeProject,
        "down",
        "-v",
        "--remove-orphans",
      ], {
        cwd: candidate.workspacePath,
        maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
      });
      const verification = await cleanupDockerComposeProjectByLabels(record, {
        ...options,
        execFileAsync: execCommand,
      });
      if (!verification.errors.length) {
        cleaned.push(
          { ...record, stdout: result.stdout ?? "", stderr: result.stderr ?? "" },
          ...verification.cleaned,
        );
      }
      skipped.push(...verification.skipped);
      errors.push(...verification.errors);
    } catch (error) {
      const fallback = await cleanupDockerComposeProjectByLabels(record, {
        ...options,
        composeError: error,
        execFileAsync: execCommand,
      });
      cleaned.push(...fallback.cleaned);
      skipped.push(...fallback.skipped);
      errors.push(...fallback.errors);
    }
  }

  return { cleaned, skipped, errors };
}

async function cleanupDockerComposeProjectByLabels(record, options = {}) {
  const execCommand = options.execFileAsync ?? execFileAsync;
  const dryRun = options.dryRun === true;
  const composeProject = record.composeProject;
  const cleaned = [];
  const skipped = [];
  const errors = [];
  const baseRecord = {
    ...record,
    kind: "docker_compose_labels",
    composeDownError: options.composeError instanceof Error
      ? options.composeError.message
      : String(options.composeError ?? ""),
  };

  if (dryRun) {
    skipped.push({ ...baseRecord, reason: "dry_run" });
    return { cleaned, skipped, errors };
  }

  let resources;
  try {
    resources = await listDockerComposeResources(execCommand, composeProject);
  } catch (error) {
    errors.push({
      ...baseRecord,
      reason: "resource_discovery_failed",
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error: error instanceof Error ? error.message : String(error),
    });
    return { cleaned, skipped, errors };
  }

  const { containers, volumes, networks } = resources;
  if (!containers.length && !volumes.length && !networks.length) {
    skipped.push({ ...baseRecord, reason: "no_labeled_resources" });
    return { cleaned, skipped, errors };
  }

  const removals = [
    { resource: "containers", names: containers, args: ["rm", "-f", ...containers] },
    { resource: "volumes", names: volumes, args: ["volume", "rm", ...volumes] },
    { resource: "networks", names: networks, args: ["network", "rm", ...networks] },
  ];

  for (const removal of removals) {
    if (!removal.names.length) continue;
    try {
      await execCommand("docker", removal.args, {
        maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
      });
    } catch (error) {
      errors.push({
        ...baseRecord,
        reason: "resource_removal_failed",
        resource: removal.resource,
        resources: removal.names,
        stdout: error?.stdout ?? "",
        stderr: error?.stderr ?? "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let remaining;
  try {
    remaining = await listDockerComposeResources(execCommand, composeProject);
  } catch (error) {
    errors.push({
      ...baseRecord,
      reason: "resource_verification_failed",
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error: error instanceof Error ? error.message : String(error),
    });
    return { cleaned, skipped, errors };
  }

  if (remaining.containers.length || remaining.volumes.length || remaining.networks.length) {
    errors.push({
      ...baseRecord,
      reason: "resources_remaining",
      remaining,
      error: "Docker Compose resources remain after cleanup",
    });
    return { cleaned, skipped, errors };
  }

  if (!errors.length) {
    cleaned.push({ ...baseRecord, containers, volumes, networks, verified: true });
  }

  return { cleaned, skipped, errors };
}

async function listDockerComposeResources(execCommand, composeProject) {
  const [containers, volumes, networks] = await Promise.all([
    listDockerResourcesByComposeProject(execCommand, "ps", composeProject),
    listDockerResourcesByComposeProject(execCommand, "volume", composeProject),
    listDockerResourcesByComposeProject(execCommand, "network", composeProject),
  ]);
  return { containers, volumes, networks };
}

async function listDockerResourcesByComposeProject(execCommand, kind, composeProject) {
  const filter = `label=com.docker.compose.project=${composeProject}`;
  const argsByKind = {
    ps: ["ps", "-a", "--filter", filter, "--format", "{{.ID}}"],
    volume: ["volume", "ls", "--filter", filter, "--format", "{{.Name}}"],
    network: ["network", "ls", "--filter", filter, "--format", "{{.Name}}"],
  };
  const result = await execCommand("docker", argsByKind[kind]);
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseBrowserState(content) {
  if (!content) return null;
  const values = {};
  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2];
  }
  return values;
}

function browserStateDir(env = process.env) {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "vercel-browser");
}

function parseWorktreePorcelain(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function defaultGetBrowserSessionForWorkspace(workspacePath, options = {}) {
  const execCommand = options.execFileAsync ?? execFileAsync;
  let rootResult;
  let listResult;
  try {
    rootResult = await execCommand("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"]);
    listResult = await execCommand("git", ["-C", workspacePath, "worktree", "list", "--porcelain"]);
  } catch {
    return null;
  }

  const rootPath = await canonicalPath(String(rootResult.stdout ?? "").trim() || workspacePath);
  const worktreePaths = parseWorktreePorcelain(listResult.stdout);

  for (let index = 0; index < worktreePaths.length; index += 1) {
    if (await canonicalPath(worktreePaths[index]) !== rootPath) continue;
    const session = `wt${index}`;
    const stateDir = options.browserStateDir ?? browserStateDir(options.env);
    return {
      session,
      debugPort: 9222 + index,
      stateDir,
      statePath: join(stateDir, `${session}.env`),
    };
  }

  return null;
}

async function defaultReadBrowserState(statePath) {
  try {
    return await readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function commandUsesProfile(command, profilePath) {
  return Boolean(profilePath) && String(command ?? "").includes(profilePath);
}

async function defaultListBrowserProcesses({ profilePath, procRoot = "/proc" } = {}) {
  if (process.platform !== "linux" || !profilePath) return [];

  let entries;
  try {
    entries = await readdir(procRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;

    const pid = Number.parseInt(entry.name, 10);
    if (!Number.isFinite(pid) || pid === process.pid) continue;

    try {
      const command = (await readFile(join(procRoot, entry.name, "cmdline"), "utf8"))
        .replace(/\0/g, " ")
        .trim();
      if (!commandUsesProfile(command, profilePath)) continue;
      processes.push({ pid, command });
    } catch {
      // Browser processes can exit while scanning /proc.
    }
  }

  return processes;
}

async function defaultRemovePath(path, options = {}) {
  await rm(path, options);
}

async function removeTempBrowserProfile(removePath, profilePath, options = {}) {
  const attempts = options.browserProfileRemoveAttempts ?? 5;
  const retryMs = options.browserProfileRemoveRetryMs ?? 100;
  const wait = options.sleep ?? sleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await removePath(profilePath, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = ["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code);
      if (!retryable || attempt === attempts) throw error;
      await wait(retryMs);
    }
  }
}

function isSafeTempBrowserProfile({ profilePath, profileMode, stateDir, session }) {
  if (profileMode !== "temp" || !profilePath || !stateDir || !session) return false;
  if (!isInsidePath(stateDir, profilePath)) return false;
  return basename(profilePath).startsWith(`${session}-profile-`);
}

export async function cleanupCompletedWorkspaceBrowsers(options = {}) {
  const dryRun = options.dryRun === true;
  const candidates = completedResourceWorkspaceSessions(options.observability, options.sessionIds ?? null);
  const getBrowserSessionForWorkspace = options.getBrowserSessionForWorkspace ?? defaultGetBrowserSessionForWorkspace;
  const readBrowserState = options.readBrowserState ?? defaultReadBrowserState;
  const listBrowserProcesses = options.listBrowserProcesses ?? defaultListBrowserProcesses;
  const killProcess = options.killProcess ?? defaultKillProcess;
  const removePath = options.removePath ?? defaultRemovePath;
  const cleaned = [];
  const skipped = [];
  const errors = [];

  for (const candidate of candidates) {
    const baseRecord = {
      sessionId: candidate.sessionId,
      issueId: candidate.issueId,
      status: candidate.status,
      workspacePath: candidate.workspacePath,
    };

    let browserSession;
    try {
      browserSession = await getBrowserSessionForWorkspace(candidate.workspacePath, options);
    } catch (error) {
      errors.push({ ...baseRecord, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (!browserSession?.statePath) {
      skipped.push({ ...baseRecord, reason: "no_browser_session" });
      continue;
    }

    let state;
    try {
      state = parseBrowserState(await readBrowserState(browserSession.statePath, options));
    } catch (error) {
      errors.push({ ...baseRecord, statePath: browserSession.statePath, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (!state) {
      skipped.push({ ...baseRecord, browserSession: browserSession.session, statePath: browserSession.statePath, reason: "no_browser_state" });
      continue;
    }

    const profilePath = state.PROFILE_OLD ?? "";
    const profileMode = state.PROFILE_MODE_OLD ?? "";
    const record = {
      ...baseRecord,
      browserSession: browserSession.session,
      debugPort: browserSession.debugPort,
      statePath: browserSession.statePath,
      profilePath,
      profileMode,
    };

    if (dryRun) {
      skipped.push({ ...record, reason: "dry_run" });
      continue;
    }

    try {
      const processes = await listBrowserProcesses({
        ...browserSession,
        profilePath,
        profileMode,
        procRoot: options.procRoot,
      });
      const killedPids = [];
      const seenPids = new Set();

      for (const processInfo of processes) {
        if (!processInfo?.pid || seenPids.has(processInfo.pid)) continue;
        seenPids.add(processInfo.pid);
        await killProcess(processInfo.pid, options.browserSignal ?? "SIGTERM");
        killedPids.push(processInfo.pid);
      }

      let removedProfile = false;
      if (isSafeTempBrowserProfile({
        profilePath,
        profileMode,
        stateDir: browserSession.stateDir,
        session: browserSession.session,
      })) {
        await removeTempBrowserProfile(removePath, profilePath, options);
        removedProfile = true;
      }

      await removePath(browserSession.statePath, { force: true });
      cleaned.push({ ...record, killedPids, removedProfile });
    } catch (error) {
      errors.push({
        ...record,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    attempted: candidates.length > 0,
    dryRun,
    workspaceCount: candidates.length,
    cleaned,
    skipped,
    errors,
  };
}

export async function cleanupCompletedWorkspaceResources(options = {}) {
  const project = options.project ?? {};
  const commands = normalizeCleanupCommands(project);
  const dryRun = options.dryRun === true;
  const execCommand = options.execFileAsync ?? execFileAsync;
  const candidates = completedResourceWorkspaceSessions(options.observability, options.sessionIds ?? null);
  const cleaned = [];
  const skipped = [];
  const errors = [];

  if (!candidates.length) {
    return {
      attempted: false,
      dryRun,
      workspaceCount: candidates.length,
      commandCount: commands.length,
      cleaned,
      skipped,
      errors,
    };
  }

  for (const candidate of candidates) {
    const composeCleanup = await cleanupDockerComposeProjectsForWorkspace(candidate, {
      ...options,
      dryRun,
      execFileAsync: execCommand,
    });
    cleaned.push(...composeCleanup.cleaned);
    skipped.push(...composeCleanup.skipped);
    errors.push(...composeCleanup.errors);

    for (const command of commands) {
      const record = {
        sessionId: candidate.sessionId,
        issueId: candidate.issueId,
        status: candidate.status,
        workspacePath: candidate.workspacePath,
        command,
      };

      if (dryRun) {
        skipped.push({ ...record, reason: "dry_run" });
        continue;
      }

      try {
        const result = await execCommand("sh", ["-lc", command], {
          cwd: candidate.workspacePath,
          env: resourceCleanupEnv(project, candidate, options.env),
          maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
        });
        cleaned.push({
          ...record,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        });
      } catch (error) {
        errors.push({
          ...record,
          stdout: error?.stdout ?? "",
          stderr: error?.stderr ?? "",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    attempted: true,
    dryRun,
    workspaceCount: candidates.length,
    commandCount: commands.length,
    cleaned,
    skipped,
    errors,
  };
}

function isInsidePath(parentPath, candidatePath) {
  const parent = resolve(parentPath);
  const candidate = resolve(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

async function defaultListWorkspaceProcesses(workspacePath, options = {}) {
  if (process.platform !== "linux") return [];

  const procRoot = options.procRoot ?? "/proc";
  let entries;
  try {
    entries = await readdir(procRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;

    const pid = Number.parseInt(entry.name, 10);
    if (!Number.isFinite(pid) || pid === process.pid) continue;

    try {
      const cwd = await readlink(join(procRoot, entry.name, "cwd"));
      if (!isInsidePath(workspacePath, cwd)) continue;

      let command = "";
      try {
        command = (await readFile(join(procRoot, entry.name, "cmdline"), "utf8"))
          .replace(/\0/g, " ")
          .trim();
      } catch {
        command = "";
      }

      processes.push({ pid, cwd, command });
    } catch {
      // Processes can exit or be unreadable while scanning /proc.
    }
  }

  return processes;
}

async function defaultKillProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function cleanupTerminalWorkspaceProcesses(options = {}) {
  const dryRun = options.dryRun === true;
  const signal = options.signal ?? "SIGTERM";
  const listWorkspaceProcesses = options.listWorkspaceProcesses ?? defaultListWorkspaceProcesses;
  const killProcess = options.killProcess ?? defaultKillProcess;
  const candidates = terminalWorkspaceSessions(options.observability, options.sessionIds ?? null, {
    includeNonTerminal: options.includeNonTerminal === true,
  });
  const killed = [];
  const skipped = [];
  const errors = [];

  for (const candidate of candidates) {
    let processes;
    try {
      processes = await listWorkspaceProcesses(candidate.workspacePath, options);
    } catch (error) {
      errors.push({
        sessionId: candidate.sessionId,
        workspacePath: candidate.workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!processes.length) {
      skipped.push({
        sessionId: candidate.sessionId,
        workspacePath: candidate.workspacePath,
        reason: "no_processes",
      });
      continue;
    }

    for (const processInfo of processes) {
      if (!processInfo?.pid || processInfo.pid === process.pid) continue;

      const record = {
        sessionId: candidate.sessionId,
        issueId: candidate.issueId,
        status: candidate.status,
        workspacePath: candidate.workspacePath,
        pid: processInfo.pid,
        cwd: processInfo.cwd ?? null,
        command: processInfo.command ?? "",
      };

      if (dryRun) {
        skipped.push({ ...record, reason: "dry_run" });
        continue;
      }

      try {
        await killProcess(processInfo.pid, signal);
        killed.push(record);
      } catch (error) {
        errors.push({
          ...record,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    attempted: candidates.length > 0,
    dryRun,
    workspaceCount: candidates.length,
    killed,
    skipped,
    errors,
  };
}

function combineWorkspaceCleanup(left, right) {
  if (!left) return right;
  if (!right) return left;

  return {
    attempted: Boolean(left.attempted || right.attempted),
    dryRun: Boolean(left.dryRun && right.dryRun),
    workspaceCount: (left.workspaceCount ?? 0) + (right.workspaceCount ?? 0),
    killed: [...(left.killed ?? []), ...(right.killed ?? [])],
    skipped: [...(left.skipped ?? []), ...(right.skipped ?? [])],
    errors: [...(left.errors ?? []), ...(right.errors ?? [])],
  };
}

function combineResourceCleanup(left, right) {
  if (!left) return right;
  if (!right) return left;

  return {
    attempted: Boolean(left.attempted || right.attempted),
    dryRun: Boolean(left.dryRun && right.dryRun),
    workspaceCount: (left.workspaceCount ?? 0) + (right.workspaceCount ?? 0),
    commandCount: Math.max(left.commandCount ?? 0, right.commandCount ?? 0),
    cleaned: [...(left.cleaned ?? []), ...(right.cleaned ?? [])],
    skipped: [...(left.skipped ?? []), ...(right.skipped ?? [])],
    errors: [...(left.errors ?? []), ...(right.errors ?? [])],
  };
}

function combineBrowserCleanup(left, right) {
  if (!left) return right;
  if (!right) return left;

  return {
    attempted: Boolean(left.attempted || right.attempted),
    dryRun: Boolean(left.dryRun && right.dryRun),
    workspaceCount: (left.workspaceCount ?? 0) + (right.workspaceCount ?? 0),
    cleaned: [...(left.cleaned ?? []), ...(right.cleaned ?? [])],
    skipped: [...(left.skipped ?? []), ...(right.skipped ?? [])],
    errors: [...(left.errors ?? []), ...(right.errors ?? [])],
  };
}

function combineBranchCleanup(left, right) {
  if (!left) return right;
  if (!right) return left;

  return {
    attempted: Boolean(left.attempted || right.attempted),
    dryRun: Boolean(left.dryRun && right.dryRun),
    projectId: left.projectId ?? right.projectId ?? null,
    defaultBranch: left.defaultBranch ?? right.defaultBranch ?? "main",
    deleted: [...(left.deleted ?? []), ...(right.deleted ?? [])],
    skipped: [...(left.skipped ?? []), ...(right.skipped ?? [])],
    errors: [...(left.errors ?? []), ...(right.errors ?? [])],
  };
}

const CLEANUP_FAILURE_REASONS = new Set([
  "compose_discovery_failed",
  "resource_discovery_failed",
  "resource_removal_failed",
  "resource_verification_failed",
  "resources_remaining",
]);

function cleanupRecordMatches(left, right) {
  const keys = ["sessionId", "issueId", "branch", "workspacePath", "name"];
  return keys.some((key) => left?.[key] && right?.[key] && left[key] === right[key]);
}

function cleanupFailures(result) {
  const errors = result?.errors ?? [];
  const completed = [...(result?.cleaned ?? []), ...(result?.deleted ?? [])];
  const skipped = (result?.skipped ?? []).filter((item) => {
    if (CLEANUP_FAILURE_REASONS.has(item?.reason)) return true;
    if (item?.reason !== "checked_out_worktree") return false;
    return !completed.some((record) => cleanupRecordMatches(item, record));
  });
  return [...errors, ...skipped];
}

function hasCleanupErrors(result) {
  return cleanupFailures(result).length > 0;
}

function hasCleanupPreconditionErrors(result) {
  return (result?.errors ?? []).length > 0
    || (result?.skipped ?? []).some((item) => CLEANUP_FAILURE_REASONS.has(item?.reason));
}

function hasCheckedOutWorktreeSkips(result) {
  return Array.isArray(result?.skipped)
    && result.skipped.some((item) => item?.reason === "checked_out_worktree");
}

function createCleanupStageReport({ result = null, reason, blockedBy = [] } = {}) {
  if (result) {
    if (result.dryRun === true) return { status: "skipped", reason: "dry_run", result };
    const failures = cleanupFailures(result);
    return failures.length > 0
      ? { status: "failed", result, failures }
      : { status: "completed", result };
  }
  return {
    status: "skipped",
    reason,
    blockedBy,
  };
}

function createCleanupReport({
  cleanupEnabled,
  orchestratorCleanup,
  mergeQueueAttempted,
  postMergeBrowserCleanup,
  postMergeResourceCleanup,
  postMergeBranchCleanup,
  postMergeCleanup,
  postMergeBranchCleanupFailed,
  observedCompletionBrowserCleanup,
  observedCompletionResourceCleanup,
  observedCompletionBranchCleanup,
  observedCompletionCleanup,
  hasObservedCompleted,
  dryRun,
  mergeFinalized,
} = {}) {
  const postMergePreCleanupBlockedBy = [
    ...(hasCleanupErrors(postMergeBrowserCleanup) ? ["workspace_browsers"] : []),
    ...(hasCleanupErrors(postMergeResourceCleanup) ? ["workspace_resources"] : []),
  ];
  const observedCompletionPreCleanupBlockedBy = [
    ...(hasCleanupErrors(observedCompletionBrowserCleanup) ? ["workspace_browsers"] : []),
    ...(hasCleanupErrors(observedCompletionResourceCleanup) ? ["workspace_resources"] : []),
  ];

  return {
    enabled: cleanupEnabled,
    orchestrator: cleanupEnabled
      ? createCleanupStageReport({
        result: orchestratorCleanup,
        reason: dryRun ? "dry_run" : "not_run",
      })
      : createCleanupStageReport({ reason: "cleanup_disabled" }),
    postMerge: {
      browserCleanup: mergeQueueAttempted
        ? createCleanupStageReport({ result: postMergeBrowserCleanup })
        : createCleanupStageReport({ reason: dryRun ? "dry_run" : "merge_queue_not_attempted" }),
      resourceCleanup: mergeQueueAttempted
        ? createCleanupStageReport({ result: postMergeResourceCleanup })
        : createCleanupStageReport({ reason: dryRun ? "dry_run" : "merge_queue_not_attempted" }),
      branchCleanup: postMergeBranchCleanup
        ? createCleanupStageReport({ result: postMergeBranchCleanup })
        : createCleanupStageReport({
          reason: !cleanupEnabled
            ? "cleanup_disabled"
            : dryRun
              ? "dry_run"
              : !mergeFinalized
                ? "merge_not_finalized"
                : postMergePreCleanupBlockedBy.length > 0
                  ? "pre_cleanup_errors"
                  : "not_run",
          blockedBy: postMergePreCleanupBlockedBy,
        }),
      completedSessionCleanup: postMergeCleanup
        ? createCleanupStageReport({ result: postMergeCleanup })
        : createCleanupStageReport({
          reason: !cleanupEnabled
            ? "cleanup_disabled"
            : dryRun
              ? "dry_run"
              : !mergeFinalized
                ? "merge_not_finalized"
                : postMergePreCleanupBlockedBy.length > 0
                  ? "pre_cleanup_errors"
                  : postMergeBranchCleanupFailed
                    ? "branch_cleanup_errors"
                    : "not_run",
          blockedBy: postMergeBranchCleanupFailed
            ? ["branches"]
            : postMergePreCleanupBlockedBy,
        }),
    },
    observedCompletion: {
      browserCleanup: observedCompletionBrowserCleanup
        ? createCleanupStageReport({ result: observedCompletionBrowserCleanup })
        : createCleanupStageReport({
          reason: !cleanupEnabled
            ? "cleanup_disabled"
            : dryRun
              ? "dry_run"
              : postMergeCleanup
                ? "post_merge_cleanup_completed"
                : postMergeBranchCleanupFailed
                  ? "post_merge_branch_cleanup_errors"
                  : !hasObservedCompleted
                    ? "no_completed_sessions"
                    : "not_run",
        }),
      resourceCleanup: observedCompletionResourceCleanup
        ? createCleanupStageReport({ result: observedCompletionResourceCleanup })
        : createCleanupStageReport({
          reason: !cleanupEnabled
            ? "cleanup_disabled"
            : dryRun
              ? "dry_run"
              : postMergeCleanup
                ? "post_merge_cleanup_completed"
                : postMergeBranchCleanupFailed
                  ? "post_merge_branch_cleanup_errors"
                  : !hasObservedCompleted
                    ? "no_completed_sessions"
                    : "not_run",
        }),
      branchCleanup: observedCompletionBranchCleanup
        ? createCleanupStageReport({ result: observedCompletionBranchCleanup })
        : createCleanupStageReport({
          reason: !cleanupEnabled
            ? "cleanup_disabled"
            : dryRun
              ? "dry_run"
              : postMergeCleanup
                ? "post_merge_cleanup_completed"
                : postMergeBranchCleanupFailed
                  ? "post_merge_branch_cleanup_errors"
                  : !hasObservedCompleted
                    ? "no_completed_sessions"
                    : observedCompletionPreCleanupBlockedBy.length > 0
                      ? "pre_cleanup_errors"
                      : "not_run",
          blockedBy: observedCompletionPreCleanupBlockedBy,
        }),
      completedSessionCleanup: observedCompletionCleanup
        ? createCleanupStageReport({ result: observedCompletionCleanup })
        : createCleanupStageReport({
          reason: !cleanupEnabled
            ? "cleanup_disabled"
            : dryRun
              ? "dry_run"
              : postMergeCleanup
                ? "post_merge_cleanup_completed"
                : postMergeBranchCleanupFailed
                  ? "post_merge_branch_cleanup_errors"
                  : !hasObservedCompleted
                    ? "no_completed_sessions"
                    : observedCompletionPreCleanupBlockedBy.length > 0
                      ? "pre_cleanup_errors"
                      : hasCleanupErrors(observedCompletionBranchCleanup)
                        ? "branch_cleanup_errors"
                        : "not_run",
          blockedBy: hasCleanupErrors(observedCompletionBranchCleanup)
            ? ["branches"]
            : observedCompletionPreCleanupBlockedBy,
        }),
    },
  };
}

function cleanupReportHasFailures(value) {
  if (!value || typeof value !== "object") return false;
  if (value.status === "failed") return true;
  return Object.values(value).some(cleanupReportHasFailures);
}

function normalizeLeaseHeartbeatIntervalMs(value, staleAfterMs) {
  const maximumInterval = Math.max(1, Math.floor(staleAfterMs / 3));
  if (value === undefined || value === null) return maximumInterval;
  const interval = Number(value);
  if (!Number.isFinite(interval) || interval < 1) {
    throw new Error("Lease heartbeat interval must be a positive number of milliseconds");
  }
  return Math.min(Math.floor(interval), maximumInterval);
}

export function normalizeLeaseHeartbeatTimeoutMs(value, staleAfterMs) {
  const staleThreshold = Number(staleAfterMs);
  if (!Number.isFinite(staleThreshold) || staleThreshold <= 1) {
    throw new Error("Lease stale threshold must be greater than one millisecond");
  }

  const maximumTimeout = Math.max(1, Math.ceil(staleThreshold) - 1);
  const requestedTimeout = value === undefined || value === null
    ? Math.floor(staleThreshold / 3)
    : Number(value);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
    throw new Error("Lease heartbeat timeout must be a positive number of milliseconds");
  }
  return Math.min(Math.max(1, Math.floor(requestedTimeout)), maximumTimeout);
}

export function createLeaseHeartbeatGuard(options) {
  let ownershipError = null;
  let heartbeatInFlight = null;
  let heartbeatPending = false;
  let stopped = false;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  const performHeartbeat = () => {
    let timeoutHandle;
    const heartbeatOperation = Promise.resolve().then(() => options.heartbeatLease({
      leasePath: options.leasePath,
      ownerId: options.lease.ownerId,
      leaseId: options.lease.leaseId,
      now: options.now,
    }));
    const timeoutOperation = new Promise((_, rejectPromise) => {
      timeoutHandle = setTimeoutFn(() => {
        const error = Object.assign(
          new Error(`Dark Factory lease heartbeat timed out after ${options.timeoutMs}ms`),
          { code: "DARK_FACTORY_LEASE_HEARTBEAT_TIMEOUT" },
        );
        rejectPromise(error);
      }, options.timeoutMs);
      timeoutHandle?.unref?.();
    });

    const currentHeartbeat = Promise.race([heartbeatOperation, timeoutOperation])
      .catch((error) => {
        ownershipError ??= error;
      })
      .finally(() => {
        clearTimeoutFn(timeoutHandle);
        if (heartbeatInFlight !== currentHeartbeat) return;
        heartbeatInFlight = null;
        if (stopped || ownershipError || !heartbeatPending) return;
        heartbeatPending = false;
        heartbeatInFlight = performHeartbeat();
      });
    return currentHeartbeat;
  };

  const queueHeartbeat = () => {
    if (stopped || ownershipError) return heartbeatInFlight ?? Promise.resolve();
    if (heartbeatInFlight) {
      heartbeatPending = true;
      return heartbeatInFlight;
    }
    heartbeatInFlight = performHeartbeat();
    return heartbeatInFlight;
  };
  const timer = setIntervalFn(queueHeartbeat, options.intervalMs);
  timer.unref?.();

  const assertOwned = async () => {
    const heartbeatSnapshot = heartbeatInFlight;
    if (heartbeatSnapshot) await heartbeatSnapshot;
    if (ownershipError) throw ownershipError;
  };

  return {
    assertOwned,
    getOwnershipError: () => ownershipError,
    heartbeatNow: async () => {
      queueHeartbeat();
      await assertOwned();
    },
    runOwned: async (operation) => {
      await assertOwned();
      let result;
      try {
        result = await operation();
      } catch (error) {
        throw error;
      }
      await assertOwned();
      return result;
    },
    stop: async () => {
      stopped = true;
      heartbeatPending = false;
      clearIntervalFn(timer);
      if (heartbeatInFlight) await heartbeatInFlight;
      return ownershipError;
    },
  };
}

export async function runDarkFactory(options = {}) {
  const { project, projects } = await resolveRunTarget(options);
  const runtimePaths = getProjectRuntimePaths(project.id);
  const controlStatePath = options.controlStatePath ?? runtimePaths.controlStatePath;
  const readControlState = options.readControlState ?? readControlStateFile;
  const control = await readControlState(controlStatePath, { project });
  const leasePath = options.leasePath ?? `${runtimePaths.root}/lease.json`;
  const ownerId = options.leaseOwnerId ?? `${process.pid}:${randomUUID()}`;
  const acquireLease = options.acquireProjectLease ?? acquireProjectLease;
  const heartbeatLease = options.heartbeatProjectLease ?? heartbeatProjectLease;
  const releaseLease = options.releaseProjectLease ?? releaseProjectLease;
  const writeSupervisionFailureState = options.writeSupervisionFailureState ?? writeControlStateFile;
  const supervisionFailureStatePath = options.supervisionFailureStatePath
    ?? `${runtimePaths.root}/supervision-failure.json`;
  const leaseStaleAfterMs = options.leaseStaleAfterMs ?? 120_000;
  const leaseHeartbeatIntervalMs = normalizeLeaseHeartbeatIntervalMs(
    options.leaseHeartbeatIntervalMs,
    leaseStaleAfterMs,
  );
  const leaseHeartbeatTimeoutMs = normalizeLeaseHeartbeatTimeoutMs(
    options.leaseHeartbeatTimeoutMs,
    leaseStaleAfterMs,
  );
  const lease = await acquireLease({
    leasePath,
    projectId: project.id,
    ownerId,
    staleAfterMs: leaseStaleAfterMs,
    now: options.now,
  });
  const heartbeatGuard = createLeaseHeartbeatGuard({
    leasePath,
    lease,
    heartbeatLease,
    now: options.now,
    intervalMs: leaseHeartbeatIntervalMs,
    timeoutMs: leaseHeartbeatTimeoutMs,
    setIntervalFn: options.setLeaseHeartbeatInterval,
    clearIntervalFn: options.clearLeaseHeartbeatInterval,
    setTimeoutFn: options.setLeaseHeartbeatTimeout,
    clearTimeoutFn: options.clearLeaseHeartbeatTimeout,
  });

  let orchestrationError = null;
  try {
    return await runDarkFactoryWithLease({
      ...options,
      project,
      projects,
      controlStatePath,
      readControlState,
      initialControl: control,
    }, {
      leasePath,
      lease,
      assertOwned: heartbeatGuard.assertOwned,
      heartbeatNow: heartbeatGuard.heartbeatNow,
      runOwned: heartbeatGuard.runOwned,
    });
  } catch (error) {
    orchestrationError = error;
    const failedSupervision = {
      version: 1,
      projectId: project.id,
      exitReason: "failed",
      controlMode: String(control?.mode ?? "active").toLowerCase(),
    };
    error.supervision = failedSupervision;
    try {
      const failedAtValue = options.now ? options.now() : new Date();
      const failedAt = failedAtValue instanceof Date ? failedAtValue : new Date(failedAtValue);
      if (Number.isNaN(failedAt.getTime())) throw new Error("Supervision failure clock returned an invalid date");
      await heartbeatGuard.runOwned(() => writeSupervisionFailureState(supervisionFailureStatePath, {
        ...failedSupervision,
        failedAt: failedAt.toISOString(),
      }));
    } catch (persistenceError) {
      if (persistenceError === heartbeatGuard.getOwnershipError()) {
        if (persistenceError !== error) error.leaseOwnershipError = persistenceError;
      } else {
        error.failureStatePersistenceError = persistenceError;
      }
    }
    throw error;
  } finally {
    const ownershipError = await heartbeatGuard.stop();
    if (ownershipError && orchestrationError && ownershipError !== orchestrationError) {
      orchestrationError.leaseOwnershipError ??= ownershipError;
    }
    const primaryError = orchestrationError ?? ownershipError;
    try {
      await releaseLease({
        leasePath,
        ownerId: lease.ownerId,
        leaseId: lease.leaseId,
      });
    } catch (releaseError) {
      if (primaryError) primaryError.leaseReleaseError = releaseError;
      else throw releaseError;
    }
    if (!orchestrationError && ownershipError) throw ownershipError;
  }
}

async function runDarkFactoryWithLease(options, leaseContext) {
  const cwd = options.cwd ?? process.cwd();
  const { project, projects } = await resolveRunTarget(options);
  const dryRun = options.dryRun ?? true;
  const aoCommand = options.aoCommand ?? project.agentConfig?.aoCommand;
  const transport = aoTransport({ ...options, cwd, aoCommand });
  const ownedCall = (operation) => (...args) => leaseContext.runOwned(() => operation(...args));
  const verifyPlanningFresh = ownedCall(options.verifyPlanningFresh ?? verifyProjectPlanningFresh);
  const preflight = await verifyPlanningFresh({ project });
  const runtimePaths = getProjectRuntimePaths(project.id);
  const observabilityStatePath = options.observabilityStatePath ?? runtimePaths.observabilityStatePath;
  const runnerStatePath = options.statePath ?? runtimePaths.runnerStatePath;
  const eventLogPath = options.eventLogPath ?? runtimePaths.eventLogPath;
  const dashboardOutputPath = options.dashboardOutputPath ?? runtimePaths.dashboardOutputPath;
  const controlStatePath = options.controlStatePath ?? runtimePaths.controlStatePath;
  const readControlState = ownedCall(options.readControlState ?? readControlStateFile);
  let control = options.initialControl ?? await readControlState(controlStatePath, { project });
  let controlMode = String(control?.mode ?? "active").toLowerCase();
  let effectiveConcurrency = allowsWorkerProgress(controlMode) ? options.concurrency : 0;
  const runObserver = ownedCall(options.runObserver ?? runObservabilityOnce);
  const runRunner = ownedCall(options.runRunner ?? runOnce);
  const writeDashboardFile = ownedCall(options.writeDashboard ?? writeDashboard);
  const syncAoConfig = ownedCall(options.writeAoConfig ?? writeAoConfig);
  const runCleanup = ownedCall(options.cleanupAoSessions ?? cleanupObservedCompletedAoSessions);
  const runOrchestratorCleanup = ownedCall(
    options.cleanupStaleAoOrchestrators ?? skippedGoAoOrchestratorCleanup,
  );
  const runWorkspaceCleanup = ownedCall(
    options.cleanupWorkspaceProcesses ?? cleanupTerminalWorkspaceProcesses,
  );
  const runResourceCleanup = ownedCall(
    options.cleanupWorkspaceResources ?? cleanupCompletedWorkspaceResources,
  );
  const runBrowserCleanup = ownedCall(
    options.cleanupWorkspaceBrowsers ?? cleanupCompletedWorkspaceBrowsers,
  );
  const runBranchCleanup = ownedCall(options.cleanupMergedBranches ?? cleanupMergedBranches);
  const runAoLifecycleStartup = ownedCall(
    options.ensureAoLifecycle ?? (options.runRunner ? async () => null : ensureAoLifecycleStarted),
  );
  const aoConfig = await syncAoConfig({
    registryPath: options.registryPath ?? DEFAULT_REGISTRY_PATH,
    cwd,
    transport,
    createTransport: options.createTransport,
    project,
    projects,
    aoCommand: options.aoCommand,
    workerPlugin: options.workerPlugin,
  });
  const cleanupEnabled = options.cleanupCompletedSessions !== false;
  const maxAutonomousSupervisionPasses = normalizeAutonomousSupervisionPasses(
    options.maxAutonomousSupervisionPasses ?? options.maxAutonomousRecoveryPasses,
  );
  const supervisionIntervalMs = normalizeAutonomousSupervisionIntervalMs(options.supervisionIntervalMs);
  const waitForSupervision = options.sleep ?? sleep;
  const supervision = {
    passes: 0,
    exitReason: allowsWorkerProgress(controlMode)
      ? null
      : controlMode === "stopped"
        ? "stopped"
        : "paused",
    controlMode,
  };
  let supervisionHalted = !allowsWorkerProgress(controlMode);
  const runTaskLimit = options.taskLimit;
  const runId = options.runId ?? randomUUID();
  const invocationId = options.invocationId ?? randomUUID();
  let currentRunLedger = options.runLedger ?? null;
  const cleanupSessionIdsFor = (currentObservability) => sessionIdsForTaskIds(
    currentObservability,
    currentRunLedger?.chargedTaskIds ?? [],
  );
  const runRunnerWithControlFence = async (runnerOptions) => {
    control = await readControlState(controlStatePath, { project });
    controlMode = String(control?.mode ?? "active").toLowerCase();
    supervision.controlMode = controlMode;
    const workerProgressAllowed = allowsWorkerProgress(controlMode);
    effectiveConcurrency = workerProgressAllowed ? options.concurrency : 0;
    if (!workerProgressAllowed) {
      supervision.exitReason = controlMode === "stopped" ? "stopped" : "paused";
      supervisionHalted = true;
    }

    const result = await runRunner({
      ...runnerOptions,
      dryRun: workerProgressAllowed ? runnerOptions.dryRun : true,
      concurrency: workerProgressAllowed ? runnerOptions.concurrency : 0,
      taskLimit: workerProgressAllowed ? runnerOptions.taskLimit : 0,
      runLedgerPath: options.runLedgerPath ?? runtimePaths.runLedgerPath,
      runId,
      invocationId,
      runInvocation: "run",
      runLedger: currentRunLedger,
    });
    currentRunLedger = result?.runLedger ?? currentRunLedger;
    return result;
  };
  const orchestratorCleanup = cleanupEnabled
    ? await runOrchestratorCleanup({
      cwd,
      project,
      dryRun,
      transport,
      aoCommand,
    })
    : null;
  const aoLifecycle = dryRun
    ? null
    : await runAoLifecycleStartup({
      cwd,
      project,
      transport,
      aoCommand,
    });
  let observedRunnerState = false;
  let observability = await runObserver({
    cwd,
    project,
    statePath: observabilityStatePath,
    runnerStatePath,
    eventLogPath,
    transport,
    aoCommand,
    staleAfterMs: options.staleAfterMs,
  });
  let runner = await runRunnerWithControlFence({
    cwd,
    project,
    dryRun,
    concurrency: effectiveConcurrency,
    taskLimit: runTaskLimit,
    statePath: runnerStatePath,
    observabilityStatePath,
    eventLogPath,
    observabilityState: observability,
    transport,
    aoCommand,
  });
  observedRunnerState = false;
  let workspaceCleanup = null;
  let resourceCleanup = null;
  let browserCleanup = null;
  let postMergeBrowserCleanup = null;
  let postMergeResourceCleanup = null;
  let supervisingStartedWorkers = hasSpawnedWorkers(runner)
    || hasResumedWorkers(runner)
    || hasActiveWorkers(observability)
    || (hasMergeQueueAttempt(runner) && hasActiveWorkers(observability));

  for (
    ;
    !dryRun
      && supervision.passes < maxAutonomousSupervisionPasses
      && shouldContinueAutonomousSupervision({ runner, observability, supervisingStartedWorkers });
  ) {
    if (supervisionIntervalMs > 0) {
      await waitForSupervision(supervisionIntervalMs);
    }

    await leaseContext.heartbeatNow();
    control = await readControlState(controlStatePath, { project });
    controlMode = String(control?.mode ?? "active").toLowerCase();
    supervision.controlMode = controlMode;
    if (!allowsWorkerProgress(controlMode)) {
      supervision.exitReason = controlMode === "stopped" ? "stopped" : "paused";
      supervisionHalted = true;
      break;
    }
    effectiveConcurrency = options.concurrency;

    observability = await runObserver({
      cwd,
      project,
      statePath: observabilityStatePath,
      runnerStatePath,
      eventLogPath,
      transport,
      aoCommand,
      staleAfterMs: options.staleAfterMs,
    });
    observedRunnerState = true;

    workspaceCleanup = combineWorkspaceCleanup(workspaceCleanup, await runWorkspaceCleanup({
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    }));

    runner = await runRunnerWithControlFence({
      cwd,
      project,
      dryRun,
      concurrency: effectiveConcurrency,
      taskLimit: runTaskLimit,
      statePath: runnerStatePath,
      observabilityStatePath,
      eventLogPath,
      observabilityState: observability,
      transport,
      aoCommand,
    });
    supervisingStartedWorkers = supervisingStartedWorkers || hasSpawnedWorkers(runner) || hasResumedWorkers(runner);
    observedRunnerState = false;
    supervision.passes += 1;
  }

  if (!dryRun && !supervisionHalted && hasMergeQueueAttempt(runner)) {
    observability = await runObserver({
      cwd,
      project,
      statePath: observabilityStatePath,
      runnerStatePath,
      eventLogPath,
      transport,
      aoCommand,
      staleAfterMs: options.staleAfterMs,
    });
    observedRunnerState = true;

    workspaceCleanup = combineWorkspaceCleanup(workspaceCleanup, await runWorkspaceCleanup({
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    }));

    postMergeBrowserCleanup = await runBrowserCleanup({
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    });
    browserCleanup = combineBrowserCleanup(browserCleanup, postMergeBrowserCleanup);

    postMergeResourceCleanup = await runResourceCleanup({
      project,
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    });
    resourceCleanup = combineResourceCleanup(resourceCleanup, postMergeResourceCleanup);
  }

  const canRunPostMergeCleanup = cleanupEnabled
    && !dryRun
    && !supervisionHalted
    && hasSuccessfulMergeQueueRun(runner)
    && !hasCleanupErrors(resourceCleanup)
    && !hasCleanupErrors(browserCleanup);

  let postMergeBranchCleanup = canRunPostMergeCleanup
    ? await runBranchCleanup({
      cwd,
      project,
      dryRun: false,
      observability,
      sessionIds: cleanupSessionIdsFor(observability),
    })
    : null;
  const postMergeBranchCleanupFailed = hasCleanupPreconditionErrors(postMergeBranchCleanup);

  let postMergeCleanup = canRunPostMergeCleanup
    && !postMergeBranchCleanupFailed
    ? await runCleanup({
      cwd,
      project,
      dryRun: false,
      observability,
      transport,
      aoCommand,
      sessionIds: cleanupSessionIdsFor(observability),
    })
    : null;

  if (postMergeCleanup && hasCheckedOutWorktreeSkips(postMergeBranchCleanup)) {
    postMergeBranchCleanup = combineBranchCleanup(postMergeBranchCleanup, await runBranchCleanup({
      cwd,
      project,
      dryRun: false,
      observability,
      sessionIds: cleanupSessionIdsFor(observability),
    }));
  }

  if (postMergeCleanup) {
    observability = await runObserver({
      cwd,
      project,
      statePath: observabilityStatePath,
      runnerStatePath,
      eventLogPath,
      transport,
      aoCommand,
      staleAfterMs: options.staleAfterMs,
    });
    observedRunnerState = true;
    if (!supervisionHalted && hasStaleWorkspaceSkips(runner)) {
      runner = await runRunnerWithControlFence({
        cwd,
        project,
        dryRun,
        concurrency: effectiveConcurrency,
        taskLimit: runTaskLimit,
        statePath: runnerStatePath,
        observabilityStatePath,
        eventLogPath,
        observabilityState: observability,
        transport,
        aoCommand,
      });
      observedRunnerState = false;
    }
  }

  if (!observedRunnerState) {
    observability = await runObserver({
      cwd,
      project,
      statePath: observabilityStatePath,
      runnerStatePath,
      eventLogPath,
      transport,
      aoCommand,
      staleAfterMs: options.staleAfterMs,
    });
  }

  if (!supervisionHalted && shouldRunTerminalMergePass({ dryRun, runner, observability })) {
    workspaceCleanup = combineWorkspaceCleanup(workspaceCleanup, await runWorkspaceCleanup({
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    }));

    runner = await runRunnerWithControlFence({
      cwd,
      project,
      dryRun,
      recoverOnly: true,
      concurrency: effectiveConcurrency,
      taskLimit: 0,
      statePath: runnerStatePath,
      observabilityStatePath,
      eventLogPath,
      observabilityState: observability,
      transport,
      aoCommand,
    });
    observedRunnerState = false;

    if (hasMergeQueueAttempt(runner)) {
      observability = await runObserver({
        cwd,
        project,
        statePath: observabilityStatePath,
        runnerStatePath,
        eventLogPath,
        transport,
        aoCommand,
        staleAfterMs: options.staleAfterMs,
      });
      observedRunnerState = true;

      workspaceCleanup = combineWorkspaceCleanup(workspaceCleanup, await runWorkspaceCleanup({
        observability,
        dryRun: false,
        sessionIds: cleanupSessionIdsFor(observability),
      }));
    }
  }

  const observedCompletionBrowserCleanup = cleanupEnabled
    && !dryRun
    && !supervisionHalted
    && !postMergeCleanup
    && !postMergeBranchCleanupFailed
    && hasTerminalResourceCleanupCandidates(observability, cleanupSessionIdsFor(observability))
    ? await runBrowserCleanup({
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    })
    : null;

  const observedCompletionResourceCleanup = cleanupEnabled
    && !dryRun
    && !supervisionHalted
    && !postMergeCleanup
    && !postMergeBranchCleanupFailed
    && hasTerminalResourceCleanupCandidates(observability, cleanupSessionIdsFor(observability))
    ? await runResourceCleanup({
      project,
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    })
    : null;

  resourceCleanup = combineResourceCleanup(resourceCleanup, observedCompletionResourceCleanup);
  browserCleanup = combineBrowserCleanup(browserCleanup, observedCompletionBrowserCleanup);

  const observedCompletionCleanup = cleanupEnabled
    && !dryRun
    && !supervisionHalted
    && !postMergeCleanup
    && !postMergeBranchCleanupFailed
    && hasObservedCompletedSessions(observability, cleanupSessionIdsFor(observability))
    && !hasCleanupErrors(observedCompletionResourceCleanup)
    && !hasCleanupErrors(observedCompletionBrowserCleanup);

  let observedCompletionBranchCleanup = observedCompletionCleanup
    ? await runBranchCleanup({
      cwd,
      project,
      dryRun: false,
      observability,
      sessionIds: cleanupSessionIdsFor(observability),
    })
    : null;

  const observedCompletionAoCleanup = observedCompletionCleanup
    && !hasCleanupPreconditionErrors(observedCompletionBranchCleanup)
    ? await runCleanup({
      cwd,
      project,
      dryRun: false,
      observability,
      transport,
      aoCommand,
      sessionIds: cleanupSessionIdsFor(observability),
    })
    : null;

  if (observedCompletionAoCleanup && hasCheckedOutWorktreeSkips(observedCompletionBranchCleanup)) {
    observedCompletionBranchCleanup = combineBranchCleanup(observedCompletionBranchCleanup, await runBranchCleanup({
      cwd,
      project,
      dryRun: false,
      observability,
      sessionIds: cleanupSessionIdsFor(observability),
    }));
  }

  if (observedCompletionAoCleanup) {
    observability = await runObserver({
      cwd,
      project,
      statePath: observabilityStatePath,
      runnerStatePath,
      eventLogPath,
      transport,
      aoCommand,
      staleAfterMs: options.staleAfterMs,
    });
    if (!supervisionHalted && hasStaleWorkspaceSkips(runner)) {
      runner = await runRunnerWithControlFence({
        cwd,
        project,
        dryRun,
        concurrency: effectiveConcurrency,
        taskLimit: runTaskLimit,
        statePath: runnerStatePath,
        observabilityStatePath,
        eventLogPath,
        observabilityState: observability,
        transport,
        aoCommand,
      });
    }
  }

  if (!supervision.exitReason) {
    const supervisionBudgetExhausted = !dryRun
      && supervision.passes >= maxAutonomousSupervisionPasses
      && shouldContinueAutonomousSupervision({ runner, observability, supervisingStartedWorkers });
    supervision.exitReason = supervisionBudgetExhausted ? "budget_exhausted" : "complete";
  }

  const cleanup = createCleanupReport({
    cleanupEnabled,
    orchestratorCleanup,
    mergeQueueAttempted: !dryRun && hasMergeQueueAttempt(runner),
    postMergeBrowserCleanup,
    postMergeResourceCleanup,
    postMergeBranchCleanup,
    postMergeCleanup,
    postMergeBranchCleanupFailed,
    observedCompletionBrowserCleanup,
    observedCompletionResourceCleanup,
    observedCompletionBranchCleanup,
    observedCompletionCleanup: observedCompletionAoCleanup,
    hasObservedCompleted: hasObservedCompletedSessions(observability),
    dryRun,
    mergeFinalized: hasSuccessfulMergeQueueRun(runner),
  });

  runner = reconcileRunnerSnapshot({
    ...runner,
    control,
    supervision,
    cleanup,
  }, observability, { now: options.now });

  if (!dryRun && currentRunLedger) {
    const runLedgerPath = options.runLedgerPath ?? runtimePaths.runLedgerPath;
    currentRunLedger = runner.complete
      ? await completeRunLedger(runLedgerPath, currentRunLedger, {
        now: options.now,
        cleanup,
        status: cleanupReportHasFailures(cleanup) ? "cleanup_failed" : "completed",
      })
      : await updateRunLedger(runLedgerPath, currentRunLedger, { cleanup }, { now: options.now });
    runner.runLedger = currentRunLedger;
  }

  const persistRunnerState = options.persistRunnerState
    ?? (options.runRunner ? null : writeRunnerState);
  if (!dryRun && persistRunnerState) {
    await ownedCall(persistRunnerState)(runnerStatePath, runner);
  }

  const dashboard = await writeDashboardFile({
    observability,
    runner,
    outputPath: dashboardOutputPath,
    control,
    supervision,
  });

  return {
    project,
    preflight,
    dryRun: runner.dryRun,
    observability,
    runner,
    dashboard,
    aoConfig,
    aoLifecycle,
    control,
    supervision,
    orchestratorCleanup,
    cleanup,
    workspaceCleanup,
    resourceCleanup,
    browserCleanup,
    branchCleanup: postMergeBranchCleanup ?? observedCompletionBranchCleanup,
    postMergeBranchCleanup,
    postMergeCleanup,
    observedCompletionBranchCleanup,
    observedCompletionCleanup: observedCompletionAoCleanup,
  };
}

export async function runDarkFactoryCleanup(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const { project, projects } = await resolveRunTarget(options);
  const dryRun = options.dryRun ?? true;
  const aoCommand = options.aoCommand ?? project.agentConfig?.aoCommand;
  const transport = aoTransport({ ...options, cwd, aoCommand });
  const verifyPlanningFresh = options.verifyPlanningFresh ?? verifyProjectPlanningFresh;
  const preflight = await verifyPlanningFresh({ project });
  const runtimePaths = getProjectRuntimePaths(project.id);
  const observabilityStatePath = options.observabilityStatePath ?? runtimePaths.observabilityStatePath;
  const runnerStatePath = options.statePath ?? runtimePaths.runnerStatePath;
  const eventLogPath = options.eventLogPath ?? runtimePaths.eventLogPath;
  const dashboardOutputPath = options.dashboardOutputPath ?? runtimePaths.dashboardOutputPath;
  const syncAoConfig = options.writeAoConfig ?? writeAoConfig;
  const runObserver = options.runObserver ?? runObservabilityOnce;
  const writeDashboardFile = options.writeDashboard ?? writeDashboard;
  const runWorkspaceCleanup = options.cleanupWorkspaceProcesses ?? cleanupTerminalWorkspaceProcesses;
  const runBrowserCleanup = options.cleanupWorkspaceBrowsers ?? cleanupCompletedWorkspaceBrowsers;
  const runResourceCleanup = options.cleanupWorkspaceResources ?? cleanupCompletedWorkspaceResources;
  const runBranchCleanup = options.cleanupMergedBranches ?? cleanupMergedBranches;
  const runCleanup = options.cleanupAoSessions ?? cleanupObservedCompletedAoSessions;
  const runOrchestratorCleanup = options.cleanupStaleAoOrchestrators ?? skippedGoAoOrchestratorCleanup;

  const aoConfig = await syncAoConfig({
    registryPath: options.registryPath ?? DEFAULT_REGISTRY_PATH,
    cwd,
    transport,
    createTransport: options.createTransport,
    project,
    projects,
    aoCommand: options.aoCommand,
    workerPlugin: options.workerPlugin,
  });

  let observability = await runObserver({
    cwd,
    project,
    statePath: observabilityStatePath,
    runnerStatePath,
    eventLogPath,
    transport,
    aoCommand,
    staleAfterMs: options.staleAfterMs,
  });

  const sessionIds = options.sessionIds ?? null;
  const workspaceCleanup = await runWorkspaceCleanup({ observability, dryRun, sessionIds });
  const browserCleanup = await runBrowserCleanup({ observability, dryRun, sessionIds });
  const resourceCleanup = await runResourceCleanup({ project, observability, dryRun, sessionIds });
  const unsafeBeforeBranchCleanup = hasCleanupErrors(browserCleanup) || hasCleanupErrors(resourceCleanup);
  let branchCleanup = unsafeBeforeBranchCleanup
    ? null
    : await runBranchCleanup({
      cwd,
      project,
      dryRun,
      observability,
      sessionIds,
    });
  const unsafeToRemoveWorktrees = unsafeBeforeBranchCleanup || hasCleanupPreconditionErrors(branchCleanup);

  const cleanup = unsafeToRemoveWorktrees
    ? null
    : await runCleanup({
      cwd,
      project,
      dryRun,
      observability,
      transport,
      aoCommand,
      sessionIds,
    });

  if (cleanup && hasCheckedOutWorktreeSkips(branchCleanup)) {
    branchCleanup = combineBranchCleanup(branchCleanup, await runBranchCleanup({
      cwd,
      project,
      dryRun,
      observability,
      sessionIds,
    }));
  }

  const orchestratorCleanup = unsafeToRemoveWorktrees
    ? null
    : await runOrchestratorCleanup({
      cwd,
      project,
      dryRun,
      transport,
      aoCommand,
    });

  observability = await runObserver({
    cwd,
    project,
    statePath: observabilityStatePath,
    runnerStatePath,
    eventLogPath,
    transport,
    aoCommand,
    staleAfterMs: options.staleAfterMs,
  });

  const dashboard = await writeDashboardFile({
    observability,
    runner: null,
    outputPath: dashboardOutputPath,
  });

  return {
    project,
    preflight,
    dryRun,
    aoConfig,
    observability,
    workspaceCleanup,
    browserCleanup,
    resourceCleanup,
    branchCleanup,
    cleanup,
    orchestratorCleanup,
    dashboard,
    blocked: unsafeToRemoveWorktrees
      ? { reason: "cleanup_errors_before_worktree_removal" }
      : null,
  };
}

export async function stopDarkFactory(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const { project, projects } = await resolveRunTarget(options);
  const dryRun = options.dryRun ?? true;
  const aoCommand = options.aoCommand ?? project.agentConfig?.aoCommand;
  const verifyPlanningFresh = options.verifyPlanningFresh ?? verifyProjectPlanningFresh;
  const preflight = await verifyPlanningFresh({ project });
  const runtimePaths = getProjectRuntimePaths(project.id);
  const observabilityStatePath = options.observabilityStatePath ?? runtimePaths.observabilityStatePath;
  const runnerStatePath = options.statePath ?? runtimePaths.runnerStatePath;
  const eventLogPath = options.eventLogPath ?? runtimePaths.eventLogPath;
  const dashboardOutputPath = options.dashboardOutputPath ?? runtimePaths.dashboardOutputPath;
  const controlStatePath = options.controlStatePath ?? runtimePaths.controlStatePath;
  const syncAoConfig = options.writeAoConfig ?? writeAoConfig;
  const runObserver = options.runObserver ?? runObservabilityOnce;
  const writeDashboardFile = options.writeDashboard ?? writeDashboard;
  const cleanupWorkspaceProcesses = options.cleanupWorkspaceProcesses ?? cleanupTerminalWorkspaceProcesses;
  const writeControlState = options.writeControlState ?? writeControlStateFile;
  const now = options.now ?? (() => new Date());
  const transport = aoTransport({ ...options, cwd, aoCommand });

  const aoConfig = await syncAoConfig({
    registryPath: options.registryPath ?? DEFAULT_REGISTRY_PATH,
    cwd,
    transport,
    createTransport: options.createTransport,
    project,
    projects,
    aoCommand: options.aoCommand,
    workerPlugin: options.workerPlugin,
  });

  const control = {
    version: 1,
    projectId: project.id,
    mode: "stopped",
    updatedAt: now().toISOString(),
  };
  if (!dryRun) {
    await writeControlState(controlStatePath, control, { project });
  }

  let observability = await runObserver({
    cwd,
    project,
    statePath: observabilityStatePath,
    runnerStatePath,
    eventLogPath,
    transport,
    aoCommand,
    staleAfterMs: options.staleAfterMs,
  });

  const stopped = await preserveActiveAoWorkerSessions({
    cwd,
    project,
    dryRun,
    observability,
    transport,
    aoCommand,
    execFileAsync: options.execFileAsync,
  });

  if (!dryRun && stopped.suspended.length > 0) {
    observability = await runObserver({
      cwd,
      project,
      statePath: observabilityStatePath,
      runnerStatePath,
      eventLogPath,
      transport,
      aoCommand,
      staleAfterMs: options.staleAfterMs,
    });
  }

  const workspaceCleanup = await cleanupWorkspaceProcesses({
    observability,
    dryRun,
    sessionIds: projectWorkerWorkspaceSessionIds(observability, project.id),
    includeNonTerminal: true,
  });

  const dashboard = dryRun
    ? null
    : await writeDashboardFile({
      observability,
      runner: null,
      control,
      outputPath: dashboardOutputPath,
    });

  return {
    project,
    preflight,
    dryRun,
    aoConfig,
    control,
    stopped,
    workspaceCleanup,
    observability,
    dashboard,
    controlStatePath,
  };
}

export async function recoverDarkFactory(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const { project, projects } = await resolveRunTarget(options);
  const dryRun = options.dryRun ?? true;
  const aoCommand = options.aoCommand ?? project.agentConfig?.aoCommand;
  const transport = aoTransport({ ...options, cwd, aoCommand });
  const verifyPlanningFresh = options.verifyPlanningFresh ?? verifyProjectPlanningFresh;
  const preflight = await verifyPlanningFresh({ project });
  const runtimePaths = getProjectRuntimePaths(project.id);
  const observabilityStatePath = options.observabilityStatePath ?? runtimePaths.observabilityStatePath;
  const runnerStatePath = options.statePath ?? runtimePaths.runnerStatePath;
  const eventLogPath = options.eventLogPath ?? runtimePaths.eventLogPath;
  const dashboardOutputPath = options.dashboardOutputPath ?? runtimePaths.dashboardOutputPath;
  const controlStatePath = options.controlStatePath ?? runtimePaths.controlStatePath;
  const syncAoConfig = options.writeAoConfig ?? writeAoConfig;
  const runObserver = options.runObserver ?? runObservabilityOnce;
  const runRunner = options.runRunner ?? runOnce;
  const writeDashboardFile = options.writeDashboard ?? writeDashboard;
  const writeControlState = options.writeControlState ?? writeControlStateFile;
  const readControlState = options.readControlState ?? readControlStateFile;
  const runWorkspaceCleanup = options.cleanupWorkspaceProcesses ?? cleanupTerminalWorkspaceProcesses;
  const runBrowserCleanup = options.cleanupWorkspaceBrowsers ?? cleanupCompletedWorkspaceBrowsers;
  const runResourceCleanup = options.cleanupWorkspaceResources ?? cleanupCompletedWorkspaceResources;
  const runBranchCleanup = options.cleanupMergedBranches ?? cleanupMergedBranches;
  const runCleanup = options.cleanupAoSessions ?? cleanupObservedCompletedAoSessions;
  const completeLedger = options.completeRunLedger ?? completeRunLedger;
  const updateLedger = options.updateRunLedger ?? updateRunLedger;
  const cleanupEnabled = options.cleanupCompletedSessions !== false;
  const now = options.now ?? (() => new Date());
  const maxAutonomousSupervisionPasses = normalizeAutonomousSupervisionPasses(
    options.maxAutonomousSupervisionPasses ?? options.maxAutonomousRecoveryPasses,
  );
  const supervisionIntervalMs = normalizeAutonomousSupervisionIntervalMs(options.supervisionIntervalMs);
  const waitForSupervision = options.sleep ?? sleep;
  const supervision = {
    passes: 0,
    exitReason: null,
    controlMode: "recovering",
  };
  let supervisionHalted = false;
  const runTaskLimit = options.taskLimit;
  const runId = options.runId ?? randomUUID();
  const invocationId = options.invocationId ?? randomUUID();
  let currentRunLedger = options.runLedger ?? null;
  const cleanupSessionIdsFor = (currentObservability) => sessionIdsForTaskIds(
    currentObservability,
    currentRunLedger?.chargedTaskIds ?? [],
  );

  const aoConfig = await syncAoConfig({
    registryPath: options.registryPath ?? DEFAULT_REGISTRY_PATH,
    cwd,
    transport,
    createTransport: options.createTransport,
    project,
    projects,
    aoCommand: options.aoCommand,
    workerPlugin: options.workerPlugin,
  });

  let control = {
    version: 1,
    projectId: project.id,
    mode: "recovering",
    updatedAt: now().toISOString(),
  };
  if (!dryRun) {
    await writeControlState(controlStatePath, control, { project });
  }

  const refreshControlFence = async () => {
    if (dryRun) return true;

    control = await readControlState(controlStatePath, { project });
    const controlMode = String(control?.mode ?? "active").toLowerCase();
    supervision.controlMode = controlMode;
    if (allowsWorkerProgress(controlMode)) return true;

    supervision.exitReason = controlMode === "stopped" ? "stopped" : "paused";
    supervisionHalted = true;
    return false;
  };

  const runRunnerWithControlFence = async (runnerOptions) => {
    const workerProgressAllowed = await refreshControlFence();
    const result = await runRunner({
      ...runnerOptions,
      dryRun: workerProgressAllowed ? runnerOptions.dryRun : true,
      taskLimit: workerProgressAllowed ? runnerOptions.taskLimit : 0,
      runLedgerPath: options.runLedgerPath ?? runtimePaths.runLedgerPath,
      runId,
      invocationId,
      runInvocation: "recover",
      runLedger: currentRunLedger,
    });
    currentRunLedger = result?.runLedger ?? currentRunLedger;
    return result;
  };

  let observability = await runObserver({
    cwd,
    project,
    statePath: observabilityStatePath,
    runnerStatePath,
    eventLogPath,
    transport,
    aoCommand,
    staleAfterMs: options.staleAfterMs,
  });

  let runner = await runRunnerWithControlFence({
    cwd,
    project,
    dryRun,
    recoverOnly: true,
    taskLimit: runTaskLimit,
    statePath: runnerStatePath,
    observabilityStatePath,
    eventLogPath,
    observabilityState: observability,
    transport,
    aoCommand,
  });
  let workspaceCleanup = null;
  let supervisingStartedWorkers = hasResumedWorkers(runner);

  for (
    ;
    !dryRun
      && !supervisionHalted
      && supervision.passes < maxAutonomousSupervisionPasses
      && shouldContinueRecoverySupervision({ runner, observability, supervisingStartedWorkers });
  ) {
    if (supervisionIntervalMs > 0) {
      await waitForSupervision(supervisionIntervalMs);
    }

    if (!await refreshControlFence()) break;

    observability = await runObserver({
      cwd,
      project,
      statePath: observabilityStatePath,
      runnerStatePath,
      eventLogPath,
      transport,
      aoCommand,
      staleAfterMs: options.staleAfterMs,
    });

    if (!await refreshControlFence()) break;

    workspaceCleanup = combineWorkspaceCleanup(workspaceCleanup, await runWorkspaceCleanup({
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    }));

    runner = await runRunnerWithControlFence({
      cwd,
      project,
      dryRun,
      recoverOnly: true,
      taskLimit: runTaskLimit,
      statePath: runnerStatePath,
      observabilityStatePath,
      eventLogPath,
      observabilityState: observability,
      transport,
      aoCommand,
    });
    supervisingStartedWorkers = supervisingStartedWorkers || hasResumedWorkers(runner);
    supervision.passes += 1;
  }

  if (!supervisionHalted && shouldRunTerminalMergePass({ dryRun, runner, observability })) {
    workspaceCleanup = combineWorkspaceCleanup(workspaceCleanup, await runWorkspaceCleanup({
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    }));

    runner = await runRunnerWithControlFence({
      cwd,
      project,
      dryRun,
      recoverOnly: true,
      taskLimit: runTaskLimit,
      statePath: runnerStatePath,
      observabilityStatePath,
      eventLogPath,
      observabilityState: observability,
      transport,
      aoCommand,
    });
  }

  if (!dryRun && !supervisionHalted && hasMergeQueueAttempt(runner)) {
    observability = await runObserver({
      cwd,
      project,
      statePath: observabilityStatePath,
      runnerStatePath,
      eventLogPath,
      transport,
      aoCommand,
      staleAfterMs: options.staleAfterMs,
    });

    workspaceCleanup = combineWorkspaceCleanup(workspaceCleanup, await runWorkspaceCleanup({
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    }));
  }

  const browserCleanup = cleanupEnabled
    && !dryRun
    && !supervisionHalted
    && hasTerminalResourceCleanupCandidates(observability, cleanupSessionIdsFor(observability))
    ? await runBrowserCleanup({
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    })
    : null;
  const resourceCleanup = cleanupEnabled
    && !dryRun
    && !supervisionHalted
    && hasTerminalResourceCleanupCandidates(observability, cleanupSessionIdsFor(observability))
    ? await runResourceCleanup({
      project,
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    })
    : null;
  const cleanupPreconditionsPassed = cleanupEnabled
    && !dryRun
    && !supervisionHalted
    && hasObservedCompletedSessions(observability, cleanupSessionIdsFor(observability))
    && !hasCleanupErrors(browserCleanup)
    && !hasCleanupErrors(resourceCleanup);
  let branchCleanup = cleanupPreconditionsPassed
    ? await runBranchCleanup({
      cwd,
      project,
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    })
    : null;
  const cleanup = cleanupPreconditionsPassed && !hasCleanupPreconditionErrors(branchCleanup)
    ? await runCleanup({
      cwd,
      project,
      observability,
      transport,
      aoCommand,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    })
    : null;

  if (cleanup && hasCheckedOutWorktreeSkips(branchCleanup)) {
    branchCleanup = combineBranchCleanup(branchCleanup, await runBranchCleanup({
      cwd,
      project,
      observability,
      dryRun: false,
      sessionIds: cleanupSessionIdsFor(observability),
    }));
  }

  if (!supervisionHalted && cleanup) {
    observability = await runObserver({
      cwd,
      project,
      statePath: observabilityStatePath,
      runnerStatePath,
      eventLogPath,
      transport,
      aoCommand,
      staleAfterMs: options.staleAfterMs,
    });
  }

  if (
    !dryRun
    && !supervisionHalted
    && shouldRestoreActiveControlAfterRecovery({ runner, observability, supervisingStartedWorkers })
  ) {
    const currentControl = await readControlState(controlStatePath, { project });
    const currentMode = String(currentControl?.mode ?? "active").toLowerCase();

    if (currentMode === "recovering" && currentControl?.updatedAt === control.updatedAt) {
      control = {
        version: 1,
        projectId: project.id,
        mode: "active",
        updatedAt: now().toISOString(),
      };
      await writeControlState(controlStatePath, control, { project });
    } else {
      control = currentControl;
    }
  }

  if (!supervision.exitReason) {
    const supervisionBudgetExhausted = !dryRun
      && supervision.passes >= maxAutonomousSupervisionPasses
      && shouldContinueRecoverySupervision({ runner, observability, supervisingStartedWorkers });
    supervision.exitReason = supervisionBudgetExhausted ? "budget_exhausted" : "complete";
  }

  const cleanupReport = createCleanupReport({
    cleanupEnabled,
    orchestratorCleanup: null,
    mergeQueueAttempted: false,
    postMergeBrowserCleanup: null,
    postMergeResourceCleanup: null,
    postMergeBranchCleanup: null,
    postMergeCleanup: null,
    postMergeBranchCleanupFailed: false,
    observedCompletionBrowserCleanup: browserCleanup,
    observedCompletionResourceCleanup: resourceCleanup,
    observedCompletionBranchCleanup: branchCleanup,
    observedCompletionCleanup: cleanup,
    hasObservedCompleted: hasObservedCompletedSessions(observability),
    dryRun,
    mergeFinalized: false,
  });

  runner = reconcileRunnerSnapshot({
    ...runner,
    control,
    supervision,
    cleanup: cleanupReport,
  }, observability, { now: options.now });

  if (!dryRun && currentRunLedger) {
    const runLedgerPath = options.runLedgerPath ?? runtimePaths.runLedgerPath;
    currentRunLedger = runner.complete
      ? await completeLedger(runLedgerPath, currentRunLedger, {
        now: options.now,
        cleanup: cleanupReport,
        status: cleanupReportHasFailures(cleanupReport) ? "cleanup_failed" : "completed",
      })
      : await updateLedger(runLedgerPath, currentRunLedger, { cleanup: cleanupReport }, { now: options.now });
    runner.runLedger = currentRunLedger;
  }

  const persistRunnerState = options.persistRunnerState
    ?? (options.runRunner ? null : writeRunnerState);
  if (!dryRun && persistRunnerState) {
    await persistRunnerState(runnerStatePath, runner);
  }

  const dashboard = dryRun
    ? null
    : await writeDashboardFile({
      observability,
      runner,
      control,
      supervision,
      outputPath: dashboardOutputPath,
    });

  return {
    project,
    preflight,
    dryRun,
    aoConfig,
    control,
    observability,
    runner,
    supervision,
    workspaceCleanup,
    browserCleanup,
    resourceCleanup,
    branchCleanup,
    cleanup,
    cleanupReport,
    dashboard,
    controlStatePath,
  };
}

export async function initDarkFactoryProject(options = {}) {
  const register = options.registerProject ?? registerProject;
  const syncAoConfig = options.writeAoConfig ?? writeAoConfig;
  const result = await register({
    registryPath: options.registryPath ?? DEFAULT_REGISTRY_PATH,
    projectId: options.projectId,
    name: options.name,
    planningPath: options.planningPath,
    path: options.path,
    projectPath: options.projectPath,
    repo: options.repo,
    defaultBranch: options.defaultBranch,
    sessionPrefix: options.sessionPrefix,
    workerPlugin: options.workerPlugin,
    aoCommand: options.aoCommand,
    archonWorkflow: options.archonWorkflow,
    archonInstruction: options.archonInstruction,
    envFiles: options.envFiles,
    cleanupCommands: options.cleanupCommands,
    tasksFile: options.tasksFile,
    baseDir: options.cwd ?? process.cwd(),
  });
  const aoConfig = await syncAoConfig({
    projects: getRegisteredProjects(result.registry),
    registryPath: options.registryPath ?? DEFAULT_REGISTRY_PATH,
    cwd: options.cwd,
    aoCommand: options.aoCommand,
    transport: options.transport,
    createTransport: options.createTransport,
  });

  return {
    ...result,
    aoConfig,
    next: {
      dryRun: `node orchestrator/dark-factory.js run --project ${result.project.id} --dry-run`,
      run: `node orchestrator/dark-factory.js run --project ${result.project.id} --run`,
      dashboard: "node orchestrator/dark-factory.js dashboard",
      aoDaemon: "AO daemon must already be running before Dark Factory can run or display live AO state.",
    },
  };
}

export async function getDarkFactoryControl(options = {}) {
  const { project } = await resolveRunTarget(options);
  const runtimePaths = getProjectRuntimePaths(project.id);
  const controlStatePath = options.controlStatePath ?? runtimePaths.controlStatePath;
  const readControlState = options.readControlState ?? readControlStateFile;
  const control = await readControlState(controlStatePath, { project });

  return {
    project,
    control: {
      version: control?.version ?? 1,
      projectId: control?.projectId ?? project.id,
      mode: control?.mode ?? "active",
      updatedAt: control?.updatedAt ?? null,
    },
    controlStatePath,
  };
}

export async function setDarkFactoryControl(options = {}) {
  const mode = String(options.mode ?? "").toLowerCase();
  if (!CONTROL_MODES.has(mode)) {
    throw new Error(`Unsupported Dark Factory control mode: ${options.mode}`);
  }

  const { project } = await resolveRunTarget(options);
  const runtimePaths = getProjectRuntimePaths(project.id);
  const controlStatePath = options.controlStatePath ?? runtimePaths.controlStatePath;
  const now = options.now ?? (() => new Date());
  const control = {
    version: 1,
    projectId: project.id,
    mode,
    updatedAt: now().toISOString(),
  };
  const writeControlState = options.writeControlState ?? writeControlStateFile;
  await writeControlState(controlStatePath, control, { project });

  return {
    project,
    control,
    controlStatePath,
  };
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeDarkFactoryDashboards(options = {}) {
  const loadRegistry = options.loadProjectRegistry ?? loadProjectRegistry;
  const registry = options.registry ?? await loadRegistry(options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const projects = getRegisteredProjects(registry);
  const readJson = options.readJsonIfExists ?? readJsonIfExists;
  const writeProjectDashboard = options.writeDashboard ?? writeDashboard;
  const writeIndex = options.writeDashboardIndex ?? writeDashboardIndex;
  const projectSummaries = [];
  const projectDashboards = [];

  for (const project of projects) {
    const paths = getProjectRuntimePaths(project.id);
    const observability = await readJson(paths.observabilityStatePath);
    const runner = await readJson(paths.runnerStatePath) ?? {
      dryRun: true,
      launchPlan: { toLaunch: [], skipped: [], activeSessions: [] },
    };

    if (observability) {
      const dashboard = await writeProjectDashboard({
        observability,
        runner,
        outputPath: paths.dashboardOutputPath,
      });
      projectDashboards.push({ projectId: project.id, outputPath: dashboard.outputPath });
    }

    projectSummaries.push({
      id: project.id,
      name: project.name,
      path: project.path,
      observedAt: observability?.observedAt ?? null,
      summary: observability?.summary ?? null,
      dashboardPath: observability ? paths.dashboardOutputPath : null,
    });
  }

  const index = await writeIndex({
    projects: projectSummaries,
    outputPath: options.dashboardOutputPath ?? ".dark-factory/dashboard/index.html",
  });

  return {
    projects: projectSummaries,
    projectDashboards,
    index,
  };
}

function parseArgs(argv) {
  const options = {
    command: "run",
    dryRun: true,
    supervisionIntervalMs: 60000,
  };
  const args = [...argv];
  const first = args[0];
  if (first && !first.startsWith("-")) {
    options.command = first;
    args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => args[++index];

    if (arg === "--run") options.dryRun = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--project" || arg === "--project-id") options.projectId = next();
    else if (arg === "--planning") options.planningPath = next();
    else if (arg === "--name") options.name = next();
    else if (arg === "--path" || arg === "--project-path") options.path = next();
    else if (arg === "--repo") options.repo = next();
    else if (arg === "--default-branch") options.defaultBranch = next();
    else if (arg === "--session-prefix") options.sessionPrefix = next();
    else if (arg === "--session") options.sessionIds = [...(options.sessionIds ?? []), next()];
    else if (arg === "--worker-plugin" || arg === "--worker-agent") options.workerPlugin = next();
    else if (arg === "--archon-workflow") options.archonWorkflow = next();
    else if (arg === "--archon-instruction") options.archonInstruction = next();
    else if (arg === "--env-file") options.envFiles = [...(options.envFiles ?? []), next()];
    else if (arg === "--cleanup-command") options.cleanupCommands = [...(options.cleanupCommands ?? []), next()];
    else if (arg === "--tasks-file") options.tasksFile = next();
    else if (arg === "--concurrency") {
      const value = next();
      options.concurrency = value === "auto" ? undefined : Number.parseInt(value, 10);
    }
    else if (arg === "--task-limit") options.taskLimit = parsePositiveIntegerOption(next(), "task-limit");
    else if (arg === "--project-config") options.projectConfigPath = next();
    else if (arg === "--registry") options.registryPath = next();
    else if (arg === "--ao-command") options.aoCommand = next();
    else if (arg === "--state-path") options.statePath = next();
    else if (arg === "--observability-state-path") options.observabilityStatePath = next();
    else if (arg === "--event-log-path") options.eventLogPath = next();
    else if (arg === "--dashboard-output-path") options.dashboardOutputPath = next();
    else if (arg === "--stale-after-ms") options.staleAfterMs = Number.parseInt(next(), 10);
    else if (arg === "--supervision-interval-ms") {
      options.supervisionIntervalMs = parseNonNegativeIntegerOption(next(), "supervision-interval-ms");
    }
    else if (arg === "--max-autonomous-supervision-passes") {
      options.maxAutonomousSupervisionPasses = parseNonNegativeIntegerOption(next(), "max-autonomous-supervision-passes");
    }
    else if (arg === "--cleanup") options.cleanupCompletedSessions = true;
    else if (arg === "--no-cleanup") options.cleanupCompletedSessions = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node orchestrator/dark-factory.js init --project <id> --planning <path>
  node orchestrator/dark-factory.js run --project <id> [--dry-run|--run]
  node orchestrator/dark-factory.js pause --project <id>
  node orchestrator/dark-factory.js stop --project <id> [--dry-run|--run]
  node orchestrator/dark-factory.js recover --project <id> [--dry-run|--run]
  node orchestrator/dark-factory.js resume --project <id>
  node orchestrator/dark-factory.js status --project <id>
  node orchestrator/dark-factory.js cleanup --project <id> [--dry-run|--run]
  node orchestrator/dark-factory.js dashboard

Options:
  --project <id>                  Project id for init/run/pause/stop/recover/resume/status/cleanup
  --planning <path>               Target project planning folder for init
  --dry-run                       Observe and plan without spawning AO sessions (default)
  --run                           Observe, then execute AO spawn for planned tasks
  --concurrency <n>               Maximum active AO sessions for the project (default: auto, capped at 4)
  --task-limit <n>                Maximum tasks to start or resume in this run (default: unlimited)
  --session <id>                  Limit cleanup to an AO session; repeatable
  --registry <path>               Project registry path (default: .dark-factory/projects.json)
  --project-config <path>         Dark factory project config (default: dark-factory.yaml)
  --ao-command <command>          Store or temporarily override the AO launcher (default: project value or ao)
  --worker-plugin <name>          AO plugin for feature worker sessions (default: archon)
  --env-file <from -> to>         Copy env file into AO worktrees when missing; repeatable
  --cleanup-command <command>     Run explicit command in completed worker worktrees before AO cleanup; repeatable
  --state-path <path>             D003 runner state path
  --observability-state-path <p>  D004 observability state path
  --event-log-path <path>         Append-only event log path
  --dashboard-output-path <path>  D005 dashboard HTML path
  --stale-after-ms <ms>           Active-session stale threshold
  --supervision-interval-ms <ms>  Delay between autonomous supervision passes (default: 60000)
  --max-autonomous-supervision-passes <n>
                                  Maximum autonomous supervision passes (default: 240)
  --cleanup                       Run AO cleanup for completed sessions/worktrees (default)
  --no-cleanup                    Skip AO cleanup for completed sessions/worktrees
`);
}

async function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  if (options.command === "init") {
    const result = await initDarkFactoryProject(options);
    console.log(JSON.stringify({
      projectId: result.project.id,
      registryPath: result.registryPath,
      aoProjects: result.aoConfig.updated,
      next: result.next,
    }, null, 2));
    return;
  }

  if (options.command === "dashboard") {
    const result = await writeDarkFactoryDashboards(options);
    console.log(JSON.stringify({
      projects: result.projects.map((project) => ({
        id: project.id,
        observedAt: project.observedAt,
        dashboardPath: project.dashboardPath,
      })),
      indexPath: result.index.outputPath,
    }, null, 2));
    return;
  }

  if (options.command === "pause" || options.command === "resume") {
    const result = await setDarkFactoryControl({
      ...options,
      mode: options.command === "pause" ? "paused" : "active",
    });
    console.log(JSON.stringify({
      projectId: result.project.id,
      control: result.control,
      controlStatePath: result.controlStatePath,
    }, null, 2));
    return;
  }

  if (options.command === "status") {
    const result = await getDarkFactoryControl(options);
    console.log(JSON.stringify({
      projectId: result.project.id,
      control: result.control,
      controlStatePath: result.controlStatePath,
    }, null, 2));
    return;
  }

  if (options.command === "cleanup") {
    const result = await runDarkFactoryCleanup(options);
    console.log(JSON.stringify({
      projectId: result.project.id,
      dryRun: result.dryRun,
      blocked: result.blocked,
      observedSummary: result.observability.summary,
      aoProjects: result.aoConfig,
      workspaceCleanup: result.workspaceCleanup ? {
        attempted: result.workspaceCleanup.attempted,
        killed: result.workspaceCleanup.killed.length,
        errors: result.workspaceCleanup.errors.length,
      } : null,
      browserCleanup: result.browserCleanup ? {
        attempted: result.browserCleanup.attempted,
        cleaned: result.browserCleanup.cleaned.length,
        skipped: result.browserCleanup.skipped.length,
        errors: result.browserCleanup.errors.length,
      } : null,
      resourceCleanup: result.resourceCleanup ? {
        attempted: result.resourceCleanup.attempted,
        cleaned: result.resourceCleanup.cleaned.length,
        skipped: result.resourceCleanup.skipped.length,
        errors: result.resourceCleanup.errors.length,
      } : null,
      branchCleanup: result.branchCleanup ? {
        attempted: result.branchCleanup.attempted,
        deleted: result.branchCleanup.deleted.length,
        skipped: result.branchCleanup.skipped.length,
        errors: result.branchCleanup.errors.length,
      } : null,
      cleanup: result.cleanup ? {
        projectId: result.cleanup.projectId,
        dryRun: result.cleanup.dryRun,
        killed: result.cleanup.killed?.length ?? null,
        skipped: result.cleanup.skipped?.length ?? null,
        errors: result.cleanup.errors?.length ?? null,
      } : null,
      orchestratorCleanup: result.orchestratorCleanup ? {
        projectId: result.orchestratorCleanup.projectId,
        dryRun: result.orchestratorCleanup.dryRun,
        killed: result.orchestratorCleanup.killed.length,
        skipped: result.orchestratorCleanup.skipped.length,
      } : null,
      eventLogPath: resolve(process.cwd(), options.eventLogPath ?? getProjectRuntimePaths(result.project.id).eventLogPath),
      dashboardPath: result.dashboard.outputPath,
    }, null, 2));
    return;
  }

  if (options.command === "stop") {
    const result = await stopDarkFactory(options);
    console.log(JSON.stringify({
      projectId: result.project.id,
      dryRun: result.dryRun,
      control: result.control,
      stopped: {
        suspended: result.stopped.suspended.length,
        preserved: result.stopped.preserved.length,
        errors: result.stopped.errors.length,
      },
      controlStatePath: result.controlStatePath,
      dashboardPath: result.dashboard?.outputPath ?? null,
    }, null, 2));
    return;
  }

  if (options.command === "recover") {
    const result = await recoverDarkFactory(options);
    console.log(JSON.stringify({
      projectId: result.project.id,
      dryRun: result.dryRun,
      control: result.control,
      toResume: result.runner.launchPlan.toResume.map((issue) => issue.id),
      toLaunch: result.runner.launchPlan.toLaunch.map((issue) => issue.id),
      dashboardPath: result.dashboard?.outputPath ?? null,
      controlStatePath: result.controlStatePath,
    }, null, 2));
    return;
  }

  if (options.command !== "run") {
    throw new Error(`Unknown command: ${options.command}`);
  }

  const result = await runDarkFactory(options);
  console.log(JSON.stringify({
    projectId: result.project.id,
    dryRun: result.dryRun,
    observedSummary: result.observability.summary,
    control: result.control,
    toLaunch: result.runner.launchPlan.toLaunch.map((issue) => issue.id),
    skipped: result.runner.launchPlan.skipped,
    aoProjects: result.aoConfig.updated,
    cleanup: result.cleanup,
    orchestratorCleanup: result.orchestratorCleanup ? {
      projectId: result.orchestratorCleanup.projectId,
      dryRun: result.orchestratorCleanup.dryRun,
      killed: result.orchestratorCleanup.killed.length,
      skipped: result.orchestratorCleanup.skipped.length,
    } : null,
    workspaceCleanup: result.workspaceCleanup ? {
      attempted: result.workspaceCleanup.attempted,
      killed: result.workspaceCleanup.killed.length,
      errors: result.workspaceCleanup.errors.length,
    } : null,
    resourceCleanup: result.resourceCleanup ? {
      attempted: result.resourceCleanup.attempted,
      cleaned: result.resourceCleanup.cleaned.length,
      skipped: result.resourceCleanup.skipped.length,
      errors: result.resourceCleanup.errors.length,
    } : null,
    runnerStatePath: resolve(process.cwd(), options.statePath ?? getProjectRuntimePaths(result.project.id).runnerStatePath),
    observabilityStatePath: resolve(
      process.cwd(),
      options.observabilityStatePath ?? getProjectRuntimePaths(result.project.id).observabilityStatePath,
    ),
    eventLogPath: resolve(process.cwd(), options.eventLogPath ?? getProjectRuntimePaths(result.project.id).eventLogPath),
    dashboardPath: result.dashboard.outputPath,
  }, null, 2));
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
