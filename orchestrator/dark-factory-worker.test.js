import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workerUrl = new URL("./dark-factory-worker.js", import.meta.url);

async function loadWorker() {
  try {
    return await import(`${workerUrl.href}?test=${Date.now()}-${Math.random()}`);
  } catch (error) {
    assert.fail(`worker entrypoint should load: ${error.message}`);
  }
}

function workerEnv(overrides = {}) {
  return {
    AO_SESSION_ID: "sample-7",
    AO_PROJECT_ID: "sample",
    AO_ISSUE_ID: "T007",
    HOME: "/home/tester",
    ...overrides,
  };
}

test("buildWorkerCommand passes the literal AO prompt into existing Archon policy", async () => {
  const { buildWorkerCommand } = await loadWorker();

  const prompt = "Fix $(touch /tmp/unsafe) and preserve 'quotes'\nsecond line";

  const command = buildWorkerCommand("start", workerEnv(), { prompt });

  assert.match(command, /workflow_name='auto-feature'/);
  assert.match(command, /archon workflow run "\$workflow_name" --no-worktree --json "\$workflow_message"/);
  assert.match(command, /auto-merge\/scripts\/auto-merge\.mjs" --mode prepare/);
  assert.match(command, /dark_factory_project_id='sample'/);
  assert.match(command, /dark_factory_session_id='sample-7'/);
  assert.match(command, /dark_factory_issue_id='T007'/);
  assert.doesNotMatch(command, /\bao report\b/);
  assert.doesNotMatch(command, /Dark Factory restore mode:/);
  assert.match(command, /AO prompt:/);
  assert.match(command, /Fix \$\(touch \/tmp\/unsafe\) and preserve/);
  assert.match(command, /second line/);
});

test("buildWorkerCommand selects the existing Archon restore policy", async () => {
  const { buildWorkerCommand } = await loadWorker();

  const command = buildWorkerCommand("restore", workerEnv());

  assert.match(command, /Dark Factory restore mode:/);
  assert.match(command, /archon workflow resume "\$dark_factory_archon_run_id" --json/);
  assert.match(command, /Continue from the current branch, index, commits, PR state, and local workflow state/);
});

test("runWorker rejects unsupported modes and missing AO identity", async () => {
  const { runWorker } = await loadWorker();

  await assert.rejects(() => runWorker(["restart"], { env: workerEnv() }), /Expected start or restore/);
  await assert.rejects(() => runWorker(["restore", "--prompt", "nope"], { env: workerEnv() }), /--prompt is only valid with start/);
  await assert.rejects(() => runWorker(["start", "--prompt"], { env: workerEnv() }), /--prompt requires a value/);
  await assert.rejects(
    () => runWorker(["start"], { env: workerEnv({ AO_ISSUE_ID: "" }) }),
    /Missing required environment variable: AO_ISSUE_ID/,
  );
});

test("runWorker loads generic Archon settings from the Dark Factory registry", async () => {
  const { runWorker } = await loadWorker();
  const root = await mkdtemp(join(tmpdir(), "dark-factory-worker-"));
  const registryPath = join(root, "projects.json");
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: {
      sample: {
        agentConfig: {
          archonWorkflow: "custom-flow",
          archonInstruction: "Follow the custom instruction.",
          runtimeEnv: { API_URL: "http://127.0.0.1:${apiPort}" },
        },
      },
    },
  }));

  let launchedCommand = "";
  try {
    await runWorker(["start", "--prompt", "literal $(not-shell)"], {
      env: workerEnv({ DARK_FACTORY_REGISTRY_PATH: registryPath }),
      runCommand: async (command) => {
        launchedCommand = command;
        return 0;
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.match(launchedCommand, /workflow_name='custom-flow'/);
  assert.match(launchedCommand, /Follow the custom instruction\./);
  assert.match(launchedCommand, /export API_URL="http:\/\/127\.0\.0\.1:\$\{dark_factory_api_port\}"/);
  assert.match(launchedCommand, /AO prompt:/);
  assert.match(launchedCommand, /literal \$\(not-shell\)/);
});

test("runWorker executes the policy in the current AO worktree", async () => {
  const { runWorker } = await loadWorker();
  const calls = [];
  const env = workerEnv({ CUSTOM_VALUE: "kept" });

  const result = await runWorker(["start"], {
    cwd: "/tmp/ao-worker",
    env,
    runCommand: async (command, options) => {
      calls.push({ command, options });
      return 23;
    },
    reportActivity: async (event) => {
      calls.push({ event });
    },
  });

  assert.equal(result, 23);
  assert.deepEqual(calls.map((call) => call.event ?? "command"), ["session-start", "command", "session-end"]);
  assert.equal(calls[1].options.cwd, "/tmp/ao-worker");
  assert.equal(calls[1].options.env, env);
  assert.match(calls[1].command, /workflow_name='auto-feature'/);
});

test("runWorker reports session end when the external command fails", async () => {
  const { runWorker } = await loadWorker();
  const events = [];

  await assert.rejects(() => runWorker(["start"], {
    env: workerEnv(),
    runCommand: async () => {
      throw new Error("worker failed");
    },
    reportActivity: async (event) => {
      events.push(event);
    },
  }), /worker failed/);

  assert.deepEqual(events, ["session-start", "session-end"]);
});

test("reportAoActivity sends external lifecycle events through the installed AO CLI", async () => {
  const { reportAoActivity } = await loadWorker();
  const calls = [];

  const reported = await reportAoActivity("session-start", {
    cwd: "/tmp/ao-worker",
    env: workerEnv({ DARK_FACTORY_AO_BINARY: "/opt/ao" }),
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  assert.equal(reported, true);
  assert.equal(calls[0].command, "/opt/ao");
  assert.deepEqual(calls[0].args, ["hooks", "external", "session-start"]);
  assert.equal(calls[0].options.cwd, "/tmp/ao-worker");
  assert.equal(calls[0].options.env.AO_SESSION_ID, "sample-7");
});

test("resolvePosixShell uses an explicit override before platform defaults", async () => {
  const { resolvePosixShell } = await loadWorker();

  assert.equal(resolvePosixShell({
    env: { DARK_FACTORY_POSIX_SHELL: "/opt/tools/bash" },
    platform: "win32",
    pathExists: () => false,
  }), "/opt/tools/bash");
});

test("resolvePosixShell uses the safe Unix default", async () => {
  const { resolvePosixShell } = await loadWorker();

  assert.equal(resolvePosixShell({ env: {}, platform: "linux" }), "/bin/sh");
  assert.equal(resolvePosixShell({ env: {}, platform: "darwin" }), "/bin/sh");
});

test("resolvePosixShell discovers Bash on Windows PATH", async () => {
  const { resolvePosixShell } = await loadWorker();
  const checked = [];

  const shell = resolvePosixShell({
    env: { PATH: "C:\\Tools;C:\\Program Files\\Git\\bin" },
    platform: "win32",
    pathExists: (path) => {
      checked.push(path);
      return path === "C:\\Program Files\\Git\\bin\\bash.exe";
    },
  });

  assert.equal(shell, "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.deepEqual(checked, [
    "C:\\Tools\\bash.exe",
    "C:\\Tools\\bash",
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ]);
});

test("resolvePosixShell discovers a standard Git Bash installation on Windows", async () => {
  const { resolvePosixShell } = await loadWorker();

  assert.equal(resolvePosixShell({
    env: { ProgramFiles: "C:\\Program Files" },
    platform: "win32",
    pathExists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
  }), "C:\\Program Files\\Git\\bin\\bash.exe");
});

test("runExternalCommand launches the command through explicit POSIX shell argv", async () => {
  const { runExternalCommand } = await loadWorker();
  const child = new EventEmitter();
  const calls = [];
  const command = "printf '%s' \"hello world\"";

  const resultPromise = runExternalCommand(command, {
    cwd: "/tmp/ao worker",
    env: { CUSTOM_VALUE: "kept", DARK_FACTORY_POSIX_SHELL: "/opt/bin/bash" },
    spawnProcess: (file, args, options) => {
      calls.push({ file, args, options });
      return child;
    },
  });
  child.emit("exit", 23, null);

  assert.equal(await resultPromise, 23);
  assert.deepEqual(calls, [{
    file: "/opt/bin/bash",
    args: ["-c", command],
    options: {
      cwd: "/tmp/ao worker",
      env: { CUSTOM_VALUE: "kept", DARK_FACTORY_POSIX_SHELL: "/opt/bin/bash" },
      shell: false,
      stdio: "inherit",
    },
  }]);
});

test("runExternalCommand fails before spawn when Windows has no POSIX shell", async () => {
  const { runExternalCommand } = await loadWorker();
  let spawned = false;

  await assert.rejects(() => runExternalCommand("archon workflow run", {
    env: {},
    platform: "win32",
    pathExists: () => false,
    spawnProcess: () => {
      spawned = true;
      return new EventEmitter();
    },
  }), /POSIX shell is required.*Git Bash.*DARK_FACTORY_POSIX_SHELL/i);

  assert.equal(spawned, false);
});

test("runExternalCommand preserves child termination signals", async () => {
  const { runExternalCommand } = await loadWorker();
  const child = new EventEmitter();

  const resultPromise = runExternalCommand("archon workflow run", {
    spawnProcess: () => child,
  });
  child.emit("exit", null, "SIGTERM");

  await assert.rejects(resultPromise, (error) => {
    assert.equal(error.signal, "SIGTERM");
    return true;
  });
});

test("runWorker always executes restore when a matching ready artifact exists", async () => {
  const { runWorker } = await loadWorker();
  const root = await mkdtemp(join(tmpdir(), "dark-factory-worker-"));
  const readyDir = join(root, "projects", "sample", "sessions");
  const readyPath = join(readyDir, "sample-7.ready.json");
  await mkdir(readyDir, { recursive: true });
  await writeFile(readyPath, `${JSON.stringify({
    version: 1,
    projectId: "sample",
    sessionId: "sample-7",
    issueId: "T007",
  })}\n`);

  let launched = false;
  try {
    const result = await runWorker(["restore"], {
      cwd: root,
      env: workerEnv({ AGENT_ORCHESTRATOR_HOME: root }),
      runCommand: async () => {
        launched = true;
        return 0;
      },
    });

    assert.equal(result, 0);
    assert.equal(launched, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker file is a directly executable Node entrypoint", async () => {
  const sourceUrl = pathToFileURL(workerUrl.pathname);
  assert.equal(sourceUrl.protocol, "file:");
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(workerUrl, "utf8"));
  assert.match(source, /^#!\/usr\/bin\/env node\n/);
});
