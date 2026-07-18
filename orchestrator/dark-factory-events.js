import { randomUUID } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

const STRING_FIELDS = [
  "type",
  "projectId",
  "taskId",
  "runId",
  "workflowRunId",
  "nodeId",
  "sessionId",
  "prNumber",
  "status",
  "error",
];

function requireEventLogPath(options = {}) {
  const eventLogPath = options.eventLogPath;
  if (!eventLogPath) {
    throw new TypeError("eventLogPath is required");
  }
  return eventLogPath;
}

function normalizeString(value) {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Error) {
    return String(value.stack ?? value.message ?? value).trim() || undefined;
  }
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

function normalizeTimestamp(value, now = () => new Date()) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return now().toISOString();
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }

  return String(value).trim();
}

function eventSortKey(event, index) {
  const timestamp = Date.parse(event?.timestamp ?? "");
  return {
    timestamp: Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY,
    index,
  };
}

function isLaterEvent(left, right) {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp > right.timestamp;
  }
  return left.index > right.index;
}

export function normalizeEvent(input, options = {}) {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const event = { ...(input ?? {}) };

  event.version = 1;
  event.id = normalizeString(event.id) ?? idFactory();
  event.timestamp = normalizeTimestamp(event.timestamp, now);

  for (const field of STRING_FIELDS) {
    const normalized = normalizeString(event[field]);
    if (normalized === undefined) {
      delete event[field];
    } else {
      event[field] = normalized;
    }
  }

  if (event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)) {
    event.metadata = input.metadata;
  } else {
    delete event.metadata;
  }

  return event;
}

export async function appendEvent(event, options = {}) {
  const eventLogPath = requireEventLogPath(options);
  const normalized = normalizeEvent(event, options);

  await mkdir(dirname(eventLogPath), { recursive: true });
  await appendFile(eventLogPath, `${JSON.stringify(normalized)}\n`, "utf8");

  return normalized;
}

function eventStateFingerprint(event) {
  return JSON.stringify({
    type: event?.type ?? null,
    projectId: event?.projectId ?? null,
    taskId: event?.taskId ?? null,
    runId: event?.runId ?? null,
    workflowRunId: event?.workflowRunId ?? null,
    nodeId: event?.nodeId ?? null,
    sessionId: event?.sessionId ?? null,
    prNumber: event?.prNumber ?? null,
    status: event?.status ?? null,
    error: event?.error ?? null,
    metadata: event?.metadata ?? null,
  });
}

export async function appendEventIfChanged(event, options = {}) {
  const eventLogPath = requireEventLogPath(options);
  const normalized = normalizeEvent(event, options);
  const events = await readEvents({ eventLogPath });
  const previous = events.findLast((item) => (
    item?.projectId === normalized.projectId
    && item?.taskId === normalized.taskId
  ));

  if (previous && eventStateFingerprint(previous) === eventStateFingerprint(normalized)) {
    return null;
  }

  await mkdir(dirname(eventLogPath), { recursive: true });
  await appendFile(eventLogPath, `${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

export async function readEvents(options = {}) {
  const eventLogPath = requireEventLogPath(options);

  try {
    const contents = await readFile(eventLogPath, "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function summarizeEvents(events) {
  const summary = {
    total: 0,
    byType: {},
    latestByTask: {},
  };

  const latestByTask = new Map();

  for (const [index, event] of (Array.isArray(events) ? events : []).entries()) {
    summary.total += 1;

    const type = normalizeString(event?.type) ?? "unknown";
    summary.byType[type] = (summary.byType[type] ?? 0) + 1;

    const taskId = normalizeString(event?.taskId);
    if (!taskId) continue;

    const candidate = { ...eventSortKey(event, index), event };
    const current = latestByTask.get(taskId);
    if (!current || isLaterEvent(candidate, current)) {
      latestByTask.set(taskId, candidate);
      summary.latestByTask[taskId] = event;
    }
  }

  return summary;
}
