const assert = require('node:assert/strict');
const { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const script = join(__dirname, 'review-bots.js');

test('capture refuses a symlinked state destination', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'review-bots-state-'));
  const bin = join(cwd, 'bin');
  const outside = join(mkdtempSync(join(tmpdir(), 'review-bots-outside-')), 'victim.json');
  const stateDir = join(cwd, '.archon/.state');
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(outside, 'original\n');
  symlinkSync(outside, join(stateDir, 'review-bots.json'));

  execFileSync('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, 'README.md'), 'fixture\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'add', 'README.md'], { cwd });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd });

  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'repo') process.stdout.write(JSON.stringify({owner:{login:'example'},name:'repo'}));
else if (args[0] === 'pr') process.stdout.write(JSON.stringify({number:7,headRefOid:'abc123'}));
else process.exit(2);
`);
  chmodSync(gh, 0o755);

  const result = spawnSync(process.execPath, [script, 'capture', '--force'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/i);
  assert.equal(readFileSync(outside, 'utf8'), 'original\n');
});

test('capture replaces a hard-linked state destination without changing its outside inode', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'review-bots-state-'));
  const bin = join(cwd, 'bin');
  const outside = join(mkdtempSync(join(tmpdir(), 'review-bots-outside-')), 'victim.json');
  const stateDir = join(cwd, '.archon/.state');
  const destination = join(stateDir, 'review-bots.json');
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(outside, 'original\n');
  linkSync(outside, destination);

  execFileSync('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, 'README.md'), 'fixture\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'add', 'README.md'], { cwd });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd });

  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'repo') process.stdout.write(JSON.stringify({owner:{login:'example'},name:'repo'}));
else if (args[0] === 'pr') process.stdout.write(JSON.stringify({number:7,headRefOid:'abc123'}));
else process.exit(2);
`);
  chmodSync(gh, 0o755);

  const result = spawnSync(process.execPath, [script, 'capture', '--force'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(outside, 'utf8'), 'original\n');
  assert.match(readFileSync(destination, 'utf8'), /"repoFullName": "example\/repo"/);
});
