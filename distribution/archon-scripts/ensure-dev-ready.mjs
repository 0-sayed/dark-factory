#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const agentsSkillsDir = process.env.AGENTS_SKILLS_DIR || join(homedir(), '.agents', 'skills');
const {
  discoverLocalEnvFiles,
  normalizeDevEnv,
  readEnvFiles,
} = await import(pathToFileURL(join(agentsSkillsDir, 'dev-start', 'scripts', 'dev-env-normalize.mjs')).href);
import { registerOAuthRedirects } from './register-local-oauth-redirect.mjs';
import {
  isExpectedServiceReachable,
  selectExpectedPort,
} from './dev-readiness.mjs';
import { ensureWorktreeDirectory, writeWorktreeFile, writeWorktreeFileAtomic } from './worktree-state.mjs';

const STATE_DIR = '.archon/state';
const LOG_DIR = '.archon/logs';
const DEFAULT_API_PORT = '3000';
const DEFAULT_WEB_PORT = '5173';
const TIMEOUT_MS = Number(process.env.ARCHON_DEV_READY_TIMEOUT_MS || 90_000);
const POLL_MS = 1_000;
const DB_PREP_SCRIPT_NAMES = ['db:prepare', 'db:migrate', 'migrate', 'migration:run'];

function isUsablePort(value, fallback) {
  return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65_535 ? value : fallback;
}

const isReachable = (url, role = 'api') => isExpectedServiceReachable(url, {
  role,
  cwd: process.cwd(),
});

function readRuntimeDescriptor(env) {
  const path = join(STATE_DIR, 'dark-factory-runtime.json');
  if (!existsSync(path)) return null;
  try {
    const descriptor = JSON.parse(readFileSync(path, 'utf8'));
    const idsMatch = (!env.DARK_FACTORY_PROJECT_ID || descriptor.projectId === env.DARK_FACTORY_PROJECT_ID)
      && (!env.DARK_FACTORY_SESSION_ID || descriptor.sessionId === env.DARK_FACTORY_SESSION_ID)
      && (!env.DARK_FACTORY_ISSUE_ID || descriptor.issueId === env.DARK_FACTORY_ISSUE_ID);
    return descriptor.version === 1
      && idsMatch
      && descriptor.worktreePath === process.cwd()
      && isUsablePort(String(descriptor.apiPort), '')
      && isUsablePort(String(descriptor.webPort), '')
      ? descriptor
      : null;
  } catch {
    return null;
  }
}

function updateRuntimeDescriptor(descriptor, apiPort, webPort) {
  if (!descriptor || (descriptor.apiPort === apiPort && descriptor.webPort === webPort)) return;
  const path = join(STATE_DIR, 'dark-factory-runtime.json');
  writeWorktreeFileAtomic(path, `${JSON.stringify({
    ...descriptor,
    apiPort,
    webPort,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readPackageJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function detectPackageManager() {
  if (existsSync('pnpm-lock.yaml') || existsSync('pnpm-workspace.yaml')) {
    return 'pnpm';
  }
  if (existsSync('yarn.lock')) {
    return 'yarn';
  }
  if (existsSync('package-lock.json')) {
    return 'npm';
  }
  return 'pnpm';
}

function packageScriptCommand(pm, scriptName, packageName = '') {
  if (pm === 'pnpm') {
    return packageName
      ? `corepack pnpm --filter ${shellQuote(packageName)} ${shellQuote(scriptName)}`
      : `corepack pnpm ${shellQuote(scriptName)}`;
  }

  if (pm === 'yarn') {
    return `corepack yarn ${shellQuote(scriptName)}`;
  }

  return `npm run ${shellQuote(scriptName)}`;
}

function findScript(scripts, names = DB_PREP_SCRIPT_NAMES) {
  for (const name of names) {
    if (scripts?.[name]) {
      return name;
    }
  }

  return '';
}

function workspacePackageDirs() {
  const roots = ['packages', 'apps'];
  const dirs = [];

  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs.push(join(root, entry.name));
      }
    }
  }

  return dirs;
}

function detectDbPrepCommand(env) {
  const explicitCommand = String(
    env.ARCHON_DEV_DB_PREP_COMMAND || env.DEV_START_DB_PREP_COMMAND || '',
  ).trim();
  if (explicitCommand) {
    return {
      command: explicitCommand,
      source: env.ARCHON_DEV_DB_PREP_COMMAND
        ? 'ARCHON_DEV_DB_PREP_COMMAND'
        : 'DEV_START_DB_PREP_COMMAND',
    };
  }

  const pm = detectPackageManager();
  const rootPackage = readPackageJson('package.json');
  const rootScript = findScript(rootPackage?.scripts);
  if (rootScript) {
    return {
      command: packageScriptCommand(pm, rootScript),
      source: `package.json#${rootScript}`,
    };
  }

  if (pm !== 'pnpm') {
    return null;
  }

  for (const dir of workspacePackageDirs()) {
    const pkg = readPackageJson(join(dir, 'package.json'));
    const script = findScript(pkg?.scripts);
    if (script && pkg?.name) {
      return {
        command: packageScriptCommand(pm, script, pkg.name),
        source: `${dir}/package.json#${script}`,
      };
    }
  }

  return null;
}

function packageDevCommand(path, options = {}) {
  const pkg = readPackageJson(join(path, 'package.json'));
  if (!pkg?.name || !pkg?.scripts?.dev) return null;

  let command = `corepack pnpm --filter ${shellQuote(pkg.name)} dev`;
  if (options.webPort && /\bvite\b/.test(pkg.scripts.dev)) {
    command += ` --host 127.0.0.1 --port ${shellQuote(options.webPort)}`;
  }
  return command;
}

function hasRootScript(name) {
  const pkg = readPackageJson('package.json');
  return Boolean(pkg?.scripts?.[name]);
}

function fillLocalFileStoragePlaceholders(env) {
  const driver = String(env.FILE_STORAGE_DRIVER ?? 'local').trim() || 'local';
  if (driver !== 'local') {
    return;
  }

  const placeholders = {
    FILE_STORAGE_SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com',
    FILE_STORAGE_SPACES_BUCKET: 'dark-factory-local',
    FILE_STORAGE_SPACES_ACCESS_KEY_ID: 'local-dev',
    FILE_STORAGE_SPACES_SECRET_ACCESS_KEY: 'local-dev',
  };

  for (const [key, value] of Object.entries(placeholders)) {
    if (!String(env[key] ?? '').trim()) {
      env[key] = value;
    }
  }
}

function runtimeEnvSnapshot(env, touchedKeys) {
  const values = {};

  for (const [key, value] of Object.entries(env)) {
    if ((key === 'PORT' || key.endsWith('_PORT')) && isUsablePort(value, '')) {
      values[key] = env[key];
      continue;
    }

    if (!key.endsWith('_URL') || typeof value !== 'string') {
      continue;
    }

    try {
      const url = new URL(value);
      const isLocalHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname);
      if (isLocalHost && !url.username && !url.password) {
        values[key] = value;
      }
    } catch {
      // Ignore non-URL env values in the debug snapshot.
    }
  }

  return {
    values,
    normalizedKeys: touchedKeys,
    checkedAt: new Date().toISOString(),
  };
}

function detectCommand(role, env = {}) {
  if (role === 'api') {
    const command = packageDevCommand('apps/api');
    if (command && hasRootScript('build:packages')) {
      return `corepack pnpm build:packages && ${command}`;
    }
    if (command) return command;
  }

  if (role === 'web') {
    for (const path of ['apps/web', 'apps/admin']) {
      const command = packageDevCommand(path, { webPort: env.WEB_PORT });
      if (command) return command;
    }
  }

  if (existsSync('Makefile')) {
    return role === 'api' ? 'make api' : 'make web';
  }

  throw new Error(`Cannot detect ${role} dev command`);
}

function startDetached(name, command, env) {
  mkdirSync(LOG_DIR, { recursive: true });

  const out = openSync(join(LOG_DIR, `dev-${name}.log`), 'a');
  const child = spawn(command, {
    cwd: process.cwd(),
    detached: true,
    env,
    shell: true,
    stdio: ['ignore', out, out],
  });

  child.unref();
  closeSync(out);
  return child.pid;
}

function runDbPrep(env, state) {
  const detected = detectDbPrepCommand(env);
  if (!detected) {
    state.dbPrep = {
      skipped: true,
      reason: 'no_db_prep_command_detected',
    };
    return;
  }

  mkdirSync(LOG_DIR, { recursive: true });

  const logPath = join(LOG_DIR, 'dev-db-prep.log');
  const out = openSync(logPath, 'a');
  const startedAt = new Date().toISOString();
  writeFileSync(
    out,
    `\n[${startedAt}] ${detected.source}\n$ ${detected.command}\n`,
    { flag: 'a' },
  );

  const result = spawnSync(detected.command, {
    cwd: process.cwd(),
    env,
    shell: true,
    stdio: ['ignore', out, out],
  });
  closeSync(out);

  state.dbPrep = {
    command: detected.command,
    source: detected.source,
    logPath,
    startedAt,
    completedAt: new Date().toISOString(),
    status: result.status ?? null,
  };

  if (result.status !== 0) {
    throw new Error(`Database prep failed using ${detected.source}; see ${logPath}`);
  }
}

function registerLocalOAuthRedirects(env, state) {
  try {
    state.oauthRedirectRegistration = registerOAuthRedirects(env);
  } catch (error) {
    state.oauthRedirectRegistration = {
      failed: true,
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

async function waitFor(url, label, role) {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isReachable(url, role)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  throw new Error(`${label} did not become reachable at ${url}`);
}

async function main() {
  ensureWorktreeDirectory(STATE_DIR);

  const envFile = readEnvFiles([
    '.env.example',
    '.env',
    ...discoverLocalEnvFiles({ cwd: process.cwd(), env: process.env }),
  ]);
  const baseEnv = { ...envFile, ...process.env };
  const runtimeDescriptor = readRuntimeDescriptor(baseEnv);
  const requestedApiPort = isUsablePort(
    String(runtimeDescriptor?.apiPort || baseEnv.DARK_FACTORY_API_PORT || baseEnv.PORT || DEFAULT_API_PORT),
    DEFAULT_API_PORT,
  );
  const requestedWebPort = isUsablePort(
    String(runtimeDescriptor?.webPort || baseEnv.DARK_FACTORY_WEB_PORT || baseEnv.WEB_PORT || DEFAULT_WEB_PORT),
    DEFAULT_WEB_PORT,
  );
  const reservedPorts = new Set();
  const apiPort = await selectExpectedPort(requestedApiPort, {
    cwd: process.cwd(),
    reserved: reservedPorts,
  });
  const webPort = await selectExpectedPort(requestedWebPort, {
    cwd: process.cwd(),
    reserved: reservedPorts,
  });
  updateRuntimeDescriptor(runtimeDescriptor, apiPort, webPort);
  const normalized = await normalizeDevEnv(baseEnv, { apiPort, webPort });
  const env = normalized.env;
  fillLocalFileStoragePlaceholders(env);
  env.VITE_API_URL = `http://localhost:${apiPort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}/health`;
  const webHealthUrl = `http://127.0.0.1:${webPort}/`;
  const webUrl = `http://localhost:${webPort}/`;
  const state = {
    apiUrl,
    webUrl,
    started: {},
    checkedAt: new Date().toISOString(),
  };
  writeWorktreeFile(
    join(STATE_DIR, 'dev-env.json'),
    `${JSON.stringify(runtimeEnvSnapshot(env, normalized.touchedKeys), null, 2)}\n`,
  );

  registerLocalOAuthRedirects(env, state);
  runDbPrep(env, state);

  if (!(await isReachable(apiUrl, 'api'))) {
    const command = detectCommand('api', env);
    state.started.api = {
      command,
      pid: startDetached('api', command, env),
    };
  }

  if (!(await isReachable(webHealthUrl, 'web'))) {
    const command = detectCommand('web', env);
    state.started.web = {
      command,
      pid: startDetached('web', command, env),
    };
  }

  await waitFor(apiUrl, 'API', 'api');
  await waitFor(webHealthUrl, 'Web', 'web');

  state.readyAt = new Date().toISOString();
  writeWorktreeFile(join(STATE_DIR, 'dev-servers.json'), `${JSON.stringify(state, null, 2)}\n`);
  if (existsSync(join(STATE_DIR, 'frontend-qa-context.json'))) {
    const context = JSON.parse(readFileSync(join(STATE_DIR, 'frontend-qa-context.json'), 'utf8'));
    context.appUrl = webUrl;
    writeWorktreeFile(join(STATE_DIR, 'frontend-qa-context.json'), `${JSON.stringify(context, null, 2)}\n`);
  }
  process.stdout.write('ready');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
