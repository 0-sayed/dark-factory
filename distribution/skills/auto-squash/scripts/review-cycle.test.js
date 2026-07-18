const assert = require('node:assert/strict');
const { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const reviewCycle = join(__dirname, 'review-cycle.js');

function runCheckConvos({ allChecks = [], requiredChecks = [], requiredChecksError = '' }) {
  const root = mkdtempSync(join(tmpdir(), 'auto-squash-checks-'));
  const binDir = join(root, 'bin');
  const stateFile = join(root, 'review-cycle.json');
  const ghLog = join(root, 'gh.log');
  const ghScript = join(binDir, 'gh');

  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    ghScript,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.GH_TEST_LOG, args.join(' ') + '\\n');

if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ owner: { login: 'example' }, name: 'repo' }));
} else if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 7,
    headRefOid: 'abc123',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  }));
} else if (args[0] === 'api' && args[1] === 'graphql') {
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  }));
} else if (args[0] === 'pr' && args[1] === 'checks' && args.includes('--required')) {
  if (process.env.GH_REQUIRED_ERROR) {
    process.stderr.write(process.env.GH_REQUIRED_ERROR);
    process.exit(1);
  }
  process.stdout.write(process.env.GH_REQUIRED_CHECKS);
} else if (args[0] === 'pr' && args[1] === 'checks') {
  process.stdout.write(process.env.GH_ALL_CHECKS);
} else {
  process.stderr.write('unexpected gh invocation: ' + args.join(' '));
  process.exit(2);
}
`,
  );
  chmodSync(ghScript, 0o755);

  const result = spawnSync(
    process.execPath,
    [reviewCycle, 'check-convos', '--state-file', stateFile],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_ALL_CHECKS: JSON.stringify(allChecks),
        GH_REQUIRED_CHECKS: JSON.stringify(requiredChecks),
        GH_REQUIRED_ERROR: requiredChecksError,
        GH_TEST_LOG: ghLog,
        PATH: `${binDir}:${process.env.PATH}`,
      },
    },
  );

  return {
    ghCalls: readFileSync(ghLog, 'utf8').trim().split('\n'),
    result,
    state: result.status === 0 ? JSON.parse(readFileSync(stateFile, 'utf8')) : null,
  };
}

test('falls back to all checks when the repository has no required checks', () => {
  const { ghCalls, result, state } = runCheckConvos({
    allChecks: [
      { bucket: 'pass', name: 'test', state: 'SUCCESS', workflow: 'CI' },
      { bucket: 'skipping', name: 'reviewer', state: 'NEUTRAL', workflow: '' },
    ],
    requiredChecksError: "no required checks reported on the 'feature' branch\n",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'STOP');
  assert.equal(state.checkScope, 'all');
  assert.equal(state.requiredCheckSummary.pending.length, 0);
  assert.equal(state.requiredCheckSummary.skipped.length, 1);
  assert.equal(
    ghCalls.filter((call) => call.includes('pr checks --required')).length,
    1,
  );
  assert.equal(
    ghCalls.filter((call) => call.startsWith('pr checks --json')).length,
    1,
  );
});

test('keeps failed fallback checks blocking', () => {
  const { result, state } = runCheckConvos({
    allChecks: [{ bucket: 'fail', name: 'test', state: 'FAILURE', workflow: 'CI' }],
    requiredChecksError: "no required checks reported on the 'feature' branch\n",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CONTINUE');
  assert.equal(state.checkScope, 'all');
  assert.equal(state.requiredCheckSummary.failed.length, 1);
});

test('keeps failed visible checks blocking when required checks pass', () => {
  const { ghCalls, result, state } = runCheckConvos({
    allChecks: [{ bucket: 'fail', name: 'optional', state: 'FAILURE', workflow: 'Optional' }],
    requiredChecks: [{ bucket: 'pass', name: 'test', state: 'SUCCESS', workflow: 'CI' }],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CONTINUE');
  assert.equal(state.checkScope, 'required');
  assert.equal(state.requiredCheckSummary.failed.length, 0);
  assert.equal(state.visibleCheckSummary.failed.length, 1);
  assert.equal(
    ghCalls.filter((call) => call.startsWith('pr checks --json')).length,
    1,
  );
});
