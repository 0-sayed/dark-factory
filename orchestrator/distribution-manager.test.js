import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  hashTree,
  installAssets,
  verifyInstalledAssets,
  verifySourceAssets,
} from "../scripts/manage-distribution.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dark-factory-packaging-"));
  const source = join(root, "distribution", "skills");
  const repositoryAsset = join(root, "ao-plugins");
  const home = join(root, "home");
  mkdirSync(source, { recursive: true });
  mkdirSync(repositoryAsset, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "portable skill\n");
  writeFileSync(join(source, "z-conflict.txt"), "portable conflict target\n");
  writeFileSync(join(repositoryAsset, "index.js"), "export default {};\n");

  const manifestPath = join(root, "distribution", "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    manifestVersion: 1,
    assets: [
      {
        name: "skills",
        source: "distribution/skills",
        mode: "install",
        target: ".agents/skills",
        sha256: hashTree(source),
      },
      {
        name: "ao-plugins",
        source: "ao-plugins",
        mode: "repository",
        sha256: hashTree(repositoryAsset),
      },
    ],
  }, null, 2)}\n`);

  return { root, home, manifestPath };
}

test("checked-in distribution manifest covers valid source snapshots", () => {
  const results = verifySourceAssets();
  assert.deepEqual(
    results.map((result) => result.name),
    ["archon-workflows", "archon-scripts", "agent-skills", "operator-skill", "ao-plugins"],
  );
});

test("install copies portable assets and keeps AO plugins repository-local", () => {
  const testFixture = fixture();

  try {
    const installed = installAssets({
      root: testFixture.root,
      manifestPath: testFixture.manifestPath,
      home: testFixture.home,
    });

    assert.deepEqual(installed.map((result) => result.name), ["skills"]);
    assert.equal(
      readFileSync(join(testFixture.home, ".agents", "skills", "SKILL.md"), "utf8"),
      "portable skill\n",
    );
    assert.throws(
      () => readFileSync(join(testFixture.home, "ao-plugins", "index.js"), "utf8"),
      /ENOENT/,
    );
    assert.equal(verifyInstalledAssets({
      root: testFixture.root,
      manifestPath: testFixture.manifestPath,
      home: testFixture.home,
    }).length, 1);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test("install refuses conflicting files unless overwrite is explicit", () => {
  const testFixture = fixture();
  const target = join(testFixture.home, ".agents", "skills", "z-conflict.txt");
  mkdirSync(join(testFixture.home, ".agents", "skills"), { recursive: true });
  writeFileSync(target, "local change\n");

  try {
    assert.throws(
      () => installAssets({
        root: testFixture.root,
        manifestPath: testFixture.manifestPath,
        home: testFixture.home,
      }),
      /refusing to overwrite/i,
    );
    assert.equal(readFileSync(target, "utf8"), "local change\n");
    assert.throws(
      () => readFileSync(join(testFixture.home, ".agents", "skills", "SKILL.md"), "utf8"),
      /ENOENT/,
    );

    installAssets({
      root: testFixture.root,
      manifestPath: testFixture.manifestPath,
      home: testFixture.home,
      overwrite: true,
    });
    assert.equal(readFileSync(target, "utf8"), "portable conflict target\n");
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test("doctor detects drift in an installed snapshot", () => {
  const testFixture = fixture();

  try {
    installAssets({
      root: testFixture.root,
      manifestPath: testFixture.manifestPath,
      home: testFixture.home,
    });
    writeFileSync(join(testFixture.home, ".agents", "skills", "SKILL.md"), "drifted\n");

    assert.throws(
      () => verifyInstalledAssets({
        root: testFixture.root,
        manifestPath: testFixture.manifestPath,
        home: testFixture.home,
      }),
      /installed file differs/i,
    );
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});
