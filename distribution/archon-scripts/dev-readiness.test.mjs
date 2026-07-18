import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isExpectedServiceReachable } from "./dev-readiness.mjs";

test("an unrelated HTML listener does not satisfy worktree readiness", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "dark-factory-readiness-"));
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>unrelated</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const reachable = await isExpectedServiceReachable(`http://127.0.0.1:${port}/`, {
    role: "web",
    cwd,
    listenerOwnedByWorktree: async () => false,
  });

  assert.equal(reachable, false);
});

test("HTML from a listener owned by the current worktree is accepted", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "dark-factory-readiness-owned-"));
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>app</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const reachable = await isExpectedServiceReachable(`http://127.0.0.1:${port}/`, {
    role: "web",
    cwd,
    listenerOwnedByWorktree: async () => true,
  });

  assert.equal(reachable, true);
});
