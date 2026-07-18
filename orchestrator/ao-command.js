import { execFile, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function splitCommandLine(command) {
  const text = String(command ?? "ao").trim() || "ao";
  const parts = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of text) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("Unterminated quote in AO command");
  if (current) parts.push(current);
  return parts.length ? parts : ["ao"];
}

export function aoEnv(aoConfigPath, overrides) {
  const env = overrides ? { ...process.env, ...overrides } : { ...process.env };
  if (aoConfigPath) env.AO_CONFIG_PATH = aoConfigPath;
  return env;
}

export function buildAoInvocation(aoCommand, args = []) {
  const [file, ...baseArgs] = splitCommandLine(aoCommand);
  return { file, args: [...baseArgs, ...args] };
}

export function extractJsonObject(output) {
  const text = String(output ?? "");
  let best = null;

  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaping = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = inString;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        const candidate = text.slice(start, index + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (!best || index > best.end || (index === best.end && start < best.start)) {
            best = { parsed, start, end: index };
          }
        } catch {
          // A preceding log line can contain a brace without being JSON.
        }
        break;
      }
    }
  }

  if (!best) throw new Error("AO command did not return a JSON object");
  return best.parsed;
}

function hasFlag(args, ...names) {
  return args.some((arg) => names.includes(arg));
}

export function translateGoAoArgs(args = []) {
  const input = [...args];

  if (input[0] === "spawn" && input[1] && !input[1].startsWith("-")) {
    const issueRef = input[1];
    const separator = issueRef.indexOf("/");
    const projectId = separator >= 0 ? issueRef.slice(0, separator) : null;
    const issueId = separator >= 0 ? issueRef.slice(separator + 1) : issueRef;
    const translated = ["spawn"];
    if (projectId && !hasFlag(input, "--project")) translated.push("--project", projectId);
    if (issueId && !hasFlag(input, "--issue")) translated.push("--issue", issueId);
    translated.push(...input.slice(2));
    if (!hasFlag(translated, "--harness", "--agent")) translated.push("--harness", "external");
    return translated;
  }

  if (input[0] === "session" && input[1] === "cleanup") {
    const dryRun = hasFlag(input, "--dry-run");
    const translated = input.filter((arg) => arg !== "--dry-run");
    if (dryRun) {
      return ["session", "ls", ...translated.slice(2), "--include-terminated", "--json"];
    }
    if (!hasFlag(translated, "--yes", "-y")) translated.push("--yes");
    return translated;
  }

  return input;
}

function commandArgsForTransport(aoCommand, args) {
  const command = splitCommandLine(aoCommand);
  const isLegacyNodeCommand = command.some((part) => /\.m?js$/i.test(part));
  return isLegacyNodeCommand ? [...args] : translateGoAoArgs(args);
}

function normalizeAoCliError(error) {
  const output = [error?.stderr, error?.stdout, error?.message]
    .filter(Boolean)
    .map(String)
    .join("\n");
  const domainCode = output.match(/\(([A-Z][A-Z0-9_]+)\)/)?.[1];
  if (domainCode && error && typeof error === "object") {
    error.processExitCode = error.code;
    error.code = domainCode;
  }
  return error;
}

export async function runAo(args, {
  cwd,
  aoConfigPath,
  aoCommand,
  env,
  execFileAsync: runProcess = execFileAsync,
} = {}) {
  const invocation = buildAoInvocation(aoCommand, commandArgsForTransport(aoCommand, args));
  try {
    const { stdout, stderr } = await runProcess(invocation.file, invocation.args, {
      cwd,
      env: aoEnv(aoConfigPath, env),
    });
    return { stdout, stderr };
  } catch (error) {
    throw normalizeAoCliError(error);
  }
}

export function startAo(args, { cwd, aoConfigPath, aoCommand, env, spawnProcess = spawn } = {}) {
  const invocation = buildAoInvocation(aoCommand, commandArgsForTransport(aoCommand, args));
  const child = spawnProcess(invocation.file, invocation.args, {
    cwd,
    env: aoEnv(aoConfigPath, env),
    detached: true,
    stdio: "ignore",
  });
  if (typeof child.unref === "function") child.unref();
  return { detached: true, pid: child.pid ?? null, stdout: "", stderr: "" };
}

export async function runAoJson(args, options = {}) {
  const { stdout, stderr } = await runAo(args, options);
  return extractJsonObject(`${stdout}\n${stderr}`);
}

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`AO ${label} is required`);
  return normalized;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function preferredPr(prs) {
  if (!Array.isArray(prs) || prs.length === 0) return null;
  return prs.find((pr) => ["open", "draft"].includes(String(pr?.state ?? "").toLowerCase())) ?? prs[0];
}

function apiError(payload, status) {
  const body = payload && typeof payload === "object" ? payload : {};
  const nested = body.error && typeof body.error === "object" ? body.error : {};
  const code = body.code ?? nested.code ?? null;
  const requestId = body.requestId ?? nested.requestId ?? null;
  let message = body.message ?? nested.message ?? `AO daemon returned HTTP ${status}`;
  if (code) message += ` (${code})`;
  if (requestId) message += ` [request ${requestId}]`;

  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  if (requestId) error.requestId = requestId;
  return error;
}

export function createAoTransport(options = {}) {
  const environment = { ...process.env, ...(options.env ?? {}) };
  const runFilePath = options.runFilePath
    ?? environment.AO_RUN_FILE
    ?? join(homedir(), ".ao", "running.json");
  const dataDir = options.dataDir
    ?? environment.AO_DATA_DIR
    ?? join(homedir(), ".ao", "data");
  const read = options.readFile ?? readFile;
  const request = options.fetch ?? globalThis.fetch;
  const exists = options.pathExists ?? (async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  });
  const cliOptions = {
    cwd: options.cwd,
    aoConfigPath: options.aoConfigPath,
    aoCommand: options.aoCommand,
    env: environment,
    execFileAsync: options.execFileAsync,
  };

  async function daemonBaseUrl() {
    let content;
    try {
      content = await read(runFilePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`AO daemon is not running (missing run-file at ${runFilePath})`);
      }
      throw new Error(`Cannot read AO daemon run-file at ${runFilePath}: ${error.message}`);
    }
    let info;
    try {
      info = JSON.parse(content);
    } catch (error) {
      throw new Error(`AO daemon run-file is invalid at ${runFilePath}: ${error.message}`);
    }
    if (!Number.isInteger(info?.port) || info.port < 1 || info.port > 65535) {
      throw new Error(`AO daemon run-file has no valid port at ${runFilePath}`);
    }
    return `http://127.0.0.1:${info.port}`;
  }

  async function daemonJson(path, { method = "GET", body } = {}) {
    const baseUrl = await daemonBaseUrl();
    let response;
    try {
      response = await request(`${baseUrl}/api/v1/${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(`AO daemon is not available at ${baseUrl}: ${error.message}`);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Preserve a useful HTTP error even when the daemon returns no JSON body.
    }
    if (!response.ok) throw apiError(payload, response.status);
    return payload;
  }

  async function normalizeSession(session) {
    if (!session) return null;
    const projectId = session.projectId ?? session.project ?? null;
    const id = session.id ?? session.sessionId ?? null;
    const kind = session.kind ?? session.role ?? "worker";
    const candidateWorkspace = projectId && id && kind !== "orchestrator"
      ? join(dataDir, "worktrees", String(projectId), String(id))
      : null;
    const workspacePath = session.workspacePath
      ?? session.worktree
      ?? (candidateWorkspace && await exists(candidateWorkspace) ? candidateWorkspace : null);
    const prs = Array.isArray(session.prs) ? session.prs : [];
    const lastActivityAt = isoDate(session.lastActivityAt ?? session.activity?.lastActivityAt);

    return {
      ...session,
      id,
      projectId,
      projectName: session.projectName ?? projectId,
      role: kind === "orchestrator" ? "orchestrator" : "worker",
      kind,
      branch: session.branch ?? session.metadata?.branch ?? null,
      status: session.status ?? null,
      issueId: session.issueId ?? session.issue ?? null,
      pr: session.pr ?? preferredPr(prs),
      prs,
      workspacePath,
      lastActivityAt,
      isTerminated: Boolean(session.isTerminated),
    };
  }

  async function status() {
    const payload = await runAoJson(["status", "--json"], cliOptions);
    return {
      available: payload.state !== "stopped" && payload.state !== "stale",
      ready: payload.state === "ready" && payload.ready === "ready",
      state: payload.state ?? "unknown",
      pid: payload.pid ?? null,
      port: payload.port ?? null,
      error: payload.error ?? null,
    };
  }

  async function projectGet(id) {
    const payload = await runAoJson(["project", "get", required(id, "project id"), "--json"], cliOptions);
    return payload.project ?? payload;
  }

  async function projectAdd(input = {}) {
    const payload = await daemonJson("projects", { method: "POST", body: compactObject(input) });
    return payload.project ?? payload;
  }

  async function projectSetConfig(id, config) {
    const payload = await runAoJson([
      "project",
      "set-config",
      required(id, "project id"),
      "--config-json",
      JSON.stringify(config ?? {}),
      "--json",
    ], cliOptions);
    return payload.project ?? payload;
  }

  async function spawnSession(input = {}) {
    const body = compactObject({
      projectId: required(input.projectId, "spawn project id"),
      sessionId: required(input.sessionId, "spawn explicit session id"),
      issueId: input.issueId,
      harness: input.harness,
      branch: input.branch,
      prompt: input.prompt,
      displayName: input.displayName,
    });
    const payload = await daemonJson("sessions", { method: "POST", body });
    return normalizeSession(payload.session ?? payload);
  }

  async function sessionList({ projectId, includeTerminated = true, includeOrchestrators = false } = {}) {
    const query = new URLSearchParams();
    if (!includeTerminated) query.set("active", "true");
    if (projectId) query.set("project", projectId);
    const payload = await daemonJson(`sessions${query.size ? `?${query}` : ""}`);
    const sessions = (payload.sessions ?? payload.data ?? [])
      .filter((session) => includeOrchestrators || (session.kind ?? session.role) !== "orchestrator");
    const data = await Promise.all(sessions.map(normalizeSession));
    let hiddenTerminatedCount = 0;
    if (!includeTerminated) {
      const hiddenQuery = new URLSearchParams({ active: "false" });
      if (projectId) hiddenQuery.set("project", projectId);
      const hiddenPayload = await daemonJson(`sessions?${hiddenQuery}`);
      hiddenTerminatedCount = (hiddenPayload.sessions ?? hiddenPayload.data ?? [])
        .filter((session) => includeOrchestrators || (session.kind ?? session.role) !== "orchestrator")
        .length;
    }
    return { data, meta: { hiddenTerminatedCount } };
  }

  async function sessionGet(id) {
    const payload = await daemonJson(`sessions/${encodeURIComponent(required(id, "session id"))}`);
    return normalizeSession(payload.session ?? payload);
  }

  async function sessionRestore(id) {
    const sessionId = required(id, "session id");
    const payload = await daemonJson(`sessions/${encodeURIComponent(sessionId)}/restore`, { method: "POST", body: {} });
    return normalizeSession(payload.session ?? { id: payload.sessionId ?? sessionId });
  }

  async function sessionSuspend(id) {
    const sessionId = required(id, "session id");
    return daemonJson(`sessions/${encodeURIComponent(sessionId)}/suspend`, { method: "POST", body: {} });
  }

  async function sessionKill(id) {
    const sessionId = required(id, "session id");
    return daemonJson(`sessions/${encodeURIComponent(sessionId)}/kill`, { method: "POST", body: {} });
  }

  async function cleanup({ projectId, execute = false, sessionIds = [] } = {}) {
    const normalizedProjectId = required(projectId, "cleanup project id");
    const query = new URLSearchParams({ project: normalizedProjectId });
    const selectedSessionIds = [...new Set(
      sessionIds.map((sessionId) => required(sessionId, "cleanup session id")),
    )];
    for (const sessionId of selectedSessionIds) query.append("session", sessionId);
    if (execute) {
      const payload = await daemonJson(`sessions/cleanup?${query}`, { method: "POST", body: {} });
      return {
        execute: true,
        projectId: normalizedProjectId,
        cleaned: payload.cleaned ?? [],
        skipped: payload.skipped ?? [],
      };
    }
    const previewQuery = new URLSearchParams({ active: "false", project: normalizedProjectId });
    const payload = await daemonJson(`sessions?${previewQuery}`);
    return {
      execute: false,
      projectId: normalizedProjectId,
      candidates: (payload.sessions ?? [])
        .map((session) => session.id)
        .filter((sessionId) => sessionId && (
          selectedSessionIds.length === 0 || selectedSessionIds.includes(sessionId)
        )),
    };
  }

  async function claimPr({ sessionId, pr, allowTakeover = true } = {}) {
    return daemonJson(`sessions/${encodeURIComponent(required(sessionId, "session id"))}/pr/claim`, {
      method: "POST",
      body: { pr: required(pr, "PR reference"), allowTakeover: Boolean(allowTakeover) },
    });
  }

  return {
    status,
    projectGet,
    projectAdd,
    projectSetConfig,
    spawn: spawnSession,
    sessionList,
    sessionGet,
    sessionSuspend,
    sessionRestore,
    sessionKill,
    cleanup,
    claimPr,
  };
}
