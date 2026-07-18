import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const validate = await import("../scripts/validate.mjs");
const { discoverTests } = validate;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function writeFixtureFile(root, path, contents = "") {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

test("discovers only supported tests from the validation roots", () => {
  const root = mkdtempSync(join(tmpdir(), "dark-factory-validate-"));

  try {
    writeFixtureFile(root, "orchestrator/nested/worker.test.js");
    writeFixtureFile(root, "ao-plugins/example/runtime.test.mjs");
    const shellTest = writeFixtureFile(root, "distribution/scripts/check.test", "#!/bin/sh\nexit 0\n");
    chmodSync(shellTest, 0o755);
    writeFixtureFile(root, "distribution/scripts/not-executable.test");
    writeFixtureFile(root, "outside/ignored.test.js");

    assert.deepEqual(discoverTests(root), {
      nodeTests: [
        join(root, "ao-plugins/example/runtime.test.mjs"),
        join(root, "orchestrator/nested/worker.test.js"),
      ],
      shellTests: [join(root, "distribution/scripts/check.test")],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checked-in tests include each supported validation class", () => {
  const discovered = discoverTests();

  assert(discovered.nodeTests.some((path) => path.endsWith("orchestrator/dark-factory.test.js")));
  assert(discovered.nodeTests.some((path) => path.endsWith("ao-plugins/archon-agent/runtime-context.test.mjs")));
  assert(discovered.nodeTests.some((path) => path.endsWith("distribution/archon-scripts/dev-readiness.test.mjs")));
  assert(discovered.shellTests.some((path) => path.endsWith("distribution/skills/browser-auth/scripts/chrome-auth-load.test")));
});

test("root package configuration leaves unscoped JavaScript files as CommonJS", () => {
  const fixture = mkdtempSync(join(ROOT, ".validate-cjs-"));
  const file = join(fixture, "commonjs.js");
  writeFileSync(file, "module.exports = 'commonjs';\n");

  try {
    const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("isolates HOME and USERPROFILE without dropping supplied environment values", () => {
  assert.deepEqual(
    validate.isolatedTestEnvironment({ PATH: "/bin", KEEP: "value", HOME: "/real-home" }, "/test-home"),
    { PATH: "/bin", KEEP: "value", HOME: "/test-home", USERPROFILE: "/test-home" },
  );
});

test("passes an isolated home to shell tests while preserving other environment values", () => {
  const root = mkdtempSync(join(tmpdir(), "dark-factory-validate-run-"));
  const shellResult = join(root, "shell-environment.txt");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousMarker = process.env.DARK_FACTORY_VALIDATE_MARKER;

  try {
    process.env.HOME = "/real-home-sentinel";
    process.env.USERPROFILE = "/real-profile-sentinel";
    process.env.DARK_FACTORY_VALIDATE_MARKER = "preserved";
    const shellTest = writeFixtureFile(
      root,
      "distribution/environment.test",
      `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$HOME" "$USERPROFILE" "$DARK_FACTORY_VALIDATE_MARKER" > ${JSON.stringify(shellResult)}\n`,
    );
    chmodSync(shellTest, 0o755);
    writeFixtureFile(root, "scripts/manage-distribution.mjs", "process.exit(0);\n");

    validate.runValidation(root);

    const [shellHome, shellUserProfile, shellMarker] = readFileSync(shellResult, "utf8").trim().split("\n");
    assert.notEqual(shellHome, "/real-home-sentinel");
    assert.equal(shellUserProfile, shellHome);
    assert.equal(shellMarker, "preserved");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousMarker === undefined) delete process.env.DARK_FACTORY_VALIDATE_MARKER;
    else process.env.DARK_FACTORY_VALIDATE_MARKER = previousMarker;
    rmSync(root, { recursive: true, force: true });
  }
});
