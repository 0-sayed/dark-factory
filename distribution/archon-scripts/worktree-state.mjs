import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function ensureSafeParent(root, parent) {
  const rel = relative(root, parent);
  let current = root;

  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) {
      mkdirSync(current);
      continue;
    }

    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked worktree state directory: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Worktree state parent is not a directory: ${current}`);
  }
}

export function resolveWorktreeFile(path, { cwd = process.cwd(), createParent = true } = {}) {
  const root = realpathSync(cwd);
  const destination = resolve(root, path);
  if (!inside(root, destination)) throw new Error(`Refusing worktree state path outside ${root}: ${path}`);

  const parent = dirname(destination);
  if (createParent) {
    ensureSafeParent(root, parent);
  } else if (existsSync(parent)) {
    ensureSafeParent(root, parent);
  }

  if (existsSync(destination)) {
    const stat = lstatSync(destination);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked worktree state file: ${destination}`);
    if (!stat.isFile()) throw new Error(`Worktree state destination is not a regular file: ${destination}`);
  }

  return destination;
}

export function writeWorktreeFile(path, data, { cwd = process.cwd(), mode = 0o600 } = {}) {
  const destination = resolveWorktreeFile(path, { cwd });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    writeFileSync(fd, data, 'utf8');
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, destination);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeWorktreeFileAtomic(path, data, { cwd = process.cwd(), mode = 0o600 } = {}) {
  writeWorktreeFile(path, data, { cwd, mode });
}

export function removeWorktreeFile(path, { cwd = process.cwd() } = {}) {
  const destination = resolveWorktreeFile(path, { cwd, createParent: false });
  if (existsSync(destination)) rmSync(destination);
}

export function ensureWorktreeDirectory(path, { cwd = process.cwd() } = {}) {
  const root = realpathSync(cwd);
  const destination = resolve(root, path);
  if (!inside(root, destination)) throw new Error(`Refusing worktree state directory outside ${root}: ${path}`);
  ensureSafeParent(root, destination);
  return destination;
}
