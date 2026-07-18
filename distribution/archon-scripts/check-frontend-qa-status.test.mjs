import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = new URL('./check-frontend-qa-status.mjs', import.meta.url).pathname;
const contextScriptPath = new URL('./frontend-qa-context.mjs', import.meta.url).pathname;
const recorderScriptPath = new URL('./record-frontend-qa-revision.mjs', import.meta.url).pathname;

function runChecker({ result, status = 'QA_BLOCKED' }) {
  const cwd = mkdtempSync(join(tmpdir(), 'frontend-qa-status-'));
  const stateDir = join(cwd, '.archon/state');
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd });
  writeFileSync(join(cwd, 'package.json'), '{"private":true}\n');
  execFileSync('git', ['add', 'package.json'], { cwd });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });
  execFileSync(process.execPath, [contextScriptPath], { cwd });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'frontend-qa-result.md'), result);
  if (status !== null) {
    writeFileSync(join(stateDir, 'frontend-qa-status.txt'), status);
  }
  execFileSync(process.execPath, [recorderScriptPath], { cwd });

  try {
    const run = spawnSync(process.execPath, [scriptPath], {
      cwd,
      encoding: 'utf8',
    });
    const writtenStatus = readFileSync(join(stateDir, 'frontend-qa-status.txt'), 'utf8');
    const writtenResult = readFileSync(join(stateDir, 'frontend-qa-result.md'), 'utf8');
    return { ...run, writtenStatus, writtenResult };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('accepts authenticated shell and changed surfaces when only local seed data blocks deeper QA', () => {
  const result = runChecker({
    result: `QA_BLOCKED

- App URL reachable: http://localhost:44065/
- Browser auth loaded and the authenticated admin shell rendered.
- Changed frontend list/empty-state surfaces rendered: \`/projects\`, \`/documents\`, and \`/materials\`.
- Portfolio documents API returned 200 and the documents filters/summary surface rendered.
- Deeper project documents route is blocked by local seed data: \`/projects/fixture-project\` returned 404, while the scoped documents request returned 200.
- Browser page errors: none observed on the scoped routes.
- Focused validation passed: targeted admin Vitest selection completed.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('accepts explicit local seed data blocker notes even when result omits sentinel', () => {
  const result = runChecker({
    result: `- App reachable at \`http://localhost:59371/\`.
- Browser auth worked; authenticated admin shell loaded for a workspace user.
- Changed project list surface rendered and showed the empty local-data state: "No projects match these filters".
- Scoped submittals route loaded the shell but showed "Could not load project submittals." because no local project seed data is available for deeper route QA.
- Focused admin validation passed: targeted test selection completed.
- QA blocked by local seed data absence; no product code changes made.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('accepts absent local seed data wording after authenticated scoped QA', () => {
  const result = runChecker({
    result: `QA_BLOCKED

- App URL was reachable at \`http://localhost:5173/\`.
- Browser auth worked; the authenticated admin shell loaded.
- Scoped changed surfaces rendered: global nav, Projects list empty state and filters, Project creation wizard, portfolio Documents empty state and filters, and portfolio Materials empty state.
- Deeper project-scoped routes were blocked by absent local seed data: \`/projects/demo-project\` rendered the project dashboard failure state after the project lookup could not load a local project.
- Focused validation passed: \`corepack pnpm --filter @example/admin test\` completed.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('accepts authenticated empty local dataset wording after scoped QA', () => {
  const result = runChecker({
    result: `QA_BLOCKED

- App URL was reachable at \`http://localhost:5173/\`.
- Browser auth loaded and the authenticated admin shell rendered.
- Scoped changed frontend surfaces checked: workspace shell/nav, \`/projects\` empty-state and filters, \`/documents\` portfolio documents filters/summary, \`/projects/new\` basics form, and direct project detail/admin route probes.
- \`/projects\` returned an authenticated empty local dataset (\`{"projects":[],"nextCursor":null}\`), so project-specific dashboard/documents/schedule/submittals routes could not be exercised with real local seed data.
- No scoped conflict markers or browser runtime errors were found in the checked frontend surface.
- Focused validation passed: \`corepack pnpm --filter @example/admin test\`.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('accepts missing local reference data after authenticated scoped QA', () => {
  const result = runChecker({
    result: `QA_BLOCKED

- App URL was reachable at http://localhost:5173/.
- Authenticated browser shell loaded for a workspace user.
- Changed frontend surfaces rendered: Projects empty state, portfolio Documents filters/summary, and Project creation wizard through Review.
- Deeper project-scoped Documents/Submittals routes are blocked by local data: \`/projects?includeArchived=true&limit=100\` returned an empty project list, and creating a project via the wizard failed with backend 400 \`End customer identity does not exist\`.
- Focused admin validation passed: \`corepack pnpm --filter @example/admin test -- src/projects/creation-wizard/ProjectCreationWizard.test.tsx src/projects/documents/PortfolioDocumentsPage.test.tsx\`.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('accepts direct route render with empty local project list', () => {
  const result = runChecker({
    result: `Frontend QA result: blocked.

- App URL was reachable at \`http://localhost:53685/\`.
- Browser auth worked after using the example sign-in flow; the authenticated admin shell loaded.
- Scoped project list surface rendered the changed empty state: no local projects were returned.
- Direct scoped snags route rendered the Snags admin page, summary, create form, and empty list.
- Deeper scoped route coverage is blocked by absent local seed data: \`/projects\` returned an empty list, the test project detail returned 404, and creating a snag for that missing project returned 404.
- Focused admin validation passed with \`corepack pnpm --filter @example/admin test -- --run ...\`.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('accepts rendered list and portfolio surfaces with missing local project detail', () => {
  const result = runChecker({
    result: `QA_BLOCKED

- App URL was reachable at \`http://localhost:52903/\`.
- Browser auth worked; the authenticated admin shell loaded for workspace \`Example Workspace\`.
- Changed frontend list/empty-state surfaces rendered: Projects showed filters plus \`No projects match these filters\`; Materials / BOM showed the empty portfolio register; project Documents showed summary cards, create/certificate/photo forms, filters, and an empty table.
- Project dashboard, project materials, and project schedule routes were blocked only by missing local seed data for \`fixture-project\`; required API requests returned 404.
- Focused validation passed for all scoped admin frontend files.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('accepts top-level scoped surfaces with local project list blocker', () => {
  const result = runChecker({
    result: `QA_BLOCKED

- App reachable at \`http://localhost:49607/\`; authenticated admin shell loaded.
- Scoped top-level frontend surfaces rendered without browser errors: projects list empty state/filters, portfolio materials, portfolio documents, people/roles admin, and settings admin.
- Fixed feature-specific settings DI failures in \`SettingsController\` and \`SettingsService\`; rechecked \`/settings/defaults\` returned 200 and the settings page rendered.
- Focused validation passed:
  - \`@example/api\` settings controller test run passed.
  - \`@example/admin\` scoped frontend test run passed.
- Blocker: local project list is empty, so scoped project-detail admin routes only reached Retry/404 states for a dummy project id. The failures were 404 local-data responses, not frontend runtime errors.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('accepts scoped surfaces that work when only local records block deeper QA', () => {
  const result = runChecker({
    result: `QA_BLOCKED

- App URL reachable: http://localhost:44031/
- Authenticated browser shell loaded for a workspace user.
- Scoped global search surface works: topbar search opens, labelled searchbox focuses, one-character input stays below the search threshold, and "villa" renders the no-results state.
- Scoped top-level admin surfaces render with local empty data: lists, documents, branding, and settings.
- Detail-specific scoped routes cannot be fully exercised from real search/list navigation because local data has zero records; opening a valid-looking detail route shows the handled dashboard load-failure state.
- Focused validation passed: \`corepack pnpm --filter @example/admin test -- src/search/GlobalSearchOverlay.test.tsx src/search/searchResultRoutes.test.ts src/App.test.tsx\`.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('accepts scoped browser checks with absent local project seed data', () => {
  const result = runChecker({
    result: `QA_BLOCKED

- App reachable at \`http://localhost:49007/\`.
- Browser auth worked; the authenticated admin shell loaded.
- Scoped changed surfaces checked in browser: global nav, projects list empty state, branding admin form/preview, portfolio materials empty state, and portfolio documents empty state.
- Deeper project dashboard and child route QA is blocked by absent local project seed data: \`/projects?includeArchived=false&limit=50\` returned \`{"projects":[],"nextCursor":null}\` and representative project/project snags requests returned 404 \`Project not found\`.
- No feature-specific frontend bug was found in the scoped browser pass.
- Focused admin validation passed: \`@example/admin\` Vitest run completed.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('accepts activation-data gating after scoped onboarding QA', () => {
  const result = runChecker({
    result: `QA_BLOCKED

- App reachable at \`http://localhost:55529/\`; authenticated admin shell loaded with saved local auth.
- Scoped onboarding surface rendered: company/work email, brand onboarding, client portal preview, checklist, brand save action, search overlay empty state, and Arabic toggle all worked in browser QA.
- Deeper scoped routes (\`/projects\`, \`/branding\`, \`/people\`, \`/settings\`, \`/materials\`, \`/documents\`) redirect to \`/onboarding\` because the local workspace has no first project/client invite activation data.
- Focused validation passed: admin changed-surface Vitest subset completed.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('accepts no-local-project gating after scoped onboarding QA', () => {
  const result = runChecker({
    result: `Frontend QA result: blocked.

- App URL was reachable: \`http://localhost:55529/\`.
- Authenticated browser shell loaded with local auth state.
- Changed onboarding surface rendered at \`/onboarding\`.
- Brand save action completed without a visible browser error.
- Onboarding "Create project" action opened \`/projects/new\`.
- Scoped top-level routes \`/branding\`, \`/people\`, \`/settings\`, \`/projects\`, \`/materials\`, and \`/documents\` redirected back to \`/onboarding\` while activation is incomplete.
- Search overlay opened and accepted a two-character query from the authenticated shell.
- Focused admin validation passed: targeted test selection completed.

Blocked because local data has no project, so deeper project-specific scoped routes cannot be exercised without creating seed data through an out-of-scope frontend surface.
`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yes');
  assert.equal(result.writtenStatus, 'QA_PASSED');
  assert.match(result.writtenResult, /^QA_PASSED/);
});

test('still rejects auth blockers even when local data is mentioned', () => {
  const result = runChecker({
    result: `QA_BLOCKED

- App URL reachable: http://localhost:44065/
- Browser session opened but login failed and the app remained unauthenticated.
- Changed frontend list surface rendered in a partial shell.
- Deeper route is blocked by local seed data.
- Focused validation passed: admin Vitest run completed.
`,
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, 'no');
  assert.match(result.stderr, /Frontend QA/);
});
