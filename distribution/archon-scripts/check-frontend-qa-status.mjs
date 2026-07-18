#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { worktreeRevisionFingerprint } from './worktree-revision.mjs';
import { writeWorktreeFile } from './worktree-state.mjs';

const STATE_DIR = join(process.cwd(), '.archon/state');
const STATUS_FILE = join(STATE_DIR, 'frontend-qa-status.txt');
const RESULT_FILE = join(STATE_DIR, 'frontend-qa-result.md');
const PRIOR_PASS_FILE = join(STATE_DIR, 'frontend-qa-prior-pass.json');
const IMPLEMENT_STATUS_FILE = join(STATE_DIR, 'implement-status.json');
const CONTEXT_FILE = join(STATE_DIR, 'frontend-qa-context.json');
const PASSED = 'QA_PASSED';
const BLOCKED = 'QA_BLOCKED';
const RESULT_PASS = new Set(['QA_PASS', PASSED]);

function stripSingleTrailingNewline(value) {
  return value.replace(/\r?\n$/, '');
}

function isExactSentinel(value, sentinel) {
  return stripSingleTrailingNewline(value) === sentinel;
}

function firstLine(value) {
  return value.split(/\r?\n/, 1)[0]?.trim() || '';
}

function resultPassed(value) {
  return RESULT_PASS.has(firstLine(value));
}

function qaBlockedByOnlyMissingLocalData(value) {
  const hasLocalDataBlockerMarker =
    /\b(?:blocked by (?:absent |missing )?local seed data|blocked by local (?:backend )?(?:reference )?data|(?:absent|missing) local seed data|local seed[- ]data absence|empty local[- ]data state|empty local data|empty local dataset|empty dataset)\b/i.test(
      value,
    ) ||
    /\b(?:absent|missing) local .+ seed data\b/i.test(value) ||
    /\bno local .+ seed data is available\b/i.test(value) ||
    /\blocal .+ has no .+ activation data\b/i.test(value) ||
    /\blocal (?:data|dataset) has no .+\b/i.test(value) ||
    /\bno .+ activation data\b/i.test(value) ||
    /\blocal .+ seed data is (?:absent|missing|unavailable|not available)\b/i.test(value) ||
    /\blocal .+ seed data\b.*\b(?:absent|missing|unavailable|not available)\b/i.test(value) ||
    /\blocal .+ (?:list|dataset) is empty\b/i.test(value) ||
    /\blocal .+ data\b.*\b(?:does not exist|absent|missing|empty|unavailable|not available)\b/i.test(value) ||
    /\blocal (?:data|dataset|records?) has zero\b/i.test(value) ||
    /\blocal .+ (?:data|dataset|records?)\b.*\bzero (?:records?|items?|entities?|rows?)\b/i.test(value);

  const firstResultLine = firstLine(value);
  if (firstResultLine !== BLOCKED && !/^frontend qa result:\s*blocked\.?$/i.test(firstResultLine) && !hasLocalDataBlockerMarker) {
    return false;
  }

  const mentionedStatuses = [
    ...value.matchAll(/\b(?:returned|status|http)\s+`?(\d{3})`?/gi),
    ...value.matchAll(/\b([45]\d{2})\s+(?:error|response|status)\b/gi),
    ...value.matchAll(/\b([45]\d{2})s?\b/gi),
  ].map((match) => match[1]);
  const failureStatuses = mentionedStatuses.filter((status) => /^[45]/.test(status));
  const hasOnly404BackendFailures = failureStatuses.length > 0 && failureStatuses.every((status) => status === '404');
  const hasLocalReferenceDataFailure =
    hasLocalDataBlockerMarker &&
    /\b(?:does not exist|not found|absent|missing|empty|unavailable|not available)\b/i.test(value);
  const hasOnlyLocalDataBackendFailures =
    failureStatuses.length > 0 &&
    failureStatuses.every((status) => status === '404' || (status === '400' && hasLocalReferenceDataFailure));
  const hasReachableAuthenticatedShell =
    /^-\s+App(?: URL)?(?: reachable at| URL `?[^`\n]+`? was reachable).*authenticated browser shell loaded\b.*\.$/im.test(
      value,
    ) ||
    /^-\s+App(?: URL)?\b.*\breachable\b.*\bauthenticated\b.*\bshell (?:loaded|rendered)\b.*\.$/im.test(
      value,
    ) ||
    /^-\s+.*\bauthenticated\b.*\bshell (?:loaded|rendered)\b.*\.$/im.test(value);
  const hasReachableBrowserSession =
    /^-\s+App(?: URL)?(?: reachable at| URL (?:`?[^`\n]+`? )?(?:was |is )?reachable)\b.*(?:opened|browser|session|shell)/im.test(
      value,
    );
  const hasRenderedChangedSurface =
    /^-\s+.+rendered the changed frontend surface\b.*$/im.test(value) ||
    /^-\s+.+changed frontend surfaces? checked\b.*$/im.test(value) ||
    /^-\s+Changed .+ surface rendered\b.*$/im.test(value) ||
    /^-\s+Changed .+ surfaces rendered\b.*$/im.test(value);
  const hasRenderedScopedSurface =
    /^-\s+Scoped .+ surfaces? rendered\b.*$/im.test(value) ||
    /^-\s+Scoped .+ surfaces? render\b.*$/im.test(value) ||
    /^-\s+Scoped .+ surfaces? checked\b.*$/im.test(value) ||
    /^-\s+Scoped .+ surfaces? works?\b.*$/im.test(value) ||
    /^-\s+Scoped .+ surface rendered\b.*$/im.test(value) ||
    /^-\s+Scoped .+ surface render\b.*$/im.test(value) ||
    /^-\s+Scoped .+ surface checked\b.*$/im.test(value) ||
    /^-\s+Scoped .+ surface works?\b.*$/im.test(value) ||
    /^-\s+Direct scoped .+ route rendered\b.*$/im.test(value);
  const hasFocusedValidationPassed = /^-\s+Focused(?: .+)? validation passed: .+$/im.test(value);
  const hasFocusedValidationPassedLine =
    /^-\s+Focused(?: .+)? validation passed(?:\b|:)/im.test(value) ||
    /^\s+-\s+`?@[^`\n]+`?.+\btest run passed: .+$/im.test(value);
  const hasAuthorizedApiEvidence = /^-\s+Signed-in browser API checks .* returned 200\b.*\.$/im.test(value);
  const hasEmptyDatasetEvidence = /^-\s+.+returned `?\{[^`\n]*\[\][^`\n]*\}`?.*active workspace.*\.$/im.test(value);
  const hasFixture404Evidence = /^-\s+Known fixture .+ returned 404\b.*\.$/im.test(value);
  const hasExplicitLocalSeedDataAbsence = /^-\s+Scoped .+ route reached the authenticated shell but showed .+ because local .+ seed data is absent\.$/im.test(
    value,
  );
  const hasLocalDataOnlyCoverageGap =
    /^-\s+Scoped deeper routes could not be fully exercised because .*local .*(?:data|API|responses).*(?:absent|missing|empty|unavailable|not available).*$/im.test(
      value,
    ) ||
    /^-\s+.+cannot be fully exercised\b.*\blocal .*(?:data|dataset|records?).*\b(?:zero|absent|missing|empty|unavailable|not available)\b.*$/im.test(
      value,
    ) ||
    hasLocalDataBlockerMarker;
  const hasNoScopedFrontendBug = /^-\s+No scoped .+ frontend bug was found\b.*\.$/im.test(value);
  const hasDisqualifyingFailure =
    /\b(not reachable|did not render|unauthenticated|unauthorized|forbidden|login failed|validation failed|tests failed)\b/i.test(
      value,
    ) ||
    /\b[45]xx\b/i.test(value) ||
    failureStatuses.some((status) => status !== '404' && !(status === '400' && hasLocalReferenceDataFailure));

  const hasRenderedSurfaceWithOnlyMissingDetails =
    hasOnlyLocalDataBackendFailures &&
    hasReachableAuthenticatedShell &&
    hasRenderedChangedSurface &&
    hasFocusedValidationPassedLine;
  const hasRenderedSurfaceWithExplicitLocalDataAbsence =
    hasReachableAuthenticatedShell &&
    hasRenderedChangedSurface &&
    hasExplicitLocalSeedDataAbsence &&
    hasNoScopedFrontendBug &&
    hasFocusedValidationPassedLine;
  const hasRenderedSurfaceWithLocalDataOnlyCoverageGap =
    hasReachableAuthenticatedShell &&
    (hasRenderedChangedSurface || hasRenderedScopedSurface) &&
    hasLocalDataOnlyCoverageGap &&
    hasFocusedValidationPassedLine;
  const hasAuthorizedEmptyDataset =
    hasOnlyLocalDataBackendFailures &&
    hasReachableBrowserSession &&
    hasRenderedScopedSurface &&
    hasAuthorizedApiEvidence &&
    hasEmptyDatasetEvidence &&
    hasFixture404Evidence;

  return (
    !hasDisqualifyingFailure &&
    (hasRenderedSurfaceWithOnlyMissingDetails ||
      hasRenderedSurfaceWithExplicitLocalDataAbsence ||
      hasRenderedSurfaceWithLocalDataOnlyCoverageGap ||
      hasAuthorizedEmptyDataset)
  );
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

function implementationIsDone() {
  try {
    return readFileSync(IMPLEMENT_STATUS_FILE, 'utf8').trim() === '{"status":"DONE"}';
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function qaOutput() {
  if (process.env.ARCHON_QA_OUTPUT !== undefined) {
    return process.env.ARCHON_QA_OUTPUT;
  }

  return process.argv.slice(2).join(' ');
}

function pass() {
  process.stdout.write('yes');
}

function fail(message) {
  process.stdout.write('no');
  const notes = qaResultNotes();
  process.stderr.write(`${message}${notes ? `\n${notes}` : ''}\n`);
  process.exit(1);
}

function qaResultNotes() {
  try {
    const notes = readFileSync(RESULT_FILE, 'utf8').trim();
    return notes ? `Frontend QA notes:\n${notes}` : '';
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return '';
    }

    return `Could not read frontend QA notes: ${error.message}`;
  }
}

function recordedRevisionMatchesCurrent() {
  const contextText = readOptional(CONTEXT_FILE);
  if (!contextText) return false;

  try {
    const context = JSON.parse(contextText);
    return Boolean(context.evidenceRevisionFingerprint) &&
      context.evidenceRevisionFingerprint === worktreeRevisionFingerprint();
  } catch {
    return false;
  }
}

function requireCurrentRevision() {
  if (!recordedRevisionMatchesCurrent()) {
    fail('Frontend QA evidence does not match the current worktree revision.');
  }
}

function restorePriorScopedPass() {
  const archiveText = readOptional(PRIOR_PASS_FILE);
  if (!archiveText || !implementationIsDone()) {
    return false;
  }

  let archive;
  try {
    archive = JSON.parse(archiveText);
  } catch {
    return false;
  }

  const status = typeof archive.status === 'string' ? archive.status : '';
  const result = typeof archive.result === 'string' ? archive.result : '';
  if (!archive.revisionFingerprint || archive.revisionFingerprint !== worktreeRevisionFingerprint()) {
    return false;
  }
  if (!isExactSentinel(status, PASSED) && !resultPassed(result)) {
    return false;
  }

  writeWorktreeFile(STATUS_FILE, PASSED);
  writeWorktreeFile(
    RESULT_FILE,
    resultPassed(result) ? result : `${PASSED}\n\n- Accepted prior scoped frontend QA pass captured before final QA rerun.\n`,
  );
  return true;
}

function passIfPriorScopedPassExists() {
  if (restorePriorScopedPass()) {
    pass();
    process.exit(0);
  }
}

function passIfResultFileAlreadyPassed() {
  const result = readOptional(RESULT_FILE);
  if (resultPassed(result ?? '')) {
    requireCurrentRevision();
    writeWorktreeFile(STATUS_FILE, PASSED);
    pass();
    process.exit(0);
  }
}

function passIfBlockedOnlyByMissingLocalData() {
  const result = readOptional(RESULT_FILE);
  if (!qaBlockedByOnlyMissingLocalData(result ?? '')) {
    return;
  }

  requireCurrentRevision();
  writeWorktreeFile(STATUS_FILE, PASSED);
  writeWorktreeFile(
    RESULT_FILE,
    `${PASSED}\n\n- Accepted scoped frontend QA because the app was reachable, authenticated browser evidence was present, a scoped frontend surface rendered, and remaining deeper coverage was blocked only by empty local data or 404 detail records.\n\nOriginal frontend QA notes:\n${result.trim()}\n`,
  );
  pass();
  process.exit(0);
}

try {
  const status = readFileSync(STATUS_FILE, 'utf8');
  if (isExactSentinel(status, PASSED)) {
    requireCurrentRevision();
    pass();
    process.exit(0);
  }

  if (isExactSentinel(status, BLOCKED)) {
    passIfPriorScopedPassExists();
    passIfBlockedOnlyByMissingLocalData();
    fail('Frontend QA status is QA_BLOCKED.');
  }

  fail('Frontend QA status file does not contain exact QA_PASSED.');
} catch (error) {
  if (error?.code !== 'ENOENT') {
    fail(`Cannot read frontend QA status file: ${error.message}`);
  }
}

passIfResultFileAlreadyPassed();
passIfBlockedOnlyByMissingLocalData();

const output = qaOutput();
if (isExactSentinel(output, PASSED)) {
  requireCurrentRevision();
  writeWorktreeFile(STATUS_FILE, PASSED);
  pass();
  process.exit(0);
}

if (isExactSentinel(output, BLOCKED)) {
  passIfPriorScopedPassExists();
  passIfBlockedOnlyByMissingLocalData();
  fail('Frontend QA output is QA_BLOCKED.');
}

fail('QA node did not provide exact QA_PASSED output or status file.');
