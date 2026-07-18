import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test(
  "distribution matches the installed canonical Archon assets",
  {
    skip: !existsSync(join(homedir(), ".archon")),
  },
  async () => {
    const pairs = [
      [
        "scripts/frontend-qa-context.mjs",
        "archon-scripts/frontend-qa-context.mjs",
      ],
      [
        "scripts/initialize-sdd-workspace.mjs",
        "archon-scripts/initialize-sdd-workspace.mjs",
      ],
      ["workflows/auto-feature.yaml", "archon-workflows/auto-feature.yaml"],
    ];

    for (const [installedPath, distributionPath] of pairs) {
      const installed = await readFile(
        join(homedir(), ".archon", installedPath),
        "utf8",
      );
      const distributed = await readFile(
        new URL(`../distribution/${distributionPath}`, import.meta.url),
        "utf8",
      );
      assert.equal(
        distributed,
        installed,
        `${distributionPath} drifted from the installed canonical asset`,
      );
    }
  },
);

test("docs expose a copyable tasks.md starter template", async () => {
  const template = await readFile(
    new URL("../templates/planning/roadmap/tasks.md", import.meta.url),
    "utf8",
  );
  const bootstrap = await readFile(
    new URL("../templates/planning/bootstrap.md", import.meta.url),
    "utf8",
  );
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  const architecture = await readFile(
    new URL("../docs/architecture.md", import.meta.url),
    "utf8",
  );
  const setup = await readFile(
    new URL("../docs/setup.md", import.meta.url),
    "utf8",
  );
  const dependencies = await readFile(
    new URL("../docs/dependencies.md", import.meta.url),
    "utf8",
  );
  const contract = await readFile(
    new URL("../docs/planning-contract.md", import.meta.url),
    "utf8",
  );
  const operatorSkill = await readFile(
    new URL("../skills/dark-factory/SKILL.md", import.meta.url),
    "utf8",
  );
  const operatorGuide = await readFile(
    new URL(
      "../skills/dark-factory/references/operator-guide.md",
      import.meta.url,
    ),
    "utf8",
  );
  const cliSource = await readFile(
    new URL("./dark-factory.js", import.meta.url),
    "utf8",
  );
  const autoFeatureWorkflow = await readFile(
    new URL(
      "../distribution/archon-workflows/auto-feature.yaml",
      import.meta.url,
    ),
    "utf8",
  );
  const autoMergeSkill = await readFile(
    new URL("../distribution/skills/auto-merge/SKILL.md", import.meta.url),
    "utf8",
  );
  const waitReviewBotsSkill = await readFile(
    new URL(
      "../distribution/skills/wait-review-bots/SKILL.md",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(template, /## Task Graph/);
  assert.match(
    template,
    /\|\s*Done\s*\|\s*Priority\s*\|\s*Task\s*\|\s*Depends On\s*\|\s*Branch\s*\|\s*Context\s*\|/,
  );
  assert.match(template, /`T000` - Project bootstrap/);
  assert.match(template, /`T001` - First feature[^\n]+T000/);
  assert.match(bootstrap, /human supervision/i);
  assert.match(bootstrap, /merged manually/i);
  assert.match(bootstrap, /structured logging/i);
  assert.match(bootstrap, /unit, integration, and end-to-end testing/i);
  assert.match(bootstrap, /### Step 4 — Engineering Tooling Selection/);
  assert.match(bootstrap, /### Step 8 — Observability Foundation/);
  assert.match(bootstrap, /### Step 9 — Testing Foundation/);
  const step4Start = bootstrap.indexOf(
    "### Step 4 — Engineering Tooling Selection",
  );
  const step5Start = bootstrap.indexOf("### Step 5 — Automated CI Setup");
  const step4 = bootstrap.slice(step4Start, step5Start);
  const step4Checklist = step4
    .split("\n")
    .filter((line) => line.startsWith("- [ ] "));
  assert.deepEqual(step4Checklist, [
    "- [ ] Pin the runtime, language, package manager, and build-tool versions using the ecosystem's standard version and manifest files.",
    "- [ ] Enable the language's strict compiler or type-checking mode, plus additional high-value safety checks that do not create framework-boundary noise. Keep production builds separate from tests and development-only files where applicable.",
    "- [ ] Initialize package/workspace tooling for the chosen project shape. For monorepos, start with the package manager's native workspace support; add an orchestration tool only when dependency graphs, caching, or affected builds justify it.",
    "- [ ] Configure a formatter and its ignore file (for example, Prettier) so formatting is deterministic and CI-checkable.",
    "- [ ] Configure language-aware linting or static analysis with strict production rules and focused test/config overrides (for example, ESLint). Do not weaken production checks to accommodate test doubles or framework configuration files.",
    "- [ ] Configure dead-code and unused-dependency detection (for example, Knip or the ecosystem equivalent).",
    "- [ ] Select a structured logging library appropriate to the stack (for example, Pino); wire it after the app skeletons exist.",
    "- [ ] Select persistence clients and migration tooling from the project architecture (for example, Drizzle or the framework/ecosystem equivalent); wire them with local infrastructure in Step 7.",
    "- [ ] Select generated API documentation tooling for public HTTP entrypoints when applicable (for example, OpenAPI/Swagger); wire it while creating the app skeletons in Step 6.",
    "- [ ] Select unit, integration, and end-to-end testing tools appropriate to the stack (for example, Vitest, Supertest, and Testcontainers); configure them after app skeletons and infrastructure exist.",
    "- [ ] Define one repository validation command and add each applicable formatter, lint/static-analysis, compiler/type-check, test, dead-code, dependency/security-audit, and production-build check as it becomes available.",
    "- [ ] Stop at reusable engineering foundations here. Do not generate business-specific services, routes, schemas, queues, workers, or feature libraries in this generic phase.",
  ]);

  const orderedBootstrapStages = [
    "### Step 6 — App/Service/Lib Skeletons From Planning",
    "### Step 7 — Local Development Infrastructure",
    "### Step 8 — Observability Foundation",
    "### Step 9 — Testing Foundation",
  ];
  for (let index = 1; index < orderedBootstrapStages.length; index += 1) {
    assert.ok(
      bootstrap.indexOf(orderedBootstrapStages[index - 1]) <
        bootstrap.indexOf(orderedBootstrapStages[index]),
    );
  }

  const orderedT000Actions = [
    "Mark the T000 row as complete (`[x]`)",
    "Review the T000 implementation with human supervision",
    "Merge the T000 pull request manually",
    "Sync local `main` with `origin/main`",
    "Register the project with Dark Factory",
    "Run a Dark Factory dry-run",
  ];
  for (let index = 1; index < orderedT000Actions.length; index += 1) {
    assert.ok(
      bootstrap.indexOf(orderedT000Actions[index - 1]) <
        bootstrap.indexOf(orderedT000Actions[index]),
    );
  }
  assert.match(bootstrap, /T000 --> T001/);
  assert.match(bootstrap, /current official documentation/i);
  assert.match(bootstrap, /Mark the T000 row as complete \(`\[x\]`\)/);
  assert.doesNotMatch(bootstrap, /^\s+validate\s*$/m);
  assert.doesNotMatch(bootstrap, /pinact_linux_amd64/);
  assert.match(readme, /templates\/planning\//);
  assert.match(readme, /docs\/planning\.md/);
  assert.match(readme, /templates\/planning\/bootstrap\.md/);
  assert.match(readme, /human\s+supervision/i);
  assert.match(readme, /merged\s+manually/i);
  assert.match(contract, /templates\/planning\/roadmap\/tasks\.md/);
  assert.match(contract, /templates\/planning\/bootstrap\.md/);
  assert.match(contract, /must not\s+run Dark Factory/i);
  assert.match(operatorGuide, /pause --project/);
  assert.match(operatorGuide, /stop --project/);
  assert.match(operatorGuide, /recover --project/);
  assert.match(contract, /DAG/i);
  assert.doesNotMatch(template, /Execution Waves|\bwave\b/i);
  assert.doesNotMatch(readme, /Execution Waves|\bwave\b/i);
  assert.doesNotMatch(architecture, /Execution Waves|\bwave\b/i);
  assert.doesNotMatch(contract, /Execution Waves|\bwave\b/i);
  assert.doesNotMatch(autoFeatureWorkflow, /Execution Waves|\bwave\b/i);
  assert.doesNotMatch(autoMergeSkill, /Execution Waves|\bwave\b/i);
  assert.doesNotMatch(waitReviewBotsSkill, /Execution Waves|\bwave\b/i);
  assert.match(architecture, /Archon Workspace Warning/);
  for (const docs of [architecture, contract, operatorGuide]) {
    assert.doesNotMatch(docs, /--no-orchestrator/);
    assert.doesNotMatch(
      docs,
      /AO YAML|generated AO (?:config|configuration)|regenerates? AO config|agent-orchestrator\.yaml/i,
    );
    assert.match(docs, /Go AO daemon API/i);
    assert.match(docs, /project registration/i);
    assert.match(docs, /config(?:uration)? sync/i);
  }
  assert.match(architecture, /Dark Factory owns orchestration/);
  assert.match(architecture, /stale failed GitHub check runs/i);
  assert.match(contract, /stale failed GitHub check runs/i);
  assert.match(architecture, /Controller Isolation Rule/);
  assert.match(contract, /Controller Isolation Rule/);
  assert.match(architecture, /controller_must_not_mutate_worker_worktree/);
  assert.match(contract, /resume_worker_session/);
  assert.match(
    contract,
    /fresh tasks, resumed tasks, failed tasks, and ready PRs/i,
  );
  assert.match(
    operatorGuide,
    /review lifecycle processes.*active worker ownership/i,
  );
  assert.match(operatorGuide, /terminat(?:e|ion).*wait.*reclaim/i);
  const helpText = cliSource.match(
    /function printHelp\(\) \{\s*console\.log\(`([\s\S]*?)`\);\s*\}/,
  )?.[1];
  assert.ok(helpText, "Dark Factory CLI help text must remain discoverable");
  const publicOptions = [...helpText.matchAll(/^\s+(--[a-z][a-z-]*)/gm)].map(
    (match) => match[1],
  );
  const operatorDocs = `${operatorSkill}\n${operatorGuide}`;
  for (const option of publicOptions) {
    assert.ok(
      operatorDocs.includes(option),
      `${option} is missing from the Dark Factory operator docs`,
    );
  }
  assert.match(setup, /dependencies\.lock\.json/);
  assert.match(setup, /manage-distribution\.mjs doctor/);
  assert.match(setup, /manage-distribution\.mjs verify-install/);
  assert.match(setup, /AO plugins remain repository-local/i);
  assert.match(setup, /go version/i);
  assert.match(setup, /install-ao-runtime\.mjs/);
  assert.match(setup, /AO desktop[^\n]*pinned fork/i);
  assert.match(setup, /ao start/);
  assert.match(setup, /ao status --json/);
  assert.match(setup, /state[^\n]*ready/i);
  assert.match(setup, /codex login status/);
  assert.match(setup, /gh api user/);
  assert.match(setup, /codex plugin add superpowers@superpowers-dev/);
  assert.match(dependencies, /Docker Compose plugin/i);
  assert.match(dependencies, /PostgreSQL client.*optional/i);
  assert.doesNotMatch(setup, /^cd \.\.\/worktree-compose$/m);
  assert.match(readme, /Linux/i);
});

test("distributed Archon workflows use stable unnumbered filenames without duplicate names", async () => {
  const workflowDirectory = new URL(
    "../distribution/archon-workflows/",
    import.meta.url,
  );
  const filenames = (await readdir(workflowDirectory)).sort();

  assert.deepEqual(filenames, [
    "auto-feature.yaml",
    "auto-squash.yaml",
    "merge-gate.yaml",
  ]);

  const names = await Promise.all(
    filenames.map(async (filename) => {
      const content = await readFile(
        new URL(filename, workflowDirectory),
        "utf8",
      );
      return content.match(/^name:\s*(\S+)\s*$/m)?.[1];
    }),
  );

  assert.deepEqual(names.sort(), ["auto-feature", "auto-squash", "merge-gate"]);
  assert.equal(new Set(names).size, names.length);
});
