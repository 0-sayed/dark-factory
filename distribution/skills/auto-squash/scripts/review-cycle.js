#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

const DEFAULT_STATE_FILE = '.archon/.state/review-cycle.json';
const DEFAULT_QUIET_STATE_FILE = '.archon/.state/review-bots.json';
const DEFAULT_WORKFLOW = 'auto-squash';
const DEFAULT_MESSAGE =
  'Run one PR review pass. Stop only when review threads are clear and no reported PR checks are failing.';
const DEFAULT_MAX_CYCLES = 10;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 1800;
const DEFAULT_CHECK_POLL_INTERVAL_SECONDS = 30;
const SKILLS_DIR = process.env.AGENTS_SKILLS_DIR || join(homedir(), '.agents', 'skills');
const WAIT_SCRIPT = join(SKILLS_DIR, 'wait-review-bots', 'scripts', 'review-bots.js');
const GH_RETRY_DELAYS_MS = [1000, 3000, 5000];
const GRAPHQL_THREADS_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$cursor) {
        nodes {
          isResolved
          isOutdated
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

function usage() {
  console.error(
    [
      'Usage:',
      '  check-convos [--state-file PATH] [--check-timeout-seconds N] [--check-poll-interval-seconds N]',
      '  run [--workflow NAME] [--message TEXT] [--state-file PATH] [--quiet-state-file PATH] [--quiet-window-seconds N] [--timeout-seconds N] [--poll-interval-seconds N] [--check-timeout-seconds N] [--check-poll-interval-seconds N] [--max-cycles N]',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const parsed = {
    command: argv[0],
    checkPollIntervalSeconds: Number(
      process.env.AUTO_SQUASH_CHECK_POLL_INTERVAL_SECONDS || DEFAULT_CHECK_POLL_INTERVAL_SECONDS,
    ),
    checkTimeoutSeconds: Number(
      process.env.AUTO_SQUASH_CHECK_TIMEOUT_SECONDS || DEFAULT_CHECK_TIMEOUT_SECONDS,
    ),
    maxCycles: DEFAULT_MAX_CYCLES,
    message: DEFAULT_MESSAGE,
    pollIntervalSeconds: 30,
    quietStateFile: DEFAULT_QUIET_STATE_FILE,
    quietWindowSeconds: 300,
    stateFile: DEFAULT_STATE_FILE,
    timeoutSeconds: 1800,
    workflow: DEFAULT_WORKFLOW,
    runToken: `${Date.now()}-${process.pid}`,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--workflow') {
      parsed.workflow = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--message') {
      parsed.message = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--state-file') {
      parsed.stateFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--quiet-state-file') {
      parsed.quietStateFile = argv[index + 1];
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

    if (arg === '--check-timeout-seconds') {
      parsed.checkTimeoutSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--check-poll-interval-seconds') {
      parsed.checkPollIntervalSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--max-cycles') {
      parsed.maxCycles = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--run-token') {
      parsed.runToken = argv[index + 1];
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

function ghOutput(args, options = {}) {
  let lastError;
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return execFileSync('gh', args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      lastError = error;

      if (
        attempt === GH_RETRY_DELAYS_MS.length ||
        (options.shouldRetry && !options.shouldRetry(error))
      ) {
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

function ghJson(args, options) {
  return JSON.parse(ghOutput(args, options));
}

function ghJsonOrNull(args) {
  try {
    return ghJson(args);
  } catch {
    return null;
  }
}

function gitOutput(args) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function execInherit(command, args, extraEnv = {}) {
  execFileSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
}

function getStatePath(filePath) {
  return resolve(process.cwd(), filePath);
}

function writeState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function clearStateFile(stateFile) {
  const statePath = getStatePath(stateFile);

  if (existsSync(statePath)) {
    rmSync(statePath);
  }
}

function fetchRepo() {
  const repo = ghJson(['repo', 'view', '--json', 'owner,name']);
  return `${repo.owner.login}/${repo.name}`;
}

function fetchPullRequestFromCurrentContext() {
  const pr = ghJsonOrNull(['pr', 'view', '--json', 'number,headRefOid,mergeable,mergeStateStatus']);

  if (pr && pr.number && pr.headRefOid) {
    return {
      headSha: pr.headRefOid,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
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
    mergeable: fullPr.mergeable ? 'MERGEABLE' : undefined,
    mergeStateStatus: fullPr.mergeable_state ? String(fullPr.mergeable_state).toUpperCase() : undefined,
    prNumber: fullPr.number,
    source: 'commit',
  };
}

function fetchUnresolvedThreadCount(repoFullName, prNumber) {
  const [owner, repo] = repoFullName.split('/');
  let hasNextPage = true;
  let cursor = null;
  let unresolvedCount = 0;

  while (hasNextPage) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${GRAPHQL_THREADS_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `repo=${repo}`,
      '-F',
      `number=${prNumber}`,
    ];

    if (cursor) {
      args.push('-F', `cursor=${cursor}`);
    }

    const response = ghJson(args);
    const threads = response.data.repository.pullRequest.reviewThreads;

    unresolvedCount += threads.nodes.filter(
      (thread) => !thread.isResolved && !thread.isOutdated,
    ).length;
    hasNextPage = threads.pageInfo.hasNextPage;
    cursor = threads.pageInfo.endCursor;
  }

  return unresolvedCount;
}

function isNoRequiredChecksError(error) {
  return Boolean(
    error &&
      error.stderr &&
      String(error.stderr).toLowerCase().includes('no required checks reported'),
  );
}

function fetchRequiredChecks() {
  try {
    return {
      checkScope: 'required',
      requiredChecks: ghJson(
        ['pr', 'checks', '--required', '--json', 'bucket,name,state,workflow'],
        { shouldRetry: (error) => !isNoRequiredChecksError(error) },
      ),
    };
  } catch (error) {
    if (!isNoRequiredChecksError(error)) {
      throw error;
    }

    return {
      checkScope: 'all',
      requiredChecks: ghJson(['pr', 'checks', '--json', 'bucket,name,state,workflow']),
    };
  }
}

function summarizeRequiredChecks(requiredChecks) {
  const summary = {
    failed: [],
    passed: [],
    pending: [],
    skipped: [],
  };

  for (const check of requiredChecks) {
    const bucket = String(check.bucket || '').toLowerCase();
    const normalized = {
      bucket: check.bucket,
      name: check.name,
      state: check.state,
      workflow: check.workflow,
    };

    if (bucket === 'pass') {
      summary.passed.push(normalized);
      continue;
    }

    if (bucket === 'fail' || bucket === 'cancel') {
      summary.failed.push(normalized);
      continue;
    }

    if (bucket === 'skipping') {
      summary.skipped.push(normalized);
      continue;
    }

    summary.pending.push(normalized);
  }

  return summary;
}

function includeVisibleChecks(checks) {
  const visibleChecks =
    checks.checkScope === 'all'
      ? checks.requiredChecks
      : ghJson(['pr', 'checks', '--json', 'bucket,name,state,workflow']);

  return {
    ...checks,
    visibleChecks,
    visibleCheckSummary: summarizeRequiredChecks(visibleChecks),
  };
}

function isMergeConflict(pr) {
  return pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY';
}

function waitForRequiredChecks(args) {
  const deadline = Date.now() + args.checkTimeoutSeconds * 1000;
  let checkScope = 'required';
  let lastChecks = [];
  let lastSummary = summarizeRequiredChecks(lastChecks);

  while (true) {
    const fetched = fetchRequiredChecks();
    checkScope = fetched.checkScope;
    lastChecks = fetched.requiredChecks;
    lastSummary = summarizeRequiredChecks(lastChecks);

    if (lastSummary.failed.length > 0 || lastSummary.pending.length === 0) {
      return {
        checkScope,
        requiredChecks: lastChecks,
        requiredCheckSummary: lastSummary,
      };
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Required checks are still pending after ${args.checkTimeoutSeconds}s: ${lastSummary.pending
          .map((check) => check.name)
          .join(', ')}`,
      );
    }

    console.error(
      `Required checks still pending: ${lastSummary.pending
        .map((check) => check.name)
        .join(', ')}. Rechecking in ${args.checkPollIntervalSeconds}s.`,
    );
    sleepSync(args.checkPollIntervalSeconds * 1000);
  }
}

function checkConvos(args) {
  const statePath = getStatePath(args.stateFile);
  const repoFullName = fetchRepo();
  const pr = fetchPullRequestFromCurrentContext();
  const unresolvedThreadCount = fetchUnresolvedThreadCount(repoFullName, pr.prNumber);
  let checks = {
    checkScope: 'not-checked',
    requiredChecks: [],
    requiredCheckSummary: summarizeRequiredChecks([]),
    visibleChecks: [],
    visibleCheckSummary: summarizeRequiredChecks([]),
  };

  if (unresolvedThreadCount === 0) {
    if (isMergeConflict(pr)) {
      checks.checkScope = 'skipped';
      checks.requiredCheckSummary.skipped.push({
        reason: 'required checks unavailable while PR has merge conflicts',
      });
    } else {
      checks = includeVisibleChecks(waitForRequiredChecks(args));
    }
  }

  const signal =
    unresolvedThreadCount === 0
      && checks.requiredCheckSummary.failed.length === 0
      && checks.visibleCheckSummary.failed.length === 0
      ? 'STOP'
      : 'CONTINUE';
  const state = {
    checkScope: checks.checkScope,
    checkedAt: new Date().toISOString(),
    headSha: pr.headSha,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    prNumber: pr.prNumber,
    requiredChecks: checks.requiredChecks,
    requiredCheckSummary: checks.requiredCheckSummary,
    visibleChecks: checks.visibleChecks,
    visibleCheckSummary: checks.visibleCheckSummary,
    repoFullName,
    resolvedVia: pr.source,
    signal,
    unresolvedThreadCount,
  };

  writeState(statePath, state);
  console.error(
    `PR #${state.prNumber} @ ${state.headSha}: unresolved review threads=${unresolvedThreadCount}, failed required checks=${checks.requiredCheckSummary.failed.length}, failed visible checks=${checks.visibleCheckSummary.failed.length}, pending required checks=${checks.requiredCheckSummary.pending.length}, skipped required checks=${checks.requiredCheckSummary.skipped.length} -> ${signal}`,
  );
  process.stdout.write(signal);
}

function readSignalState(stateFile) {
  const statePath = getStatePath(stateFile);

  if (!existsSync(statePath)) {
    throw new Error(`No auto-squash state file found at ${statePath}.`);
  }

  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function runQuietWait(args) {
  execInherit('node', [
    WAIT_SCRIPT,
    'capture',
    '--force',
    '--state-file',
    args.quietStateFile,
  ]);
  execInherit('node', [
    WAIT_SCRIPT,
    'wait',
    '--state-file',
    args.quietStateFile,
    '--quiet-window-seconds',
    String(args.quietWindowSeconds),
    '--timeout-seconds',
    String(args.timeoutSeconds),
    '--poll-interval-seconds',
    String(args.pollIntervalSeconds),
  ]);
}

function runWorkflow(args, cycleNumber) {
  execInherit(
    'archon',
    [
      'workflow',
      'run',
      args.workflow,
      '--no-worktree',
      `${args.message} Cycle ${cycleNumber}. Run ${args.runToken}.`,
    ],
    {
      AUTO_SQUASH_CHECK_POLL_INTERVAL_SECONDS: String(args.checkPollIntervalSeconds),
      AUTO_SQUASH_CHECK_TIMEOUT_SECONDS: String(args.checkTimeoutSeconds),
      AUTO_SQUASH_STATE_FILE: args.stateFile,
    },
  );
}

function run(args) {
  for (let cycleNumber = 1; cycleNumber <= args.maxCycles; cycleNumber += 1) {
    console.log(`Starting review cycle ${cycleNumber}/${args.maxCycles}.`);
    runQuietWait(args);
    clearStateFile(args.stateFile);
    runWorkflow(args, cycleNumber);

    const state = readSignalState(args.stateFile);

    if (state.signal === 'STOP') {
      console.log(
        `Review cycle complete for PR #${state.prNumber}. No unresolved review threads remain.`,
      );
      return;
    }

    if (state.signal !== 'CONTINUE') {
      throw new Error(`Unknown auto-squash signal: ${state.signal}`);
    }
  }

  throw new Error(`Review cycle hit the max cycle limit (${args.maxCycles}).`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'check-convos') {
    checkConvos(args);
    return;
  }

  if (args.command === 'run') {
    run(args);
    return;
  }

  usage();
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unknown review cycle error.');
  process.exitCode = 1;
}
