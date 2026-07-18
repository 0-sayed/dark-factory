#!/usr/bin/env node

import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const TEST_ROOTS = ["orchestrator", "ao-plugins", "distribution"];

export function classifyTestFile(path) {
  const extension = extname(path);
  if (path.endsWith(".test")) {
    return (lstatSync(path).mode & 0o111) ? "shell" : null;
  }
  if (extension === ".js" || extension === ".mjs") {
    return path.endsWith(`.test${extension}`) ? "node" : null;
  }
  return null;
}

function walkTests(directory, discovered) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walkTests(path, discovered);
    else if (entry.isFile()) {
      const type = classifyTestFile(path);
      if (type === "node") discovered.nodeTests.push(path);
      if (type === "shell") discovered.shellTests.push(path);
    }
  }
}

export function discoverTests(root = ROOT) {
  const discovered = { nodeTests: [], shellTests: [] };
  for (const testRoot of TEST_ROOTS) {
    const directory = resolve(root, testRoot);
    try {
      if (lstatSync(directory).isDirectory()) walkTests(directory, discovered);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  discovered.nodeTests.sort();
  discovered.shellTests.sort();
  return discovered;
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "signal"}.`);
}

export function isolatedTestEnvironment(environment, home) {
  return { ...environment, HOME: home, USERPROFILE: home };
}

export function runValidation(root = ROOT) {
  const { nodeTests, shellTests } = discoverTests(root);
  const home = mkdtempSync(resolve(tmpdir(), "dark-factory-test-home-"));
  const testEnvironment = isolatedTestEnvironment(process.env, home);
  try {
    if (nodeTests.length) {
      run(process.execPath, ["--test", ...nodeTests], root, testEnvironment);
    }
    for (const test of shellTests) run(test, [], root, testEnvironment);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  run(process.execPath, [resolve(root, "scripts/manage-distribution.mjs"), "verify-source"], root);
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  try {
    runValidation();
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}
