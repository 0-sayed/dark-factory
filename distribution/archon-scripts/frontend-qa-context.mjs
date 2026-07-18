#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { worktreeRevisionFingerprint } from './worktree-revision.mjs';
import { ensureWorktreeDirectory, removeWorktreeFile, writeWorktreeFile } from './worktree-state.mjs';

const FRONTEND_PATTERNS = [
  /\.(html|css|scss|sass|less|vue|svelte|jsx|tsx)$/,
  /(^|\/)(vite|webpack|rollup|next|nuxt|tailwind|postcss)\.config\.[cm]?[jt]sx?$/,
  /(^|\/)(components?|hooks?|pages?|views?|ui|stores?|layouts?|routes?)\/.*\.ts$/,
  /(^|\/)(e2e|browser|browser-tests|ui-tests|playwright|cypress)\/.*\.[cm]?[jt]sx?$/,
  /\.(e2e|browser)\.[cm]?[jt]sx?$/,
  /(^|\/)(playwright|cypress|webdriver|testcafe)\.config\.[cm]?[jt]s$/,
];
const BROWSER_TEST_CONTENT = /(?:from\s+['"]@playwright\/test['"]|require\(['"]@playwright\/test['"]\)|\bpage\.goto\s*\(|\bbrowser\.newPage\s*\(|\bcy\.(?:visit|mount)\s*\()/;
const STATUS_FILE = '.archon/state/frontend-qa-status.txt';
const RESULT_FILE = '.archon/state/frontend-qa-result.md';
const PRIOR_PASS_FILE = '.archon/state/frontend-qa-prior-pass.json';
const CONTEXT_FILE = '.archon/state/frontend-qa-context.json';
const PASSED = 'QA_PASSED';
const RESULT_PASS = new Set(['QA_PASS', PASSED]);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function parseArgs(argv) {
  const args = { mode: 'feature', includeFile: '', output: '.archon/state/frontend-qa-context.json' };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      args.mode = argv[++index] || args.mode;
    } else if (arg === '--include-file') {
      args.includeFile = argv[++index] || '';
    } else if (arg === '--output') {
      args.output = argv[++index] || args.output;
    }
  }

  return args;
}

function lines(value) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function stripSingleTrailingNewline(value) {
  return value.replace(/\r?\n$/, '');
}

function firstLine(value) {
  return value.split(/\r?\n/, 1)[0]?.trim() || '';
}

function statusPassed(value) {
  return value !== null && stripSingleTrailingNewline(value) === PASSED;
}

function resultPassed(value) {
  return value !== null && RESULT_PASS.has(firstLine(value));
}

function evidenceRevisionFingerprintFromContext(value) {
  if (!value) return '';

  try {
    const context = JSON.parse(value);
    return typeof context.evidenceRevisionFingerprint === 'string' ? context.evidenceRevisionFingerprint : '';
  } catch {
    return '';
  }
}

function archivePriorFrontendQaPass() {
  const status = readOptional(STATUS_FILE);
  const result = readOptional(RESULT_FILE);
  const passedByStatus = statusPassed(status);
  const passedByResult = resultPassed(result);
  const priorContext = readOptional(CONTEXT_FILE);

  if (!passedByStatus && !passedByResult) {
    removeWorktreeFile(PRIOR_PASS_FILE);
    return;
  }

  writeWorktreeFile(
    PRIOR_PASS_FILE,
    `${JSON.stringify(
      {
        savedAt: new Date().toISOString(),
        passedByStatus,
        passedByResult,
        status: status ?? '',
        result: result ?? '',
        revisionFingerprint: evidenceRevisionFingerprintFromContext(priorContext),
      },
      null,
      2,
    )}\n`,
  );
}

function readEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  return Object.fromEntries(
    lines(readFileSync(path, 'utf8'))
      .filter((line) => !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^["']|["']$/g, '')];
      }),
  );
}

function collectChanged(includeFile) {
  const changed = [
    ...lines(git(['diff', '--name-only', '--diff-filter=ACMR'])),
    ...lines(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])),
    ...lines(git(['diff', '--name-only', '--diff-filter=U'])),
    ...lines(git(['ls-files', '--others', '--exclude-standard'])),
  ];

  if (includeFile && existsSync(includeFile)) {
    changed.push(...lines(readFileSync(includeFile, 'utf8')));
  }

  return [...new Set(changed)].sort();
}

function isFrontendFile(file) {
  if (FRONTEND_PATTERNS.some((pattern) => pattern.test(file))) return true;
  if (!/\.[cm]?[jt]sx?$/.test(file)) return false;
  const content = readOptional(file);
  return content !== null && BROWSER_TEST_CONTENT.test(content);
}

function detectUrl() {
  const env = { ...readEnvFile('.env.example'), ...readEnvFile('.env'), ...process.env };
  const rawPort = env.DARK_FACTORY_WEB_PORT || env.WEB_PORT || '5173';
  const port = Number.parseInt(rawPort, 10);
  const webPort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 5173;

  return `http://localhost:${webPort}`;
}

const args = parseArgs(process.argv.slice(2));
const changedFiles = collectChanged(args.includeFile);
const frontendFiles = changedFiles.filter(isFrontendFile);
ensureWorktreeDirectory('.archon/state');
archivePriorFrontendQaPass();
removeWorktreeFile(STATUS_FILE);
removeWorktreeFile(RESULT_FILE);

const context = {
  mode: args.mode,
  shouldQa: frontendFiles.length > 0,
  appUrl: detectUrl(),
  changedFiles,
  frontendFiles,
  revisionFingerprint: worktreeRevisionFingerprint(),
  evidenceRevisionFingerprint: '',
  instructions: [
    'Use only the frontendFiles list as the QA scope.',
    'Fix only issues necessary for the changed frontend surface to work.',
    'If the blocker is related backend/API/config/test code, make the appropriate scoped fix and re-check with focused validation plus browser QA.',
    'Prefer the fix that preserves intended product behavior and existing architecture; avoid band-aids and broad unrelated cleanup.',
    'Do not fix unrelated product areas, infrastructure, dependency, environment, formatting, or broad cleanup issues.',
    'Do not run foreground dev-server commands from the QA node.',
    'If the app URL is not reachable, report QA_BLOCKED instead of changing product code.',
    'If a backend/API request required by the changed frontend surface fails for an unrelated reason, report QA_BLOCKED instead of passing QA.',
    'If browser auth works, the changed list/empty-state surface renders, and deeper scoped routes are blocked only because local seed data is absent, run focused validation and write QA_BLOCKED notes that explicitly say the app was reachable and authenticated browser shell loaded, the changed frontend surface rendered, only 404 or empty local-data responses blocked deeper routes, and focused validation passed.',
    'If a feature-specific bug is found, make the appropriate scoped fix and re-check it in the browser.',
  ],
};

writeWorktreeFile(args.output, `${JSON.stringify(context, null, 2)}\n`);
process.stdout.write(context.shouldQa ? 'yes' : 'no');
