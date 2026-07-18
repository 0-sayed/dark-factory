import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import tasksMdTracker from "../ao-plugins/tasks-md-tracker/index.js";
import { createAoTransport, extractJsonObject } from "./ao-command.js";
import { appendEvent, normalizeEvent, readEvents, summarizeEvents } from "./dark-factory-events.js";
import { normalizeSessionsPayload } from "./dark-factory-runner.js";

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const execFileAsync = promisify(execFile);
const GITHUB_CLI_TIMEOUT_MS = 30000;
export const LIFECYCLE_STATUSES = Object.freeze([
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

const SUMMARY_KEYS = LIFECYCLE_STATUSES;
const PRIORITY = {
  merged: 90,
  cleanup_failed: 85,
  merging: 80,
  ready_to_merge: 70,
  in_review: 60,
  running: 50,
  queued: 35,
  needs_input: 30,
  failed: 20,
};

function normalizeTaskId(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function isAoOrchestratorSession(session, project) {
  const role = String(session?.role ?? "").toLowerCase();
  const kind = String(session?.lifecycle?.session?.kind ?? "").toLowerCase();
  if (role === "orchestrator" || kind === "orchestrator") return true;

  const sessionPrefix = project?.sessionPrefix ?? project?.id;
  return Boolean(sessionPrefix && session?.id === `${sessionPrefix}-orchestrator`);
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonArtifactIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readTextArtifactIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = resolve(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function hasMergedPr(session) {
  return session?.pr?.merged === true || session?.pr?.state === "merged" || session?.prStatus === "merged";
}

function defaultReadyArtifactPath(projectId, sessionId) {
  const compatibilityRoot = process.env.DARK_FACTORY_COMPAT_STATE_PATH
    ?? resolve(".dark-factory/compat/agent-orchestrator");
  return resolve(compatibilityRoot, "projects", projectId, "sessions", `${sessionId}.ready.json`);
}

function metadataPr(metadata) {
  const number = metadata?.agentReportedPrNumber;
  const url = metadata?.agentReportedPrUrl ?? metadata?.prs;
  const state = metadata?.agentReportedPrState ?? metadata?.agentReportedState;
  if (!number && !url) return null;
  return {
    ...(number ? { number: Number.parseInt(String(number), 10) || String(number) } : {}),
    ...(url ? { url } : {}),
    ...(state ? { state: String(state).toLowerCase() } : {}),
  };
}

function normalizePrReference(pr) {
  if (!pr) return null;
  if (typeof pr === "string") return { url: pr };
  if (typeof pr === "number") return { number: pr };
  if (typeof pr === "object") return pr;
  return null;
}

function branchFromSession(session) {
  return String(session?.branch ?? session?.branchName ?? session?.headRefName ?? "")
    .trim()
    .replace(/^refs\/heads\//, "");
}

function agentMilestoneFromNote(note) {
  const match = String(note ?? "").match(/\bdark-factory\s+milestone=([a-z0-9_]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function archonRunIdFromNote(note) {
  const match = String(note ?? "").match(/\barchonRunId=([A-Za-z0-9_.:-]+)/);
  return match ? match[1] : null;
}

function metadataAgentReport(metadata) {
  if (!metadata?.agentReportedState) return null;
  const note = metadata.agentReportedNote ?? null;
  return {
    agentReportedState: String(metadata.agentReportedState),
    agentReportedAt: metadata.agentReportedAt ?? null,
    agentReportedNote: note,
    agentMilestone: agentMilestoneFromNote(note),
    archonRunId: archonRunIdFromNote(note),
  };
}

async function readSessionMetadata(session, project, options = {}) {
  if (!options.readSessionMetadata) return null;
  return options.readSessionMetadata(session, project);
}

async function readSessionReadyArtifact(session, project, options = {}) {
  if (session?.readyArtifact) return session.readyArtifact;

  const readArtifact = options.readReadyArtifact ?? (async (currentSession, currentProject) => {
    const path = options.readyArtifactPath
      ? join(resolve(options.readyArtifactPath), `${currentSession.id}.ready.json`)
      : defaultReadyArtifactPath(currentProject.id, currentSession.id);
    return readJsonIfExists(path);
  });

  return readArtifact(session, project);
}

function defaultReadyArtifactDir(projectId) {
  const compatibilityRoot = process.env.DARK_FACTORY_COMPAT_STATE_PATH
    ?? resolve(".dark-factory/compat/agent-orchestrator");
  return resolve(compatibilityRoot, "projects", projectId, "sessions");
}

async function defaultListReadyArtifacts(project, options = {}) {
  const dir = options.readyArtifactPath
    ? resolve(options.readyArtifactPath)
    : defaultReadyArtifactDir(project.id);

  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const artifacts = await Promise.all(entries
    .filter((entry) => entry.endsWith(".ready.json"))
    .map((entry) => readJsonIfExists(join(dir, entry))));

  return artifacts.filter(Boolean);
}

function synthesizeReadyArtifactSessions(sessions, artifacts, project) {
  const existingSessionIds = new Set(sessions.map((session) => String(session.id ?? "")));
  const existingIssueIds = new Set(sessions.map((session) => normalizeTaskId(session.issueId ?? session.issue)).filter(Boolean));
  const synthesized = [];

  for (const artifact of artifacts ?? []) {
    const sessionId = String(artifact?.sessionId ?? "").trim();
    const issueId = normalizeTaskId(artifact?.issueId);
    if (!sessionId || !issueId) continue;
    if (existingSessionIds.has(sessionId) || existingIssueIds.has(issueId)) continue;

    synthesized.push({
      id: sessionId,
      projectId: artifact.projectId ?? project.id,
      issueId,
      status: "ready_to_merge",
      branch: artifact.branch ?? artifact.pr?.headRefName ?? null,
      lastActivityAt: artifact.preparedAt ?? null,
      pr: artifact.pr ?? null,
      readyArtifact: artifact,
    });
  }

  return [...sessions, ...synthesized];
}

async function defaultReadWorkspaceArchonState(session) {
  if (!session?.workspacePath) return null;

  const stateDir = join(session.workspacePath, ".archon/state");
  const [merge, ...qaTexts] = await Promise.all([
    readJsonArtifactIfExists(join(stateDir, "merge-status.json")),
    readTextArtifactIfExists(join(stateDir, "qa-status.txt")),
    readTextArtifactIfExists(join(stateDir, "frontend-qa-status.txt")),
  ]);

  const qaStatus = qaTexts.map(normalizeQaStatus).find(Boolean) ?? null;
  if (!merge && !qaStatus) return null;

  return {
    ...(merge ? { merge } : {}),
    ...(qaStatus ? { qaStatus } : {}),
  };
}

function workspaceArtifactPr(artifact) {
  const mergeStatus = String(artifact?.merge?.status ?? "").toLowerCase();
  if (mergeStatus !== "merged") return null;

  const pr = normalizePrReference(artifact?.merge?.pr);
  const mergedAt = artifact?.merge?.mergedAt ?? null;
  return {
    ...(pr ?? {}),
    state: "merged",
    mergedAt,
    merged: true,
  };
}

function normalizeQaStatus(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  const normalized = firstLine.toUpperCase().replace(/[-\s]+/g, "_").replace(/[^A-Z_]/g, "");
  if (["QA_PASSED", "QA_FAILED", "QA_BLOCKED"].includes(normalized)) return normalized;
  if (/^QA\s*[_ -]?\s*PASSED\b/i.test(firstLine)) return "QA_PASSED";
  if (/^QA\s*[_ -]?\s*FAILED\b/i.test(firstLine)) return "QA_FAILED";
  if (/^QA\s*[_ -]?\s*BLOCKED\b/i.test(firstLine)) return "QA_BLOCKED";
  return null;
}

function isReadyArtifactForSession(session, artifact) {
  if (!artifact || typeof artifact !== "object") return false;
  const sessionId = String(session?.id ?? "");
  const issueId = normalizeTaskId(session?.issueId ?? session?.issue);

  if (artifact.sessionId && String(artifact.sessionId) !== sessionId) return false;
  if (artifact.issueId && normalizeTaskId(artifact.issueId) !== issueId) return false;
  return Boolean(artifact.pr?.url || artifact.pr?.number);
}

function readyArtifactReport(session, artifact, pr) {
  if (!isReadyArtifactForSession(session, artifact)) return null;
  const prState = String(pr?.state ?? artifact.pr?.state ?? "").toLowerCase();
  if (prState && prState !== "open") return null;

  const issueId = normalizeTaskId(session?.issueId ?? session?.issue ?? artifact.issueId);
  return {
    agentReportedState: "ready_for_review",
    agentReportedAt: artifact.preparedAt ?? null,
    agentReportedNote: `dark-factory milestone=ready_to_merge task=${issueId} phase=auto_merge`,
    agentMilestone: "ready_to_merge",
  };
}

async function defaultGetPullRequestState(pr, _session, _project, options = {}) {
  const reference = pr?.url ?? pr?.number;
  if (!reference) return null;
  const runProcess = options.execFileAsync ?? execFileAsync;
  const cwd = pr?.workspacePath ?? _session?.workspacePath ?? _project?.path ?? process.cwd();
  const { stdout } = await runProcess("gh", [
    "pr",
    "view",
    String(reference),
    "--json",
    "number,url,state,mergedAt,mergeStateStatus,statusCheckRollup",
  ], {
    cwd,
    encoding: "utf8",
    timeout: GITHUB_CLI_TIMEOUT_MS,
  });
  const state = extractJsonObject(stdout);
  const checkArgs = [
    "pr",
    "checks",
    String(reference),
    "--json",
    "bucket,name,state,workflow,link",
  ];
  let currentChecks = null;

  try {
    const result = await runProcess("gh", checkArgs, {
      cwd,
      encoding: "utf8",
      timeout: GITHUB_CLI_TIMEOUT_MS,
    });
    currentChecks = extractJsonArrayOrNull(result.stdout);
  } catch (error) {
    currentChecks = extractJsonArrayOrNull(error?.stdout);
  }

  return currentChecks !== null ? { ...state, currentChecks } : state;
}

function extractJsonArrayOrNull(output) {
  const text = String(output ?? "").trim();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end < start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function extractJsonArray(output) {
  return extractJsonArrayOrNull(output) ?? [];
}

async function defaultGetPullRequestForBranch(branch, _session, project, options = {}) {
  if (!branch) return null;
  const runProcess = options.execFileAsync ?? execFileAsync;
  const { stdout } = await runProcess("gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,url,state,mergedAt,headRefOid,mergeStateStatus,statusCheckRollup",
    "--limit",
    "5",
  ], {
    cwd: project?.path ?? process.cwd(),
    encoding: "utf8",
    timeout: GITHUB_CLI_TIMEOUT_MS,
  });
  const prs = extractJsonArray(stdout);
  return prs.find((candidate) => String(candidate?.state ?? "").toUpperCase() === "OPEN") ?? prs[0] ?? null;
}

function successfulCheck(check) {
  const bucket = String(check?.bucket ?? "").toLowerCase();
  if (bucket) return bucket === "pass" || bucket === "skipping";

  const conclusion = String(check?.conclusion ?? "").toUpperCase();
  if (conclusion) return ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conclusion);

  const state = String(check?.state ?? "").toUpperCase();
  if (state) return ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(state);

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

function blockingChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.filter((check) => !successfulCheck(check) && !pendingCheck(check));
}

function pendingChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.filter(pendingCheck);
}

function pullRequestReadiness(pr) {
  if (!pr || typeof pr !== "object") return null;
  if (pr.merged === true || String(pr.state ?? "").toUpperCase() === "MERGED") return "merged";

  const state = String(pr.state ?? "").toUpperCase();
  if (state && state !== "OPEN") return "queued";

  const checks = pr.currentChecks ?? pr.statusCheckRollup;
  if (blockingChecks(checks).length > 0) return "queued";
  if (pendingChecks(checks).length > 0) return "running";

  const mergeState = String(pr.mergeStateStatus ?? "").toUpperCase();
  if (mergeState && !["CLEAN", "HAS_HOOKS"].includes(mergeState)) return "review";

  return state === "OPEN" ? "ready" : null;
}

async function defaultGetArchonRun(runId, _session, project, options = {}) {
  const runProcess = options.execFileAsync ?? execFileAsync;
  const { stdout } = await runProcess("archon", ["workflow", "get", String(runId), "--json"], {
    cwd: project?.path ?? process.cwd(),
    encoding: "utf8",
  });
  return extractJsonObject(stdout);
}

export async function hydrateSessionPullRequests(sessions, project, options = {}) {
  const getPullRequestState = options.getPullRequestState ?? defaultGetPullRequestState;
  const getPullRequestForBranch = options.getPullRequestForBranch ?? defaultGetPullRequestForBranch;
  const hydrated = [];
  const readWorkspaceArchonState = options.readWorkspaceArchonState ?? defaultReadWorkspaceArchonState;

  for (const session of normalizeSessionsPayload(sessions)) {
    let pr = normalizePrReference(session.pr);
    const metadata = await readSessionMetadata(session, project, options);
    const readyArtifact = await readSessionReadyArtifact(session, project, options);
    const workspaceArchonState = await readWorkspaceArchonState(session, project, options);
    const agentReport = metadataAgentReport(metadata);

    if (!pr) {
      pr = metadataPr(metadata);
    }

    if (!pr && isReadyArtifactForSession(session, readyArtifact)) {
      pr = normalizePrReference(readyArtifact.pr);
    }

    const workspacePr = workspaceArtifactPr(workspaceArchonState);
    if (workspacePr) {
      pr = {
        ...(pr ?? {}),
        ...workspacePr,
      };
    }

    if (!pr) {
      const branch = branchFromSession(session);
      if (branch) {
        try {
          pr = normalizePrReference(await getPullRequestForBranch(branch, session, project, options));
        } catch {
          // Branch PR discovery is best-effort; stale AO metadata should not break observability.
        }
      }
    }

    if (pr?.url || pr?.number) {
      try {
        const state = await getPullRequestState(pr, session, project, options);
        if (state) {
          pr = {
            ...pr,
            number: state.number ?? pr.number,
            url: state.url ?? pr.url,
            state: String(state.state ?? pr.state ?? "").toLowerCase(),
            mergedAt: state.mergedAt ?? pr.mergedAt,
            mergeStateStatus: state.mergeStateStatus ?? pr.mergeStateStatus,
            statusCheckRollup: state.statusCheckRollup ?? pr.statusCheckRollup,
            currentChecks: state.currentChecks ?? pr.currentChecks,
            merged: Boolean(state.mergedAt) || String(state.state ?? "").toUpperCase() === "MERGED",
          };
        }
      } catch {
        // PR hydration is best-effort; the core AO/task state should still render.
      }
    }

    const artifactReport = readyArtifactReport(session, readyArtifact, pr);
    const prReadiness = pullRequestReadiness(pr);
    const qaStatus = normalizeQaStatus(workspaceArchonState?.qaStatus);
    hydrated.push({
      ...session,
      ...(pr ? { pr } : {}),
      ...(prReadiness ? { prReadiness } : {}),
      ...(qaStatus ? { qaStatus } : {}),
      ...(agentReport ?? {}),
      ...(artifactReport ? { readyArtifact } : {}),
      ...(artifactReport ?? {}),
    });
  }

  return hydrated;
}

function lastActivityTime(session) {
  const raw = session.lastActivityAt ?? session.updatedAt ?? session.completedAt ?? session.createdAt;
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function classifySession(session, options = {}) {
  return normalizeLifecycleStatus(session, options);
}

function normalizePrReadiness(readiness) {
  switch (readiness) {
    case "merged":
      return "merged";
    case "ready":
      return "ready_to_merge";
    case "running":
      return "in_review";
    case "review":
      return "in_review";
    case "queued":
      return "running";
    default:
      return null;
  }
}

export function normalizeLifecycleStatus(session, options = {}) {
  const status = String(session?.status ?? "").toLowerCase();
  const reportedState = String(session?.agentReportedState ?? "").toLowerCase();
  const rawPrReadiness = session?.prReadiness;
  const prReadiness = normalizePrReadiness(rawPrReadiness);
  const qaStatus = normalizeQaStatus(session?.qaStatus);

  if (hasMergedPr(session) || status === "merged") return "merged";
  if (status === "cleanup_failed" || session?.agentMilestone === "cleanup_failed") return "cleanup_failed";
  if (qaStatus === "QA_FAILED" || qaStatus === "QA_BLOCKED") return "failed";
  if (prReadiness && (rawPrReadiness !== "queued" || session?.pr)) return prReadiness;
  if (status === "merging" || session?.agentMilestone === "auto_merge_preparing") return "merging";
  if (["ready_for_review", "ready_to_merge"].includes(reportedState)) return "ready_to_merge";
  if (["ready_for_review", "ready_to_merge"].includes(session?.agentMilestone)) return "ready_to_merge";
  if (session?.agentMilestone === "failed" || reportedState === "failed") return "failed";
  if (reportedState === "needs_input") return "needs_input";
  if (["done", "verified", "cleanup"].includes(status)) return "merged";
  if (isInterruptedWithoutExplicitFailure(session)) return "queued";
  if (["needs_input", "waiting", "blocked"].includes(status)) return "needs_input";
  if (["failed", "error", "errored"].includes(status)) return "failed";
  if (prReadiness) return prReadiness;

  return "running";
}

function summarizeSession(session, options) {
  return {
    id: session.id,
    issueId: normalizeTaskId(session.issueId ?? session.issue),
    status: session.status,
    observableStatus: normalizeLifecycleStatus(session, options),
    branch: session.branch,
    workspacePath: session.workspacePath,
    lastActivityAt: session.lastActivityAt ?? null,
    pr: session.pr ?? null,
    prReadiness: session.prReadiness ?? null,
    agentReportedState: session.agentReportedState ?? null,
    agentReportedAt: session.agentReportedAt ?? null,
    agentReportedNote: session.agentReportedNote ?? null,
    agentMilestone: session.agentMilestone ?? null,
    archonRunId: session.archonRunId ?? null,
    qaStatus: session.qaStatus ?? null,
    readyArtifact: session.readyArtifact ?? null,
  };
}

function chooseSessionStatus(sessions) {
  return sortSessionsForDisplay(sessions)[0]?.observableStatus;
}

function isInterruptedWithoutExplicitFailure(session) {
  const status = String(session?.status ?? "").toLowerCase();
  return ["killed", "terminated", "runtime_lost"].includes(status)
    && session?.agentMilestone !== "failed"
    && !session?.pr;
}

function compareSessions(left, right) {
  const statusDifference = (PRIORITY[right.observableStatus] ?? 0) - (PRIORITY[left.observableStatus] ?? 0);
  if (statusDifference !== 0) return statusDifference;

  const rightActivity = lastActivityTime(right) ?? 0;
  const leftActivity = lastActivityTime(left) ?? 0;
  if (rightActivity !== leftActivity) return rightActivity - leftActivity;

  return String(right.id ?? "").localeCompare(String(left.id ?? ""));
}

function sortSessionsForDisplay(sessions) {
  return [...sessions].sort(compareSessions);
}

function makeSummary(tasks) {
  const summary = {
    total: Object.keys(tasks).length,
  };

  for (const key of SUMMARY_KEYS) {
    summary[key] = 0;
  }

  for (const task of Object.values(tasks)) {
    summary[task.status] = (summary[task.status] ?? 0) + 1;
  }

  return summary;
}

function countCleanupFailures(value) {
  if (!value || typeof value !== "object") return 0;
  if (value.status === "failed") return 1;

  return Object.values(value).reduce(
    (total, child) => total + countCleanupFailures(child),
    0,
  );
}

function taskStatusById(tasks) {
  const statuses = new Map();
  if (!tasks || typeof tasks !== "object") return statuses;

  for (const [key, task] of Object.entries(tasks)) {
    const taskId = normalizeTaskId(task?.id ?? key);
    const status = String(task?.status ?? "").trim();
    if (taskId && status) statuses.set(taskId, status);
  }

  return statuses;
}

function reconciliationEventKey({ taskId, previousStatus, currentStatus }) {
  return [
    normalizeTaskId(taskId),
    String(previousStatus ?? "").trim(),
    String(currentStatus ?? "").trim(),
  ].join("\u0000");
}

function existingReconciliationEventKeys(events) {
  const keys = new Set();

  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== "task.reconciled") continue;
    keys.add(reconciliationEventKey({
      taskId: event.taskId,
      previousStatus: event.metadata?.previousStatus,
      currentStatus: event.metadata?.currentStatus ?? event.status,
    }));
  }

  return keys;
}

function reconciliationEventInputs(previousSnapshot, currentSnapshot, existingEvents = []) {
  const previousStatuses = taskStatusById(previousSnapshot?.tasks);
  const currentStatuses = taskStatusById(currentSnapshot?.tasks);
  const projectId = currentSnapshot?.project?.id;
  const existingKeys = existingReconciliationEventKeys(existingEvents);

  return [...currentStatuses]
    .filter(([taskId, currentStatus]) => {
      const previousStatus = previousStatuses.get(taskId);
      return previousStatus
        && previousStatus !== currentStatus
        && !existingKeys.has(reconciliationEventKey({ taskId, previousStatus, currentStatus }));
    })
    .map(([taskId, currentStatus]) => {
      const previousStatus = previousStatuses.get(taskId);
      return {
        type: "task.reconciled",
        projectId,
        taskId,
        timestamp: currentSnapshot.observedAt,
        status: currentStatus,
        metadata: {
          previousStatus,
          currentStatus,
          source: "observability",
        },
      };
    });
}

function eventTime(event) {
  const timestamp = Date.parse(event?.timestamp ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareEvents(left, right) {
  const leftTime = eventTime(left);
  const rightTime = eventTime(right);

  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  if (leftTime === null && rightTime !== null) return -1;
  if (leftTime !== null && rightTime === null) return 1;

  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function milestoneEventType(session) {
  switch (session?.agentMilestone) {
    case "auto_feature_started":
    case "resume_started":
      return "archon.workflow.started";
    case "auto_feature_completed":
      return "archon.workflow.finished";
    case "pr_opened":
      return "pr.opened";
    case "ready_to_merge":
      return "pr.ready";
    case "failed":
      return "archon.workflow.failed";
    default:
      return null;
  }
}

function milestoneMetadata(session) {
  if (session?.agentMilestone === "resume_started") {
    return { mode: "resume" };
  }
  if (session?.agentMilestone === "auto_feature_started") {
    return { mode: "auto_feature" };
  }
  return undefined;
}

function deriveSessionEvents(sessions, project, options = {}) {
  const now = options.now ?? (() => new Date());

  return sessions
    .filter((session) => session?.issueId && session?.agentMilestone)
    .map((session, index) => {
      const type = milestoneEventType(session);
      if (!type) return null;

      return normalizeEvent({
        id: `derived:${session.id}:${session.agentMilestone}:${index}`,
        type,
        projectId: project?.id,
        taskId: normalizeTaskId(session.issueId),
        sessionId: session.id,
        timestamp: session.agentReportedAt ?? session.lastActivityAt ?? options.observedAt ?? now().toISOString(),
        status: session.agentReportedState ?? session.observableStatus ?? session.status,
        metadata: milestoneMetadata(session),
      }, { now });
    })
    .filter(Boolean)
    .sort(compareEvents);
}

function archonEventType(event) {
  const type = String(event?.type ?? event?.event ?? "").toLowerCase();
  if (type.includes("node") && type.includes("start")) return "archon.node.started";
  if (type.includes("node") && (type.includes("finish") || type.includes("complete"))) return "archon.node.finished";
  if (type.includes("node") && type.includes("fail")) return "archon.node.failed";
  return null;
}

function archonEventTimestamp(event) {
  return event?.timestamp ?? event?.created_at ?? event?.createdAt ?? null;
}

function archonNodeName(event) {
  return event?.nodeName ?? event?.node_name ?? event?.name ?? null;
}

function archonEventMetadata(event, runId) {
  const metadata = {
    archonRunId: runId,
    nodeId: event?.nodeId ?? event?.node_id ?? null,
    nodeName: archonNodeName(event),
  };

  if (event?.durationMs !== undefined && event?.durationMs !== null) {
    metadata.durationMs = event.durationMs;
  } else if (event?.duration_ms !== undefined && event?.duration_ms !== null) {
    metadata.durationMs = event.duration_ms;
  }

  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null));
}

function archonRunStatusEvent(run, session, project, sessionIndex, now, options = {}) {
  const status = run?.status ?? run?.run?.status;
  if (!status) return null;

  const runId = run?.id ?? run?.runId ?? run?.run?.id ?? session.archonRunId;
  const metadata = {
    archonRunId: runId,
    workflowName: run?.workflow_name ?? run?.workflowName ?? run?.run?.workflow_name ?? run?.run?.workflowName,
    currentStepName: run?.current_step_name ?? run?.currentStepName ?? run?.run?.current_step_name ?? run?.run?.currentStepName,
    currentStepStatus: run?.current_step_status ?? run?.currentStepStatus ?? run?.run?.current_step_status ?? run?.run?.currentStepStatus,
    nodeCounts: run?.metadata?.node_counts ?? run?.metadata?.nodeCounts ?? run?.run?.metadata?.node_counts ?? run?.run?.metadata?.nodeCounts,
  };

  return normalizeEvent({
    id: `derived:archon:${session.id}:${runId}:status:${sessionIndex}`,
    type: "archon.workflow.status",
    projectId: project?.id,
    taskId: normalizeTaskId(session.issueId),
    sessionId: session.id,
    timestamp: run?.last_activity_at ?? run?.lastActivityAt ?? run?.completed_at ?? run?.completedAt ?? session.lastActivityAt ?? session.agentReportedAt ?? options.observedAt ?? now().toISOString(),
    status,
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined && value !== null)),
  }, { now });
}

async function deriveArchonEvents(sessions, project, options = {}) {
  const getArchonRun = options.getArchonRun;
  if (typeof getArchonRun !== "function") return [];

  const now = options.now ?? (() => new Date());
  const events = [];

  for (const [sessionIndex, session] of sessions.entries()) {
    if (!session?.issueId || !session?.archonRunId) continue;

    let run;
    try {
      run = await getArchonRun(session.archonRunId, session, project);
    } catch {
      continue;
    }

    const statusEvent = archonRunStatusEvent(run, session, project, sessionIndex, now, options);
    if (statusEvent) events.push(statusEvent);

    const runEvents = Array.isArray(run?.events) ? run.events : [];

    for (const [eventIndex, event] of runEvents.entries()) {
      const type = archonEventType(event);
      if (!type) continue;

      events.push(normalizeEvent({
        id: `derived:archon:${session.id}:${session.archonRunId}:${sessionIndex}:${eventIndex}`,
        type,
        projectId: project?.id,
        taskId: normalizeTaskId(session.issueId),
        sessionId: session.id,
        timestamp: archonEventTimestamp(event) ?? session.agentReportedAt ?? session.lastActivityAt ?? options.observedAt ?? now().toISOString(),
        status: session.agentReportedState ?? session.observableStatus ?? session.status,
        error: event?.error ?? event?.message,
        metadata: archonEventMetadata(event, session.archonRunId),
      }, { now }));
    }
  }

  return events.sort(compareEvents);
}

export function buildObservabilitySnapshot(options) {
  const now = options.now ?? (() => new Date());
  const observedAt = now();
  const project = options.project ?? defaultProject(process.cwd());
  const allIssues = options.allIssues ?? [];
  const sessions = normalizeSessionsPayload(options.sessions)
    .filter((session) => !session.projectId || !project.id || session.projectId === project.id)
    .filter((session) => !isAoOrchestratorSession(session, project))
    .map((session) => summarizeSession(session, { now: observedAt, staleAfterMs: options.staleAfterMs }));
  const persistedEvents = (Array.isArray(options.events) ? options.events : []).map((event) => normalizeEvent(event, { now }));
  const derivedEvents = deriveSessionEvents(sessions, project, { now, observedAt: observedAt.toISOString() });
  const events = [...persistedEvents, ...derivedEvents].sort(compareEvents);
  const sessionsByIssue = new Map();
  const eventsByIssue = new Map();
  const tasks = {};

  for (const session of sessions) {
    if (!session.issueId) continue;
    const existing = sessionsByIssue.get(session.issueId) ?? [];
    existing.push(session);
    sessionsByIssue.set(session.issueId, existing);
  }

  for (const event of events) {
    const issueId = normalizeTaskId(event.taskId);
    if (!issueId) continue;
    const existing = eventsByIssue.get(issueId) ?? [];
    existing.push(event);
    eventsByIssue.set(issueId, existing);
  }

  for (const issue of allIssues) {
    const issueId = normalizeTaskId(issue.id);
    const issueState = String(issue.state ?? "").toLowerCase();
    const issueSessions = sortSessionsForDisplay(sessionsByIssue.get(issueId) ?? []);
    const sessionStatus = chooseSessionStatus(issueSessions);
    let status = sessionStatus;

    if (!status) {
      if (issueState === "closed") status = "merged";
      else status = "queued";
    }

    if (issueState !== "closed" && status === "failed" && isInterruptedWithoutExplicitFailure(issueSessions[0])) {
      status = "queued";
    }

    if (issueState === "closed") {
      status = "merged";
    }

    tasks[issueId] = {
      id: issueId,
      title: issue.title,
      branchName: issue.branchName,
      sourceState: issue.state,
      status,
      currentSession: issueSessions[0] ?? null,
      sessionHistory: issueSessions.slice(1),
      sessions: issueSessions,
      timeline: (eventsByIssue.get(issueId) ?? []).sort(compareEvents),
    };
  }

  const summary = makeSummary(tasks);
  summary.cleanup_failed = Math.max(
    summary.cleanup_failed,
    countCleanupFailures(options.runnerState?.cleanup),
  );

  return {
    version: 1,
    observedAt: observedAt.toISOString(),
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
      tasksPath: project.tracker?.tasksPath,
    },
    runnerState: options.runnerState ?? null,
    events,
    eventSummary: summarizeEvents(events),
    tasks,
    sessions,
    summary,
  };
}

async function defaultListSessions({ project, transport }) {
  return transport.sessionList({ projectId: project.id, includeTerminated: true });
}

export async function runObservabilityOnce(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const project = options.project ?? defaultProject(cwd);
  const aoCommand = options.aoCommand;
  const transport = options.transport ?? (options.createTransport ?? createAoTransport)({
    cwd,
    aoCommand,
    env: options.env,
  });
  const statePath = resolve(cwd, options.statePath ?? `.dark-factory/observability/${project.id}.json`);
  const runnerStatePath = resolve(cwd, options.runnerStatePath ?? `.dark-factory/state/${project.id}.json`);
  const tracker = options.tracker ?? tasksMdTracker.create();
  const getAllIssues = options.getAllIssues ?? (() => tracker.listIssues({ state: "all" }, project));
  const getRunnableIssues = options.getRunnableIssues ?? (() => tracker.listIssues({ state: "open" }, project));
  const listSessions = options.listSessions ?? (() => defaultListSessions({ project, transport }));
  const listReadyArtifacts = options.listReadyArtifacts ?? (() => defaultListReadyArtifacts(project, options));
  const eventLogPath = options.eventLogPath ? resolve(cwd, options.eventLogPath) : null;
  const previousSnapshot = await readJsonIfExists(statePath);
  const runnerState = options.runnerState ?? await readJsonIfExists(runnerStatePath);
  const events = eventLogPath ? await readEvents({ eventLogPath }) : [];
  const listedSessions = normalizeSessionsPayload(await listSessions());
  const sessionsWithReadyArtifacts = synthesizeReadyArtifactSessions(
    listedSessions,
    await listReadyArtifacts(),
    project,
  );
  const sessions = await hydrateSessionPullRequests(sessionsWithReadyArtifacts, project, options);
  const archonEvents = await deriveArchonEvents(sessions, project, {
    getArchonRun: options.getArchonRun === undefined
      ? (runId, session, currentProject) => defaultGetArchonRun(runId, session, currentProject, options)
      : options.getArchonRun,
    now: options.now,
    observedAt: (options.now ?? (() => new Date()))().toISOString(),
  });
  const snapshotOptions = {
    project,
    allIssues: await getAllIssues(),
    runnableIssues: await getRunnableIssues(),
    sessions,
    events: [...events, ...archonEvents],
    runnerState,
    now: options.now,
    staleAfterMs: options.staleAfterMs,
  };
  const trustedSnapshot = buildObservabilitySnapshot(snapshotOptions);
  const reconciliationEvents = [];

  if (eventLogPath) {
    for (const event of reconciliationEventInputs(previousSnapshot, trustedSnapshot, events)) {
      reconciliationEvents.push(await appendEvent(event, { eventLogPath, now: options.now }));
    }
  }

  const snapshot = reconciliationEvents.length > 0
    ? buildObservabilitySnapshot({
      ...snapshotOptions,
      events: [...events, ...archonEvents, ...reconciliationEvents],
    })
    : trustedSnapshot;

  await writeJsonAtomic(statePath, snapshot);
  return snapshot;
}

function parseArgs(argv) {
  const options = {
    project: defaultProject(process.cwd()),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];

    if (arg === "--project-id") options.project.id = next();
    else if (arg === "--project-name") options.project.name = next();
    else if (arg === "--project-path") options.project.path = next();
    else if (arg === "--tasks-path") options.project.tracker.tasksPath = next();
    else if (arg === "--state-path") options.statePath = next();
    else if (arg === "--runner-state-path") options.runnerStatePath = next();
    else if (arg === "--ao-command") options.aoCommand = next();
    else if (arg === "--stale-after-ms") options.staleAfterMs = Number.parseInt(next(), 10);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node orchestrator/dark-factory-observability.js [options]

Options:
  --project-id <id>          AO project id (default: project)
  --project-name <name>      Project display name (default: Project)
  --project-path <path>      Source project path (default: cwd)
  --tasks-path <path>        Roadmap path inside project
  --state-path <path>        Observable snapshot path
  --runner-state-path <path> D003 runner state path
  --ao-command <cmd>         AO command for session listing (default: ao)
  --stale-after-ms <ms>      Active-session stale threshold (default: 1800000)
`);
}

async function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  const snapshot = await runObservabilityOnce(options);
  console.log(JSON.stringify({
    observedAt: snapshot.observedAt,
    projectId: snapshot.project.id,
    summary: snapshot.summary,
    statePath: resolve(process.cwd(), options.statePath ?? `.dark-factory/observability/${snapshot.project.id}.json`),
  }, null, 2));
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
