import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_STALE_AFTER_MS = 120_000;

function leaseError(code, message, lease) {
  const error = new Error(message);
  error.code = code;
  error.ownerId = lease?.ownerId;
  error.lease = lease ?? null;
  return error;
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Project lease clock returned an invalid date");
  return date;
}

function requireLeaseId(options) {
  const leaseId = String(options.leaseId ?? "").trim();
  if (!leaseId) {
    throw leaseError(
      "DARK_FACTORY_LEASE_ID_REQUIRED",
      "Dark Factory lease heartbeat and release require a lease id",
    );
  }
  return leaseId;
}

function serializeLease(lease) {
  return `${JSON.stringify(lease, null, 2)}\n`;
}

function releaseMarkerPath(leasePath, leaseId) {
  return `${leasePath}.released-${leaseId}`;
}

function heartbeatGenerationPath(leasePath, leaseId) {
  return `${leasePath}.heartbeat-${leaseId}`;
}

function heartbeatGenerationTempPath(leasePath, leaseId, generationId) {
  return `${heartbeatGenerationPath(leasePath, leaseId)}.tmp-${generationId}`;
}

async function readLease(path) {
  const raw = await readFile(path, "utf8");
  return { raw, lease: JSON.parse(raw) };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function pathReferencesHandle(path, handle) {
  const handleStats = await handle.stat();
  try {
    return sameFile(handleStats, await stat(path));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeHandle(handle, contents) {
  const bytes = Buffer.from(contents, "utf8");
  await handle.truncate(0);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) throw new Error("Project lease write made no progress");
    offset += bytesWritten;
  }
  await handle.truncate(bytes.length);
  await handle.sync();
}

async function writeExclusive(path, lease, openFile) {
  const handle = await openFile(path, "wx");
  let operationError = null;
  try {
    await writeHandle(handle, serializeLease(lease));
  } catch (error) {
    operationError = error;
    try {
      if (await pathReferencesHandle(path, handle)) await rm(path);
    } catch (cleanupError) {
      error.leasePartialCleanupError = cleanupError;
    }
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (operationError) operationError.leaseCloseError = closeError;
      else throw closeError;
    }
  }
}

function validHeartbeatGeneration(generation, lease) {
  return generation?.leaseId === lease?.leaseId
    && generation?.ownerId === lease?.ownerId
    && Number.isFinite(Date.parse(generation?.heartbeatAt ?? ""));
}

async function readHeartbeatGeneration(leasePath, lease) {
  try {
    const observed = await readLease(heartbeatGenerationPath(leasePath, lease.leaseId));
    return validHeartbeatGeneration(observed.lease, lease) ? observed : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isStale(lease, heartbeatGeneration, currentTime, staleAfterMs) {
  if (lease?.releasedAt) return true;
  const heartbeatTime = Date.parse(
    heartbeatGeneration?.lease?.heartbeatAt
      ?? lease?.heartbeatAt
      ?? lease?.acquiredAt
      ?? "",
  );
  return Number.isFinite(heartbeatTime) && currentTime.getTime() - heartbeatTime > staleAfterMs;
}

async function removeHeartbeatArtifacts(leasePath, leaseId) {
  const directory = dirname(leasePath);
  const heartbeatName = basename(heartbeatGenerationPath(leasePath, leaseId));
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry === heartbeatName || entry.startsWith(`${heartbeatName}.tmp-`))
    .map((entry) => rm(join(directory, entry), { force: true })));
}

async function releaseMarkerExists(leasePath, leaseId) {
  try {
    await stat(releaseMarkerPath(leasePath, leaseId));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function restoreDisplacedLease(leasePath, displacedPath) {
  try {
    await link(displacedPath, leasePath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

async function removeDisplacedLeaseWhenSafe(leasePath, displacedPath, restored) {
  if (restored) {
    await rm(displacedPath, { force: true });
    return;
  }

  try {
    await readLease(leasePath);
    await rm(displacedPath, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

async function acquireProjectLeaseAttempt(options, leasePath, lease, currentTime) {
  const openFile = options.openFile ?? open;
  try {
    await writeExclusive(leasePath, lease, openFile);
    return lease;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  let observed;
  try {
    observed = await readLease(leasePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const observedHeartbeat = await readHeartbeatGeneration(leasePath, observed.lease);
  const released = await releaseMarkerExists(leasePath, observed.lease.leaseId);
  if (!released && !isStale(
    observed.lease,
    observedHeartbeat,
    currentTime,
    options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  )) {
    throw leaseError(
      "DARK_FACTORY_LEASE_HELD",
      `Dark Factory project lease is held by ${observed.lease.ownerId ?? "another owner"}`,
      observed.lease,
    );
  }

  const displacedPath = `${leasePath}.stale-${lease.leaseId}`;
  try {
    await rename(leasePath, displacedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  let replacementCreated = false;
  let restored = false;
  let operationError = null;
  try {
    const displaced = await readLease(displacedPath);
    if (displaced.raw !== observed.raw) {
      throw leaseError(
        "DARK_FACTORY_LEASE_HELD",
        `Dark Factory project lease changed while owner ${lease.ownerId} attempted takeover`,
        displaced.lease,
      );
    }
    const currentHeartbeat = await readHeartbeatGeneration(leasePath, displaced.lease);
    if ((currentHeartbeat?.raw ?? null) !== (observedHeartbeat?.raw ?? null)) {
      throw leaseError(
        "DARK_FACTORY_LEASE_HELD",
        `Dark Factory project lease heartbeat changed while owner ${lease.ownerId} attempted takeover`,
        displaced.lease,
      );
    }
    await writeExclusive(leasePath, lease, openFile);
    replacementCreated = true;
    return lease;
  } catch (error) {
    operationError = error;
    if (!replacementCreated) {
      try {
        restored = await restoreDisplacedLease(leasePath, displacedPath);
      } catch (restoreError) {
        error.leaseRestoreError = restoreError;
      }
    }
    throw error;
  } finally {
    try {
      if (replacementCreated) {
        await rm(displacedPath, { force: true });
        await rm(releaseMarkerPath(leasePath, observed.lease.leaseId), { force: true });
        await removeHeartbeatArtifacts(leasePath, observed.lease.leaseId);
      }
      else await removeDisplacedLeaseWhenSafe(leasePath, displacedPath, restored);
    } catch (cleanupError) {
      if (operationError) operationError.leaseQuarantineCleanupError = cleanupError;
      else throw cleanupError;
    }
  }
}

export async function acquireProjectLease(options) {
  const leasePath = resolve(options.leasePath);
  const ownerId = String(options.ownerId ?? "").trim();
  const projectId = String(options.projectId ?? "").trim();
  if (!ownerId) throw new Error("Project lease requires an owner id");
  if (!projectId) throw new Error("Project lease requires a project id");

  const now = options.now ?? (() => new Date());
  const currentTime = timestamp(now);
  const lease = {
    version: 1,
    projectId,
    ownerId,
    leaseId: randomUUID(),
    acquiredAt: currentTime.toISOString(),
    heartbeatAt: currentTime.toISOString(),
  };

  await mkdir(dirname(leasePath), { recursive: true });
  for (;;) {
    const acquired = await acquireProjectLeaseAttempt(options, leasePath, lease, currentTime);
    if (acquired) return acquired;
  }
}

async function openOwnedLease(options) {
  const leasePath = resolve(options.leasePath);
  const leaseId = requireLeaseId(options);
  const openFile = options.openFile ?? open;
  let handle;
  try {
    handle = await openFile(leasePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw leaseError(
        "DARK_FACTORY_LEASE_NOT_OWNER",
        `Dark Factory project lease is not owned by ${options.ownerId}`,
      );
    }
    throw error;
  }

  try {
    const raw = await handle.readFile("utf8");
    const lease = JSON.parse(raw);
    const owned = !lease.releasedAt
      && lease.ownerId === options.ownerId
      && lease.leaseId === leaseId
      && await pathReferencesHandle(leasePath, handle)
      && !await releaseMarkerExists(leasePath, leaseId);
    if (!owned) {
      throw leaseError(
        "DARK_FACTORY_LEASE_NOT_OWNER",
        `Dark Factory project lease is not owned by ${options.ownerId}`,
        lease,
      );
    }
    return { handle, lease, leasePath };
  } catch (error) {
    await handle.close().catch((closeError) => {
      error.leaseCloseError = closeError;
    });
    throw error;
  }
}

async function closeOwnedLease(owned, operationError) {
  try {
    await owned.handle.close();
  } catch (closeError) {
    if (operationError) operationError.leaseCloseError = closeError;
    else throw closeError;
  }
}

export async function heartbeatProjectLease(options) {
  const owned = await openOwnedLease(options);
  const generationId = randomUUID();
  const generationPath = heartbeatGenerationPath(owned.leasePath, owned.lease.leaseId);
  const tempPath = heartbeatGenerationTempPath(owned.leasePath, owned.lease.leaseId, generationId);
  let operationError = null;
  try {
    const now = options.now ?? (() => new Date());
    const heartbeatAt = timestamp(now).toISOString();
    const generation = {
      version: 1,
      projectId: owned.lease.projectId,
      ownerId: owned.lease.ownerId,
      leaseId: owned.lease.leaseId,
      generationId,
      heartbeatAt,
    };
    const lease = { ...owned.lease, heartbeatAt };
    await writeExclusive(tempPath, generation, options.openFile ?? open);
    if (!await pathReferencesHandle(owned.leasePath, owned.handle)) {
      throw leaseError(
        "DARK_FACTORY_LEASE_NOT_OWNER",
        `Dark Factory project lease is not owned by ${options.ownerId}`,
        owned.lease,
      );
    }
    if (await releaseMarkerExists(owned.leasePath, owned.lease.leaseId)) {
      throw leaseError(
        "DARK_FACTORY_LEASE_NOT_OWNER",
        `Dark Factory project lease is not owned by ${options.ownerId}`,
        owned.lease,
      );
    }
    await (options.renameFile ?? rename)(tempPath, generationPath);
    if (!await pathReferencesHandle(owned.leasePath, owned.handle)) {
      throw leaseError(
        "DARK_FACTORY_LEASE_NOT_OWNER",
        `Dark Factory project lease is not owned by ${options.ownerId}`,
        lease,
      );
    }
    return lease;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let tempCleanupError = null;
    try {
      await rm(tempPath, { force: true });
    } catch (cleanupError) {
      if (operationError) operationError.heartbeatTempCleanupError = cleanupError;
      else tempCleanupError = cleanupError;
    }
    await closeOwnedLease(owned, operationError ?? tempCleanupError);
    if (tempCleanupError) throw tempCleanupError;
  }
}

export async function releaseProjectLease(options) {
  let owned;
  try {
    owned = await openOwnedLease(options);
  } catch (error) {
    if (error?.code === "DARK_FACTORY_LEASE_NOT_OWNER") return false;
    throw error;
  }

  let operationError = null;
  try {
    const now = options.now ?? (() => new Date());
    const releasedAt = timestamp(now).toISOString();
    const markerPath = releaseMarkerPath(owned.leasePath, owned.lease.leaseId);
    const marker = {
      version: 1,
      projectId: owned.lease.projectId,
      ownerId: owned.lease.ownerId,
      leaseId: owned.lease.leaseId,
      releasedAt,
    };
    if (!await pathReferencesHandle(owned.leasePath, owned.handle)) return false;
    await writeExclusive(markerPath, marker, options.openFile ?? open);
    if (await pathReferencesHandle(owned.leasePath, owned.handle)) return true;
    await rm(markerPath, { force: true });
    return false;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    await closeOwnedLease(owned, operationError);
  }
}
