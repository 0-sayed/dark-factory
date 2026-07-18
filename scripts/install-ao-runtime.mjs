#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readDependencyLock,
  verifyDependencyRepository,
} from "./verify-dependencies.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_LOCK_PATH = resolve(ROOT, "dependencies.lock.json");
const RECEIPT_NAME = "dark-factory-runtime.json";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function githubRepositoryName(repository) {
  const match = String(repository).trim().match(
    /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/i,
  );
  if (!match) throw new Error(`AO repository must be a GitHub repository: ${repository}`);
  return match[1];
}

function defaultRunCommand(command, args, options) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
}

function runChecked(runCommand, command, args, options) {
  const result = runCommand(command, args, options);
  if (result?.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result?.status !== 0) {
    const detail = String(result?.stderr || result?.stdout || `exit ${result?.status}`).trim();
    throw new Error(`${command} failed: ${detail}`);
  }
}

function findAppImages(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findAppImages(path);
    return entry.isFile() && entry.name.endsWith(".AppImage") ? [path] : [];
  });
}

function atomicInstall(source, target, mode) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertNoLiveAoDaemon(home) {
  const runFile = join(resolve(home), ".ao", "running.json");
  if (!existsSync(runFile)) return;

  try {
    const pid = Number(JSON.parse(readFileSync(runFile, "utf8")).pid);
    if (!Number.isInteger(pid) || pid <= 0) return;
    process.kill(pid, 0);
    throw new Error("AO daemon is running; close the AO desktop application before replacing its runtime.");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

export function installAoRuntimeArtifacts({ home, appImagePath, cliPath, dependency } = {}) {
  if (!home) throw new Error("AO runtime installation requires an explicit home path.");
  if (!dependency?.repository || !/^[a-f0-9]{40}$/i.test(dependency?.commit ?? "")) {
    throw new Error("AO runtime installation requires a pinned repository and commit.");
  }
  for (const [label, path] of [["desktop AppImage", appImagePath], ["CLI", cliPath]]) {
    if (!path || !existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Built AO ${label} is missing: ${path ?? "<unset>"}`);
    }
  }

  assertNoLiveAoDaemon(home);
  const resolvedHome = resolve(home);
  const installedAppImage = join(resolvedHome, ".ao", "agent-orchestrator.AppImage");
  const installedCli = join(resolvedHome, ".local", "bin", "ao");
  const receiptPath = join(resolvedHome, ".ao", RECEIPT_NAME);

  atomicInstall(appImagePath, installedAppImage, 0o755);
  atomicInstall(cliPath, installedCli, 0o755);

  const receipt = {
    schemaVersion: 1,
    repository: dependency.repository,
    commit: dependency.commit,
    appImageSha256: sha256File(installedAppImage),
    cliSha256: sha256File(installedCli),
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

  return {
    repository: receipt.repository,
    commit: receipt.commit,
    appImageSha256: receipt.appImageSha256,
    cliSha256: receipt.cliSha256,
    appImagePath: installedAppImage,
    cliPath: installedCli,
    receiptPath,
  };
}

export function verifyAoRuntimeInstallation({ home, dependency } = {}) {
  if (!home) throw new Error("AO runtime verification requires an explicit home path.");
  const resolvedHome = resolve(home);
  const appImagePath = join(resolvedHome, ".ao", "agent-orchestrator.AppImage");
  const cliPath = join(resolvedHome, ".local", "bin", "ao");
  const receiptPath = join(resolvedHome, ".ao", RECEIPT_NAME);
  if (!existsSync(receiptPath)) throw new Error(`AO runtime receipt is missing: ${receiptPath}`);

  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (receipt.schemaVersion !== 1) throw new Error("AO runtime receipt has an unsupported schema version.");
  if (receipt.repository !== dependency?.repository) {
    throw new Error(`AO runtime repository is ${receipt.repository}; expected ${dependency?.repository}.`);
  }
  if (receipt.commit !== dependency?.commit) {
    throw new Error(`AO runtime commit is ${receipt.commit}; expected ${dependency?.commit}.`);
  }
  if (!existsSync(appImagePath) || sha256File(appImagePath) !== receipt.appImageSha256) {
    throw new Error("AO desktop checksum differs from its pinned runtime receipt.");
  }
  if (!existsSync(cliPath) || sha256File(cliPath) !== receipt.cliSha256) {
    throw new Error("AO CLI checksum differs from its pinned runtime receipt.");
  }

  return {
    repository: receipt.repository,
    commit: receipt.commit,
    appImageSha256: receipt.appImageSha256,
    cliSha256: receipt.cliSha256,
    appImagePath,
    cliPath,
    receiptPath,
  };
}

export function buildAndInstallAoRuntime({
  home,
  checkoutPath,
  dependency,
  platform = process.platform,
  architecture = process.arch,
  verifyRepository = verifyDependencyRepository,
  runCommand = defaultRunCommand,
} = {}) {
  if (platform !== "linux" || architecture !== "x64") {
    throw new Error(`AO runtime builds currently support Linux x64 only; received ${platform} ${architecture}.`);
  }
  const checkout = resolve(checkoutPath);
  verifyRepository("agent-orchestrator", dependency, checkout);
  const releaseRepository = githubRepositoryName(dependency.repository);
  const buildDirectory = mkdtempSync(join(tmpdir(), "dark-factory-ao-build-"));
  const buildCheckout = join(buildDirectory, "source");
  const builtCli = join(buildDirectory, "ao");
  const frontend = join(buildCheckout, "frontend");
  const makeDirectory = join(frontend, "out", "make");

  try {
    runChecked(runCommand, "git", [
      "clone",
      "--local",
      "--no-hardlinks",
      "--no-checkout",
      checkout,
      buildCheckout,
    ], { cwd: buildDirectory, env: process.env });
    runChecked(runCommand, "git", [
      "checkout",
      "--detach",
      dependency.commit,
    ], { cwd: buildCheckout, env: process.env });

    runChecked(runCommand, "go", [
      "build",
      "-ldflags",
      [
        `-X github.com/aoagents/agent-orchestrator/backend/internal/cli.Commit=${dependency.commit}`,
        `-X github.com/aoagents/agent-orchestrator/backend/internal/cli.releaseRepo=${releaseRepository}`,
      ].join(" "),
      "-o",
      builtCli,
      "./cmd/ao",
    ], { cwd: join(buildCheckout, "backend"), env: process.env });

    runChecked(runCommand, "npm", ["ci"], { cwd: frontend, env: process.env });
    rmSync(makeDirectory, { recursive: true, force: true });
    runChecked(runCommand, "npm", [
      "run",
      "make",
      "--",
      "--platform=linux",
      "--arch=x64",
      "--targets=appimage",
    ], {
      cwd: frontend,
      env: { ...process.env, AO_RELEASE_REPO: releaseRepository },
    });

    const appImages = findAppImages(makeDirectory);
    if (appImages.length !== 1) {
      throw new Error(`AO desktop build produced ${appImages.length} AppImages; expected exactly one.`);
    }
    return installAoRuntimeArtifacts({
      home,
      appImagePath: appImages[0],
      cliPath: builtCli,
      dependency,
    });
  } finally {
    rmSync(buildDirectory, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  const options = { home: "", checkoutPath: "", lockPath: DEFAULT_LOCK_PATH };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--home") options.home = argv[++index] ?? "";
    else if (argv[index] === "--checkout") options.checkoutPath = argv[++index] ?? "";
    else if (argv[index] === "--lock") options.lockPath = resolve(argv[++index] ?? "");
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  return options;
}

function main() {
  try {
    const options = parseCli(process.argv);
    const lock = readDependencyLock(options.lockPath);
    const dependency = lock.repositories["agent-orchestrator"];
    const checkoutPath = options.checkoutPath
      || process.env[dependency.checkout.environment]
      || resolve(dirname(options.lockPath), "..", dependency.checkout.defaultSibling);
    const result = buildAndInstallAoRuntime({
      home: options.home,
      checkoutPath,
      dependency,
    });
    console.log(`PASS installed pinned AO runtime ${result.commit}`);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) main();
