#!/usr/bin/env node
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_EMPTY_PORT_URL = /^http:\/\/(?:localhost|127\.0\.0\.1):(?=\/|$)/;
const LOCAL_HTTP_LOOPBACK_HOST = /^http:\/\/127\.0\.0\.1(?=[:/]|$)/;
const PORT_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/gi;
const DEFAULT_API_PORT = 3000;
const DEFAULT_WEB_PORT = 4173;
const DEFAULT_UNKNOWN_PORT = 49_152;

export function parseEnvText(text) {
  const env = {};

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }

    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    env[key] = value;
  }

  return env;
}

export function readEnvFiles(paths) {
  const env = {};

  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }

    Object.assign(env, parseEnvText(readFileSync(path, 'utf8')));
  }

  return env;
}

export function discoverLocalEnvFiles({ cwd = process.cwd(), env = process.env } = {}) {
  const configHome = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : '');
  const candidates = [
    join(cwd, '.env.local'),
    join(cwd, '.env.development.local'),
    ...(configHome ? [join(configHome, 'dev-start', 'env')] : []),
  ];
  const envDir = configHome ? join(configHome, 'dev-start', 'env.d') : '';

  if (envDir && existsSync(envDir)) {
    for (const file of readdirSync(envDir).sort()) {
      if (file.endsWith('.env')) {
        candidates.push(join(envDir, file));
      }
    }
  }

  return candidates.filter((path) => existsSync(path));
}

export function isUsablePort(value) {
  return /^\d+$/.test(String(value ?? '')) && Number(value) > 0 && Number(value) <= 65_535;
}

function inferPortRole(name) {
  if (/^(API|BACKEND|SERVER|GATEWAY|SERVICE)_PORT$/i.test(name)) {
    return 'api';
  }

  if (/^(WEB|ADMIN|FRONTEND|CLIENT|UI|DASHBOARD|APP)_PORT$/i.test(name)) {
    return 'web';
  }

  if (name === 'PORT') {
    return 'api';
  }

  return 'unknown';
}

function inferUrlPortRole(name) {
  if (/(API|CALLBACK|SERVER|BACKEND|GATEWAY)/i.test(name)) {
    return 'api';
  }

  if (/(ADMIN|WEB|FRONTEND|CLIENT|UI|DASHBOARD|APP)/i.test(name)) {
    return 'web';
  }

  return 'unknown';
}

function collectPortPlaceholders(env) {
  const names = new Set();

  for (const value of Object.values(env)) {
    if (typeof value !== 'string') {
      continue;
    }

    for (const match of value.matchAll(PORT_PLACEHOLDER)) {
      if (/_PORT$/i.test(match[1]) || match[1] === 'PORT') {
        names.add(match[1]);
      }
    }
  }

  return names;
}

function expandTemplates(env) {
  const expanded = { ...env };

  for (let pass = 0; pass < 10; pass += 1) {
    let changed = false;

    for (const [key, value] of Object.entries(expanded)) {
      if (typeof value !== 'string') {
        continue;
      }

      const next = value.replace(PORT_PLACEHOLDER, (_match, name) => expanded[name] ?? '');
      if (next !== value) {
        expanded[key] = next;
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return expanded;
}

async function defaultAllocatePort(preferred, reserved) {
  let port = Number(preferred);

  while (port <= 65_535) {
    if (!reserved.has(String(port)) && (await canListen(port))) {
      reserved.add(String(port));
      return String(port);
    }

    port += 1;
  }

  throw new Error(`Could not allocate a free localhost port starting at ${preferred}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function preferredRolePort(role, env, options) {
  if (role === 'api') {
    return options.apiPort ?? env.API_PORT ?? env.PORT ?? DEFAULT_API_PORT;
  }

  if (role === 'web') {
    return options.webPort ?? env.WEB_PORT ?? env.ADMIN_PORT ?? DEFAULT_WEB_PORT;
  }

  return undefined;
}

function repairEmptyLocalUrlPort(key, value, env, options) {
  if (typeof value !== 'string' || !LOCAL_EMPTY_PORT_URL.test(value)) {
    return value;
  }

  const role = inferUrlPortRole(key);
  const port =
    role === 'api'
      ? options.apiPort ?? env.API_PORT ?? env.PORT
      : role === 'web'
        ? options.webPort ?? env.WEB_PORT ?? env.ADMIN_PORT
        : undefined;

  if (!isUsablePort(port)) {
    return value;
  }

  return value.replace(LOCAL_EMPTY_PORT_URL, `http://localhost:${port}`);
}

function canonicalizeLocalHttpUrl(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(LOCAL_HTTP_LOOPBACK_HOST, 'http://localhost');
}

export async function normalizeDevEnv(inputEnv, options = {}) {
  const env = { ...inputEnv };
  const touched = new Set();
  const reserved = new Set(
    Object.entries(env)
      .filter(([key, value]) => /_PORT$|^PORT$/.test(key) && isUsablePort(value))
      .map(([, value]) => String(value)),
  );
  const allocatePort = options.allocatePort ?? ((preferred) => defaultAllocatePort(preferred, reserved));

  if (isUsablePort(options.apiPort)) {
    env.API_PORT = String(options.apiPort);
    env.PORT = String(options.apiPort);
    touched.add('API_PORT');
    touched.add('PORT');
  }

  if (isUsablePort(options.webPort)) {
    env.WEB_PORT = String(options.webPort);
    touched.add('WEB_PORT');
  }

  const placeholderPorts = collectPortPlaceholders(env);

  for (const name of placeholderPorts) {
    const role = inferPortRole(name);
    const rolePort = role === 'api' ? options.apiPort : role === 'web' ? options.webPort : undefined;
    if (isUsablePort(rolePort) && String(env[name]) !== String(rolePort)) {
      env[name] = String(rolePort);
      touched.add(name);
      continue;
    }

    if (isUsablePort(env[name])) {
      continue;
    }

    const preferred = preferredRolePort(role, env, options);
    const value = isUsablePort(preferred)
      ? String(preferred)
      : await allocatePort(DEFAULT_UNKNOWN_PORT);
    env[name] = value;
    touched.add(name);
  }

  let expanded = expandTemplates(env);

  for (const [key, value] of Object.entries(expanded)) {
    const repaired = repairEmptyLocalUrlPort(key, value, expanded, options);
    const canonicalized = canonicalizeLocalHttpUrl(repaired);
    if (canonicalized !== value) {
      expanded[key] = canonicalized;
      touched.add(key);
    }
  }

  return { env: expanded, touchedKeys: [...touched].sort() };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseSet(value) {
  const separator = value.indexOf('=');
  if (separator === -1) {
    throw new Error(`Invalid --set value: ${value}`);
  }

  return [value.slice(0, separator), value.slice(separator + 1)];
}

function detectWorktreeIndex() {
  try {
    const current = execFileSync('pwd', ['-P'], { encoding: 'utf8' }).trim();
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const paths = output
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim());

    return paths.findIndex((path) => path === current);
  } catch {
    return -1;
  }
}

function defaultWorktreePort(defaultPort, index) {
  if (index <= 0) {
    return undefined;
  }

  return String(defaultPort + index * 100);
}

async function runCli(argv) {
  const envFiles = [];
  const sets = {};
  let printShell = false;
  let printJson = false;
  let includeLocalEnv = true;
  let writeJson = '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env-file') {
      envFiles.push(argv[++i]);
    } else if (arg === '--set') {
      const [key, value] = parseSet(argv[++i]);
      sets[key] = value;
    } else if (arg === '--print-shell') {
      printShell = true;
    } else if (arg === '--print-json') {
      printJson = true;
    } else if (arg === '--no-local-env') {
      includeLocalEnv = false;
    } else if (arg === '--write-json') {
      writeJson = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const effectiveEnvFiles = includeLocalEnv ? [...envFiles, ...discoverLocalEnvFiles()] : envFiles;
  const fileEnv = readEnvFiles(effectiveEnvFiles);
  const worktreeIndex = detectWorktreeIndex();
  const apiPort =
    sets.API_PORT ??
    process.env.DARK_FACTORY_API_PORT ??
    process.env.API_PORT ??
    defaultWorktreePort(DEFAULT_API_PORT, worktreeIndex);
  const webPort =
    sets.WEB_PORT ??
    process.env.DARK_FACTORY_WEB_PORT ??
    process.env.WEB_PORT ??
    process.env.ADMIN_PORT ??
    defaultWorktreePort(DEFAULT_WEB_PORT, worktreeIndex);
  const { env, touchedKeys } = await normalizeDevEnv(
    { ...fileEnv, ...process.env, ...sets },
    {
      apiPort,
      webPort,
    },
  );
  const exportKeys = [...new Set([...Object.keys(fileEnv), ...Object.keys(sets), ...touchedKeys])].sort();

  if (writeJson) {
    mkdirSync(dirname(writeJson), { recursive: true });
    writeFileSync(writeJson, `${JSON.stringify({ env, touchedKeys }, null, 2)}\n`);
  }

  if (printShell) {
    for (const key of exportKeys) {
      if (env[key] !== undefined) {
        process.stdout.write(`export ${key}=${shellQuote(env[key])}\n`);
      }
    }
  }

  if (printJson) {
    process.stdout.write(`${JSON.stringify({ env, touchedKeys }, null, 2)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
