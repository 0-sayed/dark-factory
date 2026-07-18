import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import plugin, { parsePlanningFile } from "./index.js";

function makeProject(markdown) {
  const root = mkdtempSync(join(tmpdir(), "tasks-md-tracker-"));
  const roadmapDir = join(root, "planning", "roadmap");
  mkdirSync(roadmapDir, { recursive: true });
  writeFileSync(join(roadmapDir, "tasks.md"), markdown);

  return {
    root,
    project: {
      path: root,
      tracker: { tasksPath: "planning/roadmap/tasks.md" },
    },
  };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

const markdown = `# Tasks

## Task Graph

| Done | Priority | Task | Depends On | Branch | Context |
| --- | --- | --- | --- | --- | --- |
| [x] | 10 | \`T001\` - Foundation | - | \`chore/t001\` | \`planning/context/bootstrap.md\` |
| [ ] | 20 | \`T002\` - Backend | \`T001\` | \`feat/t002\` | - |
| [ ] | 5 | \`T003\` - Frontend | \`T001\` | \`feat/t003\` | - |
| [ ] | 15 | \`T004\` - Docs | \`T001\` | \`docs/t004\` | - |
| [ ] | 30 | \`T005\` - Polish | \`T003\`, \`T004\` | \`feat/t005\` | - |
`;

test("parsePlanningFile parses a DAG task graph", () => {
  const { root, project } = makeProject(markdown);
  try {
    const plan = parsePlanningFile(project);

    assert.equal(plan.tasks.get("T003").title, "Frontend");
    assert.equal(plan.tasks.get("T003").priority, 5);
    assert.deepEqual(plan.tasks.get("T005").dependencies, ["T003", "T004"]);
  } finally {
    cleanup(root);
  }
});

test("tracker listIssues returns all runnable DAG tasks by priority then id", async () => {
  const { root, project } = makeProject(markdown);
  try {
    const tracker = plugin.create();
    const issues = await tracker.listIssues({ state: "open" }, project);

    assert.deepEqual(issues.map((issue) => issue.id), ["T003", "T004", "T002"]);
    assert.deepEqual(issues.map((issue) => issue.branchName), ["feat/t003", "docs/t004", "feat/t002"]);
  } finally {
    cleanup(root);
  }
});

test("tracker excludes tasks whose dependencies are not effectively done", async () => {
  const blockedMarkdown = markdown.replace("| [x] | 10 | `T001` - Foundation", "| [ ] | 10 | `T001` - Foundation");
  const { root, project } = makeProject(blockedMarkdown);
  try {
    const tracker = plugin.create();
    const issues = await tracker.listIssues({ state: "open" }, project);

    assert.deepEqual(issues.map((issue) => issue.id), ["T001"]);
  } finally {
    cleanup(root);
  }
});

test("tracker uses observed merged done and completed statuses as effective done", async () => {
  const { root, project } = makeProject(markdown);
  try {
    const tracker = plugin.create();
    const issues = await tracker.listIssues({
      state: "open",
      observedTasks: {
        T002: { status: "done" },
        T003: { status: "merged" },
        T004: { status: "completed" },
      },
    }, project);

    assert.deepEqual(issues.map((issue) => issue.id), ["T005"]);
  } finally {
    cleanup(root);
  }
});

test("tracker does not let failed blocked or stale tasks block unrelated ready tasks", async () => {
  const statusMarkdown = `# Tasks

## Task Graph

| Done | Priority | Task | Depends On | Branch | Context |
| --- | --- | --- | --- | --- | --- |
| [x] | 1 | \`T001\` - Foundation | - | \`chore/t001\` | - |
| [ ] | 2 | \`T002\` - Failed Work | \`T001\` | \`feat/t002\` | - |
| [ ] | 3 | \`T003\` - Blocked Work | \`T002\` | \`feat/t003\` | - |
| [ ] | 4 | \`T004\` - Stale Work | \`T001\` | \`feat/t004\` | - |
| [ ] | 5 | \`T005\` - Unrelated Ready | \`T001\` | \`feat/t005\` | - |
`;
  const { root, project } = makeProject(statusMarkdown);
  try {
    const tracker = plugin.create();
    const issues = await tracker.listIssues({
      state: "open",
      observedTasks: {
        T002: { status: "failed" },
        T003: { status: "blocked" },
        T004: { status: "stale" },
      },
    }, project);

    assert.deepEqual(issues.map((issue) => issue.id), ["T002", "T004", "T005"]);
  } finally {
    cleanup(root);
  }
});

test("tracker generatePrompt emits a selected task packet for Archon", async () => {
  const { root, project } = makeProject(markdown);
  try {
    const tracker = plugin.create();
    const prompt = await tracker.generatePrompt("T003", project);

    assert.match(prompt, /Selected task packet:/);
    assert.match(prompt, /taskId: T003/);
    assert.match(prompt, /title: Frontend/);
    assert.match(prompt, /branchName: feat\/t003/);
    assert.match(prompt, /tasksPath: planning\/roadmap\/tasks\.md/);
    assert.match(prompt, /dependsOn: T001/);
    assert.match(prompt, /Plan and implement only this task/);
    assert.match(prompt, /mark this task `\[x\]` in Task Graph/);
    assert.match(prompt, /update .*dependencies\.(md|mmd).*done/i);
  } finally {
    cleanup(root);
  }
});

test("parsePlanningFile fails when a task depends on an unknown task", () => {
  const badMarkdown = markdown.replace("`T003`, `T004`", "`T003`, `T999`");
  const { root, project } = makeProject(badMarkdown);
  try {
    assert.throws(() => parsePlanningFile(project), /depends on unknown task T999/i);
  } finally {
    cleanup(root);
  }
});

test("parsePlanningFile fails on duplicate task ids", () => {
  const duplicateMarkdown = `${markdown}| [ ] | 40 | \`T003\` - Duplicate | - | \`feat/duplicate\` | - |\n`;
  const { root, project } = makeProject(duplicateMarkdown);
  try {
    assert.throws(() => parsePlanningFile(project), /duplicate task T003/i);
  } finally {
    cleanup(root);
  }
});

test("parsePlanningFile fails on dependency cycles", () => {
  const cyclicMarkdown = markdown.replace(
    "| [ ] | 5 | `T003` - Frontend | `T001` |",
    "| [ ] | 5 | `T003` - Frontend | `T005` |",
  );
  const { root, project } = makeProject(cyclicMarkdown);
  try {
    assert.throws(() => parsePlanningFile(project), /dependency cycle/i);
  } finally {
    cleanup(root);
  }
});
