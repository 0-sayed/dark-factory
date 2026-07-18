import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const scriptPath = new URL('./frontend-qa-context.mjs', import.meta.url).pathname;
const checkerPath = new URL('./check-frontend-qa-status.mjs', import.meta.url).pathname;
const recorderPath = new URL('./record-frontend-qa-revision.mjs', import.meta.url).pathname;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'frontend-qa-context-'));
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(cwd, 'package.json'), '{"private":true}\n');
  git(cwd, ['add', 'package.json']);
  git(cwd, ['commit', '-qm', 'baseline']);
  return cwd;
}

function run(cwd) {
  const output = join(cwd, '.archon/state/frontend-qa-context.json');
  const answer = execFileSync(process.execPath, [scriptPath, '--output', output], { cwd, encoding: 'utf8' });
  return { answer, context: JSON.parse(readFileSync(output, 'utf8')) };
}

function recordQaRevision(cwd) {
  execFileSync(process.execPath, [recorderPath], { cwd, encoding: 'utf8' });
}

test('browser-facing TypeScript tests require frontend QA regardless of project layout', () => {
  const cwd = fixture();
  mkdirSync(join(cwd, 'acceptance'), { recursive: true });
  writeFileSync(join(cwd, 'acceptance/login.spec.ts'), [
    "import { test, expect } from '@playwright/test';",
    "test('login', async ({ page }) => { await page.goto('/login'); });",
  ].join('\n'));

  const result = run(cwd);

  assert.equal(result.answer, 'yes');
  assert.deepEqual(result.context.frontendFiles, ['acceptance/login.spec.ts']);
});

test('ordinary backend TypeScript tests do not require browser QA', () => {
  const cwd = fixture();
  mkdirSync(join(cwd, 'backend'), { recursive: true });
  writeFileSync(join(cwd, 'backend/service.spec.ts'), [
    "import assert from 'node:assert/strict';",
    "assert.equal(1 + 1, 2);",
  ].join('\n'));

  const result = run(cwd);

  assert.equal(result.answer, 'no');
  assert.deepEqual(result.context.frontendFiles, []);
});

test('rejects QA evidence after the captured working tree changes', () => {
  const cwd = fixture();
  mkdirSync(join(cwd, 'pages'), { recursive: true });
  const page = join(cwd, 'pages/home.tsx');
  writeFileSync(page, 'export const Home = () => <main>before</main>;\n');
  run(cwd);

  const stateDir = join(cwd, '.archon/state');
  writeFileSync(join(stateDir, 'frontend-qa-status.txt'), 'QA_PASSED');
  writeFileSync(join(stateDir, 'frontend-qa-result.md'), 'QA_PASSED\n');
  recordQaRevision(cwd);
  writeFileSync(page, 'export const Home = () => <main>after</main>;\n');

  const checked = spawnSync(process.execPath, [checkerPath], { cwd, encoding: 'utf8' });

  assert.notEqual(checked.status, 0);
  assert.equal(checked.stdout, 'no');
  assert.match(checked.stderr, /revision/i);
});

test('rejects a stale passing result when the status file is absent', () => {
  const cwd = fixture();
  mkdirSync(join(cwd, 'pages'), { recursive: true });
  const page = join(cwd, 'pages/home.tsx');
  writeFileSync(page, 'export const Home = () => <main>before</main>;\n');
  run(cwd);

  const stateDir = join(cwd, '.archon/state');
  writeFileSync(join(stateDir, 'frontend-qa-result.md'), 'QA_PASSED\n');
  recordQaRevision(cwd);
  writeFileSync(page, 'export const Home = () => <main>after</main>;\n');

  const checked = spawnSync(process.execPath, [checkerPath], { cwd, encoding: 'utf8' });

  assert.notEqual(checked.status, 0);
  assert.equal(checked.stdout, 'no');
  assert.match(checked.stderr, /revision/i);
});

test('accepts QA evidence captured after the QA node fixes scoped code', () => {
  const cwd = fixture();
  mkdirSync(join(cwd, 'pages'), { recursive: true });
  const page = join(cwd, 'pages/home.tsx');
  writeFileSync(page, 'export const Home = () => <main>before</main>;\n');
  run(cwd);

  writeFileSync(page, 'export const Home = () => <main>fixed</main>;\n');
  const stateDir = join(cwd, '.archon/state');
  writeFileSync(join(stateDir, 'frontend-qa-status.txt'), 'QA_PASSED');
  writeFileSync(join(stateDir, 'frontend-qa-result.md'), 'QA_PASSED\n');
  recordQaRevision(cwd);

  const checked = spawnSync(process.execPath, [checkerPath], { cwd, encoding: 'utf8' });

  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout, 'yes');
});

test('fingerprints an untracked nested Git repository without crashing', () => {
  const cwd = fixture();
  const nested = join(cwd, 'vendor/example');
  mkdirSync(nested, { recursive: true });
  git(nested, ['init', '-q']);
  git(nested, ['config', 'user.email', 'test@example.com']);
  git(nested, ['config', 'user.name', 'Test']);
  git(nested, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(nested, 'README.md'), 'nested\n');
  git(nested, ['add', 'README.md']);
  git(nested, ['commit', '-qm', 'nested baseline']);

  const result = run(cwd);

  assert.match(result.context.revisionFingerprint, /^sha256:/);
});
