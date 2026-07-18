#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_LOCK_PATH = resolve(ROOT, "dependencies.lock.json");

function normalizeRepository(repository) {
  return String(repository)
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function git(checkoutPath, args) {
  try {
    return execFileSync("git", ["-C", checkoutPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const message = error.stderr?.toString().trim() || error.message;
    throw new Error(`${checkoutPath} is not a readable Git checkout: ${message}`);
  }
}

export function validateDependencyLock(lock) {
  if (!lock || lock.lockVersion !== 1) {
    throw new Error("Dependency lock must use lockVersion 1.");
  }

  const repositories = lock.repositories;
  if (!repositories || typeof repositories !== "object" || !Object.keys(repositories).length) {
    throw new Error("Dependency lock must contain at least one repository.");
  }

  for (const [name, dependency] of Object.entries(repositories)) {
    if (!dependency?.repository || typeof dependency.repository !== "string") {
      throw new Error(`${name} must define a repository URL.`);
    }
    if (!/^[a-f0-9]{40}$/i.test(dependency.commit ?? "")) {
      throw new Error(`${name} must define a 40-character commit SHA.`);
    }
    if (!dependency.checkout?.environment || !dependency.checkout?.defaultSibling) {
      throw new Error(`${name} must define checkout.environment and checkout.defaultSibling.`);
    }
  }

  if (!lock.runtimes || typeof lock.runtimes !== "object" || !Object.keys(lock.runtimes).length) {
    throw new Error("Dependency lock must contain at least one runtime check.");
  }
  for (const [name, runtime] of Object.entries(lock.runtimes)) {
    if (!runtime?.command || typeof runtime.command !== "string") {
      throw new Error(`${name} runtime must define command.`);
    }
    if (!Array.isArray(runtime.versionArgs) || !runtime.versionArgs.length
      || runtime.versionArgs.some((argument) => typeof argument !== "string")) {
      throw new Error(`${name} runtime must define non-empty versionArgs.`);
    }
    if (!runtime.expectedOutput || typeof runtime.expectedOutput !== "string") {
      throw new Error(`${name} runtime must define expectedOutput.`);
    }
  }

  return lock;
}

export function readDependencyLock(lockPath = DEFAULT_LOCK_PATH) {
  return validateDependencyLock(JSON.parse(readFileSync(lockPath, "utf8")));
}

export function verifyDependencyRepository(name, dependency, checkoutPath) {
  const repository = git(checkoutPath, ["remote", "get-url", "origin"]);
  const commit = git(checkoutPath, ["rev-parse", "HEAD"]);

  if (normalizeRepository(repository) !== normalizeRepository(dependency.repository)) {
    throw new Error(`${name} origin is ${repository}; expected ${dependency.repository}.`);
  }
  if (commit.toLowerCase() !== dependency.commit.toLowerCase()) {
    throw new Error(`${name} is at ${commit}; expected commit ${dependency.commit}.`);
  }

  return { name, repository, commit, checkoutPath };
}

export function verifyLockedDependencies({
  lockPath = DEFAULT_LOCK_PATH,
  environment = process.env,
} = {}) {
  const lock = readDependencyLock(lockPath);
  const lockDirectory = dirname(lockPath);

  return Object.entries(lock.repositories).map(([name, dependency]) => {
    const checkoutPath = environment[dependency.checkout.environment]
      || resolve(lockDirectory, "..", dependency.checkout.defaultSibling);
    return verifyDependencyRepository(name, dependency, checkoutPath);
  });
}

function runRuntimeCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`${command} is not usable: ${detail}`);
  }
}

export function verifyRuntimeTools({ runtimes, runCommand = runRuntimeCommand } = {}) {
  if (!runtimes || typeof runtimes !== "object") {
    throw new Error("Runtime checks are required.");
  }

  return Object.entries(runtimes).map(([name, runtime]) => {
    const output = String(runCommand(runtime.command, runtime.versionArgs)).trim();
    if (!output.includes(runtime.expectedOutput)) {
      throw new Error(
        `${name} runtime output did not contain expected value ${runtime.expectedOutput}: ${output || "<empty>"}`,
      );
    }
    return { name, command: runtime.command, output };
  });
}

export function verifyLockedRuntimes({ lockPath = DEFAULT_LOCK_PATH } = {}) {
  return verifyRuntimeTools({ runtimes: readDependencyLock(lockPath).runtimes });
}

function main() {
  try {
    for (const result of verifyLockedDependencies()) {
      console.log(`PASS ${result.name} ${result.commit}`);
    }
    for (const result of verifyLockedRuntimes()) {
      console.log(`PASS ${result.name} ${result.output}`);
    }
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
