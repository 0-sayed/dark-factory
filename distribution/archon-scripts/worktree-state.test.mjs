import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeWorktreeFile } from './worktree-state.mjs';

test('writes regular state files inside the worktree', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'worktree-state-'));
  writeWorktreeFile('.archon/state/example.json', 'safe\n', { cwd });
  assert.equal(readFileSync(join(cwd, '.archon/state/example.json'), 'utf8'), 'safe\n');
});

test('rejects a symlinked state directory', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'worktree-state-'));
  const outside = mkdtempSync(join(tmpdir(), 'worktree-state-outside-'));
  mkdirSync(join(cwd, '.archon'), { recursive: true });
  symlinkSync(outside, join(cwd, '.archon/state'));

  assert.throws(
    () => writeWorktreeFile('.archon/state/example.json', 'unsafe\n', { cwd }),
    /symlink/i,
  );
});

test('rejects a symlinked destination file without changing its target', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'worktree-state-'));
  const outside = join(mkdtempSync(join(tmpdir(), 'worktree-state-outside-')), 'victim.txt');
  mkdirSync(join(cwd, '.archon/state'), { recursive: true });
  writeFileSync(outside, 'original\n');
  symlinkSync(outside, join(cwd, '.archon/state/example.json'));

  assert.throws(
    () => writeWorktreeFile('.archon/state/example.json', 'unsafe\n', { cwd }),
    /symlink/i,
  );
  assert.equal(readFileSync(outside, 'utf8'), 'original\n');
});

test('replaces a hard-linked destination without changing its outside inode', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'worktree-state-'));
  const outside = join(mkdtempSync(join(tmpdir(), 'worktree-state-outside-')), 'victim.txt');
  const destination = join(cwd, '.archon/state/example.json');
  mkdirSync(join(cwd, '.archon/state'), { recursive: true });
  writeFileSync(outside, 'original\n');
  linkSync(outside, destination);

  writeWorktreeFile('.archon/state/example.json', 'safe\n', { cwd });

  assert.equal(readFileSync(outside, 'utf8'), 'original\n');
  assert.equal(readFileSync(destination, 'utf8'), 'safe\n');
});
