#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import archonPlugin from "../ao-plugins/archon-agent/index.js";

const MODES = new Set(["start", "restore"]);
const REQUIRED_ENV = ["AO_SESSION_ID", "AO_PROJECT_ID", "AO_ISSUE_ID"];

function requiredEnvironment(env) {
  const values = {};
  for (const name of REQUIRED_ENV) {
    const value = String(env[name] ?? "").trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    values[name] = value;
  }
  return values;
}

function workerArguments(argv) {
  const mode = argv[0];
  if (!MODES.has(mode)) {
    throw new Error("Expected start or restore");
  }
  if (mode === "restore") {
    if (argv[1] === "--prompt") throw new Error("--prompt is only valid with start");
    if (argv.length !== 1) throw new Error("Expected start or restore");
    return { mode, prompt: "" };
  }
  if (argv.length === 1) return { mode, prompt: "" };
  if (argv[1] !== "--prompt" || argv.length > 3) throw new Error("Expected start or restore");
  if (argv.length < 3) throw new Error("--prompt requires a value");
  return { mode, prompt: argv[2] };
}

async function loadAgentConfig(env, identity) {
  const registryPath = String(env.DARK_FACTORY_REGISTRY_PATH ?? "").trim();
  if (!registryPath) return {};

  const registry = JSON.parse(await readFile(resolve(registryPath), "utf8"));
  const project = registry.projects?.[identity.AO_PROJECT_ID];
  if (!project) throw new Error(`Project is not registered: ${identity.AO_PROJECT_ID}`);
  const agentConfig = project.agentConfig;
  return agentConfig && typeof agentConfig === "object" && !Array.isArray(agentConfig)
    ? agentConfig
    : {};
}

export function buildWorkerCommand(mode, env = process.env, config = {}) {
  const selectedMode = workerArguments([mode]).mode;
  const identity = requiredEnvironment(env);
  const agent = archonPlugin.create();

  return agent.getLaunchCommand({
    sessionId: identity.AO_SESSION_ID,
    issueId: identity.AO_ISSUE_ID,
    prompt: config.prompt,
    projectConfig: {
      agentConfig: {
        ...(config.agentConfig ?? {}),
        darkFactoryProjectId: identity.AO_PROJECT_ID,
        aoCommand: "true",
      },
    },
    restore: selectedMode === "restore",
  });
}

export function resolvePosixShell(options = {}) {
  const env = options.env ?? process.env;
  const override = String(env.DARK_FACTORY_POSIX_SHELL ?? "").trim();
  if (override) return override;

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return "/bin/sh";

  const pathExists = options.pathExists ?? existsSync;
  const pathEntries = String(env.PATH ?? env.Path ?? "")
    .split(win32.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const candidates = [
    ...pathEntries.flatMap((entry) => [
      win32.join(entry, "bash.exe"),
      win32.join(entry, "bash"),
    ]),
    ...[env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
      .filter(Boolean)
      .map((root) => win32.join(
        root,
        root === env.LOCALAPPDATA ? "Programs" : "",
        "Git",
        "bin",
        "bash.exe",
      )),
  ];

  const shell = candidates.find((candidate) => pathExists(candidate));
  if (shell) return shell;

  throw new Error(
    "A POSIX shell is required to run the Archon worker on Windows. Install Git Bash or Bash, add it to PATH, or set DARK_FACTORY_POSIX_SHELL to the shell executable.",
  );
}

export function runExternalCommand(command, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const spawnProcess = options.spawnProcess ?? spawn;
    const shell = resolvePosixShell(options);
    const child = spawnProcess(shell, ["-c", command], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        const error = new Error(`Dark Factory worker command exited from signal ${signal}`);
        error.signal = signal;
        reject(error);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

export function reportAoActivity(event, options = {}) {
  return new Promise((resolvePromise) => {
    const spawnProcess = options.spawnProcess ?? spawn;
    const env = options.env ?? process.env;
    const aoBinary = String(env.DARK_FACTORY_AO_BINARY ?? "ao").trim() || "ao";
    const child = spawnProcess(aoBinary, ["hooks", "external", event], {
      cwd: options.cwd ?? process.cwd(),
      env,
      shell: false,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("error", () => resolvePromise(false));
    child.once("exit", (code, signal) => resolvePromise(signal === null && code === 0));
  });
}

export async function runWorker(argv, options = {}) {
  const args = workerArguments(argv);
  const env = options.env ?? process.env;
  const identity = requiredEnvironment(env);
  const agentConfig = await loadAgentConfig(env, identity);

  const command = buildWorkerCommand(args.mode, env, { prompt: args.prompt, agentConfig });
  const runCommand = options.runCommand ?? runExternalCommand;
  const reportActivity = options.reportActivity ?? (async () => true);
  const commandOptions = {
    cwd: options.cwd ?? process.cwd(),
    env,
  };

  await reportActivity("session-start", commandOptions);
  try {
    return await runCommand(command, commandOptions);
  } finally {
    await reportActivity("session-end", commandOptions);
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  runWorker(process.argv.slice(2), { reportActivity: reportAoActivity }).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    if (error?.signal) {
      process.kill(process.pid, error.signal);
      return;
    }
    console.error(error.message);
    process.exitCode = 1;
  });
}
