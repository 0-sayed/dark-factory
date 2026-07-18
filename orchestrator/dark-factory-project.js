import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAoTransport, splitCommandLine } from "./ao-command.js";

export const DEFAULT_PROJECT_CONFIG_PATH = "dark-factory.yaml";
export const DEFAULT_REGISTRY_PATH = ".dark-factory/projects.json";
export const DEFAULT_AO_CONFIG_PATH = ".dark-factory/generated/agent-orchestrator.yaml";

function stripQuotes(value) {
  const text = String(value ?? "").trim();
  if (
    (text.startsWith("\"") && text.endsWith("\""))
    || (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseProjectYaml(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  const values = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const literalMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*\|\s*$/);
    if (literalMatch) {
      const key = literalMatch[1];
      const literalLines = [];

      for (index += 1; index < lines.length; index += 1) {
        const literalLine = lines[index];
        if (!literalLine.startsWith("  ") && literalLine.trim()) {
          index -= 1;
          break;
        }
        literalLines.push(literalLine.replace(/^  ?/, ""));
      }

      values[key] = literalLines.join("\n").trimEnd();
      continue;
    }

    const scalarMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!scalarMatch) continue;
    values[scalarMatch[1]] = stripQuotes(scalarMatch[2]);
  }

  return values;
}

function normalizePathSeparators(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function quoteCommandPart(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\"'\"'")}'`;
}

function normalizeWorkerAoCommand(aoCommand, baseDir = process.cwd()) {
  const parts = splitCommandLine(aoCommand ?? "ao");
  const normalized = parts.map((part) => {
    if (!part.includes("/") && !part.includes("\\")) return part;
    if (isAbsolute(part)) return resolve(part);
    return resolve(baseDir, part);
  });

  return normalized.map(quoteCommandPart).join(" ");
}

function sanitizeId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseGitHubRepoFromRemoteUrl(url) {
  const text = String(url ?? "").trim().replace(/\.git$/, "");
  const sshMatch = text.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;

  const httpsMatch = text.match(/^https?:\/\/github\.com\/([^/]+)\/(.+)$/);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;

  const sshUrlMatch = text.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/);
  if (sshUrlMatch) return `${sshUrlMatch[1]}/${sshUrlMatch[2]}`;

  return "";
}

function inferGitHubRepoFromRemote(projectPath) {
  if (!projectPath || !existsSync(projectPath)) return "";

  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: projectPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return parseGitHubRepoFromRemoteUrl(remote);
  } catch {
    return "";
  }
}

function resolveConfigRelativePath(value, baseDir = process.cwd()) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return isAbsolute(text) ? resolve(text) : resolve(baseDir, text);
}

function projectRelativePath(projectPath, targetPath) {
  return normalizePathSeparators(relative(projectPath, targetPath) || ".");
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const text = String(value ?? "").trim();
  if (!text) return [];
  return text
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEnvFileEntry(value) {
  if (typeof value === "object" && value !== null) {
    const from = String(value.from ?? "").trim();
    const to = String(value.to ?? from.replace(/\.example$/, "")).trim();
    const mode = String(value.mode ?? "copy-if-missing").trim();
    if (!from || !to) return null;
    if (mode !== "copy-if-missing") throw new Error(`Unsupported env file mode: ${mode}`);
    return { from, to, mode };
  }

  const text = String(value ?? "").trim();
  if (!text) return null;
  const [rawFrom, rawTo] = text.split(/\s*->\s*/, 2);
  const from = String(rawFrom ?? "").trim();
  const to = String(rawTo ?? from.replace(/\.example$/, "")).trim();
  if (!from || !to) return null;
  return { from, to, mode: "copy-if-missing" };
}

function normalizeEnvFiles(value) {
  if (Array.isArray(value)) return value.map(normalizeEnvFileEntry).filter(Boolean);
  return normalizeList(value).map(normalizeEnvFileEntry).filter(Boolean);
}

function normalizeCleanupCommands(value) {
  return normalizeList(value);
}

function normalizeRuntimeEnv(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [String(key).trim(), String(entry ?? "").trim()])
        .filter(([key]) => key),
    );
  }

  const entries = normalizeList(value);
  const env = {};
  for (const entry of entries) {
    const match = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Invalid runtimeEnv entry: ${entry}`);
    env[match[1]] = match[2].trim();
  }
  return env;
}

function inferEnvFiles(projectPath) {
  if (!projectPath) return [];
  if (existsSync(resolve(projectPath, ".env"))) return [{ from: ".env", to: ".env", mode: "copy-if-missing" }];
  if (!existsSync(resolve(projectPath, ".env.example"))) return [];
  return [{ from: ".env.example", to: ".env", mode: "copy-if-missing" }];
}

function inferPostCreate(projectPath) {
  if (!projectPath || !existsSync(resolve(projectPath, "package.json"))) return [];
  if (existsSync(resolve(projectPath, "pnpm-lock.yaml"))) return ["test -d node_modules || pnpm install --frozen-lockfile"];
  if (existsSync(resolve(projectPath, "package-lock.json"))) return ["test -d node_modules || npm ci"];
  if (existsSync(resolve(projectPath, "yarn.lock"))) return ["test -d node_modules || yarn install --frozen-lockfile"];
  if (existsSync(resolve(projectPath, "bun.lock")) || existsSync(resolve(projectPath, "bun.lockb"))) return ["test -d node_modules || bun install"];
  return [];
}

function normalizeTasksPath(config, { projectPath, planningPath }) {
  const configuredTasksPath = String(config.tasksPath ?? "").trim();
  if (configuredTasksPath) {
    return normalizePathSeparators(
      isAbsolute(configuredTasksPath)
        ? projectRelativePath(projectPath, resolve(configuredTasksPath))
        : configuredTasksPath,
    );
  }

  const configuredTasksFile = String(config.tasksFile ?? "").trim();
  if (planningPath) {
    const tasksFile = configuredTasksFile || "roadmap/tasks.md";
    return projectRelativePath(
      projectPath,
      resolve(planningPath, tasksFile),
    );
  }

  return normalizePathSeparators(configuredTasksFile || "planning/roadmap/tasks.md");
}

function makeConfigRelativePath(targetPath, configDir = process.cwd()) {
  const relativePath = normalizePathSeparators(relative(configDir, resolve(targetPath)));
  if (!relativePath || relativePath === ".") return ".";
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

export function normalizeProjectConfig(config, options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const planningPath = config.planningPath
    ? resolveConfigRelativePath(config.planningPath, baseDir)
    : "";
  const configuredProjectPath = config.path ?? config.projectPath;
  const projectPath = configuredProjectPath
    ? resolveConfigRelativePath(configuredProjectPath, baseDir)
    : planningPath
      ? dirname(planningPath)
      : "";

  if (!projectPath) {
    throw new Error("Project config is missing required field: path or planningPath");
  }

  const id = sanitizeId(config.id ?? config.name ?? basename(projectPath));
  if (!id) throw new Error("Project config is missing required field: id");

  const name = String(config.name ?? id).trim();
  const tasksPath = normalizeTasksPath(config, { projectPath, planningPath });
  const symlinks = normalizeList(config.symlinks);
  const envFiles = normalizeEnvFiles(config.envFiles);
  const cleanupCommands = normalizeCleanupCommands(config.cleanupCommands ?? config.cleanupCommand ?? config.cleanup?.commands);
  const runtimeEnv = normalizeRuntimeEnv(config.runtimeEnv ?? config.agentConfig?.runtimeEnv);
  const postCreate = normalizeList(config.postCreate);
  const configuredAoCommand = config.aoCommand ?? config.agentConfig?.aoCommand;
  const configuredRepo = String(config.repo ?? "").trim();
  const repo = configuredRepo || inferGitHubRepoFromRemote(projectPath);

  return {
    id,
    name,
    path: projectPath,
    ...(repo ? { repo } : {}),
    defaultBranch: String(config.defaultBranch ?? "main").trim(),
    sessionPrefix: String(config.sessionPrefix ?? id).trim(),
    runtime: String(config.runtime ?? "process").trim(),
    workerPlugin: String(config.workerPlugin ?? config.workerAgent ?? config.agent ?? "archon").trim(),
    workspace: String(config.workspace ?? "worktree").trim(),
    ...(symlinks.length ? { symlinks } : {}),
    ...(envFiles.length ? { envFiles } : {}),
    ...(cleanupCommands.length ? { cleanup: { commands: cleanupCommands } } : {}),
    ...(postCreate.length ? { postCreate } : {}),
    tracker: {
      path: String(config.trackerPath ?? "./ao-plugins/tasks-md-tracker").trim(),
      tasksPath,
    },
    agentConfig: {
      archonWorkflow: String(config.archonWorkflow ?? "auto-feature").trim(),
      ...(configuredAoCommand ? { aoCommand: normalizeWorkerAoCommand(configuredAoCommand, baseDir) } : {}),
      ...(config.archonInstruction ? { archonInstruction: String(config.archonInstruction).trim() } : {}),
      ...(Object.keys(runtimeEnv).length ? { runtimeEnv } : {}),
    },
  };
}

export async function loadProjectConfig(path = DEFAULT_PROJECT_CONFIG_PATH) {
  const configPath = resolve(path);
  const content = await readFile(configPath, "utf8");
  return normalizeProjectConfig(parseProjectYaml(content), { baseDir: dirname(configPath) });
}

function emptyRegistry() {
  return {
    version: 1,
    projects: {},
  };
}

export async function loadProjectRegistry(path = DEFAULT_REGISTRY_PATH) {
  try {
    const content = await readFile(resolve(path), "utf8");
    const registry = JSON.parse(content);
    return {
      version: registry.version ?? 1,
      projects: registry.projects ?? {},
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyRegistry();
    throw error;
  }
}

async function writeProjectRegistry(path, registry) {
  const targetPath = resolve(path);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

async function assertPlanningTasksFile(planningPath, tasksFile = "roadmap/tasks.md") {
  const tasksPath = resolve(planningPath, tasksFile);
  try {
    await access(tasksPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Planning folder is missing required tasks file: ${tasksPath}`);
    }
    throw error;
  }
}

export function getRegisteredProjects(registry) {
  return Object.keys(registry?.projects ?? {})
    .sort((left, right) => left.localeCompare(right))
    .map((id) => registry.projects[id]);
}

export function resolveRegisteredProject(registry, projectId) {
  const projects = registry?.projects ?? {};
  const ids = Object.keys(projects).sort((left, right) => left.localeCompare(right));

  if (projectId) {
    const id = sanitizeId(projectId);
    if (!projects[id]) throw new Error(`Project is not registered: ${projectId}`);
    return projects[id];
  }

  if (ids.length === 1) return projects[ids[0]];
  if (ids.length === 0) throw new Error("No Dark Factory projects registered. Run init first.");
  throw new Error(`Multiple projects registered (${ids.join(", ")}). Pass --project <id>.`);
}

export function getProjectRuntimePaths(projectId) {
  const id = sanitizeId(projectId);
  const root = `.dark-factory/projects/${id}`;
  return {
    root,
    runnerStatePath: `${root}/state.json`,
    runLedgerPath: `${root}/run.json`,
    observabilityStatePath: `${root}/observability.json`,
    eventLogPath: `${root}/events.jsonl`,
    controlStatePath: `${root}/control.json`,
    dashboardOutputPath: `${root}/dashboard.html`,
  };
}

export async function registerProject(options = {}) {
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const baseDir = options.baseDir ?? process.cwd();
  const planningPath = resolveConfigRelativePath(options.planningPath, baseDir);
  const tasksFile = String(options.tasksFile ?? "roadmap/tasks.md").trim();

  if (!planningPath) throw new Error("init requires --planning <path>");
  await assertPlanningTasksFile(planningPath, tasksFile);

  const project = normalizeProjectConfig({
    id: options.projectId ?? options.id,
    name: options.name ?? options.projectId,
    path: options.path ?? options.projectPath,
    planningPath,
    repo: options.repo,
    defaultBranch: options.defaultBranch,
    sessionPrefix: options.sessionPrefix,
    workerPlugin: options.workerPlugin ?? options.workerAgent,
    aoCommand: options.aoCommand,
    archonWorkflow: options.archonWorkflow,
    archonInstruction: options.archonInstruction,
    envFiles: options.envFiles,
    cleanupCommands: options.cleanupCommands,
    tasksFile,
  }, { baseDir });
  const registry = await loadProjectRegistry(registryPath);
  const existing = registry.projects[project.id];
  if (existing?.path && resolve(existing.path) !== resolve(project.path)) {
    throw new Error(
      `Dark Factory project ${project.id} is registered at ${resolve(existing.path)}; requested repository is ${resolve(project.path)}. Use a different project id or remove the stale registration explicitly.`,
    );
  }
  registry.projects[project.id] = project;
  await writeProjectRegistry(registryPath, registry);

  return {
    registry,
    project,
    registryPath: resolve(registryPath),
  };
}

function yamlValue(value) {
  const text = String(value ?? "");
  if (!text) return "\"\"";
  if (/^[A-Za-z0-9_./:@|-]+(?: [A-Za-z0-9_./:@|-]+)*$/.test(text)) return text;
  return JSON.stringify(text);
}

function literalBlock(value, indent = "        ") {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function normalizeProjectsInput(projectsInput) {
  if (Array.isArray(projectsInput)) return projectsInput;
  if (projectsInput?.projects) return getRegisteredProjects(projectsInput);
  return [projectsInput];
}

function resolveWorkerPlugin(project, options = {}) {
  return String(options.workerPlugin ?? project.workerPlugin ?? project.workerAgent ?? project.agent ?? "archon").trim();
}

function envFileCopyCommand(projectPath, entry) {
  const source = isAbsolute(entry.from) ? resolve(entry.from) : resolve(projectPath, entry.from);
  return `test -e ${quoteCommandPart(entry.to)} || cp ${quoteCommandPart(source)} ${quoteCommandPart(entry.to)}`;
}

function renderAoProject(project, options) {
  const trackerPath = project.tracker?.path
    ? makeConfigRelativePath(project.tracker.path, options.configDir)
    : makeConfigRelativePath("ao-plugins/tasks-md-tracker", options.configDir);
  const tasksPath = project.tracker?.tasksPath ?? "planning/roadmap/tasks.md";
  const aoCommand = normalizeWorkerAoCommand(
    options.aoCommand ?? project.agentConfig?.aoCommand ?? "ao",
    options.commandBaseDir,
  );
  const agentConfig = {
    ...(project.agentConfig ?? {}),
    aoCommand,
    darkFactoryProjectId: project.id,
  };
  const symlinks = normalizeList(project.symlinks);
  const envFiles = normalizeEnvFiles(project.envFiles);
  const effectiveEnvFiles = envFiles.length ? envFiles : inferEnvFiles(project.path);
  const postCreate = normalizeList(project.postCreate);
  const effectivePostCreate = [
    ...effectiveEnvFiles.map((entry) => envFileCopyCommand(project.path, entry)),
    ...(postCreate.length ? postCreate : inferPostCreate(project.path)),
  ];
  const workerPlugin = resolveWorkerPlugin(project, options);

  return [
    `  ${project.id}:`,
    `    name: ${yamlValue(project.name)}`,
    ...(project.repo ? [`    repo: ${yamlValue(project.repo)}`] : []),
    `    path: ${yamlValue(project.path)}`,
    `    defaultBranch: ${yamlValue(project.defaultBranch ?? "main")}`,
    `    sessionPrefix: ${yamlValue(project.sessionPrefix ?? project.id)}`,
    `    runtime: ${yamlValue(project.runtime ?? "process")}`,
    `    workspace: ${yamlValue(project.workspace ?? "worktree")}`,
    "    worker:",
    `      agent: ${yamlValue(workerPlugin)}`,
    ...(symlinks.length
      ? [
          "    symlinks:",
          ...symlinks.map((path) => `      - ${yamlValue(path)}`),
        ]
      : []),
    ...(effectivePostCreate.length
      ? [
          "    postCreate:",
          ...effectivePostCreate.map((command) => `      - ${yamlValue(command)}`),
        ]
      : []),
    "    tracker:",
    `      path: ${yamlValue(trackerPath)}`,
    `      tasksPath: ${yamlValue(tasksPath)}`,
    "    agentConfig:",
    `      archonWorkflow: ${yamlValue(agentConfig.archonWorkflow ?? "auto-feature")}`,
    `      aoCommand: ${yamlValue(agentConfig.aoCommand)}`,
    `      darkFactoryProjectId: ${yamlValue(agentConfig.darkFactoryProjectId)}`,
    ...(agentConfig.runtimeEnv && Object.keys(agentConfig.runtimeEnv).length
      ? [
          "      runtimeEnv:",
          ...Object.entries(agentConfig.runtimeEnv).map(([key, value]) => `        ${key}: ${yamlValue(value)}`),
        ]
      : []),
    ...(agentConfig.archonInstruction
      ? [
          "      archonInstruction: |",
          literalBlock(agentConfig.archonInstruction),
        ]
      : []),
  ].join("\n");
}

export function buildAoConfigYaml(projectsInput, options = {}) {
  const projects = normalizeProjectsInput(projectsInput);
  if (projects.length === 0) throw new Error("Cannot generate AO config without registered projects");
  const firstProject = projects[0];
  const configDir = options.configDir ?? process.cwd();
  const workerPlugin = resolveWorkerPlugin(firstProject, options);
  const archonPluginPath = makeConfigRelativePath("ao-plugins/archon-agent", configDir);

  return [
    "# Generated by dark factory. Run init to update registered projects, then regenerate.",
    "port: 3055",
    "terminalPort: 14855",
    "directTerminalPort: 14856",
    "",
    "observability:",
    "  logLevel: info",
    "  stderr: false",
    "",
    "defaults:",
    `  runtime: ${yamlValue(firstProject.runtime ?? "process")}`,
    `  agent: ${yamlValue(workerPlugin)}`,
    `  workspace: ${yamlValue(firstProject.workspace ?? "worktree")}`,
    "  notifiers:",
    "    - dashboard",
    "  worker:",
    `    agent: ${yamlValue(workerPlugin)}`,
    "",
    "plugins:",
    "  - name: archon",
    "    source: local",
    `    path: ${yamlValue(archonPluginPath)}`,
    "    enabled: true",
    "",
    "projects:",
    projects.map((project) => renderAoProject(project, {
      aoCommand: options.aoCommand,
      commandBaseDir: options.commandBaseDir,
      configDir,
      workerPlugin: options.workerPlugin,
    })).join("\n"),
    "",
    "notifiers:",
    "  dashboard:",
    "    plugin: dashboard",
    "    limit: 100",
    "",
    "notificationRouting:",
    "  urgent:",
    "    - dashboard",
    "  action:",
    "    - dashboard",
    "  warning:",
    "    - dashboard",
    "  info:",
    "    - dashboard",
    "",
  ].join("\n");
}

export async function writeAoConfig(options = {}) {
  return syncAoProjects(options);
}

const DEFAULT_WORKER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "dark-factory-worker.js");

export function buildAoProjectConfig(project, options = {}) {
  const workerPath = resolve(options.workerPath ?? DEFAULT_WORKER_PATH);
  const registryPath = resolve(options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const compatibilityStatePath = resolve(
    options.compatibilityStatePath ?? join(dirname(registryPath), "compat/agent-orchestrator"),
  );
  const runtimeEnv = project.agentConfig?.runtimeEnv ?? {};
  const envFiles = normalizeEnvFiles(project.envFiles);
  const effectiveEnvFiles = envFiles.length ? envFiles : inferEnvFiles(project.path);
  const postCreate = normalizeList(project.postCreate);
  const effectivePostCreate = [
    ...effectiveEnvFiles.map((entry) => envFileCopyCommand(project.path, entry)),
    ...(postCreate.length ? postCreate : inferPostCreate(project.path)),
  ];

  return {
    defaultBranch: project.defaultBranch ?? "main",
    sessionPrefix: project.sessionPrefix ?? project.id,
    env: {
      ...runtimeEnv,
      DARK_FACTORY_REGISTRY_PATH: registryPath,
      DARK_FACTORY_COMPAT_STATE_PATH: compatibilityStatePath,
      AGENT_ORCHESTRATOR_HOME: compatibilityStatePath,
    },
    ...(normalizeList(project.symlinks).length ? { symlinks: normalizeList(project.symlinks) } : {}),
    ...(effectivePostCreate.length ? { postCreate: effectivePostCreate } : {}),
    worker: {
      agent: "external",
      agentConfig: {
        command: [options.nodePath ?? process.execPath, workerPath],
      },
    },
  };
}

function isMissingProjectError(error) {
  return error?.code === "PROJECT_NOT_FOUND"
    || /(?:project.*not found|not found.*project|HTTP 404)/i.test(String(error?.message ?? error));
}

function isAlreadyRegisteredError(error) {
  return error?.code === "PROJECT_ALREADY_EXISTS"
    || /(?:already exists|already registered|conflict)/i.test(String(error?.message ?? error));
}

export async function syncAoProjects(options = {}) {
  const projects = normalizeProjectsInput(options.projects ?? options.project);
  if (projects.length === 0 || projects.some((project) => !project)) {
    throw new Error("Cannot register AO project without a project config");
  }
  const transport = options.transport ?? (options.createTransport ?? createAoTransport)({
    cwd: options.cwd,
    aoCommand: options.aoCommand,
    env: options.env,
  });
  const registered = [];
  const updated = [];

  for (const project of projects) {
    let exists = true;
    let registeredProject = null;
    try {
      registeredProject = await transport.projectGet(project.id);
    } catch (error) {
      if (!isMissingProjectError(error)) throw error;
      exists = false;
    }

    if (!exists) {
      try {
        await transport.projectAdd({
          path: project.path,
          projectId: project.id,
          name: project.name,
        });
        registered.push(project.id);
      } catch (error) {
        if (!isAlreadyRegisteredError(error)) throw error;
        registeredProject = await transport.projectGet(project.id);
        exists = true;
      }
    }

    if (exists) {
      const registeredPath = String(registeredProject?.path ?? "").trim();
      if (!registeredPath) {
        throw new Error(`AO project ${project.id} did not provide a repository path; refusing to update unverified project configuration.`);
      }
      if (resolve(registeredPath) !== resolve(project.path)) {
        throw new Error(
          `AO project ${project.id} is registered at ${resolve(registeredPath)}; requested repository is ${resolve(project.path)}. Use a different project id or remove the stale AO registration explicitly.`,
        );
      }
    }

    await transport.projectSetConfig(project.id, buildAoProjectConfig(project, options));
    updated.push(project.id);
  }

  return { registered, updated, projects };
}
