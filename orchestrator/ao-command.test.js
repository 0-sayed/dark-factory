import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAoInvocation,
  createAoTransport,
  extractJsonObject,
  runAo,
} from "./ao-command.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transportFixture({ cli = {}, routes = {}, pathExists = async () => true } = {}) {
  const calls = [];
  const execFileAsync = async (file, args, options) => {
    calls.push({ type: "cli", file, args, options });
    const key = args.join(" ");
    const result = cli[key];
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error(`unexpected CLI call: ${key}`);
    return { stdout: typeof result === "string" ? result : JSON.stringify(result), stderr: "" };
  };
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method ?? "GET";
    const key = `${method} ${parsed.pathname}${parsed.search}`;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ type: "http", key, body });
    const result = routes[key];
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error(`unexpected HTTP call: ${key}`);
    return jsonResponse(result.body ?? result, result.status ?? 200);
  };

  return {
    calls,
    transport: createAoTransport({
      aoCommand: "/tmp/ao",
      env: {
        AO_DATA_DIR: "/tmp/ao-data",
        AO_RUN_FILE: "/tmp/running.json",
      },
      execFileAsync,
      fetch,
      pathExists,
      readFile: async () => JSON.stringify({ pid: 42, port: 4317 }),
    }),
  };
}

test("status normalizes Go AO readiness JSON", async () => {
  const { transport, calls } = transportFixture({
    cli: {
      "status --json": { state: "ready", pid: 42, port: 4317, health: "ok", ready: "ready" },
    },
  });

  assert.deepEqual(await transport.status(), {
    available: true,
    ready: true,
    state: "ready",
    pid: 42,
    port: 4317,
    error: null,
  });
  assert.deepEqual(calls[0].args, ["status", "--json"]);
});

test("project get, add, and set-config return normalized projects", async () => {
  const project = { id: "demo", name: "Demo", path: "/repo/demo", defaultBranch: "main" };
  const { transport, calls } = transportFixture({
    cli: {
      "project get demo --json": { status: "ok", project },
      "project set-config demo --config-json {\"worker\":{\"agent\":\"external\"}} --json": {
        project: { ...project, config: { worker: { agent: "external" } } },
      },
    },
    routes: {
      "POST /api/v1/projects": { project },
    },
  });

  assert.deepEqual(await transport.projectGet("demo"), project);
  assert.deepEqual(await transport.projectAdd({ path: "/repo/demo", projectId: "demo", name: "Demo" }), project);
  assert.equal((await transport.projectSetConfig("demo", { worker: { agent: "external" } })).config.worker.agent, "external");
  assert.deepEqual(calls[1].body, { path: "/repo/demo", projectId: "demo", name: "Demo" });
});

test("project get preserves Go AO domain error codes from CLI stderr", async () => {
  const missing = Object.assign(new Error("Command failed"), {
    code: 1,
    stderr: "Unknown project (PROJECT_NOT_FOUND) [request test/request-1]",
  });
  const { transport } = transportFixture({
    cli: {
      "project get missing --json": missing,
    },
  });

  await assert.rejects(
    () => transport.projectGet("missing"),
    (error) => error.code === "PROJECT_NOT_FOUND",
  );
});

test("spawn requires and sends an explicit session id", async () => {
  const { transport, calls } = transportFixture({
    routes: {
      "POST /api/v1/sessions": {
        session: { id: "demo-t001", projectId: "demo", issueId: "T001", kind: "worker", status: "working" },
      },
    },
  });

  await assert.rejects(() => transport.spawn({ projectId: "demo", issueId: "T001" }), /explicit session id/i);
  const result = await transport.spawn({
    projectId: "demo",
    issueId: "T001",
    sessionId: "demo-t001",
    harness: "external",
  });

  assert.equal(result.id, "demo-t001");
  assert.deepEqual(calls[0].body, {
    projectId: "demo",
    issueId: "T001",
    sessionId: "demo-t001",
    harness: "external",
  });
});

test("session list normalizes Go fields for Dark Factory", async () => {
  const { transport } = transportFixture({
    routes: {
      "GET /api/v1/sessions?project=demo": {
        sessions: [{
          id: "demo-t001",
          projectId: "demo",
          issueId: "T001",
          kind: "worker",
          branch: "ao/demo-t001/root",
          workspacePath: "/persisted/worktrees/demo/demo-t001",
          status: "pr_open",
          isTerminated: false,
          activity: { state: "active", lastActivityAt: "2026-07-13T10:00:00Z" },
          prs: [{ url: "https://github.test/acme/demo/pull/1", number: 1, state: "open" }],
          createdAt: "2026-07-13T09:00:00Z",
          updatedAt: "2026-07-13T10:00:00Z",
        }],
      },
    },
  });

  const result = await transport.sessionList({ projectId: "demo", includeTerminated: true });
  assert.deepEqual(result.meta, { hiddenTerminatedCount: 0 });
  assert.deepEqual(result.data[0], {
    id: "demo-t001",
    projectId: "demo",
    projectName: "demo",
    role: "worker",
    kind: "worker",
    branch: "ao/demo-t001/root",
    status: "pr_open",
    issueId: "T001",
    pr: { url: "https://github.test/acme/demo/pull/1", number: 1, state: "open" },
    prs: [{ url: "https://github.test/acme/demo/pull/1", number: 1, state: "open" }],
    workspacePath: "/persisted/worktrees/demo/demo-t001",
    lastActivityAt: "2026-07-13T10:00:00.000Z",
    createdAt: "2026-07-13T09:00:00Z",
    updatedAt: "2026-07-13T10:00:00Z",
    isTerminated: false,
    activity: { state: "active", lastActivityAt: "2026-07-13T10:00:00Z" },
  });
});

test("session list reports hidden terminated workers", async () => {
  const { transport } = transportFixture({
    routes: {
      "GET /api/v1/sessions?active=true&project=demo": {
        sessions: [{ id: "demo-live", projectId: "demo", kind: "worker", status: "working" }],
      },
      "GET /api/v1/sessions?active=false&project=demo": {
        sessions: [
          { id: "demo-old", projectId: "demo", kind: "worker", status: "terminated", isTerminated: true },
          { id: "demo-orchestrator", projectId: "demo", kind: "orchestrator", status: "terminated", isTerminated: true },
        ],
      },
    },
  });

  const result = await transport.sessionList({ projectId: "demo", includeTerminated: false });
  assert.deepEqual(result.data.map((session) => session.id), ["demo-live"]);
  assert.deepEqual(result.meta, { hiddenTerminatedCount: 1 });
});

test("session get, suspend, restore, and kill use daemon lifecycle endpoints", async () => {
  const session = { id: "demo-t001", projectId: "demo", kind: "worker", status: "terminated", isTerminated: true };
  const { transport, calls } = transportFixture({
    routes: {
      "GET /api/v1/sessions/demo-t001": { session },
      "POST /api/v1/sessions/demo-t001/suspend": { sessionId: "demo-t001", suspended: true, preserved: true },
      "POST /api/v1/sessions/demo-t001/restore": { sessionId: "demo-t001", session: { ...session, status: "working", isTerminated: false } },
      "POST /api/v1/sessions/demo-t001/kill": { sessionId: "demo-t001", freed: true },
    },
  });

  assert.equal((await transport.sessionGet("demo-t001")).id, "demo-t001");
  assert.deepEqual(await transport.sessionSuspend("demo-t001"), {
    sessionId: "demo-t001",
    suspended: true,
    preserved: true,
  });
  assert.equal((await transport.sessionRestore("demo-t001")).status, "working");
  assert.deepEqual(await transport.sessionKill("demo-t001"), { sessionId: "demo-t001", freed: true });
  assert.deepEqual(calls.filter((call) => call.type === "http").map((call) => call.key), [
    "GET /api/v1/sessions/demo-t001",
    "POST /api/v1/sessions/demo-t001/suspend",
    "POST /api/v1/sessions/demo-t001/restore",
    "POST /api/v1/sessions/demo-t001/kill",
  ]);
});

test("daemon errors preserve typed status and code", async () => {
  const { transport } = transportFixture({
    routes: {
      "POST /api/v1/sessions/demo-t001/restore": {
        status: 409,
        body: {
          error: "conflict",
          code: "SESSION_NOT_RESTORABLE",
          message: "Session is not restorable",
        },
      },
    },
  });

  await assert.rejects(
    () => transport.sessionRestore("demo-t001"),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "SESSION_NOT_RESTORABLE");
      assert.match(error.message, /Session is not restorable/);
      return true;
    },
  );
});

test("cleanup previews terminated sessions and executes only when requested", async () => {
  const { transport, calls } = transportFixture({
    routes: {
      "GET /api/v1/sessions?active=false&project=demo": {
        sessions: [{ id: "demo-old", projectId: "demo", kind: "worker", status: "terminated", isTerminated: true }],
      },
      "POST /api/v1/sessions/cleanup?project=demo&session=demo-old": {
        ok: true,
        cleaned: ["demo-old"],
        skipped: [],
      },
    },
  });

  assert.deepEqual(await transport.cleanup({ projectId: "demo", execute: false }), {
    execute: false,
    projectId: "demo",
    candidates: ["demo-old"],
  });
  assert.deepEqual(await transport.cleanup({
    projectId: "demo",
    execute: true,
    sessionIds: ["demo-old"],
  }), {
    execute: true,
    projectId: "demo",
    cleaned: ["demo-old"],
    skipped: [],
  });
  assert.equal(calls.filter((call) => call.key?.startsWith("POST")).length, 1);
});

test("PR claim uses the structured daemon endpoint", async () => {
  const { transport, calls } = transportFixture({
    routes: {
      "POST /api/v1/sessions/demo-t001/pr/claim": {
        ok: true,
        sessionId: "demo-t001",
        prs: [{ url: "https://github.test/acme/demo/pull/1", number: 1 }],
        branchChanged: true,
        takenOverFrom: [],
      },
    },
  });

  const result = await transport.claimPr({ sessionId: "demo-t001", pr: "1", allowTakeover: false });
  assert.equal(result.prs[0].number, 1);
  assert.deepEqual(calls[0].body, { pr: "1", allowTakeover: false });
});

test("daemon HTTP failure is clear and never invokes desktop start", async () => {
  const calls = [];
  const transport = createAoTransport({
    aoCommand: "/tmp/ao",
    execFileAsync: async (_file, args) => {
      calls.push(args);
      throw new Error("should not execute CLI");
    },
    readFile: async () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });

  await assert.rejects(() => transport.sessionList(), /AO daemon is not running/);
  assert.deepEqual(calls, []);
});

test("runAo translates legacy spawn and cleanup flags to Go AO", async () => {
  const calls = [];
  const execFileAsync = async (file, args) => {
    calls.push({ file, args });
    return { stdout: "ok", stderr: "" };
  };

  await runAo(["spawn", "demo/T001", "--session-id", "demo-t001"], {
    aoCommand: "/tmp/ao",
    execFileAsync,
  });
  await runAo(["session", "cleanup", "--project", "demo", "--dry-run"], {
    aoCommand: "/tmp/ao",
    execFileAsync,
  });
  await runAo(["session", "cleanup", "--project", "demo"], {
    aoCommand: "/tmp/ao",
    execFileAsync,
  });

  assert.deepEqual(calls.map((call) => call.args), [
    ["spawn", "--project", "demo", "--issue", "T001", "--session-id", "demo-t001", "--harness", "external"],
    ["session", "ls", "--project", "demo", "--include-terminated", "--json"],
    ["session", "cleanup", "--project", "demo", "--yes"],
  ]);
});

test("command parsing and noisy JSON extraction remain compatible", () => {
  assert.deepEqual(buildAoInvocation("node '/tmp/ao cli.js'", ["status"]), {
    file: "node",
    args: ["/tmp/ao cli.js", "status"],
  });
  assert.deepEqual(extractJsonObject("log\n{\"state\":\"ready\"}\n"), { state: "ready" });
});
