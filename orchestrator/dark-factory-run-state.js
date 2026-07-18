import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

function timestamp(now) {
  const value = now ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Run ledger clock returned an invalid date");
  return date.toISOString();
}

function normalizeTaskLimit(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Run ledger taskLimit must be a positive integer");
  return parsed;
}

function normalizeTaskIds(values = []) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
}

function withDerivedBudget(ledger) {
  const chargedTaskIds = normalizeTaskIds(ledger.chargedTaskIds);
  return {
    ...ledger,
    chargedTaskIds,
    remainingTaskSlots: ledger.taskLimit === null
      ? null
      : Math.max(0, ledger.taskLimit - chargedTaskIds.length),
  };
}

async function readLedger(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function persistLedger(path, ledger) {
  const normalized = withDerivedBudget(ledger);
  await writeJsonAtomic(path, normalized);
  await writeJsonAtomic(join(dirname(path), "runs", `${normalized.runId}.json`), normalized);
  return normalized;
}

export async function openRunLedger({
  path,
  projectId,
  taskLimit,
  invocation = "run",
  runId,
  invocationId,
  now,
} = {}) {
  if (!path) throw new Error("Run ledger path is required");
  if (!projectId) throw new Error("Run ledger project id is required");

  const existing = await readLedger(path);
  const at = timestamp(now);
  const invocationRecord = {
    id: invocationId ?? crypto.randomUUID(),
    type: invocation,
    startedAt: at,
  };

  if (existing?.status === "active") {
    if (existing.projectId !== projectId) {
      throw new Error(`Active run ledger belongs to project ${existing.projectId}`);
    }
    const requestedLimit = normalizeTaskLimit(taskLimit);
    if (taskLimit !== undefined && requestedLimit !== existing.taskLimit) {
      throw new Error(`Active run ${existing.runId} uses task limit ${existing.taskLimit ?? "unlimited"}`);
    }
    const invocations = existing.invocations ?? [];
    return persistLedger(path, {
      ...existing,
      updatedAt: at,
      invocations: invocations.some((item) => item?.id === invocationRecord.id)
        ? invocations
        : [...invocations, invocationRecord],
    });
  }

  return persistLedger(path, {
    version: 1,
    runId: runId ?? crypto.randomUUID(),
    projectId,
    status: "active",
    taskLimit: normalizeTaskLimit(taskLimit),
    chargedTaskIds: [],
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    invocations: [invocationRecord],
  });
}

export async function recordRunnerCharges(path, ledger, runner, { now } = {}) {
  const successfulResumes = (runner?.resume?.restored ?? []).map((item) => item?.issueId);
  const successfulSpawns = runner?.spawn?.attempted === true ? runner.spawn.issueIds ?? [] : [];
  return persistLedger(path, {
    ...ledger,
    updatedAt: timestamp(now),
    chargedTaskIds: normalizeTaskIds([
      ...(ledger?.chargedTaskIds ?? []),
      ...successfulSpawns,
      ...successfulResumes,
    ]),
  });
}

export async function completeRunLedger(path, ledger, { now, cleanup = null, status = "completed" } = {}) {
  if (!new Set(["completed", "cleanup_failed"]).has(status)) {
    throw new Error(`Unsupported terminal run status: ${status}`);
  }
  const completedAt = timestamp(now);
  return persistLedger(path, {
    ...ledger,
    status,
    updatedAt: completedAt,
    completedAt,
    cleanup,
  });
}

export async function updateRunLedger(path, ledger, updates, { now } = {}) {
  return persistLedger(path, {
    ...ledger,
    ...updates,
    updatedAt: timestamp(now),
  });
}
