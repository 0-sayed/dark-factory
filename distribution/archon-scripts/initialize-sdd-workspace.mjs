#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function installedHelperCandidates() {
  const home = homedir();
  const codexHome = process.env.CODEX_HOME || join(home, '.codex');
  const agentsSkills = process.env.AGENTS_SKILLS_DIR || join(home, '.agents', 'skills');
  const candidates = [
    process.env.SUPERPOWERS_SDD_WORKSPACE,
    join(agentsSkills, 'subagent-driven-development', 'scripts', 'sdd-workspace'),
    join(codexHome, 'skills', 'subagent-driven-development', 'scripts', 'sdd-workspace'),
  ];
  const versionsRoot = join(codexHome, 'plugins', 'cache', 'superpowers-dev', 'superpowers');
  if (existsSync(versionsRoot)) {
    const versions = readdirSync(versionsRoot).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    candidates.push(...versions.map((version) => join(
      versionsRoot,
      version,
      'skills',
      'subagent-driven-development',
      'scripts',
      'sdd-workspace',
    )));
  }
  return candidates.filter(Boolean);
}

const helper = installedHelperCandidates().find(existsSync);
if (!helper) {
  throw new Error('Superpowers subagent-driven-development sdd-workspace helper is not installed');
}

const workspace = resolve(execFileSync(helper, { cwd: process.cwd(), encoding: 'utf8' }).trim());
const expected = resolve('.superpowers/sdd');
if (workspace !== expected) {
  throw new Error(`sdd-workspace returned unexpected path: ${workspace}`);
}
if (readFileSync(join(workspace, '.gitignore'), 'utf8') !== '*\n') {
  throw new Error('sdd-workspace did not create the required self-ignore contract');
}

process.stdout.write(workspace);
