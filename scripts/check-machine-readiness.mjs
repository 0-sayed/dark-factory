#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function commandResult(name, command, args, runCommand) {
  const result = runCommand(command, args);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`${name} is not ready: ${detail}`);
  }
  return {
    name,
    output: String(result.stdout || result.stderr).trim(),
  };
}

export function verifyMachineReadiness({
  home,
  platform = process.platform,
  runCommand = defaultRunCommand,
  exists = existsSync,
} = {}) {
  if (platform !== "linux") {
    throw new Error(`Linux is the only supported platform; received ${platform}.`);
  }
  if (!home) throw new Error("Machine readiness requires an explicit home path.");

  const checks = [
    ["node", "node", ["--version"]],
    ["npm", "npm", ["--version"]],
    ["corepack", "corepack", ["--version"]],
    ["go", "go", ["version"]],
    ["pnpm", "pnpm", ["--version"]],
    ["bun", "bun", ["--version"]],
    ["python", "python3", ["--version"]],
    ["git", "git", ["--version"]],
    ["docker", "docker", ["--version"]],
    ["docker-compose", "docker", ["compose", "version"]],
    ["process-discovery", "pgrep", ["--version"]],
    ["process-termination", "pkill", ["--version"]],
    ["file-locking", "flock", ["--version"]],
    ["agent-browser", "agent-browser", ["--version"]],
    ["google-chrome", "google-chrome", ["--version"]],
    ["tmux", "tmux", ["-V"]],
    ["sqlite", "sqlite3", ["--version"]],
    ["patchutils", "filterdiff", ["--version"]],
    ["bash", "bash", ["--version"]],
    ["curl", "curl", ["--version"]],
  ].map(([name, command, args]) => commandResult(name, command, args, runCommand));

  try {
    checks.push(commandResult("port-inspection", "ss", ["--version"], runCommand));
  } catch {
    checks.push(commandResult("port-inspection", "lsof", ["-v"], runCommand));
  }

  const codexAuth = commandResult("codex-auth", "codex", ["login", "status"], runCommand);
  if (!/logged in/i.test(codexAuth.output)) {
    throw new Error(`Codex is not authenticated: ${codexAuth.output || "no login status"}`);
  }
  checks.push(codexAuth);

  const plugins = commandResult("superpowers-plugin", "codex", ["plugin", "list"], runCommand);
  if (!/superpowers@\S+\s+installed, enabled\s+6\.0\.3\b/i.test(plugins.output)) {
    throw new Error("Superpowers Codex plugin 6.0.3 is not installed and enabled.");
  }
  checks.push(plugins);

  const conflictSkill = join(resolve(home), ".agents", "skills", "fix-merge-conflicts", "SKILL.md");
  if (!exists(conflictSkill)) {
    throw new Error(`fix-merge-conflicts skill is missing: ${conflictSkill}`);
  }
  checks.push({ name: "fix-merge-conflicts", output: conflictSkill });

  checks.push(commandResult("github-auth", "gh", ["api", "user", "--jq", ".login"], runCommand));

  const aoDaemon = commandResult("ao-daemon", "ao", ["status", "--json"], runCommand);
  let aoStatus;
  try {
    aoStatus = JSON.parse(aoDaemon.output);
  } catch {
    throw new Error(`AO returned invalid status JSON: ${aoDaemon.output || "<empty>"}`);
  }
  if (aoStatus.state !== "ready") {
    throw new Error(`AO daemon is ${aoStatus.state ?? "not running"}; run ao start and wait for it to become ready.`);
  }
  checks.push(aoDaemon);

  return { platform, checks };
}

function main() {
  try {
    const result = verifyMachineReadiness({ home: process.env.HOME });
    console.log(`PASS ${result.checks.length} live machine readiness checks`);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) main();
