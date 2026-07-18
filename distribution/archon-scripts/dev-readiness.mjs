import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { readlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function isInside(root, candidate) {
  const parent = resolve(root);
  const child = resolve(candidate);
  return child === parent || child.startsWith(`${parent}${sep}`);
}

async function listenerPids(port) {
  try {
    const { stdout } = await execFileAsync('ss', ['-H', '-ltnp', `sport = :${port}`], {
      encoding: 'utf8',
    });
    const pids = [...stdout.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
    if (pids.length > 0) return pids;
  } catch {
    // Try lsof below for platforms without ss.
  }

  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    });
    return stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
  } catch {
    return [];
  }
}

export async function listenerOwnedByWorktree(port, cwd = process.cwd()) {
  for (const pid of await listenerPids(port)) {
    try {
      if (isInside(cwd, await readlink(`/proc/${pid}/cwd`))) return true;
    } catch {
      // A process may exit while it is being inspected.
    }
  }
  return false;
}

export function isPortAvailable(port) {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolveAvailable(false));
    server.listen({ host: '127.0.0.1', port: Number(port), exclusive: true }, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

export async function selectExpectedPort(preferred, options = {}) {
  const start = Number(preferred);
  const reserved = options.reserved ?? new Set();
  const available = options.isPortAvailable ?? isPortAvailable;
  const owned = options.listenerOwnedByWorktree ?? listenerOwnedByWorktree;

  for (let port = start; port <= 65_535; port += 1) {
    if (reserved.has(String(port))) continue;
    if (await available(port) || await owned(port, options.cwd)) {
      reserved.add(String(port));
      return String(port);
    }
  }
  throw new Error(`Could not allocate a localhost port from ${preferred}`);
}

export async function isExpectedServiceReachable(url, options = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok && response.status >= 500) return false;

    if (options.role === 'web') {
      const contentType = response.headers.get('content-type') || '';
      const body = await response.text();
      if (!contentType.includes('text/html') && !/<html[\s>]/i.test(body) && !/<!doctype html/i.test(body)) {
        return false;
      }
    }

    const port = new URL(url).port;
    const owned = options.listenerOwnedByWorktree ?? listenerOwnedByWorktree;
    return Boolean(port) && await owned(port, options.cwd ?? process.cwd());
  } catch {
    return false;
  }
}
