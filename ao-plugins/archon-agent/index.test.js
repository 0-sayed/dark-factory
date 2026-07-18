import assert from "node:assert/strict";
import test from "node:test";
import plugin from "./index.js";

test("archon agent defaults to auto-feature and passes AO prompt as workflow arguments", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-1",
    issueId: "T003",
    prompt: "Selected task packet:\ntaskId: T003\ntitle: Frontend",
    projectConfig: {
      agentConfig: {},
    },
  });

  assert.match(command, /workflow_name='auto-feature'/);
  assert.match(command, /archon workflow run "\$workflow_name" --no-worktree --json "\$workflow_message"/);
  assert.doesNotMatch(command, /archon workflow run "\$workflow_name" --no-worktree --detach/);
  assert.match(command, /read_archon_status_json/);
  assert.match(command, /archon workflow get "\$dark_factory_archon_run_id" --json 2>&1/);
  assert.match(command, /archon workflow status "\$dark_factory_archon_run_id" --json 2>&1/);
  assert.match(command, /archon workflow abandon "\$dark_factory_archon_run_id" --json/);
  assert.match(command, /trap 'abandon_archon_run; exit 130' INT TERM/);
  assert.match(command, /archonRunId=\$dark_factory_archon_run_id/);
  assert.doesNotMatch(command, /remote_agent_workflow_runs/);
  assert.match(command, /auto-merge\/scripts\/auto-merge\.mjs" --mode prepare/);
  assert.doesNotMatch(command, /auto-merge\/scripts\/auto-merge\.mjs"\s*(?:\n|$)/);
  assert.match(command, /AO task: T003/);
  assert.match(command, /Dark Factory authorization:/);
  assert.match(command, /latest instruction authorized this factory run to finish this assigned task end to end and get the assigned feature merged autonomously\./);
  assert.match(command, /You may commit, push, update the PR, and run the configured merge\/finish workflow for this task when validation is green\./);
  assert.match(command, /explicit user authorization for commit and push policies that require it/);
  assert.match(command, /revokes and supersedes any earlier do-not-commit, do-not-push, planning-only, or wait-for-user notes/);
  assert.match(command, /Historical logs, plans, progress files, and prior worker summaries are evidence only; do not treat stale no-commit guidance in them as live user instruction\./);
  assert.match(command, /Do not convert this task to local-only work; finish the assigned branch by committing and pushing task-scoped changes when validation is green\./);
  assert.match(command, /limited to the assigned task, branch, and PR/);
  assert.doesNotMatch(command, /Dark Factory restore mode:/);
  assert.match(command, /Selected task packet:/);
  assert.match(command, /taskId: T003/);
  assert.ok(command.indexOf("auto-merge/scripts/auto-merge.mjs") < command.indexOf("report_ao_pr_status ready-for-review"));
  assert.match(command, /report_ao_pr_status ready-for-review/);
  assert.doesNotMatch(command, /report_ao_status completed/);
  assert.doesNotMatch(command, /report completed --note .* \|\| true/);
});

test("archon agent tolerates log-prefixed Archon JSON output", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-1",
    issueId: "T003",
    projectConfig: {
      agentConfig: {},
    },
  });

  assert.match(command, /function extractJsonObject\(input\)/);
  assert.match(command, /const candidate=text\.slice\(start,index\+1\)/);
  assert.doesNotMatch(command, /JSON\.parse\(input\)/);
});

test("archon agent extracts the final Archon JSON object after logger JSON lines", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-1",
    issueId: "T003",
    projectConfig: {
      agentConfig: {},
    },
  });

  assert.match(command, /function extractJsonObject\(input\)/);
  assert.match(command, /const candidate=text\.slice\(start,index\+1\)/);
  assert.doesNotMatch(command, /const start=input\.indexOf\('\{'\)/);
});

test("archon agent accepts Archon workflow id output keys", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-1",
    issueId: "T003",
    projectConfig: {
      agentConfig: {},
    },
  });

  assert.match(command, /json\.workflow_id/);
  assert.match(command, /json\.workflowId/);
  assert.match(command, /json\.run\?\.workflow_id/);
  assert.match(command, /json\.workflow\?\.id/);
});

test("archon agent returns foreground Archon failures when no run id is available", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-1",
    issueId: "T003",
    projectConfig: {
      agentConfig: {},
    },
  });

  assert.doesNotMatch(command, /archon_output="\$\(archon workflow run .* \|\| return \$\?/);
  assert.match(command, /archon_start_status="\$\?"/);
  assert.match(command, /if \[ -z "\$dark_factory_archon_run_id" \]; then/);
  assert.match(command, /return "\$archon_start_status"/);
  assert.match(command, /dark_factory_archon_run_active=1/);
});

test("archon agent treats zero-exit workflow output without a run id as completed", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-1",
    issueId: "T003",
    projectConfig: {
      agentConfig: {},
    },
  });

  assert.match(command, /dark_factory_archon_run_completed=0/);
  assert.match(command, /dark_factory_archon_run_completed=1/);
  assert.match(command, /if \[ "\$\{dark_factory_archon_run_completed:-0\}" = "1" \]; then/);
  assert.match(command, /dark_factory_archon_run_completed=1\n    dark_factory_archon_run_active=0\n    return 0/);
  assert.doesNotMatch(command, /if \[ "\$archon_start_status" -eq 0 \]; then\n      return 1/);
});

test("archon agent falls back to local workflow logs when Archon status omits the run", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-1",
    issueId: "T003",
    projectConfig: {
      agentConfig: {},
    },
  });

  assert.match(command, /read_archon_log_status\(\) \{/);
  assert.match(command, /\.archon\/logs\/\$\{process\.env\.DARK_FACTORY_ARCHON_RUN_ID\}\.jsonl/);
  assert.match(command, /workflow_complete/);
  assert.match(command, /workflow_failed/);
  assert.match(command, /archon_status="\$\(printf '%s' "\$archon_status_json" \| extract_archon_run_status 2>\/dev\/null \|\| read_archon_log_status\)"/);
});

test("archon agent captures Archon run identifiers from stderr as well as stdout", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-1",
    issueId: "T003",
    projectConfig: {
      agentConfig: {},
    },
  });

  assert.match(command, /archon_output="\$\(archon workflow run .* 2>&1\)"/);
  assert.match(command, /archon_resume_output="\$\(archon workflow resume .* 2>&1\)"/);
});

test("archon agent rediscovers an Archon run when start output has no parseable id", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-t028-continuity-backend",
    issueId: "T028",
    projectConfig: {
      agentConfig: {},
    },
  });

  assert.match(command, /discover_archon_run_id\(\) \{/);
  assert.match(command, /archon workflow runs --json --limit "\$\{DARK_FACTORY_ARCHON_DISCOVERY_LIMIT:-25\}"/);
  assert.match(command, /const data = extractJsonObject\(process\.env\.DARK_FACTORY_ARCHON_RUNS_JSON \|\| '\{\}'\)/);
  assert.doesNotMatch(command, /JSON\.parse\(process\.env\.DARK_FACTORY_ARCHON_RUNS_JSON/);
  assert.match(command, /DARK_FACTORY_WORKFLOW_MESSAGE="\$workflow_message"/);
  assert.match(command, /DARK_FACTORY_WORKING_PATH="\$\(pwd -P\)"/);
  assert.match(command, /status === "running" \|\| status === "pending" \|\| status === "paused" \|\| status === "needs_input" \|\| status === "needs-input" \|\| status === "waiting" \|\| status === "blocked" \|\| status === "completed" \|\| status === "success" \|\| status === "succeeded"/);
  assert.match(command, /discover_active_archon_run_id_by_path\(\) \{/);
  assert.match(command, /archon workflow status --cwd "\$\(pwd -P\)" --json 2>&1/);
  assert.match(command, /const activeStatuses = new Set\(\["running", "pending", "paused", "needs_input", "needs-input", "waiting", "blocked"\]\)/);
  assert.match(command, /workingPath !== expectedPath/);
  assert.match(command, /abandon_stale_active_archon_runs_by_path\(\) \{/);
  assert.match(command, /DARK_FACTORY_ARCHON_ACTIVE_STALE_SECONDS="\$\{DARK_FACTORY_ARCHON_ACTIVE_STALE_SECONDS:-600\}"/);
  assert.match(command, /fs\.realpathSync\(`\/proc\/\$\{entry\}\/cwd`\)/);
  assert.match(command, /const executable = argv0\.split\('\/'\)\.pop\(\) \|\| ''/);
  assert.match(command, /\^\(archon\|codex\|claude\|opencode\|cursor-agent\)\$/);
  assert.match(command, /const detachedActive = status === 'running' \|\| status === 'paused'/);
  assert.match(command, /const pendingTimedOut = status === 'pending' && timestamp && ageSeconds >= staleSeconds/);
  assert.match(command, /!liveAgentProcess && \(detachedActive \|\| pendingTimedOut\)/);
  assert.match(command, /archon workflow abandon "\$dark_factory_stale_archon_run_id" --json/);
  assert.match(command, /dark_factory_archon_run_id="\$\(discover_archon_run_id \|\| true\)"/);
  assert.match(command, /dark_factory_archon_run_id="\$\(discover_active_archon_run_id_by_path \|\| true\)"/);
  assert.match(command, /print_archon_output "archon workflow start" "\$archon_output"/);

  const activeDiscoveryStart = command.indexOf("discover_active_archon_run_id_by_path() {");
  const activeDiscoveryEnd = command.indexOf("discover_archon_run_id_from_logs() {", activeDiscoveryStart);
  const activeDiscoveryCommand = command.slice(activeDiscoveryStart, activeDiscoveryEnd);
  assert.doesNotMatch(activeDiscoveryCommand, /DARK_FACTORY_WORKFLOW_NAME|expectedWorkflow|workflow_name|workflow_message/);

  const parseIndex = command.indexOf("dark_factory_archon_run_id=\"$(printf '%s' \"$archon_output\" | extract_archon_run_id 2>/dev/null || true)\"");
  const activeIndex = command.indexOf("dark_factory_archon_run_id=\"$(discover_active_archon_run_id_by_path || true)\"", parseIndex);
  const legacyIndex = command.indexOf("dark_factory_archon_run_id=\"$(discover_archon_run_id || true)\"", activeIndex);
  const startIndex = command.indexOf("start_archon_run() {");
  const staleCleanupIndex = command.indexOf("abandon_stale_active_archon_runs_by_path || true", startIndex);
  const launchIndex = command.indexOf("archon workflow run \"$workflow_name\"", startIndex);
  assert.notEqual(activeIndex, -1);
  assert.notEqual(legacyIndex, -1);
  assert.notEqual(staleCleanupIndex, -1);
  assert.notEqual(launchIndex, -1);
  assert.ok(parseIndex < activeIndex);
  assert.ok(activeIndex < legacyIndex);
  assert.ok(staleCleanupIndex < launchIndex);
});

test("archon agent falls back to local Archon logs when workflow runs is unavailable", () => {
  const agent = plugin.create();
  const command = agent.getRestoreCommand({
    id: "sample-t028-continuity-backend",
    issueId: "T028",
  }, {
    agentConfig: {
      darkFactoryProjectId: "sample",
    },
  });

  assert.match(command, /discover_archon_run_id_from_logs\(\) \{/);
  assert.match(command, /DARK_FACTORY_ARCHON_LOG_DIR="\$\(pwd -P\)\/\.archon\/logs"/);
  assert.match(command, /workflow_start/);
  assert.match(command, /workflow_complete/);
  assert.match(command, /DARK_FACTORY_ARCHON_IGNORE_RUN_ID/);
  assert.match(command, /DARK_FACTORY_ARCHON_ALLOW_FAILED_DISCOVERY/);
  assert.match(command, /AO session: \$\{sessionId\}/);
  assert.match(command, /AO task: \$\{issueId\}/);
  assert.match(command, /discover_archon_run_id_from_logs/);
  assert.ok(command.indexOf("archon workflow runs --json") < command.indexOf("dark_factory_archon_log_id=\"$(discover_archon_run_id_from_logs || true)\""));
  assert.ok(command.indexOf("dark_factory_archon_run_id=\"$(discover_archon_run_id || true)\"") < command.indexOf("run_dark_factory_stage \"archon workflow start\" start_archon_run"));
});

test("archon agent reports dark-factory milestones around the workflow", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-1",
    issueId: "T007",
    prompt: "Selected task packet:\ntaskId: T007",
    projectConfig: {
      agentConfig: {},
    },
  });

  assert.match(command, /milestone=auto_feature_started/);
  assert.match(command, /milestone=auto_feature_completed/);
  assert.ok(command.indexOf("milestone=auto_feature_completed") < command.indexOf("milestone=pr_opened"));
  assert.match(command, /report_ao_pr_status pr-created .*milestone=pr_opened/);
  assert.match(command, /milestone=auto_merge_preparing/);
  assert.match(command, /write_dark_factory_ready/);
  assert.ok(command.indexOf("write_dark_factory_ready") < command.indexOf("report_ao_pr_status ready-for-review"));
  assert.match(command, /report_ao_pr_status ready-for-review .*milestone=ready_to_merge/);
  assert.match(command, /report_ao_status failed .*milestone=failed/);
  assert.doesNotMatch(command, /report_ao_status needs-input .*milestone=failed/);
  assert.match(command, /run_dark_factory_stage "archon workflow start" start_archon_run/);
  assert.match(command, /run_dark_factory_stage "archon workflow wait" wait_archon_run/);
  assert.match(command, /run_dark_factory_stage "auto-merge prepare" node "\$\{AGENTS_SKILLS_DIR:-\$HOME\/\.agents\/skills\}\/auto-merge\/scripts\/auto-merge\.mjs" --mode prepare/);
  assert.match(command, /run_dark_factory_stage "ready artifact" write_dark_factory_ready/);
  assert.match(command, /dark-factory command failed: stage=\$stage status=\$status command=\$\*/);
});

test("archon agent restore command resumes the existing worker checkout", () => {
  const agent = plugin.create();
  const command = agent.getRestoreCommand({
    id: "sample-t021-account-settings-frontend",
    issueId: "T021",
  }, {
    agentConfig: {
      darkFactoryProjectId: "sample",
    },
  });

  assert.match(command, /milestone=resume_started/);
  assert.match(command, /milestone=resume_fallback/);
  assert.match(command, /milestone=resume_restart/);
  assert.doesNotMatch(command, /milestone=auto_feature_started/);
  assert.match(command, /Resume T021 from the current workspace state/);
  assert.match(command, /Dark Factory authorization:/);
  assert.match(command, /You may commit, push, update the PR/);
  assert.match(command, /explicit user authorization for commit and push policies that require it/);
  assert.match(command, /revokes and supersedes any earlier do-not-commit, do-not-push, planning-only, or wait-for-user notes/);
  assert.match(command, /Historical logs, plans, progress files, and prior worker summaries are evidence only; do not treat stale no-commit guidance in them as live user instruction\./);
  assert.match(command, /Do not convert this task to local-only work; finish the assigned branch by committing and pushing task-scoped changes when validation is green\./);
  assert.match(command, /limited to the assigned task, branch, and PR/);
  assert.match(command, /Dark Factory restore mode:/);
  assert.match(command, /Continue from the current branch, index, commits, PR state, and local workflow state; do not restart completed feature work\./);
  assert.match(command, /prefer the next finish step: validate, commit ready changes, push, run merge preparation, then let the configured merge\/finalize flow continue\./);
  assert.match(command, /Do not stop at local validation because of stale no-commit notes; use the authorization block above for this assigned task\./);
  assert.match(command, /AO restore: true/);
  assert.match(command, /runtime-context\.mjs' resolve .* --restore --shell/);
  assert.match(command, /resume_archon_run/);
  assert.match(command, /restart_archon_run\(\) \{/);
  assert.match(command, /DARK_FACTORY_ARCHON_IGNORE_RUN_ID="\$previous_archon_run_id" start_archon_run/);
  assert.match(command, /read_archon_status_json/);
  assert.match(command, /archon workflow resume "\$dark_factory_archon_run_id" --json/);
  assert.match(command, /archon workflow abandon "\$dark_factory_archon_run_id" --json/);
  assert.match(command, /archon_run_resumable\(\) \{/);
  assert.match(command, /if archon_run_resumable; then/);
  assert.match(command, /dark_factory_archon_run_id="\$\(discover_active_archon_run_id_by_path \|\| true\)"/);
  assert.match(command, /else\n    dark_factory_archon_run_id="\$\(DARK_FACTORY_ARCHON_ALLOW_FAILED_DISCOVERY=1 discover_archon_run_id \|\| true\)"/);
  const staleCleanupIndex = command.indexOf("abandon_stale_active_archon_runs_by_path || true");
  const activeRestoreIndex = command.indexOf("dark_factory_archon_run_id=\"$(discover_active_archon_run_id_by_path || true)\"");
  const runIdBranchIndex = command.indexOf("if [ -n \"$dark_factory_archon_run_id\" ]; then", activeRestoreIndex);
  const firstRestartIndex = command.indexOf("run_dark_factory_stage \"archon workflow restart\" restart_archon_run", runIdBranchIndex);
  const oldFallbackIndex = command.indexOf("else\n    dark_factory_archon_run_id=\"$(DARK_FACTORY_ARCHON_ALLOW_FAILED_DISCOVERY=1 discover_archon_run_id || true)\"");
  assert.notEqual(staleCleanupIndex, -1);
  assert.notEqual(activeRestoreIndex, -1);
  assert.notEqual(runIdBranchIndex, -1);
  assert.notEqual(firstRestartIndex, -1);
  assert.notEqual(oldFallbackIndex, -1);
  assert.ok(staleCleanupIndex < activeRestoreIndex);
  assert.ok(activeRestoreIndex < runIdBranchIndex);
  assert.ok(activeRestoreIndex < firstRestartIndex);
  assert.ok(activeRestoreIndex < oldFallbackIndex);
  assert.ok(oldFallbackIndex < command.lastIndexOf("run_dark_factory_stage \"archon workflow restart\" restart_archon_run"));
  const fallbackIndex = command.indexOf("else\n    dark_factory_archon_run_id=\"$(DARK_FACTORY_ARCHON_ALLOW_FAILED_DISCOVERY=1 discover_archon_run_id || true)\"");
  const fallbackResumeIndex = command.indexOf("run_dark_factory_stage \"archon workflow resume\" resume_archon_run", fallbackIndex);
  const fallbackWaitIndex = command.indexOf("run_dark_factory_stage \"archon workflow wait\" wait_archon_run", fallbackResumeIndex);
  assert.notEqual(fallbackResumeIndex, -1);
  assert.notEqual(fallbackWaitIndex, -1);
  assert.doesNotMatch(command, /archon workflow run 'auto-feature' --no-worktree --resume/);
  assert.doesNotMatch(command, /sqlite3/);
  assert.doesNotMatch(command, /prepare_dark_factory_restore/);
  assert.doesNotMatch(command, /\.archon\/restore-archive/);
  assert.doesNotMatch(command, /find \.archon\/logs -maxdepth 1 -type f -name '\*\.jsonl' -exec mv/);
  assert.doesNotMatch(command, /find \.archon\/state -maxdepth 1 -type f -exec mv/);
  assert.match(command, /auto-merge\/scripts\/auto-merge\.mjs" --mode prepare/);
});

test("archon agent restore sends existing merge work directly to merge preparation", () => {
  const agent = plugin.create();
  const command = agent.getRestoreCommand({
    id: "sample-t033-not-found-route-context",
    issueId: "T033",
  }, {
    agentConfig: {
      darkFactoryProjectId: "sample",
    },
  });

  assert.match(command, /restore_should_prepare_existing_pr\(\) \{/);
  assert.match(command, /gh pr view --json state --jq '\.state' 2>\/dev\/null/);
  assert.match(command, /git rev-parse --git-path MERGE_HEAD/);
  assert.match(command, /git diff --quiet/);
  assert.match(command, /git diff --cached --quiet/);
  assert.match(command, /git rev-parse '@\{upstream\}'/);
  assert.match(command, /dark_factory_restore_direct_prepare=1/);

  const directPrepareIndex = command.indexOf('if [ "$dark_factory_restore_direct_prepare" = "1" ]; then');
  const workflowRestoreIndex = command.indexOf('if [ -n "$dark_factory_archon_run_id" ]; then', directPrepareIndex);
  const prepareIndex = command.indexOf('run_dark_factory_stage "auto-merge prepare"', workflowRestoreIndex);
  assert.notEqual(directPrepareIndex, -1);
  assert.notEqual(workflowRestoreIndex, -1);
  assert.notEqual(prepareIndex, -1);
  assert.ok(directPrepareIndex < workflowRestoreIndex);
  assert.ok(workflowRestoreIndex < prepareIndex);
});

test("archon agent restarts instead of resuming cancelled restore run ids", () => {
  const agent = plugin.create();
  const command = agent.getRestoreCommand({
    id: "sample-t029-continuity-admin",
    issueId: "T029",
  }, {
    agentConfig: {
      darkFactoryProjectId: "sample",
    },
  });

  assert.match(command, /archon_run_resumable\(\) \{/);
  assert.match(command, /case "\$archon_resumable_status" in/);
  assert.match(command, /failed\|paused\|needs_input\|needs-input\|waiting\|blocked\)/);
  assert.match(command, /cancelled\|abandoned\)/);

  const restoreIndex = command.indexOf('if [ -n "$dark_factory_archon_run_id" ]; then');
  const resumableCheckIndex = command.indexOf('if archon_run_resumable; then', restoreIndex);
  const resumeIndex = command.indexOf('run_dark_factory_stage "archon workflow resume" resume_archon_run', resumableCheckIndex);
  const restartIndex = command.indexOf('run_dark_factory_stage "archon workflow restart" restart_archon_run', resumableCheckIndex);

  assert.notEqual(resumableCheckIndex, -1);
  assert.notEqual(resumeIndex, -1);
  assert.notEqual(restartIndex, -1);
  assert.ok(resumableCheckIndex < resumeIndex);
  assert.ok(resumeIndex < restartIndex);
});

test("archon agent restarts failed workflows with fresh private Archon state", () => {
  const agent = plugin.create();
  const command = agent.getRestoreCommand({
    id: "sample-t042-snags-admin",
    issueId: "T042",
  }, {
    agentConfig: {
      darkFactoryProjectId: "sample",
    },
  });

  assert.match(command, /activate_persisted_archon_home\(\) \{/);
  assert.match(command, /activate_fresh_archon_home\(\) \{/);
  assert.match(command, /dark_factory_archon_source_home="\$\{DARK_FACTORY_ARCHON_SOURCE_HOME:-\$\{ARCHON_HOME:-\$HOME\/\.archon\}\}"/);
  assert.match(command, /dark_factory_archon_homes_dir="\$\(pwd -P\)\/\.archon\/dark-factory-homes"/);
  assert.match(command, /chmod 700 "\$fresh_archon_home"/);
  assert.match(command, /for shared_name in workflows scripts config\.yaml \.env; do/);
  assert.match(command, /ln -s "\$dark_factory_archon_source_home\/\$shared_name" "\$fresh_archon_home\/\$shared_name"/);
  assert.match(command, /printf '%s\\n' "\$fresh_archon_home" > "\$dark_factory_archon_home_pointer"/);
  assert.match(command, /export ARCHON_HOME="\$fresh_archon_home"/);

  const restartIndex = command.indexOf("restart_archon_run() {");
  const activateIndex = command.indexOf("activate_fresh_archon_home", restartIndex);
  const startIndex = command.indexOf("start_archon_run", activateIndex);
  assert.notEqual(restartIndex, -1);
  assert.notEqual(activateIndex, -1);
  assert.notEqual(startIndex, -1);
  assert.ok(restartIndex < activateIndex);
  assert.ok(activateIndex < startIndex);
  assert.doesNotMatch(command, /sqlite3|archon\.db/);
});

test("archon agent treats parked Archon statuses as recoverable instead of polling forever", () => {
  const agent = plugin.create();
  const command = agent.getRestoreCommand({
    id: "sample-t036-subcontractors-admin",
    issueId: "T036",
  }, {
    agentConfig: {
      darkFactoryProjectId: "sample",
    },
  });

  assert.match(command, /failed\|error\|errored\|cancelled\|abandoned\|needs_input\|needs-input\|waiting\|blocked\|paused\)/);
  assert.match(command, /failed\|paused\|needs_input\|needs-input\|waiting\|blocked\)/);
  assert.match(command, /status === "needs_input" \|\| status === "needs-input" \|\| status === "waiting" \|\| status === "blocked"/);
  assert.match(command, /const activeStatuses = new Set\(\['running', 'pending', 'paused', 'needs_input', 'needs-input', 'waiting', 'blocked'\]\)/);
});

test("archon agent fresh launches do not archive Archon state", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-t021-account-settings-frontend",
    issueId: "T021",
    projectConfig: {
      agentConfig: {
        darkFactoryProjectId: "sample",
      },
    },
  });

  assert.doesNotMatch(command, /prepare_dark_factory_restore/);
  assert.doesNotMatch(command, /\.archon\/restore-archive/);
});

test("archon agent writes the Dark Factory ready artifact outside the worktree", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-2",
    issueId: "T002",
    prompt: "Selected task packet:\ntaskId: T002",
    projectConfig: {
      agentConfig: {
        darkFactoryProjectId: "sample",
        runtimeEnv: {
          VITE_API_URL: "http://127.0.0.1:${apiPort}",
        },
      },
    },
  });

  assert.match(command, /dark_factory_project_id='sample'/);
  assert.match(command, /ready_dir="\$\{AGENT_ORCHESTRATOR_HOME:-\$HOME\/\.agent-orchestrator\}\/projects\/\$dark_factory_project_id\/sessions"/);
  assert.match(command, /ready_path="\$ready_dir\/sample-2\.ready\.json"/);
  assert.match(command, /DARK_FACTORY_ARCHON_RUN_ID="\$dark_factory_archon_run_id"/);
  assert.match(command, /archonRunId: process\.env\.DARK_FACTORY_ARCHON_RUN_ID \|\| null/);
  assert.match(command, /frontend-qa-status\.txt/);
  assert.match(command, /frontend-qa-result\.md/);
  assert.match(command, /review-cycle\.json/);
  assert.doesNotMatch(command, /\.dark-factory\/ready\.json/);
});

test("archon agent exposes stable Dark Factory resource identity and ports to worker commands", () => {
  const agent = plugin.create();
  const environment = agent.getEnvironment({
    sessionId: "sample-2",
    issueId: "T002",
    projectConfig: {
      agentConfig: {
        darkFactoryProjectId: "sample",
      },
    },
  });

  assert.equal(environment.AO_SESSION_ID, "sample-2");
  assert.equal(environment.AO_ISSUE_ID, "T002");
  assert.equal(environment.DARK_FACTORY_PROJECT_ID, "sample");
  assert.equal(environment.DARK_FACTORY_SESSION_ID, "sample-2");
  assert.equal(environment.DARK_FACTORY_ISSUE_ID, "T002");
  assert.equal(environment.COMPOSE_PROJECT_NAME, "df-sample-sample-2");
  assert.equal(environment.CHROME_PROFILE_MODE, "temp");
  assert.match(environment.PORT, /^\d+$/);
  assert.match(environment.WEB_PORT, /^\d+$/);
  assert.equal(environment.VITE_API_URL, undefined);
  assert.equal(environment.DARK_FACTORY_API_PORT, environment.PORT);
  assert.equal(environment.DARK_FACTORY_WEB_PORT, environment.WEB_PORT);
  assert.equal(Number(environment.WEB_PORT), Number(environment.PORT) + 1);
});

test("archon agent forces disposable browser profiles for worker QA", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-2",
    issueId: "T002",
    prompt: "Selected task packet:\ntaskId: T002",
    projectConfig: {
      agentConfig: {
        darkFactoryProjectId: "sample",
        runtimeEnv: {
          VITE_API_URL: "http://127.0.0.1:${apiPort}",
        },
      },
    },
  });

  assert.match(command, /export CHROME_PROFILE_MODE='temp'/);
  assert.match(command, /runtime-context\.mjs' resolve .*--initial-api-port "\$dark_factory_api_port".*--shell/);
  assert.match(command, /eval "\$dark_factory_selected_ports"/);
  assert.match(command, /export VITE_API_URL="http:\/\/127\.0\.0\.1:\$\{dark_factory_api_port\}"/);
  assert.match(command, /export DARK_FACTORY_API_PORT="\$dark_factory_api_port"/);
  assert.match(command, /export DARK_FACTORY_WEB_PORT="\$dark_factory_web_port"/);
});

test("archon agent keeps project runtime env configurable", () => {
  const agent = plugin.create();
  const environment = agent.getEnvironment({
    sessionId: "sample-2",
    issueId: "T002",
    projectConfig: {
      agentConfig: {
        darkFactoryProjectId: "sample",
      },
    },
  });
  const command = agent.getLaunchCommand({
    sessionId: "sample-2",
    issueId: "T002",
    projectConfig: {
      agentConfig: {
        darkFactoryProjectId: "sample",
      },
    },
  });

  assert.equal(environment.VITE_API_URL, undefined);
  assert.doesNotMatch(command, /export VITE_API_URL=/);
});

test("archon agent preserves unknown runtime env template placeholders", () => {
  const agent = plugin.create();
  const environment = agent.getEnvironment({
    sessionId: "sample-2",
    issueId: "T002",
    projectConfig: {
      agentConfig: {
        darkFactoryProjectId: "sample",
        runtimeEnv: {
          DATABASE_URL: "mongodb://${MONGO_HOST}:${MONGO_PORT}/${issueId}",
        },
      },
    },
  });
  const command = agent.getLaunchCommand({
    sessionId: "sample-2",
    issueId: "T002",
    projectConfig: {
      agentConfig: {
        darkFactoryProjectId: "sample",
        runtimeEnv: {
          DATABASE_URL: "mongodb://${MONGO_HOST}:${MONGO_PORT}/${issueId}",
        },
      },
    },
  });

  assert.equal(environment.DATABASE_URL, "mongodb://${MONGO_HOST}:${MONGO_PORT}/T002");
  assert.match(command, /export DATABASE_URL="mongodb:\/\/\\\$\{MONGO_HOST\}:\\\$\{MONGO_PORT\}\/\$\{dark_factory_issue_id\}"/);
});

test("archon agent skips launch and reporting when AO did not assign a task", () => {
  const agent = plugin.create();
  const command = agent.getLaunchCommand({
    sessionId: "sample-orchestrator",
    issueId: null,
    prompt: "",
    projectConfig: {
      agentConfig: {},
    },
  });

  assert.match(command, /missing AO issue id/);
  assert.doesNotMatch(command, /manual/);
  assert.doesNotMatch(command, /report_ao_status/);
  assert.doesNotMatch(command, /archon workflow run/);
});
