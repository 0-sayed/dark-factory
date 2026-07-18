#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const skillsDir =
  process.env.AGENTS_SKILLS_DIR || join(homedir(), '.agents', 'skills');
const autoSquashScript = join(
  skillsDir,
  'auto-squash',
  'scripts',
  'review-cycle.js',
);
const stateFile =
  process.env.AUTO_SQUASH_STATE_FILE || '.archon/.state/review-cycle.json';

if (!existsSync(autoSquashScript)) {
  console.error(`auto-squash skill script not found: ${autoSquashScript}`);
  process.exit(1);
}

const result = spawnSync(
  process.env.NODE_BIN || 'node',
  [
    autoSquashScript,
    'check-convos',
    '--state-file',
    stateFile,
  ],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.stderr.write(result.stderr || '');
  process.exit(result.status || 1);
}

const signal = result.stdout.trim();

if (signal !== 'STOP' && signal !== 'CONTINUE') {
  console.error(
    `Unexpected review-convo-check signal: ${JSON.stringify(signal)}`,
  );
  process.exit(1);
}

process.stdout.write(signal);
