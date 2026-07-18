import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  appendEvent,
  appendEventIfChanged,
  normalizeEvent,
  readEvents,
  summarizeEvents,
} from "./dark-factory-events.js";

test("appendEventIfChanged suppresses repeated task waiting state until a transition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-events-dedupe-"));
  const eventLogPath = join(dir, "events.jsonl");
  const waiting = {
    type: "task.waiting",
    projectId: "sample",
    taskId: "T001",
    sessionId: "sample-1",
    status: "waiting",
    metadata: { phase: "worker-prepare", recoveryAction: "resume_worker_session" },
  };

  const first = await appendEventIfChanged(waiting, { eventLogPath, idFactory: () => "evt-1" });
  const duplicate = await appendEventIfChanged(waiting, { eventLogPath, idFactory: () => "evt-2" });
  await appendEvent({ type: "task.resumed", projectId: "sample", taskId: "T001", status: "running" }, { eventLogPath });
  const afterTransition = await appendEventIfChanged(waiting, { eventLogPath, idFactory: () => "evt-3" });

  assert.equal(first.id, "evt-1");
  assert.equal(duplicate, null);
  assert.equal(afterTransition.id, "evt-3");
  assert.deepEqual((await readEvents({ eventLogPath })).map((event) => event.type), [
    "task.waiting",
    "task.resumed",
    "task.waiting",
  ]);
});

test("normalizeEvent fills identity fields and preserves metadata", () => {
  const metadata = { actor: "agent-1", attempt: 2 };
  const event = normalizeEvent(
    {
      type: " task.started ",
      projectId: " sample ",
      taskId: " t004 ",
      runId: 12,
      workflowRunId: " wf-9 ",
      nodeId: " node-a ",
      sessionId: " session-7 ",
      prNumber: 33,
      status: " running ",
      error: new Error("boom"),
      metadata,
    },
    {
      idFactory: () => "evt-1",
      now: () => new Date("2026-06-27T10:00:00.000Z"),
    },
  );

  assert.deepEqual(event, {
    version: 1,
    id: "evt-1",
    timestamp: "2026-06-27T10:00:00.000Z",
    type: "task.started",
    projectId: "sample",
    taskId: "t004",
    runId: "12",
    workflowRunId: "wf-9",
    nodeId: "node-a",
    sessionId: "session-7",
    prNumber: "33",
    status: "running",
    error: event.error,
    metadata,
  });
  assert.match(event.error, /boom/);
});

test("appendEvent writes JSONL and readEvents ignores blank lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-events-"));
  const eventLogPath = join(dir, "nested", "events.jsonl");

  const first = await appendEvent(
    { type: " task.started ", taskId: " T001 ", metadata: { source: "test" } },
    {
      eventLogPath,
      idFactory: () => "evt-1",
      now: () => new Date("2026-06-27T10:00:00.000Z"),
    },
  );
  const second = await appendEvent(
    { type: "task.finished", taskId: "T001", status: "done" },
    {
      eventLogPath,
      idFactory: () => "evt-2",
      now: () => new Date("2026-06-27T10:01:00.000Z"),
    },
  );

  assert.equal(first.id, "evt-1");
  assert.equal(second.id, "evt-2");

  const raw = await readFile(eventLogPath, "utf8");
  assert.match(raw, /evt-1/);
  assert.match(raw, /evt-2/);

  await appendFile(eventLogPath, "\n", "utf8");

  await appendEvent(
    { type: "task.ignored", taskId: "T999" },
    {
      eventLogPath,
      idFactory: () => "evt-3",
      now: () => new Date("2026-06-27T10:02:00.000Z"),
    },
  );

  await appendEvent(
    { type: "task.started", taskId: "T002" },
    {
      eventLogPath: join(dir, "other", "events.jsonl"),
      idFactory: () => "evt-4",
      now: () => new Date("2026-06-27T10:03:00.000Z"),
    },
  );

  const events = await readEvents({ eventLogPath });
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.id), ["evt-1", "evt-2", "evt-3"]);
});

test("readEvents returns an empty list when the log is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-events-missing-"));
  const eventLogPath = join(dir, "missing", "events.jsonl");

  const events = await readEvents({ eventLogPath });

  assert.deepEqual(events, []);
});

test("summarizeEvents counts types and keeps the latest event per task", () => {
  const events = [
    { type: "task.started", taskId: "T001", timestamp: "2026-06-27T10:00:00.000Z" },
    { type: "task.started", taskId: "T002", timestamp: "2026-06-27T10:01:00.000Z" },
    { type: "task.finished", taskId: "T001", timestamp: "2026-06-27T10:02:00.000Z" },
    { type: "task.finished", taskId: "T001", timestamp: "2026-06-27T10:02:00.000Z", status: "done" },
    { type: "task.failed", timestamp: "2026-06-27T10:03:00.000Z" },
  ];

  const summary = summarizeEvents(events);

  assert.deepEqual(summary, {
    total: 5,
    byType: {
      "task.started": 2,
      "task.finished": 2,
      "task.failed": 1,
    },
    latestByTask: {
      T001: events[3],
      T002: events[1],
    },
  });
});
