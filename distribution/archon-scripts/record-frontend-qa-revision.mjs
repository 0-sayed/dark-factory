#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { worktreeRevisionFingerprint } from './worktree-revision.mjs';
import { writeWorktreeFile } from './worktree-state.mjs';

const CONTEXT_FILE = '.archon/state/frontend-qa-context.json';

let context;
try {
  context = JSON.parse(readFileSync(CONTEXT_FILE, 'utf8'));
} catch (error) {
  process.stderr.write(`Cannot record frontend QA revision: ${error.message}\n`);
  process.exit(1);
}

context.evidenceRevisionFingerprint = worktreeRevisionFingerprint();
writeWorktreeFile(CONTEXT_FILE, `${JSON.stringify(context, null, 2)}\n`);
process.stdout.write('yes');
