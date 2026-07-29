import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { normalizeMcpUrl } from './installer.js';
import { assertSafePath } from './pathSafety.js';

export const CREDENTIAL_STORE_SCHEMA_VERSION = 1;
const CREDENTIAL_STORE_LOCK_TIMEOUT_MS = 5_000;
const CREDENTIAL_STORE_STALE_LOCK_MS = 30_000;
const CREDENTIAL_STORE_LOCK_RETRY_MS = 10;
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
    assertCredentialPath(location, pathState, { allowTargetChange: true });
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

function expectedTargetRevision(pathState, filePath) {
  return pathState.components.find(component => component.path === filePath);
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
    sha256: createHash('sha256').update(content).digest('hex'),
    uid: after.uid.toString(),
  };
}

function revisionMatchesExpected(revision, expected) {
  // Moving the target into the guard changes ctime, so compare stable metadata and content.
  return identitiesMatch(revision.identity, expected)
    && revision.nlink.toString() === expected.nlink
    && revision.size.toString() === expected.size
    && revision.mtimeNs.toString() === expected.mtimeNs
    && revision.mode === expected.mode
    && revision.uid === expected.uid
    && revision.gid === expected.gid
    && revision.sha256 === expected.sha256;
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

function guardExpectedTarget(location, pathState, guard) {
  const targetName = path.basename(location.filePath);
  const expected = expectedTargetRevision(pathState, location.filePath);
  if (!expected) {
    if (lstatOrUndefined(targetName)) throw changedError('Spala credential store');
    guard.existed = false;
    return guard;
  }

  guard.existed = true;
  if (lstatOrUndefined(guard.name)) {
    throw changedError('Spala credential store recovery file');
  }

  fs.renameSync(targetName, guard.name);
  guard.isolated = true;

  const guarded = lstatOrUndefined(guard.name);
  if (!guarded) throw changedError('Spala credential store recovery file');
  guard.identity = identity(guarded);
  if (guarded.isSymbolicLink()) {
    throw new Error('Spala credential store path must not contain symbolic links.');
  }

  const descriptor = fs.openSync(guard.name, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const revision = readDescriptorRevision(
      descriptor,
      'Spala credential store recovery file',
      { requireSingleLink: false },
    );
    guard.identity = revision.identity;
    guard.revision = revision;
    if (
      !statMatchesRevision(lstatOrUndefined(guard.name), revision)
      || !revisionMatchesExpected(revision, expected)
    ) {
      throw changedError('Spala credential store');
    }
    return guard;
  } finally {
    fs.closeSync(descriptor);
  }
}

function restoreGuardedTarget(targetName, guard) {
  if (!guard?.isolated || !guard.revision) return false;

  const guarded = lstatOrUndefined(guard.name);
  if (!guarded || !statMatchesRevision(guarded, guard.revision)) {
    throw changedError('Spala credential store recovery file');
  }

  try {
    fs.copyFileSync(guard.name, targetName, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') return false;
    throw error;
  }

  let descriptor;
  try {
    descriptor = fs.openSync(targetName, fs.constants.O_RDONLY | NOFOLLOW);
    const restored = readDescriptorRevision(descriptor, 'Spala credential store');
    if (
      !restored.content.equals(guard.revision.content)
      || restored.mode !== guard.revision.mode
    ) {
      throw changedError('Spala credential store');
    }
    fs.fsyncSync(descriptor);
    if (!statMatchesRevision(lstatOrUndefined(targetName), restored)) {
      throw changedError('Spala credential store');
    }
    return true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeStore(location, store, expectedState) {
  const pathState = assertCredentialPath(location, expectedState);
  const temporaryName = `.mcp-credentials.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const temporary = path.join(location.directory, temporaryName);
  const guardName = `.mcp-credentials.restore-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const guardPath = path.join(location.directory, guardName);
  const targetName = path.basename(location.filePath);
  const content = `${JSON.stringify(store, null, 2)}\n`;
  const contentBuffer = Buffer.from(content, 'utf8');

  return withAnchoredStoreDirectory(location, pathState, directoryIdentity => {
    let descriptor;
    let targetGuard;
    let temporaryIdentity;
    let publishedIdentity;
    try {
      assertSafePath(temporary, location.homePath, 'Spala credential store temporary path');
      assertSafePath(guardPath, location.homePath, 'Spala credential store recovery path');
      verifyAnchoredDirectory(location, directoryIdentity);
      descriptor = fs.openSync(
        temporaryName,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
        0o600,
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      assertPrivateRegularFile(opened, 'Spala credential store temporary file');
      temporaryIdentity = identity(opened);
      verifyAnchoredDirectory(location, directoryIdentity);
      assertCredentialPath(location, pathState);
      fs.chmodSync(temporaryName, 0o600);
      const modeChecked = lstatOrUndefined(temporaryName);
      if (
        !modeChecked
        || modeChecked.isSymbolicLink()
        || !identitiesMatch(identity(modeChecked), temporaryIdentity)
      ) {
        throw changedError('Spala credential store temporary file');
      }
      assertPrivateRegularFile(modeChecked, 'Spala credential store temporary file');
      verifyAnchoredDirectory(location, directoryIdentity);
      assertCredentialPath(location, pathState);

      fs.writeFileSync(descriptor, content, 'utf8');
      if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
      const temporaryStat = fs.fstatSync(descriptor, { bigint: true });
      assertPrivateRegularFile(temporaryStat, 'Spala credential store temporary file');
      if (!identitiesMatch(identity(temporaryStat), temporaryIdentity)) {
        throw changedError('Spala credential store temporary file');
      }
      const namedTemporary = lstatOrUndefined(temporaryName);
      if (
        !namedTemporary
        || namedTemporary.isSymbolicLink()
        || !identitiesMatch(identity(namedTemporary), temporaryIdentity)
      ) {
        throw changedError('Spala credential store temporary file');
      }
      verifyAnchoredDirectory(location, directoryIdentity);
      assertCredentialPath(location, pathState);

      fs.closeSync(descriptor);
      descriptor = undefined;
      assertCredentialPath(location, pathState);
      verifyAnchoredDirectory(location, directoryIdentity);
      targetGuard = {
        existed: false,
        identity: undefined,
        isolated: false,
        name: guardName,
        revision: undefined,
      };
      guardExpectedTarget(location, pathState, targetGuard);
      assertCredentialPath(location, pathState, { allowTargetChange: true });
      verifyAnchoredDirectory(location, directoryIdentity);
      try {
        fs.copyFileSync(temporaryName, targetName, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'EEXIST') {
          throw changedError('Spala credential store');
        }
        throw error;
      }

      descriptor = fs.openSync(targetName, fs.constants.O_RDONLY | NOFOLLOW);
      const published = readDescriptorRevision(descriptor, 'Spala credential store');
      if (!published.content.equals(contentBuffer) || published.mode !== 0o600) {
        throw changedError('Spala credential store');
      }
      publishedIdentity = published.identity;
      fs.fsyncSync(descriptor);
      if (!statMatchesRevision(lstatOrUndefined(targetName), published)) {
        throw changedError('Spala credential store');
      }
      fs.closeSync(descriptor);
      descriptor = undefined;

      verifyAnchoredDirectory(location, directoryIdentity);
      const writtenState = assertCredentialPath(
        location,
        pathState,
        { allowTargetChange: true },
      );
      verifyAnchoredDirectory(location, directoryIdentity);
      const written = expectedTargetRevision(writtenState, location.filePath);
      if (
        !written
        || !identitiesMatch(written, published.identity)
        || written.sha256 !== published.sha256
      ) {
        throw changedError('Spala credential store');
      }
      removeOwnedEntry(
        temporaryName,
        temporaryIdentity,
        'Spala credential store temporary file',
      );
      temporaryIdentity = undefined;
      if (targetGuard.isolated) {
        removeOwnedEntry(
          targetGuard.name,
          targetGuard.identity,
          'Spala credential store recovery file',
        );
        targetGuard.isolated = false;
      }
      return writtenState;
    } catch (error) {
      let rollbackError;
      if (publishedIdentity) {
        try {
          removeOwnedEntry(
            targetName,
            publishedIdentity,
            'Spala credential store',
            { ignoreMismatch: true },
          );
        } catch (cleanupError) {
          rollbackError = cleanupError;
        }
      }
      if (targetGuard?.isolated) {
        try {
          restoreGuardedTarget(targetName, targetGuard);
        } catch (restoreError) {
          rollbackError ||= restoreError;
        }
      }
      if (rollbackError) {
        const publicationError = new Error(
          'Spala credential store publication failed and the prior revision could not be restored.',
          { cause: rollbackError },
        );
        publicationError.changed = true;
        throw publicationError;
      }
      throw error;
    } finally {
      let cleanupError;
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch (error) {
          cleanupError = error;
        }
      }
      if (temporaryIdentity) {
        try {
          removeOwnedEntry(
            temporaryName,
            temporaryIdentity,
            'Spala credential store temporary file',
          );
        } catch (error) {
          cleanupError ||= error;
        }
      }
      if (targetGuard?.isolated) {
        try {
          removeOwnedEntry(
            targetGuard.name,
            targetGuard.identity,
            'Spala credential store recovery file',
          );
        } catch (error) {
          cleanupError ||= error;
        }
      }
      if (cleanupError) throw cleanupError;
    }
  });
}

function updateStore(env, workspaceRoot, update) {
  const location = credentialStoreLocation(env, workspaceRoot);
  return withStoreLock(location, () => {
    const { pathState, store } = readStoreAtLocation(location);
    const result = update(store);
    if (result.changed) writeStore(location, result.store, pathState);
    return result.value;
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
