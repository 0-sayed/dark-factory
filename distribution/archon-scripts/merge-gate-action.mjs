#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeWorktreeFile } from './worktree-state.mjs';

const STATE_FILE = resolve(process.cwd(), '.archon/state/merge-gate-preflight.json');
const MERGE_STATUS_FILE = resolve(process.cwd(), '.archon/state/merge-status.json');
const UPDATE_STATE_FILE = resolve(process.cwd(), '.archon/state/merge-gate-update.json');

function ghEnv() {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

function runGh(args) {
  return execFileSync('gh', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: ghEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ghJson(args) {
  return JSON.parse(runGh(args));
}

function readState() {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function writeJson(path, value) {
  writeWorktreeFile(path, `${JSON.stringify(value)}\n`);
}

function sleep(seconds) {
  execFileSync('sleep', [String(seconds)], { stdio: 'ignore' });
}

function prIsMerged(prNumber) {
  const pr = ghJson(['pr', 'view', String(prNumber), '--json', 'state,mergedAt,mergeStateStatus']);
  return pr.state === 'MERGED' || Boolean(pr.mergedAt);
}

function mergeReady() {
  const state = readState();
  if (state.status !== 'READY' || !state.headSha) {
    throw new Error(`Refusing to merge from state ${state.status}.`);
  }

  if (process.env.AUTO_MERGE_MODE === 'prepare') {
    writeJson(MERGE_STATUS_FILE, {
      status: 'READY_TO_MERGE',
      prNumber: state.prNumber,
      headSha: state.headSha,
      readyAt: new Date().toISOString(),
    });
    process.stdout.write('READY_TO_MERGE');
    return;
  }

  runGh(['pr', 'merge', '--merge', '--match-head-commit', state.headSha]);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (prIsMerged(state.prNumber)) {
      writeJson(MERGE_STATUS_FILE, {
        status: 'MERGED',
        prNumber: state.prNumber,
        headSha: state.headSha,
        mergedAt: new Date().toISOString(),
      });
      process.stdout.write('MERGED');
      return;
    }

    sleep(10);
  }

  writeJson(MERGE_STATUS_FILE, {
    status: 'BLOCKED',
    prNumber: state.prNumber,
    headSha: state.headSha,
    reason: 'GitHub accepted the merge request but did not immediately merge it. Merge queue mode is not supported by this workflow.',
    blockedAt: new Date().toISOString(),
  });
  throw new Error('Merge queue mode is not supported by this workflow.');
}

function updateBranch(state) {
  try {
    runGh(['pr', 'update-branch', String(state.prNumber)]);
    writeJson(UPDATE_STATE_FILE, {
      status: 'UPDATED',
      prNumber: state.prNumber,
      checkedAt: new Date().toISOString(),
    });
    return 'UPDATED';
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr) : '';
    writeJson(UPDATE_STATE_FILE, {
      status: 'FAILED',
      prNumber: state.prNumber,
      reason: stderr.trim() || 'Branch update failed.',
      checkedAt: new Date().toISOString(),
    });
    writeJson(MERGE_STATUS_FILE, {
      status: 'BLOCKED',
      prNumber: state.prNumber,
      headSha: state.headSha,
      reason: stderr.trim() || 'Branch update failed.',
      blockedAt: new Date().toISOString(),
    });
    return 'FAILED';
  }
}

const command = process.argv[2];
if (command === 'merge-ready') {
  mergeReady();
} else if (command === 'update-branch') {
  process.stdout.write(updateBranch(readState()));
} else {
  throw new Error(`Unknown merge-gate action: ${command}`);
}
