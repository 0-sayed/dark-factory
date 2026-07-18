#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const archonHome = process.env.ARCHON_HOME || join(homedir(), '.archon');
const PREFLIGHT = process.env.MERGE_GATE_PREFLIGHT_SCRIPT || join(archonHome, 'scripts', 'merge-gate-preflight.mjs');
const PREFLIGHT_STATE = resolve(process.cwd(), '.archon/state/merge-gate-preflight.json');
const RESOLUTION_STATE = resolve(process.cwd(), '.archon/state/merge-gate-resolution.json');
const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;

function parseArgs(argv) {
  const args = {
    expectedHeadSha: process.env.MERGE_GATE_EXPECTED_HEAD_SHA || '',
    pollIntervalSeconds: Number(process.env.MERGE_GATE_POLL_INTERVAL_SECONDS || DEFAULT_POLL_INTERVAL_SECONDS),
    timeoutSeconds: Number(process.env.MERGE_GATE_TIMEOUT_SECONDS || DEFAULT_TIMEOUT_SECONDS),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--timeout-seconds') {
      args.timeoutSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--poll-interval-seconds') {
      args.pollIntervalSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--expected-head-sha') {
      args.expectedHeadSha = String(argv[index + 1] || '');
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function envWithoutGhToken() {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

function runPreflight() {
  return execFileSync('node', [PREFLIGHT], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: envWithoutGhToken(),
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function readPreflightState() {
  try {
    const raw = readFileSync(PREFLIGHT_STATE, 'utf8').trim();
    return {
      raw,
      json: raw ? JSON.parse(raw) : null,
    };
  } catch {
    return {
      raw: '',
      json: null,
    };
  }
}

function readExpectedHeadSha(args) {
  if (args.expectedHeadSha) return args.expectedHeadSha;

  try {
    const state = JSON.parse(readFileSync(RESOLUTION_STATE, 'utf8'));
    return String(state.headSha || '');
  } catch {
    return '';
  }
}

function isWaitingForExpectedHead(state, expectedHeadSha) {
  return Boolean(
    expectedHeadSha
    && state?.headSha
    && state.headSha !== expectedHeadSha,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const expectedHeadSha = readExpectedHeadSha(args);
  const deadline = Date.now() + args.timeoutSeconds * 1000;

  while (true) {
    const status = runPreflight();
    const state = readPreflightState();

    if (isWaitingForExpectedHead(state.json, expectedHeadSha)) {
      if (Date.now() >= deadline) {
        if (state.raw) {
          console.error(state.raw);
        }
        throw new Error(`Timed out waiting for PR head ${expectedHeadSha}.`);
      }

      console.error(`PR is still reporting head ${state.json.headSha}; waiting for ${expectedHeadSha}. Rechecking in ${args.pollIntervalSeconds}s.`);
      sleepSync(args.pollIntervalSeconds * 1000);
      continue;
    }

    if (status === 'READY') {
      process.stdout.write('READY');
      return;
    }

    if (status !== 'PENDING') {
      if (state.raw) {
        console.error(state.raw);
      }
      throw new Error(`PR did not become ready: ${status}`);
    }

    if (Date.now() >= deadline) {
      if (state.raw) {
        console.error(state.raw);
      }
      throw new Error(`Timed out waiting for PR readiness after ${args.timeoutSeconds}s.`);
    }

    console.error(`PR readiness is pending. Rechecking in ${args.pollIntervalSeconds}s.`);
    sleepSync(args.pollIntervalSeconds * 1000);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unknown merge-gate wait error.');
  process.exitCode = 1;
}
