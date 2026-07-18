#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_MAX_CYCLES = 5;
const DEFAULT_QUIET_WINDOW_SECONDS = 300;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;

const MERGE_STATUS_FILE = resolve(process.cwd(), '.archon/state/merge-status.json');
const MERGE_PREFLIGHT_FILE = resolve(process.cwd(), '.archon/state/merge-gate-preflight.json');

function parseArgs(argv) {
  const args = {
    mode: process.env.AUTO_MERGE_MODE || 'finalize',
    maxCycles: Number(process.env.AUTO_MERGE_MAX_CYCLES || DEFAULT_MAX_CYCLES),
    quietWindowSeconds: Number(process.env.AUTO_MERGE_QUIET_WINDOW_SECONDS || DEFAULT_QUIET_WINDOW_SECONDS),
    timeoutSeconds: Number(process.env.AUTO_MERGE_TIMEOUT_SECONDS || DEFAULT_TIMEOUT_SECONDS),
    pollIntervalSeconds: Number(process.env.AUTO_MERGE_POLL_INTERVAL_SECONDS || DEFAULT_POLL_INTERVAL_SECONDS),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--max-cycles') {
      args.maxCycles = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--mode') {
      args.mode = String(argv[index + 1] || '');
      index += 1;
      continue;
    }

    if (arg === '--quiet-window-seconds') {
      args.quietWindowSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }

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

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.mode === 'merge') {
    args.mode = 'finalize';
  }

  if (!['prepare', 'finalize'].includes(args.mode)) {
    throw new Error('mode must be prepare or finalize.');
  }

  for (const [key, value] of Object.entries(args)) {
    if (key === 'mode') continue;
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${key} must be a positive number.`);
    }
  }

  return args;
}

function envWithoutGhToken() {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...envWithoutGhToken(), ...(options.env || {}) },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: envWithoutGhToken(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    return null;
  }

  return result.stdout.trim();
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function clearStaleWorkflowResumeState(workflowName) {
  const archonHome = process.env.ARCHON_HOME || `${process.env.HOME}/.archon`;
  const dbPath = resolve(archonHome, 'archon.db');

  if (!existsSync(dbPath)) {
    return;
  }

  let workingPath = process.cwd();
  try {
    workingPath = realpathSync(workingPath);
  } catch {
    // Keep the logical cwd if the path cannot be resolved.
  }

  const sql = [
    'update remote_agent_workflow_runs',
    "set status = 'superseded',",
    "metadata = json_set(coalesce(metadata, '{}'), '$.supersededBy', 'auto-merge-fresh-run'),",
    "completed_at = coalesce(completed_at, datetime('now')),",
    "last_activity_at = datetime('now')",
    `where workflow_name = ${sqlString(workflowName)}`,
    `and working_path = ${sqlString(workingPath)}`,
    "and status in ('failed', 'pending', 'running');",
  ].join(' ');

  const result = spawnSync('sqlite3', [dbPath, sql], {
    cwd: process.cwd(),
    env: envWithoutGhToken(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return;
  }

  if ((result.status ?? 1) !== 0 && result.stderr.trim()) {
    console.error(`Unable to clear stale Archon workflow state: ${result.stderr.trim()}`);
  }
}

function readMergeStatus() {
  if (!existsSync(MERGE_STATUS_FILE)) {
    return null;
  }

  return JSON.parse(readFileSync(MERGE_STATUS_FILE, 'utf8'));
}

function readAutoSquashState() {
  const statePath = resolve(process.cwd(), '.archon/.state/review-cycle.json');

  if (!existsSync(statePath)) {
    return null;
  }

  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function canMergeGateRecoverAutoSquashFailure() {
  const state = readAutoSquashState();
  const requiredSummary = state?.requiredCheckSummary;
  const visibleSummary = state?.visibleCheckSummary;
  const hasFailedChecks = [requiredSummary, visibleSummary].some(
    (summary) => Array.isArray(summary?.failed) && summary.failed.length > 0,
  );

  // Review-cycle state is captured before its repair nodes run. Merge-gate must
  // get one chance to inspect fresh PR state after a final-cycle repair.
  return (
    state?.signal === 'CONTINUE'
    && Number(state.unresolvedThreadCount || 0) === 0
    && hasFailedChecks
    && Array.isArray(requiredSummary?.pending)
    && requiredSummary.pending.length === 0
  );
}

function runAutoSquash(args) {
  const skillsDir = process.env.AGENTS_SKILLS_DIR || `${process.env.HOME}/.agents/skills`;
  const script = `${skillsDir}/auto-squash/scripts/review-cycle.js`;
  const status = run('node', [
    script,
    'run',
    '--workflow',
    'auto-squash',
    '--state-file',
    '.archon/.state/review-cycle.json',
    '--quiet-state-file',
    '.archon/.state/review-bots.json',
    '--quiet-window-seconds',
    String(args.quietWindowSeconds),
    '--timeout-seconds',
    String(args.timeoutSeconds),
    '--poll-interval-seconds',
    String(args.pollIntervalSeconds),
  ]);

  if (status !== 0) {
    if (canMergeGateRecoverAutoSquashFailure()) {
      console.error('auto-squash stopped on failed checks with no unresolved review threads; handing off to merge-gate.');
      return;
    }

    throw new Error(`auto-squash exited with status ${status}.`);
  }
}

function runAutoMerge(mode) {
  rmSync(MERGE_STATUS_FILE, { force: true });
  rmSync(MERGE_PREFLIGHT_FILE, { force: true });
  clearStaleWorkflowResumeState('merge-gate');
  const headSha = runCapture('git', ['rev-parse', '--verify', 'HEAD']) || 'unknown-head';
  const conversationId = `auto-merge-${mode}-${headSha}-${Date.now()}`;

  return run('archon', [
    'workflow',
    'run',
    'merge-gate',
    '--no-worktree',
    '--conversation-id',
    conversationId,
    mode === 'prepare'
      ? 'Make the current PR mergeable and stop when it is ready for the external merge queue.'
      : 'Make the current PR mergeable and merge it if safe.',
  ], {
    env: mode === 'prepare' ? { AUTO_MERGE_MODE: 'prepare' } : {},
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  for (let cycle = 1; cycle <= args.maxCycles; cycle += 1) {
    console.error(`auto-merge cycle ${cycle}/${args.maxCycles}: running auto-squash`);
    runAutoSquash(args);

    console.error(`auto-merge cycle ${cycle}/${args.maxCycles}: running merge-gate (${args.mode})`);
    const autoMergeStatus = runAutoMerge(args.mode);
    const mergeStatus = readMergeStatus();

    if (args.mode === 'prepare' && mergeStatus?.status === 'READY_TO_MERGE') {
      process.stdout.write('READY_TO_MERGE');
      return;
    }

    if (mergeStatus?.status === 'MERGED') {
      process.stdout.write('MERGED');
      return;
    }

    if (mergeStatus?.status === 'NEEDS_SQUASH' || mergeStatus?.status === 'PENDING') {
      console.error(`merge-gate returned ${mergeStatus.status}; starting another auto-merge cycle.`);
      continue;
    }

    if (mergeStatus?.status === 'BLOCKED') {
      throw new Error(`merge-gate blocked: ${mergeStatus.reason || 'unknown reason'}`);
    }

    throw new Error(
      `merge-gate exited with status ${autoMergeStatus} and did not write a recognized merge status.`,
    );
  }

  const target = args.mode === 'prepare' ? 'prepared' : 'merged';
  throw new Error(`PR was not ${target} after ${args.maxCycles} auto-merge cycles.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unknown auto-merge error.');
  process.exitCode = 1;
}
