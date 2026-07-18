#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { removeWorktreeFile, writeWorktreeFile } from './worktree-state.mjs';

const STATE_FILE = resolve(process.cwd(), '.archon/state/merge-gate-preflight.json');
const MERGE_STATUS_FILE = resolve(process.cwd(), '.archon/state/merge-status.json');
const UPDATE_STATE_FILE = resolve(process.cwd(), '.archon/state/merge-gate-update.json');
const RESOLUTION_STATE_FILE = resolve(process.cwd(), '.archon/state/merge-gate-resolution.json');

const THREADS_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$cursor) {
        nodes { isResolved isOutdated }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
`;

function ghEnv() {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

function ghOutput(args) {
  return execFileSync('gh', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: ghEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

function writeJson(path, value) {
  writeWorktreeFile(path, `${JSON.stringify(value)}\n`);
}

function clearStaleState() {
  for (const path of [MERGE_STATUS_FILE, UPDATE_STATE_FILE, RESOLUTION_STATE_FILE]) {
    removeWorktreeFile(path);
  }
}

function block(reason, details = {}) {
  const state = {
    checkedAt: new Date().toISOString(),
    status: 'UNSAFE',
    reason,
    ...details,
  };
  writeJson(STATE_FILE, state);
  writeJson(MERGE_STATUS_FILE, { status: 'BLOCKED', reason });
  process.stdout.write('UNSAFE');
}

function checkBuckets(requiredChecks) {
  if (!Array.isArray(requiredChecks)) {
    return 'pending';
  }

  if (
    requiredChecks.some((check) =>
      ['fail', 'cancel'].includes(String(check.bucket || '').toLowerCase()),
    )
  ) {
    return 'failed';
  }

  if (
    requiredChecks.some((check) =>
      ['pending', 'skipping'].includes(String(check.bucket || '').toLowerCase()),
    )
  ) {
    return 'pending';
  }

  return 'passed';
}

function checkRollup(checks, options = {}) {
  if (!Array.isArray(checks)) {
    return 'pending';
  }

  if (checks.some((check) => check.bucket)) {
    const bucketChecks = options.ignoreSkippingBuckets
      ? checks.filter((check) => String(check.bucket || '').toLowerCase() !== 'skipping')
      : checks;
    return checkBuckets(bucketChecks);
  }

  if (
    checks.some((check) => {
      const conclusion = String(check.conclusion || '').toUpperCase();
      const state = String(check.state || '').toUpperCase();
      return ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(conclusion)
        || ['FAILURE', 'ERROR'].includes(state);
    })
  ) {
    return 'failed';
  }

  if (
    checks.some((check) => {
      const status = String(check.status || '').toUpperCase();
      const state = String(check.state || '').toUpperCase();
      return ['QUEUED', 'IN_PROGRESS', 'REQUESTED', 'WAITING', 'PENDING'].includes(status)
        || ['PENDING', 'EXPECTED'].includes(state);
    })
  ) {
    return 'pending';
  }

  return 'passed';
}

function classifyEarly({ pr, unresolvedThreadCount }) {
  if (pr.state !== 'OPEN') {
    return ['UNSAFE', `PR is ${String(pr.state).toLowerCase()}.`];
  }

  if (pr.isDraft) {
    return ['UNSAFE', 'PR is still a draft.'];
  }

  if (unresolvedThreadCount > 0 || pr.reviewDecision === 'CHANGES_REQUESTED') {
    return ['NOT_GREEN', 'Review feedback is still blocking.'];
  }

  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
    return ['CONFLICT', 'PR has merge conflicts.'];
  }

  return null;
}

function fetchUnresolvedThreadCount(repoFullName, prNumber) {
  const [owner, repo] = repoFullName.split('/');
  let cursor = null;
  let unresolved = 0;

  while (true) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${THREADS_QUERY}`,
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
    unresolved += threads.nodes.filter((thread) => !thread.isResolved && !thread.isOutdated).length;

    if (!threads.pageInfo.hasNextPage) {
      return unresolved;
    }

    cursor = threads.pageInfo.endCursor;
  }
}

function classify({ pr, requiredChecks, visibleChecks, unresolvedThreadCount }) {
  const earlyStatus = classifyEarly({ pr, unresolvedThreadCount });
  if (earlyStatus) {
    return earlyStatus;
  }

  const visibleChecksState = checkRollup(visibleChecks, { ignoreSkippingBuckets: true });
  if (visibleChecksState === 'failed') {
    return ['NOT_GREEN', 'PR checks failed.'];
  }
  if (visibleChecksState === 'pending') {
    return ['PENDING', 'PR checks are pending.'];
  }

  const checksState = checkBuckets(requiredChecks);
  if (checksState === 'failed') {
    return ['NOT_GREEN', 'Required checks failed.'];
  }
  if (checksState === 'pending') {
    return ['PENDING', 'Required checks are pending.'];
  }

  if (pr.mergeStateStatus === 'BEHIND') {
    return ['STALE', 'PR branch is behind the base branch.'];
  }

  if (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN') {
    return ['PENDING', 'GitHub mergeability is still being computed.'];
  }

  if (pr.mergeStateStatus === 'QUEUED') {
    return ['PENDING', 'PR is waiting in the merge queue.'];
  }

  if (pr.mergeable === 'MERGEABLE' && ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(pr.mergeStateStatus)) {
    return ['READY', 'PR is ready to merge.'];
  }

  return ['UNSAFE', `Unhandled merge state: mergeable=${pr.mergeable} mergeStateStatus=${pr.mergeStateStatus}.`];
}

function main() {
  try {
    clearStaleState();

    const repo = ghJson(['repo', 'view', '--json', 'owner,name']);
    const repoFullName = `${repo.owner.login}/${repo.name}`;
    const pr = ghJson([
      'pr',
      'view',
      '--json',
      'number,state,isDraft,mergeable,mergeStateStatus,headRefOid,headRefName,baseRefName,reviewDecision,statusCheckRollup',
    ]);
    const unresolvedThreadCount = fetchUnresolvedThreadCount(repoFullName, pr.number);
    const earlyStatus = classifyEarly({ pr, unresolvedThreadCount });
    const requiredChecks =
      earlyStatus?.[0] === 'CONFLICT'
        ? []
        : ghJsonOrNull(['pr', 'checks', '--required', '--json', 'bucket,name,state,workflow']);
    const visibleChecks =
      earlyStatus?.[0] === 'CONFLICT'
        ? []
        : ghJsonOrNull(['pr', 'checks', '--json', 'bucket,name,state,workflow'])
          || (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []);
    const [status, reason] = classify({ pr, requiredChecks, visibleChecks, unresolvedThreadCount });
    const state = {
      checkedAt: new Date().toISOString(),
      status,
      reason,
      repoFullName,
      prNumber: pr.number,
      headSha: pr.headRefOid,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      reviewDecision: pr.reviewDecision,
      requiredChecks: (requiredChecks || []).map(({ bucket, name, state: checkState, workflow }) => ({
        bucket,
        name,
        state: checkState,
        workflow,
      })),
      visibleChecks: visibleChecks.map((check) => ({
        name: check.name || check.context,
        bucket: check.bucket,
        status: check.status,
        conclusion: check.conclusion,
        state: check.state,
        workflow: check.workflow || check.workflowName,
      })),
      unresolvedThreadCount,
    };

    writeJson(STATE_FILE, state);

    if (status === 'UNSAFE') {
      writeJson(MERGE_STATUS_FILE, { status: 'BLOCKED', reason });
    } else if (status === 'NOT_GREEN') {
      writeJson(MERGE_STATUS_FILE, {
        status: 'NEEDS_SQUASH',
        reason,
        prNumber: pr.number,
        headSha: pr.headRefOid,
        checkedAt: new Date().toISOString(),
      });
    } else if (status === 'PENDING') {
      writeJson(MERGE_STATUS_FILE, {
        status: 'PENDING',
        reason,
        prNumber: pr.number,
        headSha: pr.headRefOid,
        checkedAt: new Date().toISOString(),
      });
    }

    process.stdout.write(status);
  } catch (error) {
    block(error instanceof Error ? error.message : 'Unknown preflight error.');
  }
}

main();
