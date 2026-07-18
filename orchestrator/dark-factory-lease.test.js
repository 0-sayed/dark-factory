import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  acquireProjectLease,
  heartbeatProjectLease,
  releaseProjectLease,
} from "./dark-factory-lease.js";

const execFileAsync = promisify(execFile);

async function withLeasePath(run) {
  const directory = await mkdtemp(join(tmpdir(), "dark-factory-lease-"));
  const leasePath = join(directory, "project", "lease.json");

  try {
    await run(leasePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function failAfterPartialWrite(handle, writeError) {
  return {
    close: (...args) => handle.close(...args),
    readFile: (...args) => handle.readFile(...args),
    stat: (...args) => handle.stat(...args),
    sync: (...args) => handle.sync(...args),
    truncate: (...args) => handle.truncate(...args),
    write: async (buffer, offset, length, position) => {
      await handle.write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
      throw writeError;
    },
  };
}

function heartbeatGenerationPath(leasePath, leaseId) {
  return `${leasePath}.heartbeat-${leaseId}`;
}

test("project lease allows only one live owner", async () => {
  await withLeasePath(async (leasePath) => {
    await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });

    await assert.rejects(
      acquireProjectLease({
        leasePath,
        projectId: "sample",
        ownerId: "owner-b",
        now: () => new Date("2026-07-10T10:00:01.000Z"),
      }),
      (error) => error?.code === "DARK_FACTORY_LEASE_HELD" && error?.ownerId === "owner-a",
    );
  });
});

test("project lease permits takeover after the previous heartbeat becomes stale", async () => {
  await withLeasePath(async (leasePath) => {
    await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });

    const lease = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-b",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:02.000Z"),
    });

    assert.equal(lease.ownerId, "owner-b");
    assert.equal(lease.acquiredAt, "2026-07-10T10:00:02.000Z");
    assert.equal(JSON.parse(await readFile(leasePath, "utf8")).ownerId, "owner-b");
  });
});

test("project lease release is restricted to the current owner", async () => {
  await withLeasePath(async (leasePath) => {
    const lease = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });

    assert.equal(await releaseProjectLease({ leasePath, ownerId: "owner-b", leaseId: lease.leaseId }), false);
    assert.equal(JSON.parse(await readFile(leasePath, "utf8")).ownerId, "owner-a");
    assert.equal(await releaseProjectLease({ leasePath, ownerId: "owner-a", leaseId: lease.leaseId }), true);

    const successor = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-b",
      now: () => new Date("2026-07-10T10:00:01.000Z"),
    });
    assert.equal(successor.ownerId, "owner-b");
  });
});

test("project lease heartbeat updates only the current owner's lease", async () => {
  await withLeasePath(async (leasePath) => {
    const acquired = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });

    await assert.rejects(
      heartbeatProjectLease({
        leasePath,
        ownerId: "owner-b",
        leaseId: acquired.leaseId,
        now: () => new Date("2026-07-10T10:00:01.000Z"),
      }),
      (error) => error?.code === "DARK_FACTORY_LEASE_NOT_OWNER",
    );

    const lease = await heartbeatProjectLease({
      leasePath,
      ownerId: "owner-a",
      leaseId: acquired.leaseId,
      now: () => new Date("2026-07-10T10:00:02.000Z"),
    });

    assert.equal(lease.heartbeatAt, "2026-07-10T10:00:02.000Z");
    await assert.rejects(
      acquireProjectLease({
        leasePath,
        projectId: "sample",
        ownerId: "owner-b",
        staleAfterMs: 1_000,
        now: () => new Date("2026-07-10T10:00:02.500Z"),
      }),
      (error) => error?.code === "DARK_FACTORY_LEASE_HELD",
    );
  });
});

test("project lease heartbeat keeps the authoritative ownership record immutable", async () => {
  await withLeasePath(async (leasePath) => {
    const acquired = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });
    const originalOwnershipRecord = await readFile(leasePath, "utf8");

    const heartbeat = await heartbeatProjectLease({
      leasePath,
      ownerId: acquired.ownerId,
      leaseId: acquired.leaseId,
      now: () => new Date("2026-07-10T10:00:00.500Z"),
    });

    assert.equal(await readFile(leasePath, "utf8"), originalOwnershipRecord);
    assert.equal(heartbeat.heartbeatAt, "2026-07-10T10:00:00.500Z");
    const generation = JSON.parse(await readFile(
      heartbeatGenerationPath(leasePath, acquired.leaseId),
      "utf8",
    ));
    assert.equal(generation.leaseId, acquired.leaseId);
    assert.equal(generation.heartbeatAt, heartbeat.heartbeatAt);
  });
});

test("partial heartbeat generation writes preserve the previous atomic heartbeat", async () => {
  await withLeasePath(async (leasePath) => {
    const acquired = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });
    await heartbeatProjectLease({
      leasePath,
      ownerId: acquired.ownerId,
      leaseId: acquired.leaseId,
      now: () => new Date("2026-07-10T10:00:00.400Z"),
    });
    const ownershipRecord = await readFile(leasePath, "utf8");
    const generationPath = heartbeatGenerationPath(leasePath, acquired.leaseId);
    const previousGeneration = await readFile(generationPath, "utf8");
    const writeError = Object.assign(new Error("simulated heartbeat generation write failure"), { code: "ENOSPC" });
    const openFile = async (path, flags) => {
      const handle = await open(path, flags);
      if (flags === "wx" && path.startsWith(`${generationPath}.tmp-`)) {
        return failAfterPartialWrite(handle, writeError);
      }
      return handle;
    };

    await assert.rejects(
      heartbeatProjectLease({
        leasePath,
        ownerId: acquired.ownerId,
        leaseId: acquired.leaseId,
        now: () => new Date("2026-07-10T10:00:00.800Z"),
        openFile,
      }),
      (error) => error === writeError,
    );

    assert.equal(await readFile(leasePath, "utf8"), ownershipRecord);
    assert.equal(await readFile(generationPath, "utf8"), previousGeneration);
    assert.deepEqual(
      (await readdir(join(leasePath, ".."))).filter((entry) => entry.includes(".tmp-")),
      [],
    );
    await assert.rejects(
      acquireProjectLease({
        leasePath,
        projectId: "sample",
        ownerId: "owner-b",
        staleAfterMs: 1_000,
        now: () => new Date("2026-07-10T10:00:01.200Z"),
      }),
      (error) => error?.code === "DARK_FACTORY_LEASE_HELD",
    );
  });
});

test("failed heartbeat generation publish leaves the acquired timestamp authoritative", async () => {
  await withLeasePath(async (leasePath) => {
    const acquired = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });
    const ownershipRecord = await readFile(leasePath, "utf8");
    const publishError = Object.assign(new Error("simulated heartbeat publish failure"), { code: "EIO" });

    await assert.rejects(
      heartbeatProjectLease({
        leasePath,
        ownerId: acquired.ownerId,
        leaseId: acquired.leaseId,
        now: () => new Date("2026-07-10T10:00:00.500Z"),
        renameFile: async () => {
          throw publishError;
        },
      }),
      (error) => error === publishError,
    );

    assert.equal(await readFile(leasePath, "utf8"), ownershipRecord);
    await assert.rejects(
      readFile(heartbeatGenerationPath(leasePath, acquired.leaseId)),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(
      acquireProjectLease({
        leasePath,
        projectId: "sample",
        ownerId: "owner-b",
        staleAfterMs: 1_000,
        now: () => new Date("2026-07-10T10:00:00.750Z"),
      }),
      (error) => error?.code === "DARK_FACTORY_LEASE_HELD",
    );
  });
});

test("heartbeat generations publish atomically across changed byte lengths", async () => {
  await withLeasePath(async (leasePath) => {
    const acquired = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });
    const ownershipRecord = await readFile(leasePath, "utf8");
    const generationPath = heartbeatGenerationPath(leasePath, acquired.leaseId);
    const compactGeneration = `${JSON.stringify({
      leaseId: acquired.leaseId,
      ownerId: acquired.ownerId,
      heartbeatAt: "2026-07-10T10:00:00.400Z",
    })}\n`;
    await writeFile(generationPath, compactGeneration);

    await heartbeatProjectLease({
      leasePath,
      ownerId: acquired.ownerId,
      leaseId: acquired.leaseId,
      now: () => new Date("2026-07-10T10:00:00.800Z"),
    });

    const publishedGeneration = await readFile(generationPath, "utf8");
    assert.notEqual(Buffer.byteLength(publishedGeneration), Buffer.byteLength(compactGeneration));
    assert.equal(JSON.parse(publishedGeneration).heartbeatAt, "2026-07-10T10:00:00.800Z");
    assert.equal(await readFile(leasePath, "utf8"), ownershipRecord);
    await assert.rejects(
      acquireProjectLease({
        leasePath,
        projectId: "sample",
        ownerId: "owner-b",
        staleAfterMs: 1_000,
        now: () => new Date("2026-07-10T10:00:01.500Z"),
      }),
      (error) => error?.code === "DARK_FACTORY_LEASE_HELD",
    );
  });
});

test("takeover removes old heartbeat sidecars and ignores stale-owner generations", async () => {
  await withLeasePath(async (leasePath) => {
    const staleLease = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });
    await heartbeatProjectLease({
      leasePath,
      ownerId: staleLease.ownerId,
      leaseId: staleLease.leaseId,
      now: () => new Date("2026-07-10T10:00:00.500Z"),
    });
    const successor = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-b",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:02.000Z"),
    });

    assert.equal(
      (await readdir(join(leasePath, ".."))).some((entry) => entry.includes(staleLease.leaseId)),
      false,
    );
    await assert.rejects(
      heartbeatProjectLease({
        leasePath,
        ownerId: staleLease.ownerId,
        leaseId: staleLease.leaseId,
        now: () => new Date("2026-07-10T10:00:03.000Z"),
      }),
      (error) => error?.code === "DARK_FACTORY_LEASE_NOT_OWNER",
    );

    await writeFile(heartbeatGenerationPath(leasePath, staleLease.leaseId), `${JSON.stringify({
      leaseId: staleLease.leaseId,
      ownerId: staleLease.ownerId,
      heartbeatAt: "2099-01-01T00:00:00.000Z",
    })}\n`);
    const next = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-c",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:04.000Z"),
    });
    assert.equal(next.ownerId, "owner-c");
    assert.notEqual(next.leaseId, successor.leaseId);
  });
});

test("project lease heartbeat requires a lease id", async () => {
  await withLeasePath(async (leasePath) => {
    await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });

    await assert.rejects(
      heartbeatProjectLease({ leasePath, ownerId: "owner-a" }),
      (error) => error?.code === "DARK_FACTORY_LEASE_ID_REQUIRED",
    );
  });
});

test("project lease release requires a lease id", async () => {
  await withLeasePath(async (leasePath) => {
    await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });

    await assert.rejects(
      releaseProjectLease({ leasePath, ownerId: "owner-a" }),
      (error) => error?.code === "DARK_FACTORY_LEASE_ID_REQUIRED",
    );
  });
});

test("a stale owner cannot heartbeat or release a successor lease", async () => {
  await withLeasePath(async (leasePath) => {
    const staleLease = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });
    const successor = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-b",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:02.000Z"),
    });

    await assert.rejects(
      heartbeatProjectLease({
        leasePath,
        ownerId: staleLease.ownerId,
        leaseId: staleLease.leaseId,
      }),
      (error) => error?.code === "DARK_FACTORY_LEASE_NOT_OWNER",
    );
    assert.equal(await releaseProjectLease({
      leasePath,
      ownerId: staleLease.ownerId,
      leaseId: staleLease.leaseId,
    }), false);
    assert.deepEqual(JSON.parse(await readFile(leasePath, "utf8")), successor);
  });
});

test("stale takeover and owner heartbeat are serialized atomically", async () => {
  await withLeasePath(async (leasePath) => {
    const original = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });

    const [heartbeat, takeover] = await Promise.allSettled([
      heartbeatProjectLease({
        leasePath,
        ownerId: original.ownerId,
        leaseId: original.leaseId,
        now: () => new Date("2026-07-10T10:00:02.000Z"),
      }),
      acquireProjectLease({
        leasePath,
        projectId: "sample",
        ownerId: "owner-b",
        staleAfterMs: 1_000,
        now: () => new Date("2026-07-10T10:00:02.000Z"),
      }),
    ]);
    const current = JSON.parse(await readFile(leasePath, "utf8"));

    if (current.ownerId === "owner-a") {
      assert.equal(heartbeat.status, "fulfilled");
      assert.equal(takeover.status, "rejected");
      assert.equal(takeover.reason?.code, "DARK_FACTORY_LEASE_HELD");
    } else {
      assert.equal(current.ownerId, "owner-b");
      assert.equal(takeover.status, "fulfilled");
      assert.equal(heartbeat.status, "rejected");
      assert.equal(heartbeat.reason?.code, "DARK_FACTORY_LEASE_NOT_OWNER");
    }
  });
});

test("project leases do not depend on an external flock executable", async () => {
  await withLeasePath(async (leasePath) => {
    const moduleUrl = new URL("./dark-factory-lease.js", import.meta.url).href;
    const script = `
      import { acquireProjectLease } from ${JSON.stringify(moduleUrl)};
      const lease = await acquireProjectLease({
        leasePath: ${JSON.stringify(leasePath)},
        projectId: "sample",
        ownerId: "owner-a",
      });
      process.stdout.write(lease.ownerId);
    `;

    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PATH: "" },
    });

    assert.equal(stdout, "owner-a");
  });
});

test("failed exclusive writes remove partial lease files", async () => {
  await withLeasePath(async (leasePath) => {
    const writeError = Object.assign(new Error("simulated partial lease write"), { code: "ENOSPC" });
    const openFile = async (path, flags) => {
      const handle = await open(path, flags);
      return failAfterPartialWrite(handle, writeError);
    };

    await assert.rejects(
      acquireProjectLease({
        leasePath,
        projectId: "sample",
        ownerId: "owner-a",
        openFile,
      }),
      (error) => error === writeError,
    );
    await assert.rejects(readFile(leasePath), (error) => error?.code === "ENOENT");
  });
});

test("failed stale replacement restores the displaced lease", async () => {
  await withLeasePath(async (leasePath) => {
    await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });
    const original = await readFile(leasePath, "utf8");
    const writeError = Object.assign(new Error("simulated successor write failure"), { code: "ENOSPC" });
    let exclusiveOpenCount = 0;
    const openFile = async (path, flags) => {
      if (flags === "wx") exclusiveOpenCount += 1;
      const handle = await open(path, flags);
      if (flags !== "wx" || exclusiveOpenCount === 1) return handle;
      return failAfterPartialWrite(handle, writeError);
    };

    await assert.rejects(
      acquireProjectLease({
        leasePath,
        projectId: "sample",
        ownerId: "owner-b",
        staleAfterMs: 1_000,
        now: () => new Date("2026-07-10T10:00:02.000Z"),
        openFile,
      }),
      (error) => error === writeError,
    );

    assert.equal(await readFile(leasePath, "utf8"), original);
    assert.deepEqual((await readdir(join(leasePath, ".."))).sort(), ["lease.json"]);
  });
});

test("failed heartbeat writes preserve a valid owned lease", async () => {
  await withLeasePath(async (leasePath) => {
    const acquired = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });
    const writeError = Object.assign(new Error("simulated heartbeat write failure"), { code: "ENOSPC" });
    const generationPath = heartbeatGenerationPath(leasePath, acquired.leaseId);
    const openFile = async (path, flags) => {
      const handle = await open(path, flags);
      return flags === "wx" && path.startsWith(`${generationPath}.tmp-`)
        ? failAfterPartialWrite(handle, writeError)
        : handle;
    };

    await assert.rejects(
      heartbeatProjectLease({
        leasePath,
        ownerId: acquired.ownerId,
        leaseId: acquired.leaseId,
        now: () => new Date("2026-07-10T10:00:00.500Z"),
        openFile,
      }),
      (error) => error === writeError,
    );

    const preserved = JSON.parse(await readFile(leasePath, "utf8"));
    assert.equal(preserved.ownerId, acquired.ownerId);
    assert.equal(preserved.leaseId, acquired.leaseId);
    await assert.rejects(
      acquireProjectLease({
        leasePath,
        projectId: "sample",
        ownerId: "owner-b",
        staleAfterMs: 1_000,
        now: () => new Date("2026-07-10T10:00:00.750Z"),
      }),
      (error) => error?.code === "DARK_FACTORY_LEASE_HELD",
    );
  });
});

test("failed release writes preserve a valid owned lease", async () => {
  await withLeasePath(async (leasePath) => {
    const acquired = await acquireProjectLease({
      leasePath,
      projectId: "sample",
      ownerId: "owner-a",
      staleAfterMs: 1_000,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
    });
    const original = await readFile(leasePath, "utf8");
    const writeError = Object.assign(new Error("simulated release write failure"), { code: "ENOSPC" });
    const openFile = async (path, flags) => {
      const handle = await open(path, flags);
      return flags === "wx" ? failAfterPartialWrite(handle, writeError) : handle;
    };

    await assert.rejects(
      releaseProjectLease({
        leasePath,
        ownerId: acquired.ownerId,
        leaseId: acquired.leaseId,
        now: () => new Date("2026-07-10T10:00:00.500Z"),
        openFile,
      }),
      (error) => error === writeError,
    );

    assert.equal(await readFile(leasePath, "utf8"), original);
    assert.deepEqual((await readdir(join(leasePath, ".."))).sort(), ["lease.json"]);
    await assert.rejects(
      acquireProjectLease({
        leasePath,
        projectId: "sample",
        ownerId: "owner-b",
        staleAfterMs: 1_000,
        now: () => new Date("2026-07-10T10:00:00.750Z"),
      }),
      (error) => error?.code === "DARK_FACTORY_LEASE_HELD",
    );
  });
});
