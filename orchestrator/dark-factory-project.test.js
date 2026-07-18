import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  DEFAULT_PROJECT_CONFIG_PATH,
  DEFAULT_REGISTRY_PATH,
  buildAoProjectConfig,
  buildAoConfigYaml,
  getProjectRuntimePaths,
  loadProjectConfig,
  loadProjectRegistry,
  normalizeProjectConfig,
  parseGitHubRepoFromRemoteUrl,
  registerProject,
  writeAoConfig,
} from "./dark-factory-project.js";

test("default project config path is a local dark-factory config", () => {
  assert.equal(DEFAULT_PROJECT_CONFIG_PATH, "dark-factory.yaml");
});

test("default registry path is local runtime state", () => {
  assert.equal(DEFAULT_REGISTRY_PATH, ".dark-factory/projects.json");
});

test("buildAoProjectConfig keeps only generic Go AO settings and an external worker command", () => {
  const config = buildAoProjectConfig(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
    defaultBranch: "develop",
    sessionPrefix: "api-worker",
    symlinks: [".env"],
    postCreate: ["pnpm install --offline"],
    runtimeEnv: { NODE_ENV: "test" },
    cleanupCommands: ["docker compose down"],
    archonWorkflow: "auto-feature",
  }), {
    workerPath: "/factory/orchestrator/dark-factory-worker.js",
    registryPath: "/factory/.dark-factory/projects.json",
    nodePath: "/usr/bin/node",
  });

  assert.deepEqual(config, {
    defaultBranch: "develop",
    sessionPrefix: "api-worker",
    env: {
      DARK_FACTORY_REGISTRY_PATH: "/factory/.dark-factory/projects.json",
      DARK_FACTORY_COMPAT_STATE_PATH: "/factory/.dark-factory/compat/agent-orchestrator",
      AGENT_ORCHESTRATOR_HOME: "/factory/.dark-factory/compat/agent-orchestrator",
      NODE_ENV: "test",
    },
    symlinks: [".env"],
    postCreate: ["pnpm install --offline"],
    worker: {
      agent: "external",
      agentConfig: {
        command: ["/usr/bin/node", "/factory/orchestrator/dark-factory-worker.js"],
      },
    },
  });
  assert.equal(config.tracker, undefined);
  assert.equal(config.cleanup, undefined);
  assert.equal(config.agentConfig, undefined);
});

test("writeAoConfig idempotently registers and updates projects through AO transport", async () => {
  const calls = [];
  const project = normalizeProjectConfig({ id: "api", name: "API", path: "/workspace/api" });
  const transport = {
    projectGet: async (id) => {
      calls.push(["get", id]);
      throw Object.assign(new Error("project not found"), { code: "PROJECT_NOT_FOUND" });
    },
    projectAdd: async (input) => {
      calls.push(["add", input]);
      return { id: input.projectId };
    },
    projectSetConfig: async (id, config) => {
      calls.push(["config", id, config]);
      return { id, config };
    },
  };

  const result = await writeAoConfig({
    project,
    registryPath: "/factory/.dark-factory/projects.json",
    workerPath: "/factory/orchestrator/dark-factory-worker.js",
    nodePath: "/usr/bin/node",
    transport,
  });

  assert.deepEqual(calls.slice(0, 2), [
    ["get", "api"],
    ["add", { path: "/workspace/api", projectId: "api", name: "API" }],
  ]);
  assert.deepEqual(calls[2].slice(0, 2), ["config", "api"]);
  assert.equal(calls[2][2].worker.agent, "external");
  assert.deepEqual(result.registered, ["api"]);
  assert.deepEqual(result.updated, ["api"]);
  assert.equal(result.outputPath, undefined);
});

test("registerProject creates a durable registry entry from a planning folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-registry-"));
  const planningPath = join(dir, "api", "planning");
  const registryPath = join(dir, ".dark-factory", "projects.json");
  await mkdir(join(planningPath, "roadmap"), { recursive: true });
  await writeFile(join(planningPath, "roadmap", "tasks.md"), "# Tasks\n", "utf8");

  const result = await registerProject({
    registryPath,
    projectId: "api",
    name: "API",
    planningPath,
    archonWorkflow: "archon-global",
  });

  const registry = await loadProjectRegistry(registryPath);
  assert.equal(result.project.id, "api");
  assert.equal(result.project.path, join(dir, "api"));
  assert.equal(result.project.tracker.tasksPath, "planning/roadmap/tasks.md");
  assert.deepEqual(Object.keys(registry.projects), ["api"]);
  assert.equal(registry.projects.api.agentConfig.archonWorkflow, "archon-global");
});

test("registerProject rejects local registry path drift without overwriting the existing project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-registry-drift-"));
  const registryPath = join(dir, ".dark-factory", "projects.json");
  const oldPlanningPath = join(dir, "old-api", "planning");
  const newPlanningPath = join(dir, "new-api", "planning");
  for (const planningPath of [oldPlanningPath, newPlanningPath]) {
    await mkdir(join(planningPath, "roadmap"), { recursive: true });
    await writeFile(join(planningPath, "roadmap", "tasks.md"), "# Tasks\n", "utf8");
  }

  await registerProject({ registryPath, projectId: "api", planningPath: oldPlanningPath });
  await assert.rejects(
    () => registerProject({ registryPath, projectId: "api", planningPath: newPlanningPath }),
    /Dark Factory project api is registered at .*old-api.*requested repository is .*new-api/i,
  );

  const registry = await loadProjectRegistry(registryPath);
  assert.equal(registry.projects.api.path, join(dir, "old-api"));
});

test("parseGitHubRepoFromRemoteUrl supports common GitHub remote formats", () => {
  assert.equal(parseGitHubRepoFromRemoteUrl("https://github.com/owner/sample-app.git"), "owner/sample-app");
  assert.equal(parseGitHubRepoFromRemoteUrl("git@github.com:owner/sample-app.git"), "owner/sample-app");
  assert.equal(parseGitHubRepoFromRemoteUrl("ssh://git@github.com/owner/sample-app.git"), "owner/sample-app");
  assert.equal(parseGitHubRepoFromRemoteUrl("https://gitlab.com/owner/sample-app.git"), "");
});

test("registerProject infers GitHub repo from the target project origin remote", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-registry-git-"));
  const projectPath = join(dir, "api");
  const planningPath = join(projectPath, "planning");
  const registryPath = join(dir, ".dark-factory", "projects.json");
  await mkdir(join(planningPath, "roadmap"), { recursive: true });
  await writeFile(join(planningPath, "roadmap", "tasks.md"), "# Tasks\n", "utf8");
  execFileSync("git", ["init"], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:owner/api.git"], {
    cwd: projectPath,
    stdio: "ignore",
  });

  await registerProject({
    registryPath,
    projectId: "api",
    planningPath,
  });

  const registry = await loadProjectRegistry(registryPath);
  assert.equal(registry.projects.api.repo, "owner/api");
  assert.match(buildAoConfigYaml(registry.projects.api), /repo: owner\/api/);
});

test("registerProject persists a configured AO command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-registry-"));
  const planningPath = join(dir, "api", "planning");
  const registryPath = join(dir, ".dark-factory", "projects.json");
  await mkdir(join(planningPath, "roadmap"), { recursive: true });
  await writeFile(join(planningPath, "roadmap", "tasks.md"), "# Tasks\n", "utf8");

  await registerProject({
    registryPath,
    projectId: "api",
    planningPath,
    aoCommand: "node ../agent-orchestrator/packages/ao/bin/ao.js",
    baseDir: join(dir, "factory"),
  });

  const registry = await loadProjectRegistry(registryPath);
  assert.equal(
    registry.projects.api.agentConfig.aoCommand,
    `node ${join(dir, "agent-orchestrator", "packages", "ao", "bin", "ao.js")}`,
  );
});

test("loadProjectConfig reads a reusable project yaml file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-project-"));
  const path = join(dir, "sample.yaml");
  await writeFile(path, [
    "id: sample",
    "name: Sample App",
    "path: /tmp/sample-app",
    "repo: owner/sample-app",
    "defaultBranch: main",
    "tasksPath: planning/tasks.md",
    "workerPlugin: archon",
    "envFiles: .env.example -> .env",
    "cleanupCommands: |",
    "  pnpm wtc down --volumes",
    "  pnpm store prune",
    "runtimeEnv: |",
    "  VITE_API_URL=http://127.0.0.1:${apiPort}",
    "aoCommand: node /tmp/agent-orchestrator/packages/ao/bin/ao.js",
    "archonWorkflow: archon-global",
    "archonInstruction: |",
    "  Run the global Archon workflow for the selected task.",
    "  Stop after merge.",
    "",
  ].join("\n"));

  const project = await loadProjectConfig(path);

  assert.deepEqual(project, {
    id: "sample",
    name: "Sample App",
    path: "/tmp/sample-app",
    repo: "owner/sample-app",
    defaultBranch: "main",
    sessionPrefix: "sample",
    runtime: "process",
    workerPlugin: "archon",
    workspace: "worktree",
    envFiles: [
      {
        from: ".env.example",
        to: ".env",
        mode: "copy-if-missing",
      },
    ],
    cleanup: {
      commands: [
        "pnpm wtc down --volumes",
        "pnpm store prune",
      ],
    },
    tracker: {
      path: "./ao-plugins/tasks-md-tracker",
      tasksPath: "planning/tasks.md",
    },
    agentConfig: {
      archonWorkflow: "archon-global",
      aoCommand: "node /tmp/agent-orchestrator/packages/ao/bin/ao.js",
      archonInstruction: "Run the global Archon workflow for the selected task.\nStop after merge.",
      runtimeEnv: {
        VITE_API_URL: "http://127.0.0.1:${apiPort}",
      },
    },
  });
});

test("loadProjectConfig can point only at a planning folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-planning-config-"));
  const configPath = join(dir, "factory.yaml");
  await writeFile(configPath, [
    "planningPath: ./sample-app/planning",
    "archonWorkflow: archon-global",
    "",
  ].join("\n"));

  const project = await loadProjectConfig(configPath);

  assert.equal(project.id, "sample-app");
  assert.equal(project.name, "sample-app");
  assert.equal(project.path, join(dir, "sample-app"));
  assert.equal(project.tracker.tasksPath, "planning/roadmap/tasks.md");
  assert.equal(project.agentConfig.archonWorkflow, "archon-global");
});

test("normalizeProjectConfig keeps project-specific values out of the engine default", () => {
  const project = normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
  });

  assert.equal(project.id, "api");
  assert.equal(project.name, "API");
  assert.equal(project.path, "/workspace/api");
  assert.equal(project.tracker.tasksPath, "planning/roadmap/tasks.md");
  assert.equal(project.sessionPrefix, "api");
  assert.equal(project.workerPlugin, "archon");
  assert.equal(project.agentConfig.archonWorkflow, "auto-feature");
});

test("normalizeProjectConfig treats legacy agent as workerPlugin", () => {
  const project = normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
    agent: "opencode",
  });

  assert.equal(project.workerPlugin, "opencode");
});

test("normalizeProjectConfig treats legacy workerAgent as workerPlugin", () => {
  const project = normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
    workerAgent: "claude-code",
  });

  assert.equal(project.workerPlugin, "claude-code");
});

test("buildAoConfigYaml renders a project-specific AO config", () => {
  const yaml = buildAoConfigYaml(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
    repo: "owner/api",
    tasksPath: "planning/tasks.md",
    workerPlugin: "archon",
    archonInstruction: "Use the planning folder.",
  }), {
    aoCommand: "node /factory/agent-orchestrator/packages/cli/dist/index.js",
  });

  assert.match(yaml, /projects:\n  api:/);
  assert.match(yaml, /name: API/);
  assert.match(yaml, /path: \/workspace\/api/);
  assert.match(yaml, /defaults:\n  runtime: process\n  agent: archon/);
  assert.match(yaml, /worker:\n    agent: archon/);
  assert.match(yaml, /    worker:\n      agent: archon/);
  assert.doesNotMatch(yaml, /orchestratorSessionStrategy/);
  assert.doesNotMatch(yaml, /orchestrator:\n\s+agent:/);
  assert.match(yaml, /tasksPath: planning\/tasks\.md/);
  assert.match(yaml, /aoCommand: node \/factory\/agent-orchestrator\/packages\/cli\/dist\/index\.js/);
  assert.match(yaml, /archonInstruction: \|/);
  assert.match(yaml, /\n        Use the planning folder\./);
  assert.doesNotMatch(yaml, /sample-app/i);
});

test("buildAoConfigYaml renders all registered projects in one AO config", () => {
  const api = normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
    sessionPrefix: "api",
  });
  const web = normalizeProjectConfig({
    id: "web",
    name: "Web",
    path: "/workspace/web",
    sessionPrefix: "web",
  });

  const yaml = buildAoConfigYaml([api, web]);

  assert.match(yaml, /projects:\n  api:/);
  assert.match(yaml, /\n  web:/);
  assert.match(yaml, /path: \/workspace\/api/);
  assert.match(yaml, /path: \/workspace\/web/);
  assert.equal((yaml.match(/name: archon/g) ?? []).length, 1);
  assert.equal((yaml.match(/agent: archon/g) ?? []).length, 4);
  assert.doesNotMatch(yaml, /orchestratorSessionStrategy/);
  assert.doesNotMatch(yaml, /orchestrator:\n\s+agent:/);
  assert.doesNotMatch(yaml, /codex/);
});

test("buildAoConfigYaml defaults to the portable ao launcher", () => {
  const yaml = buildAoConfigYaml(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
  }));

  assert.match(yaml, /aoCommand: ao/);
  assert.doesNotMatch(yaml, /\/home\/weights/);
  assert.doesNotMatch(yaml, /agent-orchestrator\/packages\/cli\/dist\/index\.js/);
});

test("buildAoConfigYaml uses a project-scoped AO command when no override is passed", () => {
  const yaml = buildAoConfigYaml(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
    aoCommand: "node /factory/agent-orchestrator/packages/ao/bin/ao.js",
  }));

  assert.match(yaml, /aoCommand: node \/factory\/agent-orchestrator\/packages\/ao\/bin\/ao\.js/);
});

test("buildAoConfigYaml resolves relative AO script paths for worker callbacks", () => {
  const yaml = buildAoConfigYaml(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
  }), {
    aoCommand: "node ../agent-orchestrator/packages/ao/bin/ao.js",
    commandBaseDir: "/factory/dark-factory",
  });

  assert.match(yaml, /aoCommand: node \/factory\/agent-orchestrator\/packages\/ao\/bin\/ao\.js/);
});

test("buildAoConfigYaml passes the Dark Factory project id to worker plugins", () => {
  const yaml = buildAoConfigYaml(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
  }));

  assert.match(yaml, /agentConfig:\n      archonWorkflow: auto-feature\n      aoCommand: ao\n      darkFactoryProjectId: api/);
});

test("buildAoConfigYaml renders project runtime env mappings", () => {
  const yaml = buildAoConfigYaml(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
    runtimeEnv: "PUBLIC_API_URL=http://127.0.0.1:${apiPort}",
  }));

  assert.match(yaml, /runtimeEnv:\n        PUBLIC_API_URL: "http:\/\/127\.0\.0\.1:\$\{apiPort\}"/);
});

test("buildAoConfigYaml renders local plugin paths relative to generated config", () => {
  const yaml = buildAoConfigYaml(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
  }), {
    configDir: join(process.cwd(), ".dark-factory/generated"),
  });

  assert.match(yaml, /path: \.\.\/\.\.\/ao-plugins\/archon-agent/);
  assert.match(yaml, /path: \.\.\/\.\.\/ao-plugins\/tasks-md-tracker/);
});

test("buildAoConfigYaml infers guarded pnpm postCreate for JS projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-js-project-"));
  await writeFile(join(dir, "package.json"), "{}\n", "utf8");
  await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

  const yaml = buildAoConfigYaml(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: dir,
  }));

  assert.match(yaml, /postCreate:\n      - test -d node_modules \|\| pnpm install --frozen-lockfile/);
});

test("buildAoConfigYaml infers worktree-local env copy before dependency install", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-env-project-"));
  await writeFile(join(dir, "package.json"), "{}\n", "utf8");
  await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await writeFile(join(dir, ".env"), "SECRET=local\n", "utf8");
  await writeFile(join(dir, ".env.example"), "PORT=3000\n", "utf8");

  const yaml = buildAoConfigYaml(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: dir,
  }));

  const envCopyIndex = yaml.indexOf(`cp ${join(dir, ".env")} .env`);
  const installIndex = yaml.indexOf("pnpm install --frozen-lockfile");
  assert.notEqual(envCopyIndex, -1);
  assert.notEqual(installIndex, -1);
  assert.ok(envCopyIndex < installIndex);
});

test("buildAoConfigYaml falls back to env example only when real env is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dark-factory-env-example-project-"));
  await writeFile(join(dir, ".env.example"), "PORT=3000\n", "utf8");

  const yaml = buildAoConfigYaml(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: dir,
  }));

  assert.match(yaml, new RegExp(`cp ${join(dir, ".env.example").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\.env`));
});

test("buildAoConfigYaml renders configured envFiles as copy-if-missing postCreate commands", () => {
  const yaml = buildAoConfigYaml(normalizeProjectConfig({
    id: "api",
    name: "API",
    path: "/workspace/api",
    envFiles: [".env.local.example -> .env.local"],
    postCreate: ["echo ready"],
  }));

  assert.match(yaml, /postCreate:/);
  assert.match(yaml, /test -e \.env\.local \|\| cp \/workspace\/api\/\.env\.local\.example \.env\.local/);
  assert.match(yaml, /echo ready/);
});

test("writeAoConfig updates an already-registered Go AO project without adding it again", async () => {
  const calls = [];
  const result = await writeAoConfig({
    project: normalizeProjectConfig({ id: "sample", name: "Sample", path: "/tmp/sample" }),
    transport: {
      projectGet: async (id) => {
        calls.push(["get", id]);
        return { id, path: "/tmp/sample" };
      },
      projectAdd: async (input) => calls.push(["add", input]),
      projectSetConfig: async (id, config) => calls.push(["config", id, config]),
    },
  });

  assert.deepEqual(calls.map((call) => call[0]), ["get", "config"]);
  assert.deepEqual(result.registered, []);
  assert.deepEqual(result.updated, ["sample"]);
});

test("writeAoConfig fails closed when an existing Go AO project points at another repository", async () => {
  const calls = [];

  await assert.rejects(() => writeAoConfig({
    project: normalizeProjectConfig({ id: "sample", name: "Sample", path: "/workspace/new-sample" }),
    transport: {
      projectGet: async () => ({ id: "sample", path: "/workspace/old-sample" }),
      projectAdd: async (input) => calls.push(["add", input]),
      projectSetConfig: async (id, config) => calls.push(["config", id, config]),
    },
  }), /AO project sample is registered at .*old-sample.*requested repository is .*new-sample/i);

  assert.deepEqual(calls, []);
});

test("writeAoConfig rechecks path after a concurrent registration conflict", async () => {
  const calls = [];
  let reads = 0;

  await assert.rejects(() => writeAoConfig({
    project: normalizeProjectConfig({ id: "sample", name: "Sample", path: "/workspace/new-sample" }),
    transport: {
      projectGet: async () => {
        reads += 1;
        calls.push(["get"]);
        if (reads === 1) {
          const error = new Error("project not found");
          error.code = "PROJECT_NOT_FOUND";
          throw error;
        }
        return { id: "sample", path: "/workspace/old-sample" };
      },
      projectAdd: async () => {
        calls.push(["add"]);
        const error = new Error("project already registered");
        error.code = "PROJECT_ALREADY_EXISTS";
        throw error;
      },
      projectSetConfig: async (id, config) => calls.push(["config", id, config]),
    },
  }), /AO project sample is registered at .*old-sample.*requested repository is .*new-sample/i);

  assert.deepEqual(calls.map((call) => call[0]), ["get", "add", "get"]);
});

test("writeAoConfig rejects a concurrent registration conflict with no repository path", async () => {
  const calls = [];
  let reads = 0;

  await assert.rejects(() => writeAoConfig({
    project: normalizeProjectConfig({ id: "sample", name: "Sample", path: "/workspace/sample" }),
    transport: {
      projectGet: async () => {
        reads += 1;
        calls.push(["get"]);
        if (reads === 1) {
          const error = new Error("project not found");
          error.code = "PROJECT_NOT_FOUND";
          throw error;
        }
        return { id: "sample" };
      },
      projectAdd: async () => {
        calls.push(["add"]);
        const error = new Error("project already registered");
        error.code = "PROJECT_ALREADY_EXISTS";
        throw error;
      },
      projectSetConfig: async (id, config) => calls.push(["config", id, config]),
    },
  }), /did not provide a repository path.*refusing to update unverified project configuration/i);

  assert.deepEqual(calls.map((call) => call[0]), ["get", "add", "get"]);
});

test("getProjectRuntimePaths scopes state under the project id", () => {
  assert.deepEqual(getProjectRuntimePaths("api"), {
    root: ".dark-factory/projects/api",
    runnerStatePath: ".dark-factory/projects/api/state.json",
    runLedgerPath: ".dark-factory/projects/api/run.json",
    observabilityStatePath: ".dark-factory/projects/api/observability.json",
    eventLogPath: ".dark-factory/projects/api/events.jsonl",
    controlStatePath: ".dark-factory/projects/api/control.json",
    dashboardOutputPath: ".dark-factory/projects/api/dashboard.html",
  });
});
