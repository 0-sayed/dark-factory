import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const manifest = {
  name: "tasks-md",
  slot: "tracker",
  description: "Read local planning/roadmap/tasks.md as an AO tracker",
  version: "0.1.0",
  displayName: "tasks.md Tracker",
};

function stripMarkdown(value) {
  return String(value ?? "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function normalizeHeader(value) {
  return stripMarkdown(value).toLowerCase();
}

function parseTaskCell(value) {
  const clean = stripMarkdown(value);
  const match = clean.match(/^([A-Za-z]+\d{3,})\s*(?:[-—–]\s*)?(.*)$/);
  if (!match) return null;
  return {
    id: match[1].toUpperCase(),
    title: (match[2] || match[1]).trim(),
  };
}

function parseDependencies(value) {
  const clean = stripMarkdown(value);
  if (!clean || clean === "-" || clean === "—") return [];
  return clean
    .split(",")
    .map((part) => stripMarkdown(part).toUpperCase())
    .filter(Boolean);
}

function parseContext(value) {
  const clean = stripMarkdown(value);
  if (!clean || clean === "-" || clean === "—") return [];
  return clean
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseIds(value) {
  return parseDependencies(value);
}

function observedTaskStatus(taskId, observedTasks = {}) {
  return String(observedTasks[taskId]?.status ?? "").toLowerCase();
}

function isTaskEffectivelyDone(task, observedTasks = {}) {
  if (!task) return false;
  if (task.done) return true;
  return ["completed", "done", "merged"].includes(observedTaskStatus(task.id, observedTasks));
}

function parsePriority(value) {
  const clean = stripMarkdown(value);
  if (!clean || clean === "-" || clean === "—") return null;
  const parsed = Number.parseInt(clean, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function tableKindFromHeaders(headers) {
  if (headers.includes("task")) return "tasks";
  return null;
}

function makeIssue(task, project) {
  return {
    id: task.id,
    title: task.title,
    description: `Local planning task ${task.id}: ${task.title}`,
    url: `${task.tasksPath}#${task.id}`,
    state: task.done ? "closed" : "open",
    labels: ["tasks.md"],
    branchName: task.branchName,
    priority: task.priority,
    dependencies: task.dependencies,
  };
}

function assertValidPlan(plan) {
  for (const task of plan.tasks.values()) {
    for (const dependency of task.dependencies) {
      if (!plan.tasks.has(dependency)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const path = [];

  function visit(taskId) {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      const cycle = [...path.slice(cycleStart), taskId].join(" -> ");
      throw new Error(`Task dependency cycle detected: ${cycle}`);
    }

    visiting.add(taskId);
    path.push(taskId);

    for (const dependency of plan.tasks.get(taskId)?.dependencies ?? []) {
      visit(dependency);
    }

    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const taskId of plan.tasks.keys()) {
    visit(taskId);
  }
}

export function parsePlanningContent(content, options = {}) {
  const tasksPath = String(options.tasksPath ?? "planning/roadmap/tasks.md");
  const absoluteTasksPath = String(options.absoluteTasksPath ?? tasksPath);
  const lines = content.split(/\r?\n/);
  const tasks = new Map();
  let headers = null;
  let currentTable = null;

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line.trim())) {
      headers = null;
      currentTable = null;
    }

    if (!line.trim().startsWith("|")) continue;
    const cells = splitTableRow(line);
    const normalizedCells = cells.map(normalizeHeader);

    const detectedTable = tableKindFromHeaders(normalizedCells);
    if (detectedTable) {
      headers = normalizedCells;
      currentTable = detectedTable;
      continue;
    }

    if (!headers || !currentTable) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) continue;

    if (currentTable === "tasks") {
      const taskIndex = headers.indexOf("task");
      const doneIndex = headers.indexOf("done");
      const priorityIndex = headers.indexOf("priority");
      const dependsIndex = headers.indexOf("depends on");
      const branchIndex = headers.indexOf("branch");
      const contextIndex = headers.indexOf("context");
      const parsedTask = parseTaskCell(cells[taskIndex]);

      if (!parsedTask) continue;
      if (tasks.has(parsedTask.id)) {
        throw new Error(`Duplicate task ${parsedTask.id} in tasks.md`);
      }

      tasks.set(parsedTask.id, {
        id: parsedTask.id,
        title: parsedTask.title,
        done: doneIndex >= 0 && /\[x\]/i.test(cells[doneIndex] ?? ""),
        priority: priorityIndex >= 0 ? parsePriority(cells[priorityIndex]) : null,
        dependencies: dependsIndex >= 0 ? parseDependencies(cells[dependsIndex]) : [],
        branchName: branchIndex >= 0 ? stripMarkdown(cells[branchIndex]) : `feat/${parsedTask.id.toLowerCase()}`,
        contextPaths: contextIndex >= 0 ? parseContext(cells[contextIndex]) : [],
        tasksPath,
        absoluteTasksPath,
      });
    }
  }

  const plan = { tasks, tasksPath, absoluteTasksPath };
  assertValidPlan(plan);
  return plan;
}

export function parsePlanningFile(project) {
  const trackerConfig = project.tracker ?? {};
  const tasksPath = String(trackerConfig.tasksPath ?? "planning/roadmap/tasks.md");
  const absoluteTasksPath = resolve(project.path, tasksPath);
  const content = readFileSync(absoluteTasksPath, "utf-8");
  return parsePlanningContent(content, { tasksPath, absoluteTasksPath });
}

function parseTasks(project) {
  return parsePlanningFile(project).tasks;
}

function getTask(identifier, project) {
  const taskId = stripMarkdown(identifier).toUpperCase();
  const task = parseTasks(project).get(taskId);
  if (!task) {
    const error = new Error(`Task ${identifier} not found in tasks.md`);
    error.code = "ISSUE_NOT_FOUND";
    throw error;
  }
  return task;
}

const plugin = {
  manifest,
  create() {
    return {
      name: manifest.name,

      async getIssue(identifier, project) {
        const task = getTask(identifier, project);
        return makeIssue(task, project);
      },

      async isCompleted(identifier, project) {
        return getTask(identifier, project).done;
      },

      issueUrl(identifier, project) {
        const tasksPath = String(project.tracker?.tasksPath ?? "planning/roadmap/tasks.md");
        return `${tasksPath}#${stripMarkdown(identifier).toUpperCase()}`;
      },

      issueLabel(url) {
        return stripMarkdown(url).split("#").pop() || url;
      },

      branchName(identifier, project) {
        return getTask(identifier, project).branchName;
      },

      async generatePrompt(identifier, project) {
        const task = getTask(identifier, project);
        return [
          "Selected task packet:",
          `taskId: ${task.id}`,
          `title: ${task.title}`,
          `branchName: ${task.branchName}`,
          `tasksPath: ${task.tasksPath}`,
          `dependsOn: ${task.dependencies.length ? task.dependencies.join(", ") : "none"}`,
          `contextFiles: ${task.contextPaths.length ? task.contextPaths.join(", ") : "none"}`,
          `priority: ${task.priority ?? "none"}`,
          "",
          "Plan and implement only this task. Use the planning folder as the source of truth.",
          "Before shipping the PR, mark this task `[x]` in Task Graph.",
          "Update `planning/roadmap/dependencies.md` or `planning/roadmap/dependencies.mmd` from pending to done when that diagram exists.",
        ].join("\n");
      },

      async listIssues(filters = {}, project) {
        const plan = parsePlanningFile(project);
        const state = filters.state ?? "open";
        const observedTasks = filters.observedTasks ?? {};

        if (state === "closed") {
          return [...plan.tasks.values()].filter((task) => task.done).map((task) => makeIssue(task, project));
        }

        if (state === "all") {
          return [...plan.tasks.values()].map((task) => makeIssue(task, project));
        }

        const runnableTasks = [...plan.tasks.values()]
          .filter((task) => !isTaskEffectivelyDone(task, observedTasks))
          .filter((task) => task.dependencies.every((dependency) =>
            isTaskEffectivelyDone(plan.tasks.get(dependency), observedTasks),
          ))
          .sort((a, b) => {
            const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
            const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
            return priorityA - priorityB || a.id.localeCompare(b.id);
          });

        return runnableTasks.map((task) => makeIssue(task, project));
      },
    };
  },
};

export default plugin;
