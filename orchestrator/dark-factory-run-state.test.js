import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  completeRunLedger,
  openRunLedger,
  recordRunnerCharges,
} from "./dark-factory-run-state.js";

test("run ledger survives controller recovery and charges task ids once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-run-ledger-"));
  const path = join(dir, "run.json");
  const times = [
    new Date("2026-07-14T08:00:00.000Z"),
    new Date("2026-07-14T08:01:00.000Z"),
    new Date("2026-07-14T08:02:00.000Z"),
  ];
  const now = () => times.shift();

  let ledger = await openRunLedger({
    path,
    projectId: "sample",
    taskLimit: 2,
    invocation: "run",
    runId: "run-1",
    invocationId: "invocation-1",
    now,
  });
  ledger = await recordRunnerCharges(path, ledger, {
    spawn: { attempted: true, issueIds: ["T001"] },
    resume: { attempted: false, restored: [] },
  }, { now });

  const recovered = await openRunLedger({
    path,
    projectId: "sample",
    taskLimit: 2,
    invocation: "recover",
    runId: "ignored-new-id",
    invocationId: "invocation-2",
    now,
  });
  const chargedAgain = await recordRunnerCharges(path, recovered, {
    spawn: { attempted: false, issueIds: [] },
    resume: { attempted: true, restored: [{ issueId: "T001" }, { issueId: "T002" }] },
  }, { now: () => new Date("2026-07-14T08:03:00.000Z") });

  assert.equal(chargedAgain.runId, "run-1");
  assert.deepEqual(chargedAgain.chargedTaskIds, ["T001", "T002"]);
  assert.equal(chargedAgain.remainingTaskSlots, 0);
  assert.deepEqual(chargedAgain.invocations.map((item) => item.id), ["invocation-1", "invocation-2"]);

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(persisted.chargedTaskIds, ["T001", "T002"]);
});

test("completed ledger causes the next run to receive a new identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-run-ledger-complete-"));
  const path = join(dir, "run.json");
  const initial = await openRunLedger({
    path,
    projectId: "sample",
    taskLimit: 1,
    invocation: "run",
    runId: "run-1",
    invocationId: "invocation-1",
    now: () => new Date("2026-07-14T08:00:00.000Z"),
  });
  await completeRunLedger(path, initial, {
    now: () => new Date("2026-07-14T08:05:00.000Z"),
  });

  const next = await openRunLedger({
    path,
    projectId: "sample",
    taskLimit: 3,
    invocation: "run",
    runId: "run-2",
    invocationId: "invocation-2",
    now: () => new Date("2026-07-14T08:06:00.000Z"),
  });

  assert.equal(next.runId, "run-2");
  assert.equal(next.taskLimit, 3);
  assert.deepEqual(next.chargedTaskIds, []);
  assert.equal(next.status, "active");
});

test("completed ledger can retain a terminal cleanup failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-run-ledger-cleanup-failed-"));
  const path = join(dir, "run.json");
  const initial = await openRunLedger({
    path,
    projectId: "sample",
    taskLimit: 1,
    runId: "run-1",
    invocationId: "invocation-1",
  });
  const completed = await completeRunLedger(path, initial, {
    status: "cleanup_failed",
    cleanup: { observedCompletion: { resourceCleanup: { status: "failed" } } },
  });

  assert.equal(completed.status, "cleanup_failed");
  assert.equal(completed.cleanup.observedCompletion.resourceCleanup.status, "failed");
});

test("reopening within one controller invocation does not duplicate invocation history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-run-ledger-invocation-"));
  const path = join(dir, "run.json");
  await openRunLedger({
    path,
    projectId: "sample",
    taskLimit: 2,
    invocation: "run",
    runId: "run-1",
    invocationId: "invocation-1",
    now: () => new Date("2026-07-14T08:00:00.000Z"),
  });
  const reopened = await openRunLedger({
    path,
    projectId: "sample",
    taskLimit: 2,
    invocation: "run",
    runId: "run-1",
    invocationId: "invocation-1",
    now: () => new Date("2026-07-14T08:01:00.000Z"),
  });

  assert.deepEqual(reopened.invocations.map((item) => item.id), ["invocation-1"]);
});
