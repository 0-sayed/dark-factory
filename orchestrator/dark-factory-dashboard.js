import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STATUS_COLUMNS = ["queued", "running", "in_review", "ready_to_merge", "merging", "merged", "failed", "needs_input", "cleanup_failed"];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeTasks(tasks = {}) {
  return Object.values(tasks).sort((left, right) => left.id.localeCompare(right.id));
}

function isErrorEvent(event) {
  const type = String(event?.type ?? "").toLowerCase();
  return Boolean(event?.error) || type.includes("failed") || type.includes("blocked");
}

function selectLastEvent(timeline = []) {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index];
    if (!isErrorEvent(event)) return event;
  }

  return timeline[timeline.length - 1] ?? null;
}

function selectLastError(timeline = []) {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index];
    if (isErrorEvent(event)) return event;
  }

  return null;
}

function enrichTask(task = {}) {
  const timeline = Array.isArray(task.timeline) ? task.timeline : [];

  return {
    ...task,
    timeline,
    lastEvent: selectLastEvent(timeline),
    lastError: selectLastError(timeline),
  };
}

export function buildDashboardModel({ observability, runner }) {
  const tasks = normalizeTasks(observability?.tasks).map(enrichTask);
  const columns = Object.fromEntries(STATUS_COLUMNS.map((status) => [status, []]));

  for (const task of tasks) {
    const status = columns[task.status] ? task.status : "queued";
    columns[status].push(task);
  }

  return {
    projectName: observability?.project?.name ?? observability?.project?.id ?? "Project",
    projectId: observability?.project?.id ?? "project",
    observedAt: observability?.observedAt ?? null,
    summary: observability?.summary ?? {},
    events: observability?.events ?? [],
    eventSummary: observability?.eventSummary ?? {},
    tasks,
    columns,
    toLaunch: runner?.launchPlan?.toLaunch ?? [],
    skipped: runner?.launchPlan?.skipped ?? [],
    activeSessions: runner?.launchPlan?.activeSessions ?? [],
    runnerDryRun: runner?.dryRun ?? true,
    spawn: runner?.spawn ?? { attempted: false, issueIds: [] },
    controlMode: String(runner?.control?.mode ?? "active").toLowerCase(),
    supervisionExitReason: runner?.supervision?.exitReason ?? null,
    complete: runner?.complete === true,
  };
}

function renderCountPill(status, count) {
  return `<div class="count-pill" data-status="${escapeHtml(status)}"><span>${escapeHtml(status)}</span><strong>${escapeHtml(count)}</strong></div>`;
}

function renderCompletionBanner(model) {
  if (!model.complete) return "";

  return `<section class="band complete-banner">
      <h2>Project complete</h2>
      <p class="muted">All planned tasks are terminal and no launches or merges are pending.</p>
    </section>`;
}

function renderSession(session) {
  return `<li class="session-row">
    <span class="mono">${escapeHtml(session.id)}</span>
    <span>${escapeHtml(session.observableStatus ?? session.status)}</span>
    <span>${escapeHtml(session.branch ?? "")}</span>
    <span class="path">${escapeHtml(session.workspacePath ?? "")}</span>
  </li>`;
}

function renderTimelineMeta(event) {
  const parts = [];
  const durationMs = event?.durationMs ?? event?.metadata?.durationMs;
  const reason = event?.error ?? event?.reason ?? event?.metadata?.reason;

  if (event?.timestamp) parts.push(escapeHtml(event.timestamp));
  if (durationMs !== null && durationMs !== undefined) parts.push(`${escapeHtml(durationMs)}ms`);
  if (reason) parts.push(escapeHtml(reason));

  return parts.join(" - ");
}

function renderTimeline(task) {
  const timeline = Array.isArray(task?.timeline) ? task.timeline : [];
  if (!timeline.length) return "";

  return `<section class="timeline">
    <h4>Timeline</h4>
    <ul class="timeline-list">
      ${timeline.map((event) => `<li class="timeline-item">
        <span class="timeline-type">${escapeHtml(event.type ?? "unknown")}</span>
        <span class="timeline-meta">${renderTimelineMeta(event)}</span>
      </li>`).join("")}
    </ul>
  </section>`;
}

function renderTaskHighlights(task) {
  const lastEventMeta = task?.lastEvent ? renderTimelineMeta(task.lastEvent) : "";
  const lastErrorMeta = task?.lastError ? renderTimelineMeta(task.lastError) : "";
  const lastEvent = task?.lastEvent
    ? `<div class="task-highlight"><span>Last event</span><strong>${escapeHtml(task.lastEvent.type ?? "unknown")}</strong>${lastEventMeta ? `<small>${lastEventMeta}</small>` : ""}</div>`
    : `<div class="task-highlight"><span>Last event</span><strong>None</strong></div>`;
  const lastError = task?.lastError
    ? `<div class="task-highlight task-highlight-error"><span>Last error</span><strong>${escapeHtml(task.lastError.type ?? "unknown")}</strong>${lastErrorMeta ? `<small>${lastErrorMeta}</small>` : ""}</div>`
    : `<div class="task-highlight task-highlight-error"><span>Last error</span><strong>None</strong></div>`;

  return `<div class="task-highlights">${lastEvent}${lastError}</div>`;
}

function renderTask(task) {
  const currentSession = task.currentSession ?? task.sessions?.[0] ?? null;
  const historyCount = Array.isArray(task.sessionHistory)
    ? task.sessionHistory.length
    : Math.max(0, (task.sessions?.length ?? 0) - (currentSession ? 1 : 0));
  const sessions = currentSession
    ? `<ul class="session-list">${renderSession(currentSession)}</ul>${
        historyCount > 0
          ? `<div class="session-history">${escapeHtml(historyCount)} older session${historyCount === 1 ? "" : "s"} hidden</div>`
          : ""
      }`
    : `<div class="empty-inline">No sessions</div>`;

  return `<article class="task" data-task-status="${escapeHtml(task.status ?? "queued")}">
    <div class="task-head">
      <span class="task-id">${escapeHtml(task.id)}</span>
      <span class="task-source">${escapeHtml(task.sourceState)}</span>
    </div>
    <h3>${escapeHtml(task.title)}</h3>
    <div class="task-meta">
      <span>${escapeHtml(task.branchName)}</span>
    </div>
    ${renderTaskHighlights(task)}
    ${sessions}
    ${renderTimeline(task)}
  </article>`;
}

function renderColumn(status, tasks) {
  return `<section class="column" data-column-status="${escapeHtml(status)}">
    <div class="column-head">
      <h2>${escapeHtml(status)}</h2>
      <span>${tasks.length}</span>
    </div>
    <div class="task-stack">
      ${tasks.length ? tasks.map(renderTask).join("") : `<div class="empty-column">Empty</div>`}
    </div>
  </section>`;
}

function renderPlanList(title, items, emptyLabel) {
  return `<section class="band">
    <h2>${escapeHtml(title)}</h2>
    ${
      items.length
        ? `<ul class="plan-list">${items
            .map((item) => `<li><span class="mono">${escapeHtml(item.id)}</span><span>${escapeHtml(item.reason ?? item.title ?? item.branchName ?? "")}</span></li>`)
            .join("")}</ul>`
        : `<div class="empty-inline">${escapeHtml(emptyLabel)}</div>`
    }
  </section>`;
}

function renderTaskDetail(task) {
  const timeline = Array.isArray(task?.timeline) ? task.timeline : [];
  const rows = timeline.length
    ? timeline
        .map((event) => `<li class="detail-row">
            <span class="detail-type">${escapeHtml(event.type ?? "unknown")}</span>
            <span class="detail-meta">${renderTimelineMeta(event)}</span>
          </li>`)
        .join("")
    : `<li class="detail-row empty-inline">No timeline events</li>`;

  return `<article class="task-detail" data-task-status="${escapeHtml(task.status ?? "queued")}">
    <div class="task-head">
      <span class="task-id">${escapeHtml(task.id)}</span>
      <span class="task-source">${escapeHtml(task.status ?? "queued")}</span>
    </div>
    <h3>${escapeHtml(task.title)}</h3>
    <div class="task-meta">
      <span>${escapeHtml(task.branchName)}</span>
    </div>
    ${renderTaskHighlights(task)}
    <section class="timeline">
      <h4>Timeline</h4>
      <ul class="timeline-list detail-timeline">${rows}</ul>
    </section>
  </article>`;
}

function renderFilters(statuses = STATUS_COLUMNS) {
  return `<section class="filters" aria-label="Task filters">
    <button type="button" class="filter-chip is-active" data-filter-status="all" aria-pressed="true">All</button>
    ${statuses.map((status) => `<button type="button" class="filter-chip" data-filter-status="${escapeHtml(status)}" aria-pressed="false">${escapeHtml(status)}</button>`).join("")}
  </section>`;
}

function renderTaskDetails(tasks) {
  return `<section class="band task-details">
    <h2>Task details</h2>
    <div class="task-detail-grid">
      ${tasks.length ? tasks.map(renderTaskDetail).join("").trim() : `<div class="empty-inline">No task details</div>`}
    </div>
  </section>`;
}

function renderRawEvents(events) {
  const raw = JSON.stringify(Array.isArray(events) ? events : [], null, 2);

  return `<section class="band raw-events">
    <h2>Raw Events</h2>
    <pre>${escapeHtml(raw)}</pre>
  </section>`;
}

function renderOperations(model) {
  const project = model.projectId;
  const commands = [
    ["Run", `node orchestrator/dark-factory.js run --project ${project} --run`],
    ["Pause", `node orchestrator/dark-factory.js pause --project ${project}`],
    ["Resume", `node orchestrator/dark-factory.js resume --project ${project}`],
    ["Status", `node orchestrator/dark-factory.js status --project ${project}`],
  ];

  return `<section class="band operations">
    <h2>Control: ${escapeHtml(model.controlMode)} - Supervision: ${escapeHtml(model.supervisionExitReason ?? "unknown")}</h2>
    <ul class="command-list">
      ${commands
        .map(([label, command]) => `<li><span>${escapeHtml(label)}</span><code>${escapeHtml(command)}</code></li>`)
        .join("")}
    </ul>
  </section>`;
}

export function renderDashboardHtml({ observability, runner }) {
  const model = buildDashboardModel({ observability, runner });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dark Factory - ${escapeHtml(model.projectName)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #111315;
      --panel: #181b1f;
      --panel-2: #20242a;
      --text: #edf0f2;
      --muted: #aab2bb;
      --line: #303740;
      --accent: #61d394;
      --warn: #f1c75b;
      --bad: #f06f6f;
      --info: #79a8ff;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      letter-spacing: 0;
    }
    main {
      width: min(1440px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0 40px;
    }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: end;
      border-bottom: 1px solid var(--line);
      padding-bottom: 18px;
    }
    h1, h2, h3, h4, p { margin: 0; }
    h1 { font-size: 28px; font-weight: 720; }
    h2 { font-size: 15px; text-transform: uppercase; color: var(--muted); font-weight: 680; }
    h3 { font-size: 15px; line-height: 1.35; font-weight: 650; }
    .muted { color: var(--muted); }
    .mono, code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    .command {
      background: #0b0d0f;
      border: 1px solid var(--line);
      padding: 10px 12px;
      border-radius: 6px;
      white-space: nowrap;
    }
    .counts {
      display: grid;
      grid-template-columns: repeat(8, minmax(96px, 1fr));
      gap: 8px;
      margin: 20px 0;
    }
    .count-pill, .band, .column {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    .count-pill {
      padding: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      min-width: 0;
    }
    .count-pill span { color: var(--muted); }
    .count-pill strong { font-size: 20px; }
    .board {
      display: grid;
      grid-template-columns: repeat(4, minmax(240px, 1fr));
      gap: 12px;
      align-items: start;
    }
    .column { min-height: 120px; overflow: hidden; }
    .column-head {
      display: flex;
      justify-content: space-between;
      padding: 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-2);
    }
    .task-stack { display: grid; gap: 8px; padding: 8px; }
    .task {
      background: #111417;
      border: 1px solid #2a3038;
      border-radius: 6px;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .task-head, .task-meta, .session-row, .plan-list li {
      display: grid;
      gap: 8px;
      align-items: center;
    }
    .task-head {
      grid-template-columns: auto auto;
      justify-content: space-between;
    }
    .task-id {
      color: var(--accent);
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-weight: 700;
    }
    .task-source {
      color: var(--muted);
      font-size: 12px;
    }
    .task-meta, .path {
      color: var(--muted);
      overflow-wrap: anywhere;
      line-height: 1.35;
    }
    .task-highlights {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .task-highlight {
      border-top: 1px solid #252b32;
      padding-top: 6px;
      display: grid;
      gap: 2px;
    }
    .task-highlight span {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }
    .task-highlight strong {
      font-size: 12px;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .task-highlight-error strong { color: var(--bad); }
    .session-list, .plan-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 6px;
    }
    .command-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 8px;
    }
    .command-list li {
      display: grid;
      grid-template-columns: 76px 1fr;
      gap: 10px;
      align-items: center;
      border-top: 1px solid var(--line);
      padding-top: 8px;
    }
    .command-list span { color: var(--muted); }
    .command-list code {
      background: #0b0d0f;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .session-row {
      grid-template-columns: minmax(90px, auto) minmax(70px, auto) 1fr;
      padding-top: 6px;
      border-top: 1px solid #252b32;
    }
    .session-row .path {
      grid-column: 1 / -1;
    }
    .session-history {
      color: var(--muted);
      font-size: 12px;
      border-top: 1px solid #252b32;
      padding-top: 6px;
    }
    .timeline {
      display: grid;
      gap: 6px;
      border-top: 1px solid #252b32;
      padding-top: 8px;
    }
    .timeline h4 {
      font-size: 12px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
    }
    .timeline-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 6px;
    }
    .timeline-item {
      display: grid;
      gap: 2px;
    }
    .timeline-type {
      font-size: 12px;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .timeline-meta {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .detail-timeline .detail-row {
      display: grid;
      gap: 2px;
    }
    .detail-type {
      font-size: 12px;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .detail-meta {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .lower {
      display: grid;
      grid-template-columns: repeat(2, minmax(260px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 12px 0 8px;
    }
    .filter-chip {
      background: #0b0d0f;
      color: var(--muted);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 10px;
      font: inherit;
      cursor: pointer;
    }
    .filter-chip.is-active,
    .filter-chip[aria-pressed="true"] {
      color: var(--text);
      border-color: var(--accent);
    }
    .band { padding: 14px; display: grid; gap: 10px; margin-top: 12px; }
    .task-details, .raw-events { margin-top: 12px; }
    .task-detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }
    .task-detail {
      background: #111417;
      border: 1px solid #2a3038;
      border-radius: 6px;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .raw-events pre {
      margin: 0;
      padding: 12px;
      background: #0b0d0f;
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .plan-list li {
      grid-template-columns: 88px 1fr;
      border-top: 1px solid var(--line);
      padding-top: 8px;
    }
    .empty-column, .empty-inline {
      color: var(--muted);
      padding: 10px;
    }
    @media (max-width: 1000px) {
      .counts { grid-template-columns: repeat(4, minmax(96px, 1fr)); }
      .board { grid-template-columns: repeat(2, minmax(220px, 1fr)); }
    }
    @media (max-width: 640px) {
      main { width: min(100vw - 20px, 560px); padding-top: 16px; }
      header, .lower { grid-template-columns: 1fr; }
      .counts, .board { grid-template-columns: 1fr; }
      .command { white-space: normal; overflow-wrap: anywhere; }
      .task-highlights { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main data-dashboard data-supervision-exit-reason="${escapeHtml(model.supervisionExitReason ?? "unknown")}">
    <header>
      <div>
        <h1>Dark Factory</h1>
        <p class="muted">${escapeHtml(model.projectName)} - observed ${escapeHtml(model.observedAt ?? "unknown")}</p>
      </div>
      <code class="command">Control: ${escapeHtml(model.controlMode)} - Supervision: ${escapeHtml(model.supervisionExitReason ?? "unknown")}</code>
    </header>
    <section class="counts">
      ${STATUS_COLUMNS.map((status) => renderCountPill(status, model.summary[status] ?? 0)).join("")}
    </section>
    ${renderCompletionBanner(model)}
    ${renderFilters()}
    <section class="board">
      ${STATUS_COLUMNS.map((status) => renderColumn(status, model.columns[status])).join("")}
    </section>
    <section class="lower">
      ${renderOperations(model)}
      ${renderPlanList("Launch Plan", model.toLaunch, "No tasks planned")}
      ${renderPlanList("Skipped", model.skipped, "No skipped tasks")}
    </section>
    ${renderTaskDetails(model.tasks)}
    ${renderRawEvents(model.events)}
  </main>
  <script>
    (() => {
      const root = document.querySelector("[data-dashboard]");
      if (!root) return;
      const filters = Array.from(root.querySelectorAll("[data-filter-status]"));
      const targets = Array.from(root.querySelectorAll("[data-task-status], [data-column-status]"));

      const applyFilter = (status) => {
        filters.forEach((button) => {
          const active = button.dataset.filterStatus === status;
          button.classList.toggle("is-active", active);
          button.setAttribute("aria-pressed", String(active));
        });

        targets.forEach((element) => {
          const elementStatus = element.dataset.taskStatus ?? element.dataset.columnStatus ?? "all";
          element.hidden = status !== "all" && elementStatus !== status;
        });
      };

      filters.forEach((button) => {
        button.addEventListener("click", () => applyFilter(button.dataset.filterStatus ?? "all"));
      });

      applyFilter("all");
    })();
  </script>
</body>
</html>
`;
}

export async function writeDashboard({ observability, runner, outputPath }) {
  const targetPath = resolve(outputPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, renderDashboardHtml({ observability, runner }), "utf8");
  return { outputPath: targetPath };
}

function renderProjectSummary(summary) {
  if (!summary) return "Not observed yet";
  return ["total", ...STATUS_COLUMNS]
    .filter((key) => summary[key] !== undefined)
    .map((key) => `${key}: ${summary[key]}`)
    .join(" / ");
}

function renderProjectCard(project) {
  const dashboard = project.dashboardPath
    ? `<a href="${escapeHtml(project.dashboardPath)}">${escapeHtml(project.dashboardPath)}</a>`
    : `<span class="muted">No project dashboard yet</span>`;

  return `<article class="project-card">
    <div class="project-head">
      <div>
        <h2>${escapeHtml(project.name ?? project.id)}</h2>
        <p class="muted mono">${escapeHtml(project.id)}</p>
      </div>
      <span class="status">${escapeHtml(project.observedAt ? "Observed" : "Not observed yet")}</span>
    </div>
    <p class="path">${escapeHtml(project.path ?? "")}</p>
    <p>${escapeHtml(renderProjectSummary(project.summary))}</p>
    <p class="mono">${dashboard}</p>
  </article>`;
}

export function renderDashboardIndexHtml({ projects = [] } = {}) {
  const orderedProjects = [...projects].sort((left, right) => String(left.id).localeCompare(String(right.id)));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dark Factory Projects</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #111315;
      --panel: #181b1f;
      --text: #edf0f2;
      --muted: #aab2bb;
      --line: #303740;
      --accent: #61d394;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-size: 14px; letter-spacing: 0; }
    main { width: min(1080px, calc(100vw - 32px)); margin: 0 auto; padding: 24px 0 40px; }
    header { border-bottom: 1px solid var(--line); padding-bottom: 18px; margin-bottom: 16px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 28px; font-weight: 720; }
    h2 { font-size: 18px; font-weight: 700; }
    a { color: var(--accent); overflow-wrap: anywhere; }
    .muted { color: var(--muted); }
    .mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
    .project-card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 14px; display: grid; gap: 10px; }
    .project-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
    .status { border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; color: var(--muted); white-space: nowrap; }
    .path { color: var(--muted); overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Dark Factory Projects</h1>
      <p class="muted">${orderedProjects.length} registered project${orderedProjects.length === 1 ? "" : "s"}</p>
    </header>
    <section class="grid">
      ${orderedProjects.length ? orderedProjects.map(renderProjectCard).join("") : `<p class="muted">No projects registered</p>`}
    </section>
  </main>
</body>
</html>
`;
}

export async function writeDashboardIndex({ projects, outputPath }) {
  const targetPath = resolve(outputPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, renderDashboardIndexHtml({ projects }), "utf8");
  return { outputPath: targetPath };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseArgs(argv) {
  const options = {
    projectId: "project",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];

    if (arg === "--project-id") options.projectId = next();
    else if (arg === "--observability-state-path") options.observabilityStatePath = next();
    else if (arg === "--runner-state-path") options.runnerStatePath = next();
    else if (arg === "--output-path") options.outputPath = next();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node orchestrator/dark-factory-dashboard.js [options]

Options:
  --project-id <id>               Project id (default: project)
  --observability-state-path <p>  D004 observability state path
  --runner-state-path <p>         D003 runner state path
  --output-path <p>               Dashboard HTML output path
`);
}

async function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  const observabilityPath = options.observabilityStatePath ?? `.dark-factory/observability/${options.projectId}.json`;
  const runnerPath = options.runnerStatePath ?? `.dark-factory/state/${options.projectId}.json`;
  const outputPath = options.outputPath ?? `.dark-factory/dashboard/${options.projectId}.html`;
  const result = await writeDashboard({
    observability: await readJson(observabilityPath),
    runner: await readJson(runnerPath),
    outputPath,
  });

  console.log(JSON.stringify(result, null, 2));
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
