import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISTRIBUTION = join(ROOT, "distribution");
const PERSONAL_PATH = /(?:\/home|\/Users)\/[A-Za-z0-9._-]+\//;

function textFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return textFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

test("distribution contains no personal absolute paths", () => {
  const violations = textFiles(DISTRIBUTION)
    .filter((path) => PERSONAL_PATH.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(ROOT.length + 1));

  assert.deepEqual(violations, []);
});
