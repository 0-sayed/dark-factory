#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readDependencyLock,
  verifyLockedDependencies,
  verifyLockedRuntimes,
} from "./verify-dependencies.mjs";
import { verifyMachineReadiness } from "./check-machine-readiness.mjs";
import { verifyAoRuntimeInstallation } from "./install-ao-runtime.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_MANIFEST_PATH = resolve(ROOT, "distribution", "manifest.json");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function resolveWithin(base, path, label) {
  if (!path || isAbsolute(path)) throw new Error(`${label} must be a relative path.`);
  const resolved = resolve(base, path);
  const fromBase = relative(base, resolved);
  if (fromBase.startsWith("..") || isAbsolute(fromBase)) {
    throw new Error(`${label} escapes its allowed root: ${path}`);
  }
  return resolved;
}

function listFiles(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Distribution assets cannot contain symlinks: ${path}`);
    if (entry.isDirectory()) return listFiles(path, base);
    if (!entry.isFile()) return [];
    return [{
      path,
      relativePath: relative(base, path).replaceAll("\\", "/"),
    }];
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function fileMode(path) {
  return statSync(path).mode & 0o777;
}

function portableFileMode(path) {
  return fileMode(path) & 0o111 ? 0o755 : 0o644;
}

export function hashTree(directory) {
  const digest = createHash("sha256");
  for (const file of listFiles(directory)) {
    digest.update(file.relativePath);
    digest.update("\0");
    digest.update(portableFileMode(file.path).toString(8));
    digest.update("\0");
    digest.update(sha256(readFileSync(file.path)));
    digest.update("\n");
  }
  return digest.digest("hex");
}

export function readManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.manifestVersion !== 1) throw new Error("Distribution manifest must use manifestVersion 1.");
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) {
    throw new Error("Distribution manifest must contain assets.");
  }

  const names = new Set();
  for (const asset of manifest.assets) {
    if (!asset?.name || names.has(asset.name)) throw new Error("Distribution asset names must be unique.");
    names.add(asset.name);
    if (!asset.source || !["install", "repository"].includes(asset.mode)) {
      throw new Error(`${asset.name} must define source and a supported mode.`);
    }
    if (asset.mode === "install" && !asset.target) {
      throw new Error(`${asset.name} must define an installation target.`);
    }
    if (!/^[a-f0-9]{64}$/i.test(asset.sha256 ?? "")) {
      throw new Error(`${asset.name} must define a SHA-256 tree checksum.`);
    }
  }
  return manifest;
}

export function verifySourceAssets({ root = ROOT, manifestPath = DEFAULT_MANIFEST_PATH } = {}) {
  const manifest = readManifest(manifestPath);
  return manifest.assets.map((asset) => {
    const sourcePath = resolveWithin(root, asset.source, `${asset.name} source`);
    if (!existsSync(sourcePath)) throw new Error(`${asset.name} source is missing: ${asset.source}`);
    const actual = hashTree(sourcePath);
    if (actual !== asset.sha256) {
      throw new Error(`${asset.name} source checksum differs from distribution/manifest.json.`);
    }
    return { ...asset, sourcePath };
  });
}

function requireHome(home) {
  if (!home) throw new Error("An explicit --home path is required.");
  return resolve(home);
}

function filesForInstall(asset, homePath) {
  const targetRoot = resolveWithin(homePath, asset.target, `${asset.name} target`);
  return listFiles(asset.sourcePath).map((file) => ({
    source: file.path,
    target: resolveWithin(targetRoot, file.relativePath, `${asset.name} file target`),
  }));
}

export function installAssets({
  root = ROOT,
  manifestPath = DEFAULT_MANIFEST_PATH,
  home,
  overwrite = false,
} = {}) {
  const homePath = requireHome(home);
  const assets = verifySourceAssets({ root, manifestPath }).filter((asset) => asset.mode === "install");
  const files = assets.flatMap((asset) => filesForInstall(asset, homePath));

  for (const file of files) {
    if (existsSync(file.target)) {
      const matches = sha256(readFileSync(file.source)) === sha256(readFileSync(file.target));
      if (!matches && !overwrite) {
        throw new Error(`Refusing to overwrite different installed file: ${file.target}`);
      }
    }
  }

  for (const file of files) {
    mkdirSync(dirname(file.target), { recursive: true });
    copyFileSync(file.source, file.target);
    chmodSync(file.target, fileMode(file.source));
  }

  return assets;
}

export function verifyInstalledAssets({
  root = ROOT,
  manifestPath = DEFAULT_MANIFEST_PATH,
  home,
} = {}) {
  const homePath = requireHome(home);
  const assets = verifySourceAssets({ root, manifestPath }).filter((asset) => asset.mode === "install");

  for (const asset of assets) {
    for (const file of filesForInstall(asset, homePath)) {
      if (!existsSync(file.target)) throw new Error(`Installed file is missing: ${file.target}`);
      if (sha256(readFileSync(file.source)) !== sha256(readFileSync(file.target))) {
        throw new Error(`Installed file differs from reviewed snapshot: ${file.target}`);
      }
      if (fileMode(file.source) !== fileMode(file.target)) {
        throw new Error(`Installed file mode differs from reviewed snapshot: ${file.target}`);
      }
    }
  }

  return assets;
}

export function refreshManifest({ root = ROOT, manifestPath = DEFAULT_MANIFEST_PATH } = {}) {
  const manifest = readManifest(manifestPath);
  const refreshed = {
    ...manifest,
    assets: manifest.assets.map((asset) => ({
      ...asset,
      sha256: hashTree(resolveWithin(root, asset.source, `${asset.name} source`)),
    })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(refreshed, null, 2)}\n`);
  return refreshed;
}

function parseCli(argv) {
  const options = { command: argv[2] ?? "", home: "", overwrite: false };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--home") options.home = argv[++index] ?? "";
    else if (argv[index] === "--overwrite") options.overwrite = true;
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  return options;
}

function main() {
  try {
    const options = parseCli(process.argv);
    if (options.command === "verify-source") {
      const assets = verifySourceAssets();
      console.log(`PASS ${assets.length} reviewed source asset groups`);
      return;
    }
    if (options.command === "refresh-manifest") {
      refreshManifest();
      console.log("PASS distribution manifest refreshed");
      return;
    }
    if (options.command === "install") {
      const assets = installAssets(options);
      console.log(`PASS installed ${assets.length} asset groups into ${resolve(options.home)}`);
      return;
    }
    if (options.command === "verify-install") {
      const assets = verifyInstalledAssets(options);
      console.log(`PASS ${assets.length} installed asset groups match the reviewed distribution`);
      return;
    }
    if (options.command === "doctor") {
      const lock = readDependencyLock();
      const dependencies = verifyLockedDependencies();
      const runtimes = verifyLockedRuntimes();
      const assets = verifyInstalledAssets(options);
      const aoRuntime = verifyAoRuntimeInstallation({
        home: options.home,
        dependency: lock.repositories["agent-orchestrator"],
      });
      const readiness = verifyMachineReadiness({ home: options.home });
      console.log(
        `PASS ${dependencies.length} pinned repositories, ${runtimes.length} active runtimes, pinned AO desktop ${aoRuntime.commit}, ${assets.length} installed asset groups, and ${readiness.checks.length} live readiness checks`,
      );
      return;
    }
    throw new Error("Usage: manage-distribution.mjs <verify-source|refresh-manifest|install|verify-install|doctor> [--home <path>] [--overwrite]");
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
