import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { normalizeMcpUrl } from './installer.js';
import { assertSafePath } from './pathSafety.js';

export const CREDENTIAL_STORE_SCHEMA_VERSION = 1;
const CREDENTIAL_STORE_LOCK_TIMEOUT_MS = 5_000;
const CREDENTIAL_STORE_STALE_LOCK_MS = 30_000;
const CREDENTIAL_STORE_LOCK_RETRY_MS = 10;
const CREDENTIAL_STORE_PUBLICATION_ATTEMPTS = 8;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY || 0)
  | NOFOLLOW;

function homeDir(env) {
  return env.SPALA_MCP_CREDENTIAL_HOME || env.HOME || env.USERPROFILE || os.homedir();
}

function credentialStoreLocation(env = process.env, workspaceRoot) {
  const homePath = path.resolve(homeDir(env));
  const filePath = path.join(homePath, '.config', 'spala', 'mcp-credentials.json');
  if (workspaceRoot) {
    const workspace = path.resolve(workspaceRoot);
    const relative = path.relative(workspace, filePath);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Spala credential storage must be outside the project workspace. Configure a user home outside this repository.');
    }
  }
  return {
    homePath,
    directory: path.dirname(filePath),
    filePath,
    lockPath: `${filePath}.lock`,
  };
}

export function credentialStorePath(env = process.env, workspaceRoot) {
  return credentialStoreLocation(env, workspaceRoot).filePath;
}

function validateProjectId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\0\r\n/\\]/.test(value)) {
    throw new Error('projectId must be a non-empty identifier without path separators.');
  }
  return value.trim();
}

function validateBearer(value) {
  if (typeof value !== 'string' || !value || value.length > 16 * 1024 || /[\0\r\n]/.test(value)) {
    throw new Error('Bootstrap response did not include a valid MCP bearer.');
  }
  return value;
}

function emptyStore() {
  return { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects: {} };
}

function assertPrivateRegularFile(stat, label) {
  if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
  if (stat.nlink !== (typeof stat.nlink === 'bigint' ? 1n : 1)) {
    throw new Error(`${label} must not have multiple hard links.`);
  }
  if (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()) {
    throw new Error(`${label} is owned by another user.`);
  }
  if (process.platform !== 'win32' && (Number(stat.mode) & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users.`);
  }
}

function sameFileVersion(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameBigintFileVersion(left, right) {
  return identitiesMatch(identity(left), identity(right))
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function pathKind(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'other';
}

function identity(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    kind: pathKind(stat),
  };
}

function identitiesMatch(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.kind === right.kind;
}

function changedError(label) {
  return new Error(`${label} changed after it was inspected; refusing to continue.`);
}

function lstatOrUndefined(filePath) {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function chdirToDescriptor(descriptor, fallbackPath, expectedIdentity, label) {
  if (identitiesMatch(identity(fs.statSync('.', { bigint: true })), expectedIdentity)) return;

  const descriptorPath = process.platform === 'win32' ? undefined : `/dev/fd/${descriptor}`;
  if (descriptorPath) {
    try {
      process.chdir(descriptorPath);
      if (!identitiesMatch(identity(fs.statSync('.', { bigint: true })), expectedIdentity)) {
        throw changedError(label);
      }
      return;
    } catch (error) {
      const unsupported = error
        && typeof error === 'object'
        && ['ENOENT', 'ENOTDIR', 'EACCES', 'EINVAL'].includes(error.code);
      if (!unsupported) throw error;
    }
  }

  const named = lstatOrUndefined(fallbackPath);
  if (
    !named
    || named.isSymbolicLink()
    || !named.isDirectory()
    || !identitiesMatch(identity(named), expectedIdentity)
  ) {
    throw changedError(label);
  }
  process.chdir(fallbackPath);
  if (!identitiesMatch(identity(fs.statSync('.', { bigint: true })), expectedIdentity)) {
    throw changedError(label);
  }
}

function expectedDirectoryIdentity(location, pathState) {
  return pathState.components.find(component => (
    component.path === location.directory && component.kind === 'directory'
  ));
}

function verifyAnchoredDirectory(location, directoryIdentity) {
  if (!identitiesMatch(identity(fs.statSync('.', { bigint: true })), directoryIdentity)) {
    throw changedError('Spala credential directory');
  }
  const named = lstatOrUndefined(location.directory);
  if (
    !named
    || named.isSymbolicLink()
    || !named.isDirectory()
    || !identitiesMatch(identity(named), directoryIdentity)
  ) {
    throw changedError('Spala credential directory');
  }
}

function withAnchoredStoreDirectory(location, pathState, action) {
  const expectedIdentity = expectedDirectoryIdentity(location, pathState);
  if (!expectedIdentity) throw changedError('Spala credential directory');

  const previousPath = process.cwd();
  const previousDescriptor = fs.openSync('.', DIRECTORY_FLAGS);
  const previousIdentity = identity(fs.fstatSync(previousDescriptor, { bigint: true }));
  let directoryDescriptor;
  let changedDirectory = false;
  let restorationError;
  try {
    directoryDescriptor = fs.openSync(location.directory, DIRECTORY_FLAGS);
    const directoryStat = fs.fstatSync(directoryDescriptor, { bigint: true });
    const directoryIdentity = identity(directoryStat);
    if (
      !directoryStat.isDirectory()
      || !identitiesMatch(directoryIdentity, expectedIdentity)
    ) {
      throw changedError('Spala credential directory');
    }
    chdirToDescriptor(
      directoryDescriptor,
      location.directory,
      directoryIdentity,
      'Spala credential directory',
    );
    changedDirectory = true;
    verifyAnchoredDirectory(location, directoryIdentity);
    return action(directoryIdentity);
  } catch (error) {
    if (error && typeof error === 'object' && ['ELOOP', 'EMLINK'].includes(error.code)) {
      throw new Error('Spala credential store path must not contain symbolic links.');
    }
    throw error;
  } finally {
    if (changedDirectory) {
      try {
        chdirToDescriptor(
          previousDescriptor,
          previousPath,
          previousIdentity,
          'Installer working directory',
        );
      } catch (error) {
        restorationError = error;
      }
    }
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
    fs.closeSync(previousDescriptor);
    if (restorationError) throw restorationError;
  }
}

function assertCredentialPath(location, expectedState, options) {
  return assertSafePath(
    location.filePath,
    location.homePath,
    'Spala credential store path',
    expectedState,
    options,
  );
}

function assertLockPath(location) {
  return assertSafePath(
    location.lockPath,
    location.homePath,
    'Spala credential store lock path',
  );
}

function ensureStoreDirectory(location, expectedState) {
  const before = expectedState || assertCredentialPath(location);
  fs.mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  const created = assertCredentialPath(location, before, { allowMissingChange: true });
  const directoryStat = fs.lstatSync(location.directory);
  if (!directoryStat.isDirectory()) {
    throw new Error('Spala credential directory must be a directory.');
  }
  if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
    throw new Error('Spala credential directory is owned by another user.');
  }
  if (process.platform !== 'win32') {
    const expectedDirectory = expectedDirectoryIdentity(location, created);
    const descriptor = fs.openSync(location.directory, DIRECTORY_FLAGS);
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!identitiesMatch(identity(opened), expectedDirectory)) {
        throw changedError('Spala credential directory');
      }
      fs.fchmodSync(descriptor, 0o700);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return assertCredentialPath(location, created);
}

function waitForStoreLock(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, Math.min(CREDENTIAL_STORE_LOCK_RETRY_MS, remaining));
  return true;
}

function acquireStoreLock(location, pathState, directoryIdentity) {
  const deadline = Date.now() + CREDENTIAL_STORE_LOCK_TIMEOUT_MS;

  while (true) {
    verifyAnchoredDirectory(location, directoryIdentity);
    assertLockPath(location);
    try {
      const release = lockfile.lockSync(location.filePath, {
        lockfilePath: path.basename(location.lockPath),
        realpath: false,
        retries: 0,
        stale: CREDENTIAL_STORE_STALE_LOCK_MS,
        update: CREDENTIAL_STORE_STALE_LOCK_MS / 2,
      });
      try {
        verifyAnchoredDirectory(location, directoryIdentity);
        assertCredentialPath(location, pathState, { allowTargetChange: true });
        assertLockPath(location);
        const lockStat = fs.lstatSync(path.basename(location.lockPath));
        if (!lockStat.isDirectory()) {
          throw new Error('Spala credential store lock must be a directory.');
        }
        if (typeof process.getuid === 'function' && lockStat.uid !== process.getuid()) {
          throw new Error('Spala credential store lock is owned by another user.');
        }
        if (process.platform !== 'win32') {
          fs.chmodSync(path.basename(location.lockPath), 0o700);
        }
        assertLockPath(location);
      } catch (error) {
        release();
        throw error;
      }
      return release;
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ELOCKED') throw error;
      if (!waitForStoreLock(deadline)) {
        throw new Error('Timed out waiting for another Spala credential update to finish.');
      }
    }
  }
}

function withStoreLock(location, action) {
  const pathState = ensureStoreDirectory(location);
  return withAnchoredStoreDirectory(location, pathState, directoryIdentity => {
    const release = acquireStoreLock(location, pathState, directoryIdentity);
    try {
      const result = action();
      verifyAnchoredDirectory(location, directoryIdentity);
      return result;
    } finally {
      release();
    }
  });
}

function readStoreAtLocation(location) {
  const pathState = assertCredentialPath(location);
  if (pathState.firstMissing) {
    return { filePath: location.filePath, location, pathState, store: emptyStore() };
  }

  let descriptor;
  let body;
  try {
    withAnchoredStoreDirectory(location, pathState, directoryIdentity => {
      descriptor = fs.openSync(path.basename(location.filePath), fs.constants.O_RDONLY | NOFOLLOW);
      const before = fs.fstatSync(descriptor, { bigint: true });
      assertPrivateRegularFile(before, 'Spala credential store');
      const expectedFile = pathState.components.find(component => component.path === location.filePath);
      if (!identitiesMatch(identity(before), expectedFile)) {
        throw changedError('Spala credential store');
      }
      verifyAnchoredDirectory(location, directoryIdentity);
      assertCredentialPath(location, pathState);
      body = fs.readFileSync(descriptor, 'utf8');
      const after = fs.fstatSync(descriptor, { bigint: true });
      assertPrivateRegularFile(after, 'Spala credential store');
      if (!sameFileVersion(before, after)) {
        throw new Error('Spala credential store changed while it was read.');
      }
      const named = lstatOrUndefined(path.basename(location.filePath));
      if (
        !named
        || named.isSymbolicLink()
        || !identitiesMatch(identity(named), identity(after))
      ) {
        throw changedError('Spala credential store');
      }
      verifyAnchoredDirectory(location, directoryIdentity);
      assertCredentialPath(location, pathState);
    });
  } catch (error) {
    if (error && typeof error === 'object' && ['ELOOP', 'EMLINK'].includes(error.code)) {
      throw new Error('Spala credential store path must not contain symbolic links.');
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Spala credential store is invalid JSON.');
  }
  if (!parsed || parsed.schemaVersion !== CREDENTIAL_STORE_SCHEMA_VERSION || !parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) {
    throw new Error('Spala credential store has an unsupported format.');
  }
  return { filePath: location.filePath, location, pathState, store: parsed };
}

function readStore(env, workspaceRoot) {
  return readStoreAtLocation(credentialStoreLocation(env, workspaceRoot));
}

function removeOwnedEntry(name, expectedIdentity, label, { ignoreMismatch = false } = {}) {
  if (!expectedIdentity) return;
  const stat = lstatOrUndefined(name);
  if (!stat) return;
  if (
    stat.isSymbolicLink()
    || !identitiesMatch(identity(stat), expectedIdentity)
  ) {
    if (ignoreMismatch) return;
    throw changedError(label);
  }
  fs.unlinkSync(name);
}

function readAll(descriptor) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, position);
    if (!count) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
    position += count;
  }
  return Buffer.concat(chunks);
}

function readDescriptorRevision(descriptor, label, { requireSingleLink = true } = {}) {
  const before = fs.fstatSync(descriptor, { bigint: true });
  if (!before.isFile()) throw new Error(`${label} must be a regular file.`);
  if (requireSingleLink && before.nlink !== 1n) {
    throw new Error(`${label} must not have multiple hard links.`);
  }
  if (typeof process.getuid === 'function' && Number(before.uid) !== process.getuid()) {
    throw new Error(`${label} is owned by another user.`);
  }
  if (process.platform !== 'win32' && (Number(before.mode) & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users.`);
  }
  const content = readAll(descriptor);
  const after = fs.fstatSync(descriptor, { bigint: true });
  if (
    !after.isFile()
    || (requireSingleLink && after.nlink !== 1n)
    || !sameBigintFileVersion(before, after)
  ) {
    throw changedError(label);
  }
  return {
    content,
    gid: after.gid.toString(),
    identity: identity(after),
    mode: Number(after.mode) & 0o777,
    nlink: after.nlink,
    size: after.size,
    mtimeNs: after.mtimeNs,
    ctimeNs: after.ctimeNs,
    uid: after.uid.toString(),
  };
}

function statMatchesRevision(stat, revision) {
  return Boolean(stat)
    && !stat.isSymbolicLink()
    && identitiesMatch(identity(stat), revision.identity)
    && stat.nlink === revision.nlink
    && stat.size === revision.size
    && stat.mtimeNs === revision.mtimeNs
    && stat.ctimeNs === revision.ctimeNs
    && (Number(stat.mode) & 0o777) === revision.mode
    && stat.uid.toString() === revision.uid
    && stat.gid.toString() === revision.gid;
}

function parseStoreRevision(content, label) {
  let store;
  try {
    store = JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error(`${label} is invalid JSON.`);
  }
  if (
    !store
    || store.schemaVersion !== CREDENTIAL_STORE_SCHEMA_VERSION
    || !store.projects
    || typeof store.projects !== 'object'
    || Array.isArray(store.projects)
  ) {
    throw new Error(`${label} has an unsupported format.`);
  }
  return store;
}

function readNamedStoreRevision(name, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(name, fs.constants.O_RDONLY | NOFOLLOW);
    const revision = readDescriptorRevision(descriptor, label);
    if (!statMatchesRevision(lstatOrUndefined(name), revision)) {
      throw changedError(label);
    }
    return { ...revision, store: parseStoreRevision(revision.content, label) };
  } catch (error) {
    if (error && typeof error === 'object' && ['ELOOP', 'EMLINK'].includes(error.code)) {
      throw new Error('Spala credential store path must not contain symbolic links.');
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readNamedStoreRevisionOrUndefined(name, label) {
  try {
    return readNamedStoreRevision(name, label);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function mergeStoreProjects(current, observed) {
  return {
    schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION,
    projects: { ...current.projects, ...observed.projects },
  };
}

function storeContent(store) {
  return Buffer.from(`${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function writeAll(descriptor, content) {
  let offset = 0;
  while (offset < content.length) {
    const written = fs.writeSync(descriptor, content, offset, content.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error('Spala credential store write did not make progress.');
    }
    offset += written;
  }
}

function prepareStoreRevision(location, store, verifyDirectory) {
  const name = `.mcp-credentials.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const filePath = path.join(location.directory, name);
  const content = storeContent(store);
  let descriptor;
  let ownedIdentity;
  try {
    assertSafePath(filePath, location.homePath, 'Spala credential store temporary path');
    verifyDirectory();
    descriptor = fs.openSync(
      name,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_WRONLY
        | NOFOLLOW,
      process.platform === 'win32' ? 0o600 : 0o000,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertPrivateRegularFile(opened, 'Spala credential store temporary file');
    ownedIdentity = identity(opened);
    if (
      opened.nlink !== 1n
      || (
        process.platform !== 'win32'
        && (Number(opened.mode) & 0o777) !== 0
      )
      || !identitiesMatch(identity(lstatOrUndefined(name)), ownedIdentity)
    ) {
      throw changedError('Spala credential store temporary file');
    }

    writeAll(descriptor, content);
    fs.fsyncSync(descriptor);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.chmodSync(name, 0o600);
    fs.fsyncSync(descriptor);

    const written = fs.fstatSync(descriptor, { bigint: true });
    if (
      !written.isFile()
      || written.nlink !== 1n
      || written.size !== BigInt(content.length)
      || !identitiesMatch(identity(written), ownedIdentity)
      || (process.platform !== 'win32' && (Number(written.mode) & 0o777) !== 0o600)
    ) {
      throw changedError('Spala credential store temporary file');
    }
    const revision = readNamedStoreRevision(
      name,
      'Spala credential store temporary file',
    );
    if (
      !identitiesMatch(revision.identity, ownedIdentity)
      || !revision.content.equals(content)
    ) {
      throw changedError('Spala credential store temporary file');
    }
    verifyDirectory();
    return { content, identity: revision.identity, name };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (cleanupError) {
        if (error && typeof error === 'object') error.cleanupError = cleanupError;
      }
      descriptor = undefined;
    }
    try {
      removeOwnedEntry(
        name,
        ownedIdentity,
        'Spala credential store temporary file',
        { ignoreMismatch: true },
      );
    } catch (cleanupError) {
      if (error && typeof error === 'object') error.cleanupError = cleanupError;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function workingDirectoryMatches(expectedIdentity) {
  return identitiesMatch(identity(fs.statSync('.', { bigint: true })), expectedIdentity);
}

function isolateNamedStore(
  location,
  targetName,
  guards,
  observe,
  verifyDirectory,
) {
  verifyDirectory();
  const before = readNamedStoreRevisionOrUndefined(targetName, 'Spala credential store');
  if (!before) return false;
  observe(before.store);

  const guardName = `.mcp-credentials.restore-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const guardPath = path.join(location.directory, guardName);
  assertSafePath(guardPath, location.homePath, 'Spala credential store recovery path');
  if (lstatOrUndefined(guardName)) {
    throw changedError('Spala credential store recovery file');
  }

  try {
    fs.renameSync(targetName, guardName);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return true;
    throw error;
  }

  const guardedStat = lstatOrUndefined(guardName);
  if (!guardedStat || guardedStat.isSymbolicLink()) {
    throw changedError('Spala credential store recovery file');
  }
  const guard = { active: true, identity: identity(guardedStat), name: guardName };
  guards.push(guard);
  const revision = readNamedStoreRevision(
    guardName,
    'Spala credential store recovery file',
  );
  guard.identity = revision.identity;
  observe(revision.store);
  verifyDirectory();
  return true;
}

function createExclusiveStore(targetName, content, verifyDirectory) {
  let descriptor;
  let ownedIdentity;
  try {
    verifyDirectory();
    try {
      descriptor = fs.openSync(
        targetName,
        fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | fs.constants.O_WRONLY
          | NOFOLLOW,
        process.platform === 'win32' ? 0o600 : 0o000,
      );
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'EEXIST') {
        return { collision: true };
      }
      throw error;
    }

    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertPrivateRegularFile(opened, 'Spala credential store');
    ownedIdentity = identity(opened);
    if (
      opened.nlink !== 1n
      || (
        process.platform !== 'win32'
        && (Number(opened.mode) & 0o777) !== 0
      )
      || !identitiesMatch(identity(lstatOrUndefined(targetName)), ownedIdentity)
    ) {
      throw changedError('Spala credential store');
    }

    writeAll(descriptor, content);
    fs.fsyncSync(descriptor);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);

    const written = fs.fstatSync(descriptor, { bigint: true });
    if (!written.isFile() || !identitiesMatch(identity(written), ownedIdentity)) {
      throw changedError('Spala credential store');
    }
    if (written.nlink === 0n) return { replaced: true };
    if (written.nlink !== 1n) {
      throw new Error('Spala credential store must not have multiple hard links.');
    }
    if (
      written.size !== BigInt(content.length)
      || (process.platform !== 'win32' && (Number(written.mode) & 0o777) !== 0o600)
    ) {
      throw changedError('Spala credential store');
    }

    const named = lstatOrUndefined(targetName);
    if (!named || named.isSymbolicLink() || !identitiesMatch(identity(named), ownedIdentity)) {
      return { replaced: true };
    }
    if (named.nlink !== 1n) {
      throw new Error('Spala credential store must not have multiple hard links.');
    }

    const revision = readNamedStoreRevision(targetName, 'Spala credential store');
    if (
      !identitiesMatch(revision.identity, ownedIdentity)
      || !revision.content.equals(content)
      || revision.mode !== 0o600
    ) {
      throw changedError('Spala credential store');
    }
    verifyDirectory();
    return { collision: false, content, revision };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (cleanupError) {
        if (error && typeof error === 'object') error.cleanupError = cleanupError;
      }
      descriptor = undefined;
    }
    try {
      removeOwnedEntry(
        targetName,
        ownedIdentity,
        'Spala credential store',
        { ignoreMismatch: true },
      );
    } catch (cleanupError) {
      if (error && typeof error === 'object') error.cleanupError = cleanupError;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function cleanupGuards(guards) {
  for (const guard of guards) {
    if (!guard.active) continue;
    removeOwnedEntry(
      guard.name,
      guard.identity,
      'Spala credential store recovery file',
    );
    guard.active = false;
  }
}

function recoverObservedStore(
  location,
  targetName,
  initialStore,
  guards,
  directoryIdentity,
) {
  let observed = initialStore;
  const observe = store => {
    observed = mergeStoreProjects(observed, store);
  };
  const verifyDirectory = () => {
    if (!workingDirectoryMatches(directoryIdentity)) {
      throw changedError('Spala credential directory');
    }
  };

  for (let attempt = 0; attempt < CREDENTIAL_STORE_PUBLICATION_ATTEMPTS; attempt += 1) {
    const current = readNamedStoreRevisionOrUndefined(targetName, 'Spala credential store');
    const content = storeContent(observed);
    if (current?.content.equals(content)) {
      cleanupGuards(guards);
      const final = readNamedStoreRevisionOrUndefined(targetName, 'Spala credential store');
      return Boolean(final?.content.equals(content));
    }
    if (current) {
      isolateNamedStore(location, targetName, guards, observe, verifyDirectory);
    }

    const published = createExclusiveStore(
      targetName,
      storeContent(observed),
      verifyDirectory,
    );
    if (published.collision || published.replaced) continue;
    cleanupGuards(guards);
    const final = readNamedStoreRevisionOrUndefined(targetName, 'Spala credential store');
    if (final?.content.equals(published.content)) return true;
    if (final) observe(final.store);
  }
  return false;
}

function writeStore(location, baseStore, expectedState, update, initialResult) {
  const pathState = assertCredentialPath(location, expectedState);
  const targetName = path.basename(location.filePath);

  return withAnchoredStoreDirectory(location, pathState, directoryIdentity => {
    let observed = baseStore;
    let ownedCanonical;
    const guards = [];
    const observe = store => {
      observed = mergeStoreProjects(observed, store);
    };
    const verifyDirectory = () => {
      verifyAnchoredDirectory(location, directoryIdentity);
      assertCredentialPath(location, pathState, { allowTargetChange: true });
    };

    try {
      for (let attempt = 0; attempt < CREDENTIAL_STORE_PUBLICATION_ATTEMPTS; attempt += 1) {
        verifyDirectory();
        let candidate;
        let candidateResult;

        if (ownedCanonical) {
          const current = readNamedStoreRevisionOrUndefined(
            targetName,
            'Spala credential store',
          );
          if (
            current
            && identitiesMatch(current.identity, ownedCanonical.identity)
            && current.content.equals(ownedCanonical.content)
          ) {
            candidate = ownedCanonical.content;
          } else {
            if (current) observe(current.store);
            ownedCanonical = undefined;
          }
        }

        if (!ownedCanonical) {
          isolateNamedStore(location, targetName, guards, observe, verifyDirectory);
          candidateResult = update(observed);
          const prepared = prepareStoreRevision(
            location,
            candidateResult.store,
            verifyDirectory,
          );
          let published;
          try {
            published = createExclusiveStore(
              targetName,
              prepared.content,
              verifyDirectory,
            );
            if (!published.collision && !published.replaced) {
              ownedCanonical = {
                content: published.content,
                identity: published.revision.identity,
              };
            }
          } finally {
            removeOwnedEntry(
              prepared.name,
              prepared.identity,
              'Spala credential store temporary file',
            );
          }
          if (published.collision || published.replaced) continue;
          candidate = published.content;
        }

        cleanupGuards(guards);
        verifyDirectory();
        const final = readNamedStoreRevisionOrUndefined(
          targetName,
          'Spala credential store',
        );
        if (
          final
          && identitiesMatch(final.identity, ownedCanonical.identity)
          && final.content.equals(candidate)
          && !update(final.store).changed
        ) {
          return initialResult.value;
        }
        if (final) observe(final.store);
        ownedCanonical = undefined;
      }

      throw new Error('Spala credential store changed too many times during publication.');
    } catch (error) {
      let recovered = false;
      try {
        if (ownedCanonical) {
          removeOwnedEntry(
            targetName,
            ownedCanonical.identity,
            'Spala credential store',
            { ignoreMismatch: true },
          );
        }
        recovered = recoverObservedStore(
          location,
          targetName,
          observed,
          guards,
          directoryIdentity,
        );
      } catch (recoveryError) {
        if (error && typeof error === 'object') error.recoveryError = recoveryError;
      }
      if (!recovered && error && typeof error === 'object') error.changed = true;
      throw error;
    }
  });
}

function updateStore(env, workspaceRoot, update) {
  const location = credentialStoreLocation(env, workspaceRoot);
  return withStoreLock(location, () => {
    const { pathState, store } = readStoreAtLocation(location);
    const result = update(store);
    if (!result.changed) return result.value;
    return writeStore(location, store, pathState, update, result);
  });
}

function validateExpiresAt(value) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) {
    throw new Error('Bootstrap response did not include a valid credential expiry.');
  }
  return new Date(parsed).toISOString();
}

function credentialStatus(credential) {
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new Error('The stored agentic MCP credential is invalid. Bind the project again with a fresh bootstrap capability.');
  }
  const expiresAt = validateExpiresAt(credential.expiresAt);
  if (credential.status !== undefined && credential.status !== 'active' && credential.status !== 'expired') {
    throw new Error('The stored agentic MCP credential has an invalid status. Bind the project again with a fresh bootstrap capability.');
  }
  return { expiresAt, status: Date.parse(expiresAt) <= Date.now() ? 'expired' : (credential.status || 'active') };
}

export function preflightCredentialStore(env = process.env, workspaceRoot) {
  const { location, pathState } = readStore(env, workspaceRoot);
  const createdState = ensureStoreDirectory(location, pathState);
  const probeName = `.write-probe-${process.pid}-${Date.now()}`;
  const probe = path.join(location.directory, probeName);
  withAnchoredStoreDirectory(location, createdState, directoryIdentity => {
    let descriptor;
    let probeIdentity;
    try {
      assertSafePath(probe, location.homePath, 'Spala credential store write probe');
      verifyAnchoredDirectory(location, directoryIdentity);
      descriptor = fs.openSync(
        probeName,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
        0o600,
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      probeIdentity = identity(opened);
      if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
      assertPrivateRegularFile(
        fs.fstatSync(descriptor, { bigint: true }),
        'Spala credential store write probe',
      );
      verifyAnchoredDirectory(location, directoryIdentity);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      removeOwnedEntry(probeName, probeIdentity, 'Spala credential store write probe');
    }
  });
  return { filePath: location.filePath };
}

export function storeProjectCredential({ projectId, mcpUrl, bearerToken, expiresAt }, env = process.env, workspaceRoot) {
  const id = validateProjectId(projectId);
  const url = normalizeMcpUrl(mcpUrl, '', true);
  const bearer = validateBearer(bearerToken);
  const expiry = validateExpiresAt(expiresAt);
  if (Date.parse(expiry) <= Date.now()) throw new Error('Bootstrap response did not include a valid future credential expiry.');
  const credential = { mcpUrl: url, bearerToken: bearer, expiresAt: expiry, status: 'active' };
  return updateStore(env, workspaceRoot, store => {
    const changed = JSON.stringify(store.projects[id]) !== JSON.stringify(credential);
    return {
      changed,
      store: changed
        ? {
          schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION,
          projects: { ...store.projects, [id]: credential },
        }
        : store,
      value: { changed, projectId: id, expiresAt: expiry, status: 'active' },
    };
  });
}

export function readProjectCredential(projectId, env = process.env, workspaceRoot) {
  const id = validateProjectId(projectId);
  const { store } = readStore(env, workspaceRoot);
  if (!Object.hasOwn(store.projects, id)) throw new Error('No agentic MCP credential is stored for this project. Bind the project again with a fresh bootstrap capability.');
  const credential = store.projects[id];
  const { expiresAt, status } = credentialStatus(credential);
  if (status === 'expired') throw new Error('The stored agentic MCP credential has expired. Bind the project again with a fresh bootstrap capability.');
  return {
    projectId: id,
    mcpUrl: normalizeMcpUrl(credential.mcpUrl, '', true),
    bearerToken: validateBearer(credential.bearerToken),
    expiresAt,
    status,
  };
}

export function projectCredentialStatus(projectId, env = process.env, workspaceRoot) {
  const id = validateProjectId(projectId);
  const { store } = readStore(env, workspaceRoot);
  if (!Object.hasOwn(store.projects, id)) return { configured: false, status: 'missing', expiresAt: null };
  const { expiresAt, status } = credentialStatus(store.projects[id]);
  return { configured: status === 'active', status, expiresAt };
}

export function hasProjectCredential(projectId, env = process.env, workspaceRoot) {
  try {
    readProjectCredential(projectId, env, workspaceRoot);
    return true;
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('No agentic MCP credential') || error.message.includes('has expired'))) return false;
    throw error;
  }
}

export function snapshotProjectCredential(projectId, env = process.env, workspaceRoot) {
  const id = validateProjectId(projectId);
  const { store } = readStore(env, workspaceRoot);
  return Object.hasOwn(store.projects, id) ? structuredClone(store.projects[id]) : null;
}

export function removeProjectCredential(projectId, env = process.env, workspaceRoot) {
  const id = validateProjectId(projectId);
  return updateStore(env, workspaceRoot, store => {
    if (!Object.hasOwn(store.projects, id)) {
      return { changed: false, store, value: { changed: false, projectId: id } };
    }
    const projects = { ...store.projects };
    delete projects[id];
    return {
      changed: true,
      store: { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects },
      value: { changed: true, projectId: id },
    };
  });
}
