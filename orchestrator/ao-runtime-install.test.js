import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildAndInstallAoRuntime,
  installAoRuntimeArtifacts,
  verifyAoRuntimeInstallation,
} from "../scripts/install-ao-runtime.mjs";

const AO_COMMIT = "a".repeat(40);
const AO_REPOSITORY = "https://github.com/example/agent-orchestrator.git";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dark-factory-ao-runtime-"));
  const home = join(root, "home");
  const checkout = join(root, "agent-orchestrator");
  const appImage = join(root, "agent-orchestrator.AppImage");
  const cli = join(root, "ao");
  mkdirSync(join(checkout, "backend"), { recursive: true });
  mkdirSync(join(checkout, "frontend"), { recursive: true });
  writeFileSync(join(checkout, "frontend", "app-update.yml"), "provider: upstream\n");
  writeFileSync(appImage, "fork desktop runtime\n");
  writeFileSync(cli, "fork cli runtime\n");
  chmodSync(appImage, 0o755);
  chmodSync(cli, 0o755);
  return { root, home, checkout, appImage, cli };
}

test("AO runtime installation records and verifies the pinned desktop and CLI", () => {
  const testFixture = fixture();

  try {
    const installed = installAoRuntimeArtifacts({
      home: testFixture.home,
      appImagePath: testFixture.appImage,
      cliPath: testFixture.cli,
      dependency: { repository: AO_REPOSITORY, commit: AO_COMMIT },
    });

    assert.equal(readFileSync(installed.appImagePath, "utf8"), "fork desktop runtime\n");
    assert.equal(readFileSync(installed.cliPath, "utf8"), "fork cli runtime\n");
    assert.deepEqual(
      verifyAoRuntimeInstallation({
        home: testFixture.home,
        dependency: { repository: AO_REPOSITORY, commit: AO_COMMIT },
      }),
      installed,
    );
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test("AO runtime verification rejects a changed desktop artifact", () => {
  const testFixture = fixture();

  try {
    const installed = installAoRuntimeArtifacts({
      home: testFixture.home,
      appImagePath: testFixture.appImage,
      cliPath: testFixture.cli,
      dependency: { repository: AO_REPOSITORY, commit: AO_COMMIT },
    });
    writeFileSync(installed.appImagePath, "unexpected desktop runtime\n");

    assert.throws(
      () => verifyAoRuntimeInstallation({
        home: testFixture.home,
        dependency: { repository: AO_REPOSITORY, commit: AO_COMMIT },
      }),
      /desktop checksum/i,
    );
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test("AO runtime verification rejects a receipt for another locked commit", () => {
  const testFixture = fixture();

  try {
    installAoRuntimeArtifacts({
      home: testFixture.home,
      appImagePath: testFixture.appImage,
      cliPath: testFixture.cli,
      dependency: { repository: AO_REPOSITORY, commit: AO_COMMIT },
    });

    assert.throws(
      () => verifyAoRuntimeInstallation({
        home: testFixture.home,
        dependency: { repository: AO_REPOSITORY, commit: "b".repeat(40) },
      }),
      /commit/i,
    );
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test("AO runtime build stamps the fork in both CLI and desktop artifacts", () => {
  const testFixture = fixture();
  const calls = [];

  try {
    const installed = buildAndInstallAoRuntime({
      home: testFixture.home,
      checkoutPath: testFixture.checkout,
      dependency: { repository: AO_REPOSITORY, commit: AO_COMMIT },
      platform: "linux",
      architecture: "x64",
      verifyRepository: () => {},
      runCommand: (command, args, options) => {
        calls.push({ command, args, options });
        if (command === "git" && args[0] === "clone") {
          const buildCheckout = args.at(-1);
          mkdirSync(join(buildCheckout, "backend"), { recursive: true });
          mkdirSync(join(buildCheckout, "frontend"), { recursive: true });
          writeFileSync(join(buildCheckout, "frontend", "app-update.yml"), "provider: upstream\n");
        }
        if (command === "go") writeFileSync(args[args.indexOf("-o") + 1], "built cli\n");
        if (command === "npm" && args.includes("make")) {
          writeFileSync(join(options.cwd, "app-update.yml"), "provider: fork\n");
          mkdirSync(join(options.cwd, "src", "renderer"), { recursive: true });
          writeFileSync(join(options.cwd, "src", "renderer", "routeTree.gen.ts"), "generated\n");
          mkdirSync(join(options.cwd, "out", "make"), { recursive: true });
          writeFileSync(
            join(options.cwd, "out", "make", "Agent.Orchestrator-test.AppImage"),
            "built desktop\n",
          );
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    const goBuild = calls.find((call) => call.command === "go");
    assert.match(goBuild.args.join(" "), new RegExp(`Commit=${AO_COMMIT}`));
    assert.match(goBuild.args.join(" "), /releaseRepo=example\/agent-orchestrator/);

    const desktopBuild = calls.find((call) => call.command === "npm" && call.args.includes("make"));
    assert.equal(desktopBuild.options.env.AO_RELEASE_REPO, "example/agent-orchestrator");
    assert.deepEqual(desktopBuild.args.slice(-3), [
      "--platform=linux",
      "--arch=x64",
      "--targets=appimage",
    ]);
    assert.equal(verifyAoRuntimeInstallation({
      home: testFixture.home,
      dependency: { repository: AO_REPOSITORY, commit: AO_COMMIT },
    }).appImageSha256, installed.appImageSha256);
    assert.equal(
      readFileSync(join(testFixture.checkout, "frontend", "app-update.yml"), "utf8"),
      "provider: upstream\n",
    );
    assert.throws(
      () => readFileSync(join(testFixture.checkout, "frontend", "src", "renderer", "routeTree.gen.ts")),
      /ENOENT/,
    );
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test("AO runtime build rejects unsupported platforms before running commands", () => {
  assert.throws(
    () => buildAndInstallAoRuntime({
      home: "/tmp/example-home",
      checkoutPath: "/tmp/example-checkout",
      dependency: { repository: AO_REPOSITORY, commit: AO_COMMIT },
      platform: "darwin",
      runCommand: () => assert.fail("build command must not run"),
    }),
    /Linux x64/i,
  );
});
