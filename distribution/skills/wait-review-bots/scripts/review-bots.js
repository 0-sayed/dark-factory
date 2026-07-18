#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, isAbsolute, relative, resolve, sep } = require('node:path');

const DEFAULT_STATE_FILE = '.archon/.state/review-bots.json';
const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;
const DEFAULT_QUIET_WINDOW_SECONDS = 600;
const GH_RETRY_DELAYS_MS = [1000, 3000, 5000];

function usage() {
  console.error(
    [
      'Usage:',
      '  capture [--force] [--state-file PATH]',
      '  wait [--state-file PATH] [--quiet-window-seconds N] [--timeout-seconds N] [--poll-interval-seconds N]',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const parsed = {
    command: argv[0],
    force: false,
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
    quietWindowSeconds: DEFAULT_QUIET_WINDOW_SECONDS,
    stateFile: DEFAULT_STATE_FILE,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--force') {
      parsed.force = true;
      continue;
    }

    if (arg === '--state-file') {
      parsed.stateFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--quiet-window-seconds') {
      parsed.quietWindowSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--timeout-seconds') {
      parsed.timeoutSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--poll-interval-seconds') {
      parsed.pollIntervalSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ghOutput(args) {
  let lastError;

  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return execFileSync('gh', args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      lastError = error;

      if (attempt === GH_RETRY_DELAYS_MS.length) {
        break;
      }

      const delay = GH_RETRY_DELAYS_MS[attempt];
      const stderr = error && error.stderr ? String(error.stderr).trim() : '';
      console.error(
        `gh ${args.join(' ')} failed; retrying in ${Math.round(delay / 1000)}s${
          stderr ? `: ${stderr}` : '.'
        }`,
      );
      sleepSync(delay);
    }
  }

  throw lastError;
}

function ghJson(args) {
  return JSON.parse(ghOutput(args));
}

function ghJsonOrNull(args) {
  try {
    return ghJson(args);
  } catch {
    return null;
  }
}

function ghPaginated(endpoint) {
  const response = ghJson(['api', '--paginate', '--slurp', endpoint]);

  if (!Array.isArray(response)) {
    return [];
  }

  return response.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

function gitOutput(args) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function getStatePath(stateFile) {
  const root = realpathSync(process.cwd());
  const statePath = resolve(root, stateFile || DEFAULT_STATE_FILE);
  const rel = relative(root, statePath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing review state path outside the worktree: ${statePath}`);
  }
  return statePath;
}

function isoNow() {
  return new Date().toISOString();
}

function writeState(statePath, state) {
  const root = realpathSync(process.cwd());
  const parent = dirname(statePath);
  let current = root;
  for (const part of relative(root, parent).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) {
      mkdirSync(current);
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked review state directory: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Review state parent is not a directory: ${current}`);
  }
  if (existsSync(statePath)) {
    const stat = lstatSync(statePath);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked review state file: ${statePath}`);
    if (!stat.isFile()) throw new Error(`Review state destination is not a regular file: ${statePath}`);
  }
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, statePath);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function parseTimestamp(value) {
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? null : milliseconds;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${String(remainder).padStart(2, '0')}s`;
}

function fetchRepo() {
  const repo = ghJson(['repo', 'view', '--json', 'owner,name']);
  return `${repo.owner.login}/${repo.name}`;
}

function fetchPullRequestFromCurrentContext() {
  const pr = ghJsonOrNull(['pr', 'view', '--json', 'number,headRefOid']);

  if (pr && pr.number && pr.headRefOid) {
    return {
      headSha: pr.headRefOid,
      prNumber: pr.number,
      source: 'branch',
    };
  }

  const repoFullName = fetchRepo();
  const headSha = gitOutput(['rev-parse', 'HEAD']);
  const pulls = ghJsonOrNull(['api', `repos/${repoFullName}/commits/${headSha}/pulls`]) || [];
  const openPull = pulls.find((entry) => entry.state === 'open') || pulls[0];

  if (!openPull || !openPull.number) {
    throw new Error(`No pull request found for current branch or HEAD commit ${headSha}.`);
  }

  const fullPr = ghJson(['api', `repos/${repoFullName}/pulls/${openPull.number}`]);

  return {
    headSha: fullPr.head.sha,
    prNumber: fullPr.number,
    source: 'commit',
  };
}

function fetchReviews(repoFullName, prNumber) {
  return ghPaginated(`repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`)
    .filter((entry) => entry && entry.submitted_at && entry.user && entry.user.login)
    .map((entry) => ({
      author: entry.user.login,
      commitId: entry.commit_id || null,
      timestamp: entry.submitted_at,
      type: 'review',
    }));
}

function fetchReviewComments(repoFullName, prNumber) {
  return ghPaginated(`repos/${repoFullName}/pulls/${prNumber}/comments?per_page=100`)
    .filter((entry) => entry && entry.created_at && entry.user && entry.user.login)
    .map((entry) => ({
      author: entry.user.login,
      commitId: entry.commit_id || null,
      timestamp: entry.created_at,
      type: 'review-comment',
    }));
}

function fetchIssueComments(repoFullName, prNumber) {
  return ghPaginated(`repos/${repoFullName}/issues/${prNumber}/comments?per_page=100`)
    .filter((entry) => entry && entry.created_at && entry.user && entry.user.login)
    .map((entry) => ({
      author: entry.user.login,
      commitId: null,
      timestamp: entry.created_at,
      type: 'issue-comment',
    }));
}

function fetchNewActivity(state) {
  const reviews = fetchReviews(state.repoFullName, state.prNumber).filter(
    (entry) =>
      entry.commitId === state.headSha &&
      parseTimestamp(entry.timestamp) > parseTimestamp(state.lastActivityAt),
  );
  const reviewComments = fetchReviewComments(state.repoFullName, state.prNumber).filter(
    (entry) =>
      entry.commitId === state.headSha &&
      parseTimestamp(entry.timestamp) > parseTimestamp(state.lastActivityAt),
  );
  const issueComments = fetchIssueComments(state.repoFullName, state.prNumber).filter(
    (entry) => parseTimestamp(entry.timestamp) > parseTimestamp(state.lastActivityAt),
  );

  return [...reviews, ...reviewComments, ...issueComments].sort(
    (left, right) => parseTimestamp(left.timestamp) - parseTimestamp(right.timestamp),
  );
}

function capture(args) {
  const statePath = getStatePath(args.stateFile);

  if (existsSync(statePath) && !args.force) {
    throw new Error(`State file already exists at ${statePath}. Re-run with --force.`);
  }

  const repoFullName = fetchRepo();
  const pr = fetchPullRequestFromCurrentContext();
  const capturedAt = isoNow();
  const state = {
    capturedAt,
    headSha: pr.headSha,
    lastActivityAt: capturedAt,
    lastActivitySummary: 'capture',
    prNumber: pr.prNumber,
    repoFullName,
    resolvedVia: pr.source,
  };

  writeState(statePath, state);

  console.log(`Captured PR #${state.prNumber} at ${state.headSha} via ${state.resolvedVia}.`);
}

function ensureCurrentPrState(state) {
  const repoPr = ghJson(['api', `repos/${state.repoFullName}/pulls/${state.prNumber}`]);
  const currentHeadSha = repoPr.head && repoPr.head.sha;

  if (!currentHeadSha) {
    throw new Error(`Unable to read current head SHA for PR #${state.prNumber}.`);
  }

  if (currentHeadSha !== state.headSha) {
    throw new Error(
      `Stored head ${state.headSha} is stale. Current PR head is ${currentHeadSha}. Re-run capture.`,
    );
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForQuietWindow(args) {
  const statePath = getStatePath(args.stateFile);

  if (!existsSync(statePath)) {
    throw new Error(`No state file found at ${statePath}. Run capture first.`);
  }

  const startedAt = Date.now();

  while (true) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    ensureCurrentPrState(state);

    const activity = fetchNewActivity(state);

    if (activity.length > 0) {
      const latest = activity[activity.length - 1];
      state.lastActivityAt = latest.timestamp;
      state.lastActivitySummary = `${latest.type}:${latest.author}`;
      writeState(statePath, state);
    }

    const quietForSeconds = (Date.now() - parseTimestamp(state.lastActivityAt)) / 1000;
    const quietRemainingSeconds = Math.max(0, args.quietWindowSeconds - quietForSeconds);

    console.log(
      [
        `PR #${state.prNumber} @ ${state.headSha}`,
        `last-activity=${state.lastActivitySummary}@${state.lastActivityAt}`,
        `quiet-for=${formatDuration(quietForSeconds)}`,
        `quiet-remaining=${formatDuration(quietRemainingSeconds)}`,
      ].join(' | '),
    );

    if (quietForSeconds >= args.quietWindowSeconds) {
      console.log('Review activity is quiet. Continuing.');
      return;
    }

    if ((Date.now() - startedAt) / 1000 >= args.timeoutSeconds) {
      throw new Error(
        `Timed out waiting for a ${formatDuration(
          args.quietWindowSeconds,
        )} quiet window. Last activity was ${state.lastActivitySummary} at ${state.lastActivityAt}.`,
      );
    }

    await sleep(args.pollIntervalSeconds * 1000);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'capture') {
    capture(args);
    return;
  }

  if (args.command === 'wait') {
    await waitForQuietWindow(args);
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Unknown review wait error.');
  process.exitCode = 1;
});
