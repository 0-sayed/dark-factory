import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readRuntimeDescriptor,
  resolveRuntimeContext,
  writeRuntimeDescriptor,
} from "./runtime-context.mjs";

test("restore reuses a persisted runtime pair owned by the same worktree", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dark-factory-runtime-"));
  await writeRuntimeDescriptor({
    cwd,
    projectId: "sample",
    sessionId: "sample-2",
    issueId: "T002",
    apiPort: "53648",
    webPort: "53649",
  });

  const result = await resolveRuntimeContext({
    cwd,
    projectId: "sample",
    sessionId: "sample-2",
    issueId: "T002",
    initialApiPort: "41000",
    restore: true,
    isPortAvailable: async () => false,
    isPortOwnedByWorktree: async () => true,
  });

  assert.equal(result.apiPort, "53648");
  assert.equal(result.webPort, "53649");
  assert.equal(result.source, "persisted");
});

test("restore reuses an owned deterministic pair when upgrading without a descriptor", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dark-factory-runtime-upgrade-"));
  const result = await resolveRuntimeContext({
    cwd,
    projectId: "sample",
    sessionId: "sample-2",
    issueId: "T002",
    initialApiPort: "53648",
    restore: true,
    isPortAvailable: async () => false,
    isPortOwnedByWorktree: async () => true,
  });

  assert.equal(result.apiPort, "53648");
  assert.equal(result.webPort, "53649");
  assert.equal(result.source, "initial-owned");
});

test("stale runtime ports advance to the next free pair and are persisted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dark-factory-runtime-stale-"));
  await writeRuntimeDescriptor({
    cwd,
    projectId: "sample",
    sessionId: "sample-2",
    issueId: "T002",
    apiPort: "42000",
    webPort: "42001",
  });

  const result = await resolveRuntimeContext({
    cwd,
    projectId: "sample",
    sessionId: "sample-2",
    issueId: "T002",
    initialApiPort: "42000",
    restore: true,
    isPortAvailable: async (port) => Number(port) >= 42002,
    isPortOwnedByWorktree: async () => false,
  });
  await writeRuntimeDescriptor(result);

  assert.equal(result.apiPort, "42002");
  assert.equal(result.webPort, "42003");
  assert.equal(result.source, "allocated");
  assert.deepEqual(
    await readRuntimeDescriptor({ cwd, projectId: "sample", sessionId: "sample-2", issueId: "T002" }),
    JSON.parse(await readFile(join(cwd, ".archon/state/dark-factory-runtime.json"), "utf8")),
  );
});
