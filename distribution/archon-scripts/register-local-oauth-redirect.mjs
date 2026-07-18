#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const DEFAULT_TABLE = 'Client';
const DEFAULT_CLIENT_ID_COLUMN = 'clientId';
const DEFAULT_REDIRECT_URIS_COLUMN = 'redirectUris';
const DEFAULT_UPDATED_AT_COLUMN = 'updatedAt';

export function isLocalHttpCallback(value) {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function sqlIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function oauthRedirectRegistrationsFromEnv(env) {
  const registrations = [];

  const pairs = [
    ['OAUTH_CLIENT_ID', 'OAUTH_CALLBACK_URL'],
    ['INFRAMODERN_OAUTH_CLIENT_ID', 'INFRAMODERN_OAUTH_CALLBACK_URL'],
    ['INFRAMODERN_SANDBOX_OAUTH_CLIENT_ID', 'INFRAMODERN_SANDBOX_OAUTH_CALLBACK_URL'],
  ];

  for (const [clientKey, callbackKey] of pairs) {
    const clientId = nonEmpty(env[clientKey]);
    const callbackUrl = nonEmpty(env[callbackKey]);

    if (!clientId || !callbackUrl || !isLocalHttpCallback(callbackUrl)) {
      continue;
    }

    if (!registrations.some((item) => item.clientId === clientId && item.callbackUrl === callbackUrl)) {
      registrations.push({ clientId, callbackUrl, source: `${clientKey}/${callbackKey}` });
    }
  }

  return registrations;
}

export function oauthRedirectDbUrlFromEnv(env) {
  return (
    nonEmpty(env.ARCHON_LOCAL_OAUTH_CLIENT_DB_URL) ||
    nonEmpty(env.DEV_START_OAUTH_CLIENT_DB_URL) ||
    nonEmpty(env.OAUTH_CLIENT_DB_URL) ||
    nonEmpty(env.INFRAMODERN_DB_URL)
  );
}

export function buildRegisterRedirectSql(registration, options = {}) {
  const table = sqlIdentifier(options.table || DEFAULT_TABLE);
  const clientIdColumn = sqlIdentifier(options.clientIdColumn || DEFAULT_CLIENT_ID_COLUMN);
  const redirectUrisColumn = sqlIdentifier(options.redirectUrisColumn || DEFAULT_REDIRECT_URIS_COLUMN);
  const updatedAtColumn = sqlIdentifier(options.updatedAtColumn || DEFAULT_UPDATED_AT_COLUMN);
  const clientId = sqlLiteral(registration.clientId);
  const callbackUrl = sqlLiteral(registration.callbackUrl);

  return `
UPDATE ${table}
SET ${redirectUrisColumn} = array_append(COALESCE(${redirectUrisColumn}, ARRAY[]::text[]), ${callbackUrl}),
    ${updatedAtColumn} = NOW()
WHERE ${clientIdColumn} = ${clientId}
  AND NOT (${callbackUrl} = ANY(COALESCE(${redirectUrisColumn}, ARRAY[]::text[])));

SELECT ${clientIdColumn} || '|' || array_to_string(${redirectUrisColumn}, ',')
FROM ${table}
WHERE ${clientIdColumn} = ${clientId};
`.trim();
}

export function registerOAuthRedirects(env, options = {}) {
  const dbUrl = oauthRedirectDbUrlFromEnv(env);
  const registrations = oauthRedirectRegistrationsFromEnv(env);
  const result = {
    skipped: false,
    reason: '',
    registrations: [],
  };

  if (!dbUrl) {
    return { ...result, skipped: true, reason: 'missing_oauth_client_db_url' };
  }

  if (registrations.length === 0) {
    return { ...result, skipped: true, reason: 'no_local_oauth_callbacks' };
  }

  const psql = options.psqlBin || env.PSQL_BIN || 'psql';

  for (const registration of registrations) {
    const sql = buildRegisterRedirectSql(registration, options);
    const command = spawnSync(psql, [dbUrl, '-v', 'ON_ERROR_STOP=1', '-Atc', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const entry = {
      clientId: registration.clientId,
      callbackUrl: registration.callbackUrl,
      source: registration.source,
      status: command.status,
    };

    if (command.status !== 0) {
      entry.error = command.stderr || command.stdout || `psql exited ${String(command.status)}`;
      result.registrations.push(entry);
      throw new Error(`OAuth redirect registration failed for ${registration.clientId}: ${entry.error}`);
    }

    entry.output = command.stdout.trim();
    result.registrations.push(entry);
  }

  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const result = registerOAuthRedirects(process.env);
    if (process.env.ARCHON_OAUTH_REDIRECT_STATE_PATH) {
      writeFileSync(process.env.ARCHON_OAUTH_REDIRECT_STATE_PATH, `${JSON.stringify(result, null, 2)}\n`);
    }
    process.stdout.write(result.skipped ? `skipped:${result.reason}` : 'registered');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
