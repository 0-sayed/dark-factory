import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 100 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function worktreeRevisionFingerprint(cwd = process.cwd()) {
  const hash = createHash('sha256');
  const pathspec = ['--', '.', ':(exclude).archon'];

  hash.update('head\0');
  hash.update(git(cwd, ['rev-parse', 'HEAD']));
  hash.update('\0tracked\0');
  hash.update(git(cwd, ['diff', '--binary', 'HEAD', ...pathspec]));

  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();

  function hashUntrackedPath(relativePath) {
    const path = join(cwd, relativePath);
    const stat = lstatSync(path);
    hash.update('\0untracked\0');
    hash.update(relativePath);
    hash.update('\0');
    if (stat.isSymbolicLink()) {
      hash.update('symlink\0');
      hash.update(readlinkSync(path));
    } else if (stat.isFile()) {
      hash.update('file\0');
      hash.update(readFileSync(path));
    } else if (stat.isDirectory()) {
      hash.update('directory\0');
      for (const name of readdirSync(path).sort()) {
        if (name === '.git') continue;
        hashUntrackedPath(`${relativePath.replace(/\/$/, '')}/${name}`);
      }
    } else {
      hash.update(`other:${stat.mode}:${stat.size}`);
    }
  }

  for (const relativePath of untracked) hashUntrackedPath(relativePath);

  return `sha256:${hash.digest('hex')}`;
}
