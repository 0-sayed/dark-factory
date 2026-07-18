import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const scriptPath = new URL('./initialize-sdd-workspace.mjs', import.meta.url).pathname;

test('initializes self-ignored scratch through the installed Superpowers helper', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'initialize-sdd-workspace-'));
  execFileSync('git', ['init', '-q'], { cwd });
  const helperDir = mkdtempSync(join(tmpdir(), 'sdd-helper-'));
  const helper = join(helperDir, 'sdd-workspace');
  writeFileSync(helper, [
    '#!/bin/sh',
    'set -eu',
    'dir="$PWD/.superpowers/sdd"',
    'mkdir -p "$dir"',
    "printf '*\\n' > \"$dir/.gitignore\"",
    'printf "%s\\n" "$dir"',
  ].join('\n'));
  chmodSync(helper, 0o755);

  const output = execFileSync(process.execPath, [scriptPath], {
    cwd,
    env: { ...process.env, SUPERPOWERS_SDD_WORKSPACE: helper },
    encoding: 'utf8',
  });

  assert.equal(output, join(cwd, '.superpowers', 'sdd'));
  assert.equal(readFileSync(join(output, '.gitignore'), 'utf8'), '*\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }), '');
});
