import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  validateDependencyLock,
  verifyDependencyRepository,
  verifyRuntimeTools,
} from "../scripts/verify-dependencies.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(remoteUrl) {
  const directory = mkdtempSync(join(tmpdir(), "dark-factory-dependency-"));
  git(directory, ["init", "--quiet", "--initial-branch=main"]);
  git(directory, ["config", "user.name", "Dark Factory Test"]);
  git(directory, ["config", "user.email", "dark-factory-test@example.invalid"]);
  git(directory, ["config", "commit.gpgsign", "false"]);
  git(directory, ["remote", "add", "origin", remoteUrl]);
  writeFileSync(join(directory, "README.md"), "fixture\n");
  git(directory, ["add", "README.md"]);
  git(directory, ["commit", "--quiet", "-m", "fixture"]);
  return { directory, commit: git(directory, ["rev-parse", "HEAD"]) };
}

test("dependency lock requires immutable repository pins", () => {
  assert.throws(
    () => validateDependencyLock({ lockVersion: 1, repositories: {} }),
    /at least one repository/i,
  );

  assert.throws(
    () => validateDependencyLock({
      lockVersion: 1,
      repositories: {
        example: {
          repository: "https://github.com/example/tool.git",
          commit: "main",
          checkout: {
            environment: "EXAMPLE_CHECKOUT",
            defaultSibling: "tool",
          },
        },
      },
    }),
    /40-character commit SHA/i,
  );
});

test("dependency lock requires executable runtime checks", () => {
  assert.throws(
    () => validateDependencyLock({
      lockVersion: 1,
      repositories: {
        example: {
          repository: "https://github.com/example/tool.git",
          commit: "a".repeat(40),
          checkout: {
            environment: "EXAMPLE_CHECKOUT",
            defaultSibling: "tool",
          },
        },
      },
      runtimes: {
        example: {
          command: "example",
          versionArgs: [],
          expectedOutput: "",
        },
      },
    }),
    /versionArgs/i,
  );
});

test("runtime verification rejects missing or unexpected active tools", () => {
  const runtimes = {
    archon: {
      command: "archon",
      versionArgs: ["version"],
      expectedOutput: "Archon CLI v0.5.0",
    },
  };

  assert.throws(
    () => verifyRuntimeTools({
      runtimes,
      runCommand: () => "Archon CLI v0.3.9\n",
    }),
    /archon.*expected.*0\.5\.0/i,
  );

  assert.deepEqual(
    verifyRuntimeTools({
      runtimes,
      runCommand: (command, args) => {
        assert.equal(command, "archon");
        assert.deepEqual(args, ["version"]);
        return "Archon CLI v0.5.0\n";
      },
    }),
    [{ name: "archon", command: "archon", output: "Archon CLI v0.5.0" }],
  );
});

test("repository verification accepts the locked origin and HEAD", () => {
  const repository = "https://github.com/example/tool.git";
  const fixture = createRepository(repository);

  try {
    const result = verifyDependencyRepository("example", {
      repository,
      commit: fixture.commit,
    }, fixture.directory);

    assert.equal(result.name, "example");
    assert.equal(result.commit, fixture.commit);
    assert.equal(result.repository, repository);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("repository verification rejects a checkout at another commit", () => {
  const repository = "https://github.com/example/tool.git";
  const fixture = createRepository(repository);

  try {
    assert.throws(
      () => verifyDependencyRepository("example", {
        repository,
        commit: "a".repeat(40),
      }, fixture.directory),
      /expected commit/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
