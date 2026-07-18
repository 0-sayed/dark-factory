import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const script = new URL('./auto-merge.mjs', import.meta.url).pathname;

function makeExecutable(path, content) {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o755 });
}

test('prepare still runs merge-gate when auto-squash stops on failed required checks only', () => {
  const dir = mkdtempScoped('auto-merge-failed-checks-');
  const binDir = join(dir, 'bin');
  const skillsDir = join(dir, 'skills');
  const autoSquashDir = join(skillsDir, 'auto-squash', 'scripts');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(autoSquashDir, { recursive: true });

  makeExecutable(join(binDir, 'git'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = "rev-parse" ]; then echo 0123456789abcdef0123456789abcdef01234567; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'));

  makeExecutable(join(binDir, 'archon'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> archon-invocations.log',
    'mkdir -p .archon/state',
    'printf "%s\\n" \'{"status":"READY_TO_MERGE"}\' > .archon/state/merge-status.json',
    'exit 0',
    '',
  ].join('\n'));

  writeFileSync(join(autoSquashDir, 'review-cycle.js'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'fs.mkdirSync(".archon/.state", { recursive: true });',
    'fs.writeFileSync(".archon/.state/review-cycle.json", JSON.stringify({',
    '  signal: "CONTINUE",',
    '  unresolvedThreadCount: 0,',
    '  requiredCheckSummary: { failed: [{ name: "Type Check" }], pending: [], passed: [], skipped: [] }',
    '}) + "\\n");',
    'process.exit(1);',
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [script, '--mode', 'prepare', '--max-cycles', '1'], {
    cwd: dir,
    env: {
      ...process.env,
      AGENTS_SKILLS_DIR: skillsDir,
      PATH: `${binDir}:${process.env.PATH}`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /READY_TO_MERGE/);
  assert.match(readFileSync(join(dir, 'archon-invocations.log'), 'utf8'), /workflow run merge-gate/);
});

test('prepare still runs merge-gate when auto-squash stops on failed visible checks only', () => {
  const dir = mkdtempScoped('auto-merge-visible-checks-');
  const binDir = join(dir, 'bin');
  const skillsDir = join(dir, 'skills');
  const autoSquashDir = join(skillsDir, 'auto-squash', 'scripts');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(autoSquashDir, { recursive: true });

  makeExecutable(join(binDir, 'git'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = "rev-parse" ]; then echo 0123456789abcdef0123456789abcdef01234567; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'));

  makeExecutable(join(binDir, 'archon'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> archon-invocations.log',
    'mkdir -p .archon/state',
    'printf "%s\\n" \'{"status":"READY_TO_MERGE"}\' > .archon/state/merge-status.json',
    'exit 0',
    '',
  ].join('\n'));

  writeFileSync(join(autoSquashDir, 'review-cycle.js'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'fs.mkdirSync(".archon/.state", { recursive: true });',
    'fs.writeFileSync(".archon/.state/review-cycle.json", JSON.stringify({',
    '  signal: "CONTINUE",',
    '  unresolvedThreadCount: 0,',
    '  requiredCheckSummary: { failed: [], pending: [], passed: [{ name: "Test" }], skipped: [] },',
    '  visibleCheckSummary: { failed: [{ name: "Conventional PR Title" }], pending: [], passed: [], skipped: [] }',
    '}) + "\\n");',
    'process.exit(1);',
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [script, '--mode', 'prepare', '--max-cycles', '1'], {
    cwd: dir,
    env: {
      ...process.env,
      AGENTS_SKILLS_DIR: skillsDir,
      PATH: `${binDir}:${process.env.PATH}`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /READY_TO_MERGE/);
  assert.match(readFileSync(join(dir, 'archon-invocations.log'), 'utf8'), /workflow run merge-gate/);
});

function mkdtempScoped(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
