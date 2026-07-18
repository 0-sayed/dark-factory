import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./git-smart-stage.sh', import.meta.url).pathname;

function git(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'git-smart-stage-'));
  assert.equal(git(cwd, 'init', '-q').status, 0);
  return cwd;
}

function stageNew(cwd, file) {
  return spawnSync('bash', [script, 'stage-new', file], {
    cwd,
    encoding: 'utf8',
  });
}

test('stages a dash-prefixed filename as a path, not a Git option', () => {
  const cwd = fixture();
  writeFileSync(join(cwd, '--invoice.txt'), 'invoice\n');

  const result = stageNew(cwd, '--invoice.txt');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(cwd, 'diff', '--cached', '--name-only').stdout.trim(), '--invoice.txt');
});

test('stages a filename that matches an option when separated by double dash', () => {
  const cwd = fixture();
  writeFileSync(join(cwd, '--dry-run'), 'literal filename\n');

  const result = spawnSync('bash', [script, 'stage-new', '--', '--dry-run'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(cwd, 'diff', '--cached', '--name-only').stdout.trim(), '--dry-run');
});

test('rejects an absolute path even when it points inside the repository', () => {
  const cwd = fixture();
  const file = join(cwd, 'notes.txt');
  writeFileSync(file, 'notes\n');

  const result = stageNew(cwd, file);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute paths are not allowed/i);
  assert.equal(git(cwd, 'diff', '--cached', '--name-only').stdout.trim(), '');
});

test('rejects parent traversal before applying never-stage policy', () => {
  const cwd = fixture();
  mkdirSync(join(cwd, 'sub'));
  writeFileSync(join(cwd, 'pr.md'), 'scratchpad\n');

  const result = stageNew(cwd, 'sub/../pr.md');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /parent traversal is not allowed/i);
  assert.equal(git(cwd, 'diff', '--cached', '--name-only').stdout.trim(), '');
});
