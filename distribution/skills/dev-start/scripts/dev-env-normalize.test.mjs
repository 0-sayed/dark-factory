import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverLocalEnvFiles, normalizeDevEnv, readEnvFiles } from './dev-env-normalize.mjs';

test('fills missing app port placeholders from explicit api and web ports before expanding urls', async () => {
  const { env, touchedKeys } = await normalizeDevEnv(
    {
      ADMIN_URL: 'http://127.0.0.1:${ADMIN_PORT}',
      API_BASE_URL: 'http://127.0.0.1:${API_PORT}',
      AUTH_CALLBACK_URL: 'http://127.0.0.1:${API_PORT}/auth/callback',
    },
    { apiPort: '32001', webPort: '42001' },
  );

  assert.equal(env.API_PORT, '32001');
  assert.equal(env.PORT, '32001');
  assert.equal(env.WEB_PORT, '42001');
  assert.equal(env.ADMIN_PORT, '42001');
  assert.equal(env.ADMIN_URL, 'http://localhost:42001');
  assert.equal(env.API_BASE_URL, 'http://localhost:32001');
  assert.equal(env.AUTH_CALLBACK_URL, 'http://localhost:32001/auth/callback');
  assert.deepEqual(touchedKeys, [
    'ADMIN_PORT',
    'ADMIN_URL',
    'API_BASE_URL',
    'API_PORT',
    'AUTH_CALLBACK_URL',
    'PORT',
    'WEB_PORT',
  ]);
});

test('explicit worktree web port overrides default admin port when admin port is referenced', async () => {
  const { env } = await normalizeDevEnv(
    {
      ADMIN_PORT: '4173',
      ADMIN_URL: 'http://127.0.0.1:${ADMIN_PORT}',
    },
    { webPort: '42001' },
  );

  assert.equal(env.WEB_PORT, '42001');
  assert.equal(env.ADMIN_PORT, '42001');
  assert.equal(env.ADMIN_URL, 'http://localhost:42001');
});

test('supports renamed backend and frontend port variables without project-specific names', async () => {
  const { env } = await normalizeDevEnv(
    {
      PUBLIC_API_URL: 'http://127.0.0.1:${BACKEND_PORT}',
      DASHBOARD_URL: 'http://127.0.0.1:${FRONTEND_PORT}',
    },
    { apiPort: '41001', webPort: '41002' },
  );

  assert.equal(env.BACKEND_PORT, '41001');
  assert.equal(env.FRONTEND_PORT, '41002');
  assert.equal(env.PUBLIC_API_URL, 'http://localhost:41001');
  assert.equal(env.DASHBOARD_URL, 'http://localhost:41002');
});

test('allocates an unknown missing port placeholder through the supplied allocator', async () => {
  const allocated = [];
  const { env } = await normalizeDevEnv(
    {
      CUSTOM_TOOL_URL: 'http://127.0.0.1:${CUSTOM_TOOL_PORT}',
    },
    {
      allocatePort: async (preferred) => {
        allocated.push(preferred);
        return '61234';
      },
    },
  );

  assert.deepEqual(allocated, [49152]);
  assert.equal(env.CUSTOM_TOOL_PORT, '61234');
  assert.equal(env.CUSTOM_TOOL_URL, 'http://localhost:61234');
});

test('repairs local urls whose port was already expanded to empty', async () => {
  const { env } = await normalizeDevEnv(
    {
      ADMIN_URL: 'http://127.0.0.1:',
      API_BASE_URL: 'http://127.0.0.1:',
      OAUTH_CALLBACK_URL: 'http://127.0.0.1:/auth/callback',
    },
    { apiPort: '32001', webPort: '42001' },
  );

  assert.equal(env.ADMIN_URL, 'http://localhost:42001');
  assert.equal(env.API_BASE_URL, 'http://localhost:32001');
  assert.equal(env.OAUTH_CALLBACK_URL, 'http://localhost:32001/auth/callback');
});

test('canonicalizes local http env urls to localhost without changing ports or paths', async () => {
  const { env } = await normalizeDevEnv(
    {
      OAUTH_CALLBACK_URL: 'http://127.0.0.1:3000/auth/callback',
      LOCAL_SERVICE_URL: 'http://localhost:4567/ready',
      PUBLIC_REMOTE_URL: 'https://example.com/app',
    },
    {},
  );

  assert.equal(env.OAUTH_CALLBACK_URL, 'http://localhost:3000/auth/callback');
  assert.equal(env.LOCAL_SERVICE_URL, 'http://localhost:4567/ready');
  assert.equal(env.PUBLIC_REMOTE_URL, 'https://example.com/app');
});

test('discovers project-local and user-local env overrides in deterministic order', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-start-project-'));
  const configHome = await mkdtemp(join(tmpdir(), 'dev-start-config-'));
  const envDir = join(configHome, 'dev-start', 'env.d');
  await mkdir(envDir, { recursive: true });

  await writeFile(join(cwd, '.env.local'), 'SERVICE_URL=http://localhost:4000\n');
  await writeFile(join(cwd, '.env.development.local'), 'SERVICE_URL=http://localhost:4001\n');
  await writeFile(join(configHome, 'dev-start', 'env'), 'SERVICE_URL=http://localhost:4002\n');
  await writeFile(join(envDir, '20-service.env'), 'SERVICE_URL=http://localhost:4003\n');
  await writeFile(join(envDir, '10-service.env'), 'SERVICE_URL=http://localhost:4004\n');

  const files = discoverLocalEnvFiles({ cwd, env: { XDG_CONFIG_HOME: configHome } });
  assert.deepEqual(files, [
    join(cwd, '.env.local'),
    join(cwd, '.env.development.local'),
    join(configHome, 'dev-start', 'env'),
    join(envDir, '10-service.env'),
    join(envDir, '20-service.env'),
  ]);

  assert.equal(readEnvFiles(files).SERVICE_URL, 'http://localhost:4003');
});
