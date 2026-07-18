import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { verifyMachineReadiness } from "../scripts/check-machine-readiness.mjs";

function successfulRunner(overrides = {}) {
  const outputs = {
    "node --version": "v22.14.0\n",
    "npm --version": "10.9.2\n",
    "corepack --version": "0.31.0\n",
    "go version": "go version go1.26.5 linux/amd64\n",
    "pnpm --version": "10.26.2\n",
    "bun --version": "1.3.6\n",
    "python3 --version": "Python 3.12.3\n",
    "git --version": "git version 2.52.0\n",
    "docker --version": "Docker version 29.1.3\n",
    "docker compose version": "Docker Compose version v2.32.4\n",
    "pgrep --version": "pgrep from procps-ng 4.0.4\n",
    "pkill --version": "pkill from procps-ng 4.0.4\n",
    "flock --version": "flock from util-linux 2.39.3\n",
    "agent-browser --version": "agent-browser 0.24.1\n",
    "google-chrome --version": "Google Chrome 140.0\n",
    "tmux -V": "tmux 3.2a\n",
    "sqlite3 --version": "3.37.2\n",
    "filterdiff --version": "filterdiff - patchutils version 0.4.2\n",
    "bash --version": "GNU bash, version 5.1\n",
    "curl --version": "curl 8.5.0\n",
    "ss --version": "ss utility, iproute2\n",
    "codex login status": "Logged in using ChatGPT\n",
    "codex plugin list": "superpowers@superpowers-dev  installed, enabled  6.0.3\n",
    "gh api user --jq .login": "0-sayed\n",
    "ao status --json": '{"state":"ready","health":"ok"}\n',
    ...overrides,
  };

  return (command, args) => {
    const key = [command, ...args].join(" ");
    if (!(key in outputs)) return { status: 127, stdout: "", stderr: `${command}: not found` };
    const value = outputs[key];
    if (typeof value === "object") return value;
    return { status: 0, stdout: value, stderr: "" };
  };
}

test("machine readiness verifies the live control-plane dependencies", () => {
  const home = "/test-home";
  const result = verifyMachineReadiness({
    home,
    platform: "linux",
    runCommand: successfulRunner(),
    exists: (path) => path === join(home, ".agents", "skills", "fix-merge-conflicts", "SKILL.md"),
  });

  assert.equal(result.platform, "linux");
  assert(result.checks.some((check) => check.name === "ao-daemon"));
  assert(result.checks.some((check) => check.name === "github-auth"));
  assert(result.checks.some((check) => check.name === "superpowers-plugin"));
  assert(result.checks.some((check) => check.name === "docker-compose"));
  assert(result.checks.some((check) => check.name === "process-discovery"));
  assert(result.checks.some((check) => check.name === "process-termination"));
  assert(result.checks.some((check) => check.name === "file-locking"));
});

test("machine readiness rejects a stopped AO daemon", () => {
  assert.throws(
    () => verifyMachineReadiness({
      home: "/test-home",
      platform: "linux",
      runCommand: successfulRunner({
        "ao status --json": '{"state":"stopped"}\n',
      }),
      exists: () => true,
    }),
    /AO daemon is stopped/i,
  );
});

test("machine readiness rejects a non-ready AO daemon", () => {
  assert.throws(
    () => verifyMachineReadiness({
      home: "/test-home",
      platform: "linux",
      runCommand: successfulRunner({
        "ao status --json": '{"state":"starting"}\n',
      }),
      exists: () => true,
    }),
    /AO daemon is starting/i,
  );
});

test("machine readiness reports missing external skills", () => {
  assert.throws(
    () => verifyMachineReadiness({
      home: "/test-home",
      platform: "linux",
      runCommand: successfulRunner(),
      exists: () => false,
    }),
    /fix-merge-conflicts/i,
  );
});

test("machine readiness rejects unsupported operating systems", () => {
  assert.throws(
    () => verifyMachineReadiness({
      home: "/test-home",
      platform: "darwin",
      runCommand: successfulRunner(),
      exists: () => true,
    }),
    /Linux is the only supported platform/i,
  );
});
