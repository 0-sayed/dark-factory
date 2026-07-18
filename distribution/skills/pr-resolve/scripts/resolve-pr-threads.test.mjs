import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const resolver = new URL('./resolve-pr-threads.py', import.meta.url).pathname;

function runFixture({ threadNumber = 7, threadRepo = 'example/repo' }) {
  const cwd = mkdtempSync(join(tmpdir(), 'resolve-pr-threads-'));
  const bin = join(cwd, 'bin');
  const log = join(cwd, 'gh.log');
  mkdirSync(bin);
  writeFileSync(join(cwd, 'pr.md'), '## Worth Fixing\n- [x] Fix it <!-- thread:PRRT_test -->\n');

  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.GH_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'pr') process.stdout.write(JSON.stringify({number:7,url:'https://github.com/example/repo/pull/7'}));
else if (args[0] === 'repo') process.stdout.write(JSON.stringify({owner:{login:'example'},name:'repo'}));
else if (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => arg.includes('query=query'))) process.stdout.write(JSON.stringify({data:{node:{id:'PRRT_test',isResolved:false,pullRequest:{number:${threadNumber},repository:{nameWithOwner:${JSON.stringify(threadRepo)}}},comments:{nodes:[]}}}}));
else if (args[0] === 'api' && args[1] === 'graphql') process.stdout.write(JSON.stringify({data:{resolveReviewThread:{thread:{id:'PRRT_test'}}}}));
else process.exit(2);
`);
  chmodSync(gh, 0o755);

  const result = spawnSync('python3', [resolver], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GH_TEST_LOG: log, PATH: `${bin}:${process.env.PATH}` },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  return { calls, result };
}

test('refuses a review thread owned by another pull request', () => {
  const { calls, result } = runFixture({ threadNumber: 8 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not belong to.*pull request 7/i);
  assert.equal(calls.filter((args) => args.some((arg) => arg.includes('mutation('))).length, 0);
});

test('refuses a review thread owned by another repository', () => {
  const { calls, result } = runFixture({ threadRepo: 'other/repo' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not belong to.*example\/repo/i);
  assert.equal(calls.filter((args) => args.some((arg) => arg.includes('mutation('))).length, 0);
});

test('resolves a review thread owned by the current pull request', () => {
  const { calls, result } = runFixture({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.filter((args) => args.some((arg) => arg.includes('mutation('))).length, 1);
});
