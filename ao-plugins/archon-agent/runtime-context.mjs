#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, readlink, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DESCRIPTOR_PATH = ".archon/state/dark-factory-runtime.json";

function validPort(value) {
  return /^\d+$/.test(String(value ?? ""))
    && Number(value) > 0
    && Number(value) <= 65_535;
}

function isInside(root, candidate) {
  const parent = resolve(root);
  const child = resolve(candidate);
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function descriptorPath(cwd) {
  return join(cwd, DESCRIPTOR_PATH);
}

function descriptorMatches(descriptor, expected) {
  return descriptor?.version === 1
    && descriptor.projectId === expected.projectId
    && descriptor.sessionId === expected.sessionId
    && descriptor.issueId === expected.issueId
    && resolve(descriptor.worktreePath ?? "") === resolve(expected.cwd)
    && validPort(descriptor.apiPort)
    && validPort(descriptor.webPort);
}

export async function readRuntimeDescriptor(expected) {
  try {
    const descriptor = JSON.parse(await readFile(descriptorPath(expected.cwd), "utf8"));
    return descriptorMatches(descriptor, expected) ? descriptor : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeRuntimeDescriptor(context) {
  const path = descriptorPath(context.cwd);
  let previous = null;
  try {
    previous = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  const now = new Date().toISOString();
  const descriptor = {
    version: 1,
    projectId: context.projectId,
    sessionId: context.sessionId,
    issueId: context.issueId,
    worktreePath: resolve(context.cwd),
    apiPort: String(context.apiPort),
    webPort: String(context.webPort),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  await rename(temporaryPath, path);
  return descriptor;
}

export function isPortAvailable(port) {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveAvailable(false));
    server.listen({ host: "127.0.0.1", port: Number(port), exclusive: true }, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

async function listenerPids(port) {
  try {
    const { stdout } = await execFileAsync("ss", ["-H", "-ltnp", `sport = :${port}`], {
      encoding: "utf8",
    });
    return [...stdout.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
  } catch {
    return [];
  }
}

export async function isPortOwnedByWorktree(port, cwd) {
  const pids = await listenerPids(port);
  if (pids.length === 0) return false;

  for (const pid of pids) {
    try {
      if (isInside(cwd, await readlink(`/proc/${pid}/cwd`))) return true;
    } catch {
      // A process may exit between listener discovery and cwd inspection.
    }
  }
  return false;
}

async function pairUsable(apiPort, webPort, options) {
  const apiAvailable = await options.isPortAvailable(apiPort);
  const webAvailable = await options.isPortAvailable(webPort);
  const apiOwned = !apiAvailable && options.restore
    ? await options.isPortOwnedByWorktree(apiPort, options.cwd)
    : false;
  const webOwned = !webAvailable && options.restore
    ? await options.isPortOwnedByWorktree(webPort, options.cwd)
    : false;

  return {
    usable: (apiAvailable || apiOwned) && (webAvailable || webOwned),
    owned: apiOwned || webOwned,
  };
}

export async function resolveRuntimeContext(options) {
  const initialApiPort = Number.parseInt(String(options.initialApiPort), 10);
  if (!validPort(initialApiPort) || initialApiPort >= 65_535) {
    throw new Error(`Invalid initial API port: ${options.initialApiPort}`);
  }

  const context = {
    cwd: resolve(options.cwd),
    projectId: String(options.projectId ?? ""),
    sessionId: String(options.sessionId ?? ""),
    issueId: String(options.issueId ?? ""),
    restore: options.restore === true,
    isPortAvailable: options.isPortAvailable ?? isPortAvailable,
    isPortOwnedByWorktree: options.isPortOwnedByWorktree ?? isPortOwnedByWorktree,
  };
  const persisted = await readRuntimeDescriptor(context);

  if (persisted) {
    const pair = await pairUsable(persisted.apiPort, persisted.webPort, context);
    if (pair.usable) {
      return { ...context, apiPort: persisted.apiPort, webPort: persisted.webPort, source: "persisted" };
    }
  }

  for (let apiPort = initialApiPort; apiPort < 65_535; apiPort += 2) {
    const webPort = apiPort + 1;
    const pair = await pairUsable(apiPort, webPort, context);
    if (!pair.usable) continue;
    return {
      ...context,
      apiPort: String(apiPort),
      webPort: String(webPort),
      source: pair.owned ? "initial-owned" : "allocated",
    };
  }

  throw new Error(`Could not allocate an API/web port pair from ${initialApiPort}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function parseArgs(argv) {
  const result = { restore: false, shell: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--restore") result.restore = true;
    else if (arg === "--shell") result.shell = true;
    else if (arg.startsWith("--")) result[arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = argv[++index];
    else if (!result.command) result.command = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "resolve") throw new Error("Usage: runtime-context.mjs resolve [options]");
  const context = await resolveRuntimeContext(args);
  await writeRuntimeDescriptor(context);
  if (args.shell) {
    process.stdout.write([
      `dark_factory_api_port=${shellQuote(context.apiPort)}`,
      `dark_factory_web_port=${shellQuote(context.webPort)}`,
    ].join("\n"));
  } else {
    process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
