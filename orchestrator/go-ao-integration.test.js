import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createAoTransport } from "./ao-command.js";
import { stopDarkFactory } from "./dark-factory.js";
import { normalizeProjectConfig, syncAoProjects } from "./dark-factory-project.js";
import { spawnAoIssues } from "./dark-factory-runner.js";

const execFileAsync = promisify(execFile);
const aoBinary = process.env.DARK_FACTORY_AO_E2E_BINARY;

function isolatedEnvironment(root, port) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !name.startsWith("AO_")
    && !["GITHUB_TOKEN", "GH_TOKEN", "GH_CONFIG_DIR"].includes(name)
  )));
  return {
    ...env,
    PATH: "/usr/bin:/bin",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GH_CONFIG_DIR: join(root, "gh-config"),
    TMUX_TMPDIR: join(root, "tmux"),
    AO_DATA_DIR: join(root, "ao-data"),
    AO_RUN_FILE: join(root, "running.json"),
    AO_PORT: String(port),
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const { port } = server.address();
  await new Promise((resolvePromise, reject) => server.close((error) => (
    error ? reject(error) : resolvePromise()
  )));
  return port;
}

async function waitFor(description, probe, { timeout = 10_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForExit(child, timeout = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("daemon did not exit")), timeout)),
  ]);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("Dark Factory drives a disposable real Go AO external worker", {
  skip: aoBinary ? false : "set DARK_FACTORY_AO_E2E_BINARY to a Go AO binary",
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dark-factory-go-ao-e2e-"));
  const projectPath = join(root, "project");
  const evidencePath = join(root, "worker-evidence.json");
  const workerPath = join(root, "external-worker.mjs");
  const projectId = "dark-factory-e2e";
  const issueId = "T001";
  const title = "Implement customer-facing account recovery 🔐";
  const prompt = "Verify the isolated Dark Factory Go AO transport";
  const port = await freePort();
  const env = isolatedEnvironment(root, port);
  let daemon;
  let transport;
  let sessionSpawned = false;
  let sessionId;
  let workspacePath;
  const workerPids = [];

  t.after(async () => {
    const errors = [];
    if (transport && sessionSpawned) {
      try {
        await transport.sessionKill(sessionId);
        await waitFor("terminated session", async () => (await transport.sessionGet(sessionId)).isTerminated);
        await waitFor("external worker exit", () => workerPids.every((pid) => !processExists(pid)));
        const cleanup = await transport.cleanup({ projectId, execute: true });
        assert.deepEqual(cleanup.skipped, []);
        assert.ok(cleanup.cleaned.includes(sessionId));
        if (workspacePath) await assert.rejects(access(workspacePath), { code: "ENOENT" });
      } catch (error) {
        errors.push(error);
      }
    }
    if (daemon) {
      try {
        await execFileAsync(resolve(aoBinary), ["stop", "--json"], { env });
        await waitForExit(daemon);
      } catch (error) {
        if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGTERM");
        try {
          await waitForExit(daemon);
        } catch (exitError) {
          errors.push(exitError);
        }
        errors.push(error);
      }
    }
    await rm(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "scoped Go AO E2E teardown failed");
  });

  await Promise.all([
    mkdir(projectPath, { recursive: true }),
    mkdir(env.HOME, { recursive: true }),
    mkdir(env.XDG_CONFIG_HOME, { recursive: true }),
    mkdir(env.GH_CONFIG_DIR, { recursive: true }),
    mkdir(env.TMUX_TMPDIR, { recursive: true, mode: 0o700 }),
  ]);
  await access(resolve(aoBinary), constants.X_OK);

  // The real Dark Factory Archon entrypoint requires Archon and third-party
  // services. This fixture keeps that boundary isolated behind AO's real
  // external harness while exercising Dark Factory's controller APIs.
  await writeFile(workerPath, `
import { readFile, writeFile } from "node:fs/promises";

let records = [];
try {
  records = JSON.parse(await readFile(process.env.E2E_EVIDENCE_PATH, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
records.push({
  pid: process.pid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    AO_SESSION_ID: process.env.AO_SESSION_ID,
    AO_PROJECT_ID: process.env.AO_PROJECT_ID,
    AO_ISSUE_ID: process.env.AO_ISSUE_ID,
    AO_DATA_DIR: process.env.AO_DATA_DIR,
    E2E_SENTINEL: process.env.E2E_SENTINEL,
  },
});
await writeFile(process.env.E2E_EVIDENCE_PATH, JSON.stringify(records));
setInterval(() => {}, 1_000);
`, "utf8");

  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: projectPath, env });
  await execFileAsync("git", ["config", "user.name", "Dark Factory E2E"], { cwd: projectPath, env });
  await execFileAsync("git", ["config", "user.email", "dark-factory-e2e@example.invalid"], { cwd: projectPath, env });
  await writeFile(join(projectPath, "README.md"), "# Disposable fixture\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: projectPath, env });
  await execFileAsync("git", ["commit", "-m", "test fixture"], { cwd: projectPath, env });

  const daemonOutput = [];
  daemon = spawn(resolve(aoBinary), ["daemon"], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout.on("data", (chunk) => daemonOutput.push(chunk));
  daemon.stderr.on("data", (chunk) => daemonOutput.push(chunk));

  transport = createAoTransport({
    aoCommand: resolve(aoBinary),
    env,
    runFilePath: env.AO_RUN_FILE,
    dataDir: env.AO_DATA_DIR,
  });
  const daemonStatus = await waitFor("Go AO daemon readiness", async () => {
    const status = await transport.status();
    return status.ready ? status : null;
  });
  assert.equal(daemonStatus.port, port, Buffer.concat(daemonOutput).toString("utf8"));

  const project = normalizeProjectConfig({
    id: projectId,
    name: "Dark Factory E2E",
    path: projectPath,
    defaultBranch: "main",
    runtimeEnv: {
      E2E_EVIDENCE_PATH: evidencePath,
      E2E_SENTINEL: "isolated",
    },
  });
  await transport.projectAdd({
    path: project.path,
    projectId,
    name: project.name,
  });
  const syncProject = (candidate = project) => syncAoProjects({
    project: candidate,
    transport,
    registryPath: join(root, "dark-factory", "projects.json"),
    workerPath,
    nodePath: process.execPath,
  });
  const sync = await syncProject();
  assert.deepEqual(sync.updated, [projectId]);
  const configured = await transport.projectGet(projectId);
  assert.equal(configured.config.worker.agent, "external");
  assert.deepEqual(configured.config.worker.agentConfig.command, [process.execPath, workerPath]);

  const driftPath = join(root, "path-drift");
  await mkdir(driftPath);
  await assert.rejects(
    () => syncProject({ ...project, path: driftPath }),
    /AO project dark-factory-e2e is registered at .*project.*requested repository is .*path-drift/i,
  );

  const spawnResult = await spawnAoIssues([{ id: issueId, title, prompt }], { project, transport });
  sessionId = spawnResult.spawned[0].sessionId;
  sessionSpawned = true;
  assert.equal(spawnResult.spawned[0].issueId, issueId);

  const initialEvidence = await waitFor("external worker start evidence", async () => {
    try {
      const records = JSON.parse(await readFile(evidencePath, "utf8"));
      return records.length === 1 ? records[0] : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
  const session = await transport.sessionGet(sessionId);
  workspacePath = session.workspacePath;
  const initialWorkspace = await realpath(workspacePath);
  const sessions = await transport.sessionList({ projectId, includeTerminated: true });

  workerPids.push(initialEvidence.pid);
  assert.deepEqual(initialEvidence.argv, ["start", "--prompt", prompt]);
  assert.equal(await realpath(initialEvidence.cwd), initialWorkspace);
  assert.deepEqual(initialEvidence.env, {
    AO_SESSION_ID: sessionId,
    AO_PROJECT_ID: projectId,
    AO_ISSUE_ID: issueId,
    AO_DATA_DIR: env.AO_DATA_DIR,
    E2E_SENTINEL: "isolated",
  });
  assert.equal(session.projectId, projectId);
  assert.equal(session.issueId, issueId);
  assert.equal(session.displayName, "Implement customer-f");
  assert.equal(Array.from(session.displayName).length, 20);
  assert.equal(session.isTerminated, false);
  assert.ok(session.status);
  assert.deepEqual(sessions.data.map((item) => item.id), [sessionId]);
  assert.equal((await stat(join(projectPath, ".git"))).isDirectory(), true);

  const observeSessions = async () => {
    const listed = await transport.sessionList({ projectId, includeTerminated: true });
    return {
      tasks: {},
      summary: { total: listed.data.length },
      sessions: listed.data.map((item) => ({
        ...item,
        observableStatus: item.isTerminated ? "failed" : "working",
      })),
    };
  };
  const stop = await stopDarkFactory({
    cwd: projectPath,
    project,
    dryRun: false,
    transport,
    registryPath: join(root, "dark-factory", "projects.json"),
    controlStatePath: join(root, "dark-factory", "control.json"),
    observabilityStatePath: join(root, "dark-factory", "observability.json"),
    statePath: join(root, "dark-factory", "runner.json"),
    eventLogPath: join(root, "dark-factory", "events.jsonl"),
    dashboardOutputPath: join(root, "dark-factory", "dashboard.html"),
    verifyPlanningFresh: async () => ({ ok: true }),
    writeAoConfig: ({ project: target }) => syncProject(target),
    runObserver: observeSessions,
    writeDashboard: async ({ outputPath }) => ({ outputPath }),
  });
  assert.deepEqual(stop.stopped.suspended, [sessionId]);
  assert.deepEqual(stop.stopped.preserved, [sessionId]);
  assert.deepEqual(stop.stopped.errors, []);
  const suspended = await waitFor("suspended session", async () => {
    const current = await transport.sessionGet(sessionId);
    return current.isTerminated ? current : null;
  });
  await waitFor("suspended external worker exit", () => !processExists(initialEvidence.pid));
  assert.equal(await realpath(suspended.workspacePath), initialWorkspace);
  assert.equal((await stat(workspacePath)).isDirectory(), true);

  const restored = await transport.sessionRestore(sessionId);
  assert.equal(restored.id, sessionId);
  assert.equal(restored.isTerminated, false);
  assert.equal(await realpath(restored.workspacePath), initialWorkspace);
  const restoreEvidence = await waitFor("external worker restore evidence", async () => {
    const records = JSON.parse(await readFile(evidencePath, "utf8"));
    return records.length === 2 ? records[1] : null;
  });
  workerPids.push(restoreEvidence.pid);
  assert.notEqual(restoreEvidence.pid, initialEvidence.pid);
  assert.equal(processExists(restoreEvidence.pid), true);
  assert.deepEqual(restoreEvidence.argv, ["restore"]);
  assert.equal(await realpath(restoreEvidence.cwd), initialWorkspace);
  assert.deepEqual(restoreEvidence.env, initialEvidence.env);
});
