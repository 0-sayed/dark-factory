#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, params: {} };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key.startsWith('--') || value == null) {
      throw new Error('Usage: chrome-auth-state.mjs <save|load> --port <port> --url <url> --file <file>');
    }
    args.params[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data.toString());
      if (!('id' in msg)) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result ?? {});
      }
    });
  }

  async send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  async close() {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      this.ws.addEventListener('close', resolve, { once: true });
      this.ws.close();
    });
  }
}

async function getBrowserWsUrl(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) {
    throw new Error(`Chrome is not ready on port ${port}`);
  }
  const json = await res.json();
  if (!json.webSocketDebuggerUrl) {
    throw new Error(`Chrome did not expose a browser websocket on port ${port}`);
  }
  return json.webSocketDebuggerUrl;
}

function authFileNameFromUrl(url) {
  const origin = new URL(url).origin;
  return origin.replace(/[^A-Za-z0-9._-]/g, '_');
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/^\.+/, '').replace(/\.$/, '');
}

function isLocalAuthHost(hostname) {
  const normalized = normalizeHostname(hostname);
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '127.0.0.1'
    || normalized === '0.0.0.0'
    || normalized === '::1';
}

function isLocalAuthUrl(value) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && isLocalAuthHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isLocalOrigin(value) {
  return isLocalAuthUrl(value);
}

function assertLocalAuthUrl(url, action) {
  if (!isLocalAuthUrl(url)) {
    throw new Error(`Refusing to ${action} non-local auth origin: ${new URL(url).origin}`);
  }
}

function isLocalAuthCookie(cookie) {
  if (typeof cookie.url === 'string') {
    return isLocalAuthUrl(cookie.url);
  }

  if (typeof cookie.domain === 'string') {
    return isLocalAuthHost(cookie.domain);
  }

  return false;
}

function safeCookiePath(cookie) {
  if (typeof cookie.path === 'string' && cookie.path.startsWith('/')) {
    return cookie.path;
  }
  return '/';
}

function retargetCookieForLocalUrl(cookie, targetUrl) {
  const target = new URL(targetUrl);
  const retargeted = {
    ...cookie,
    url: `${target.origin}${safeCookiePath(cookie)}`,
  };

  delete retargeted.domain;
  delete retargeted.sourcePort;
  delete retargeted.partitionKey;

  if (target.protocol === 'http:') {
    delete retargeted.secure;
  }

  return retargeted;
}

async function waitForReady(cdp, sessionId) {
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);

  for (let i = 0; i < 40; i += 1) {
    try {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }, sessionId);
      if (result?.value === 'interactive' || result?.value === 'complete') {
        return;
      }
    } catch {
      // Ignore early evaluation failures while the page boots.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for page readiness');
}

async function attachTarget(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId };
}

async function prepareSession(cdp, sessionId) {
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
}

async function navigateToUrl(cdp, sessionId, targetUrl) {
  await cdp.send('Page.navigate', { url: targetUrl }, sessionId);
  await waitForReady(cdp, sessionId);
}

async function createTarget(cdp, targetUrl = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url: targetUrl });
  return { targetId, created: true };
}

async function findPageTarget(cdp, matcher) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.find((info) => info.type === 'page' && matcher(info));
}

async function openTarget(cdp, targetUrl, { preferExistingOrigin = false, preferAnyPage = false } = {}) {
  const origin = new URL(targetUrl).origin;
  let targetInfo = null;
  let created = false;

  if (preferExistingOrigin) {
    targetInfo = await findPageTarget(cdp, (info) => info.url.startsWith(origin));
  }

  if (!targetInfo && preferAnyPage) {
    targetInfo = await findPageTarget(cdp, () => true);
  }

  if (!targetInfo) {
    ({ targetId: targetInfo, created } = await createTarget(cdp));
    targetInfo = { targetId: targetInfo, url: 'about:blank' };
  }

  const { targetId, sessionId } = await attachTarget(cdp, targetInfo.targetId);
  await prepareSession(cdp, sessionId);

  const targetUrlObject = new URL(targetUrl);
  const currentUrlObject = /^https?:\/\//.test(targetInfo.url)
    ? new URL(targetInfo.url)
    : null;
  const sameExistingOrigin =
    preferExistingOrigin && currentUrlObject?.origin === targetUrlObject.origin;

  if (targetInfo.url !== targetUrl && !sameExistingOrigin) {
    await navigateToUrl(cdp, sessionId, targetUrl);
  } else {
    await waitForReady(cdp, sessionId);
  }

  return { targetId, sessionId, created };
}

function storageExpression(kind) {
  return `(() => Object.entries(${kind}).map(([name, value]) => ({ name, value })))()`;
}

async function captureStorage(cdp, sessionId) {
  const local = await cdp.send('Runtime.evaluate', {
    expression: storageExpression('localStorage'),
    returnByValue: true,
  }, sessionId);
  const session = await cdp.send('Runtime.evaluate', {
    expression: storageExpression('sessionStorage'),
    returnByValue: true,
  }, sessionId);

  return {
    localStorage: local.result?.value ?? [],
    sessionStorage: session.result?.value ?? [],
  };
}

function cookieVariantKey(cookie) {
  return [
    cookie.name,
    cookie.url ?? '',
    cookie.domain ?? '',
    cookie.path ?? '',
    cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : '',
  ].join('\u0000');
}

function localCookieTargetUrls(targetUrl, sourceUrls = []) {
  const urls = [targetUrl, ...sourceUrls].filter(Boolean).filter(isLocalAuthUrl);
  return [...new Set(urls.map((url) => {
    const parsed = new URL(url);
    return parsed.origin;
  }))];
}

function sanitizeCookies(cookies, { targetUrl, sourceUrls = [] } = {}) {
  const allowed = new Set([
    'name',
    'value',
    'url',
    'domain',
    'path',
    'secure',
    'httpOnly',
    'sameSite',
    'expires',
    'priority',
    'sameParty',
    'sourceScheme',
    'sourcePort',
    'partitionKey',
  ]);

  const sanitizedCookies = [];
  const seen = new Set();
  for (const cookie of cookies.filter((entry) => isLocalAuthCookie(entry))) {
      const sanitized = Object.fromEntries(
        Object.entries(cookie).filter(([key, value]) => allowed.has(key) && value !== undefined),
      );

      const variants = targetUrl
        ? localCookieTargetUrls(targetUrl, sourceUrls).map((url) => retargetCookieForLocalUrl(sanitized, url))
        : [sanitized];

      for (const variant of variants) {
        const key = cookieVariantKey(variant);
        if (seen.has(key)) continue;
        seen.add(key);
        sanitizedCookies.push(variant);
      }
  }

  return sanitizedCookies;
}

function statusMatches(status, expectation) {
  const value = String(expectation ?? '200-299');
  if (/^\d+$/.test(value)) {
    return status === Number(value);
  }

  const range = value.match(/^(\d+)-(\d+)$/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    return status >= min && status <= max;
  }

  throw new Error(`Unsupported status expectation: ${value}`);
}

async function saveState({ port, url, file }) {
  assertLocalAuthUrl(url, 'save');

  const wsUrl = await getBrowserWsUrl(port);
  const cdp = new CDP(wsUrl);
  await cdp.connect();

  const origin = new URL(url).origin;
  let targetId;
  let sessionId;
  let created = false;
  try {
    ({ targetId, sessionId, created } = await openTarget(cdp, url, { preferExistingOrigin: true }));
    const cookiesResult = await cdp.send('Network.getCookies', { urls: [url] }, sessionId);
    const storage = await captureStorage(cdp, sessionId);
    const payload = {
      savedAt: new Date().toISOString(),
      url,
      cookies: sanitizeCookies(cookiesResult.cookies ?? []),
      origins: [{
        origin,
        localStorage: storage.localStorage,
        sessionStorage: storage.sessionStorage,
      }],
    };
    await fs.writeFile(file, JSON.stringify(payload, null, 2));
  } finally {
    if (targetId && created) {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
    await cdp.close().catch(() => {});
  }
}

function findOriginState(state, url) {
  const origin = new URL(url).origin;
  const exact = state.origins?.find((entry) => entry.origin === origin);
  if (exact) return exact;

  const localOrigins = (state.origins ?? []).filter((entry) => isLocalOrigin(entry.origin));
  if (isLocalOrigin(origin) && localOrigins.length === 1) {
    return {
      ...localOrigins[0],
      origin,
    };
  }

  return {
    origin,
    localStorage: [],
    sessionStorage: [],
  };
}

function injectStorageExpression(originState) {
  return `(() => {
    const localEntries = ${JSON.stringify(originState.localStorage ?? [])};
    const sessionEntries = ${JSON.stringify(originState.sessionStorage ?? [])};
    localStorage.clear();
    sessionStorage.clear();
    for (const { name, value } of localEntries) localStorage.setItem(name, value);
    for (const { name, value } of sessionEntries) sessionStorage.setItem(name, value);
    return {
      localStorage: Object.entries(localStorage).length,
      sessionStorage: Object.entries(sessionStorage).length
    };
  })()`;
}

async function loadState({ port, url, file }) {
  assertLocalAuthUrl(url, 'load');

  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  const wsUrl = await getBrowserWsUrl(port);
  const cdp = new CDP(wsUrl);
  await cdp.connect();

  const originState = findOriginState(state, url);
  const cookies = sanitizeCookies(state.cookies ?? [], {
    targetUrl: url,
    sourceUrls: [
      state.url,
      ...(state.origins ?? []).map((entry) => entry.origin),
    ],
  });

  try {
    const { sessionId } = await openTarget(cdp, url, { preferAnyPage: true });
    if (cookies.length > 0) {
      await cdp.send('Network.setCookies', { cookies }, sessionId);
    }
    await cdp.send('Runtime.evaluate', {
      expression: injectStorageExpression(originState),
      returnByValue: true,
    }, sessionId);
    await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
    await waitForReady(cdp, sessionId);
  } finally {
    await cdp.close().catch(() => {});
  }
}

async function verifyState({ port, url, expectStatus }) {
  assertLocalAuthUrl(url, 'verify');

  const wsUrl = await getBrowserWsUrl(port);
  const cdp = new CDP(wsUrl);
  await cdp.connect();

  let targetId;
  let created = false;
  let sessionId;
  try {
    ({ targetId, sessionId, created } = await openTarget(cdp, url, { preferAnyPage: true }));
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `fetch(${JSON.stringify(url)}, { credentials: 'include', redirect: 'manual' }).then((res) => ({ status: res.status, ok: res.ok, type: res.type, redirected: res.redirected })).catch((error) => ({ status: 0, ok: false, error: String(error) }))`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);

    const payload = result?.value ?? {};
    if (!statusMatches(Number(payload.status), expectStatus)) {
      const suffix = payload.error ? ` (${payload.error})` : '';
      throw new Error(`Auth verification failed: expected HTTP ${expectStatus}, got ${payload.status}${suffix}`);
    }
  } finally {
    if (targetId && created) {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
    await cdp.close().catch(() => {});
  }
}

async function listOrigins({ port }) {
  const wsUrl = await getBrowserWsUrl(port);
  const cdp = new CDP(wsUrl);
  await cdp.connect();

  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const origins = [...new Set(
      targetInfos
        .filter((info) => info.type === 'page' && /^https?:\/\//.test(info.url))
        .filter((info) => isLocalAuthUrl(info.url))
        .map((info) => new URL(info.url).origin),
    )];
    for (const origin of origins) {
      console.log(origin);
    }
  } finally {
    await cdp.close().catch(() => {});
  }
}

async function saveAll({ port, dir }) {
  const wsUrl = await getBrowserWsUrl(port);
  const cdp = new CDP(wsUrl);
  await cdp.connect();

  let origins = [];
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    origins = [...new Set(
      targetInfos
        .filter((info) => info.type === 'page' && /^https?:\/\//.test(info.url))
        .filter((info) => isLocalAuthUrl(info.url))
        .map((info) => info.url),
    )];
  } finally {
    await cdp.close().catch(() => {});
  }

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const url of origins) {
    const file = path.join(dir, `${authFileNameFromUrl(url)}.json`);
    await saveState({ port, url, file });
  }
}

function assertSelfTest(condition, message) {
  if (!condition) {
    throw new Error(`Self-test failed: ${message}`);
  }
}

function runSelfTest() {
  const targetUrl = 'http://127.0.0.1:5173/dashboard';
  const originState = findOriginState({
    origins: [{
      origin: 'http://localhost:5174',
      localStorage: [{ name: 'selectedWorkspace', value: 'demo' }],
      sessionStorage: [{ name: 'tab', value: '1' }],
    }],
  }, targetUrl);

  assertSelfTest(originState.origin === 'http://127.0.0.1:5173', 'retargets single local origin');
  assertSelfTest(originState.localStorage[0]?.name === 'selectedWorkspace', 'preserves localStorage entries');

  const emptyOriginState = findOriginState({
    origins: [
      { origin: 'http://localhost:5174', localStorage: [{ name: 'a', value: '1' }], sessionStorage: [] },
      { origin: 'http://127.0.0.1:3000', localStorage: [{ name: 'b', value: '2' }], sessionStorage: [] },
    ],
  }, targetUrl);

  assertSelfTest(emptyOriginState.localStorage.length === 0, 'does not guess between multiple local origins');

  const cookies = sanitizeCookies([
    { name: 'sid', value: 'abc', domain: 'localhost', path: '/', secure: true, sourcePort: 5174 },
    { name: 'public', value: 'nope', domain: 'example.com', path: '/' },
  ], { targetUrl, sourceUrls: ['http://localhost:5174'] });

  assertSelfTest(cookies.length === 2, 'filters non-local cookies and covers source plus target local aliases');
  assertSelfTest(cookies.some((cookie) => cookie.url === 'http://127.0.0.1:5173/'), 'retargets cookie to target local origin');
  assertSelfTest(cookies.some((cookie) => cookie.url === 'http://localhost:5174/'), 'keeps source local host alias available');
  assertSelfTest(!('domain' in cookies[0]), 'removes stale cookie domain on retarget');
  assertSelfTest(!('sourcePort' in cookies[0]), 'removes stale cookie source port on retarget');
  assertSelfTest(!('secure' in cookies[0]), 'removes secure flag for http local target');
}

async function main() {
  const { command, params } = parseArgs(process.argv.slice(2));
  const port = Number(params.port);
  const url = params.url;
  const file = params.file;
  const dir = params.dir;

  if (command === 'self-test') {
    runSelfTest();
    console.log('chrome-auth-state self-test passed');
    return;
  }

  if (!command || !port) {
    throw new Error('Usage: chrome-auth-state.mjs <save|load|verify|save-all|origins> --port <port> [--url <url>] [--file <file>] [--dir <dir>] [--expect-status <status-or-range>]');
  }

  if (command === 'save') {
    if (!url || !file) {
      throw new Error('Usage: chrome-auth-state.mjs save --port <port> --url <url> --file <file>');
    }
    await saveState({ port, url, file });
    console.log(`Saved auth state to ${file}`);
    return;
  }

  if (command === 'load') {
    if (!url || !file) {
      throw new Error('Usage: chrome-auth-state.mjs load --port <port> --url <url> --file <file>');
    }
    await loadState({ port, url, file });
    console.log(`Loaded auth state from ${file}`);
    return;
  }

  if (command === 'verify') {
    if (!url) {
      throw new Error('Usage: chrome-auth-state.mjs verify --port <port> --url <url> [--expect-status <status-or-range>]');
    }
    await verifyState({ port, url, expectStatus: params['expect-status'] ?? '200-299' });
    console.log(`Verified auth state at ${url}`);
    return;
  }

  if (command === 'origins') {
    await listOrigins({ port });
    return;
  }

  if (command === 'save-all') {
    if (!dir) {
      throw new Error('Usage: chrome-auth-state.mjs save-all --port <port> --dir <dir>');
    }
    await saveAll({ port, dir });
    return;
  }

  throw new Error(`Unsupported command: ${command}`);
}

await main();
