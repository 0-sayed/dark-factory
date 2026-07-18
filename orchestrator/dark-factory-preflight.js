import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function defaultRunGit(projectPath, args) {
  const { stdout } = await execFileAsync("git", ["-C", projectPath, ...args], { encoding: "utf8" });
  return stdout;
}

function planningRootFromTasksPath(tasksPath) {
  const root = dirname(String(tasksPath ?? "planning/roadmap/tasks.md"));
  if (root === "." || root === "") return ".";
  const firstSegment = root.split(/[\\/]/)[0];
  return firstSegment || root;
}

async function hasOriginRemote(runGit) {
  try {
    await runGit(["remote", "get-url", "origin"]);
    return true;
  } catch {
    return false;
  }
}

export async function verifyProjectPlanningFresh(options = {}) {
  const project = options.project;
  if (!project?.path) throw new Error("Planning freshness preflight requires project.path");

  const projectId = project.id ?? project.name ?? project.path;
  const defaultBranch = project.defaultBranch ?? "main";
  const tasksPath = project.tracker?.tasksPath ?? "planning/roadmap/tasks.md";
  const planningPath = planningRootFromTasksPath(tasksPath);
  const runGit = options.runGit ?? ((args) => defaultRunGit(project.path, args));
  const hasOrigin = await hasOriginRemote(runGit);
  let fastForwarded = false;

  if (hasOrigin) {
    await runGit(["fetch", "origin", "--quiet"]);
    const localRef = `refs/heads/${defaultBranch}`;
    const remoteRef = `refs/remotes/origin/${defaultBranch}`;
    const localHead = String(await runGit(["rev-parse", "--verify", localRef])).trim();
    const remoteHead = String(await runGit(["rev-parse", "--verify", remoteRef])).trim();

    if (localHead !== remoteHead) {
      const dirtyCheckout = String(await runGit(["status", "--porcelain"])).trim();
      if (dirtyCheckout) {
        throw new Error(`Cannot fast-forward planning checkout for ${projectId}: checkout has uncommitted changes`);
      }

      try {
        await runGit(["merge-base", "--is-ancestor", localRef, remoteRef]);
      } catch {
        throw new Error(`Planning checkout is stale for ${projectId}: local ${defaultBranch} cannot fast-forward to origin/${defaultBranch}`);
      }

      await runGit(["merge", "--ff-only", remoteRef]);
      fastForwarded = true;
    }
  }

  const dirtyPlanning = String(await runGit(["status", "--porcelain", "--", planningPath])).trim();
  if (dirtyPlanning) {
    throw new Error(`Planning folder has uncommitted changes for ${projectId}: commit or stash ${planningPath} before orchestration`);
  }

  return {
    checked: true,
    defaultBranch,
    fastForwarded,
    mode: hasOrigin ? "remote" : "local",
    projectId,
    planningPath,
  };
}
