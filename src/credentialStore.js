import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { normalizeMcpUrl } from './installer.js';
import { assertSafePath } from './pathSafety.js';

export const CREDENTIAL_STORE_SCHEMA_VERSION = 1;
const CREDENTIAL_STORE_LOCK_TIMEOUT_MS = 5_000;
const CREDENTIAL_STORE_STALE_LOCK_MS = 30_000;
const CREDENTIAL_STORE_LOCK_RETRY_MS = 10;
const CREDENTIAL_STORE_PUBLICATION_ATTEMPTS = 8;
const CREDENTIAL_RECOVERY_SCHEMA_VERSION = 3;
const TRANSACTIONAL_CREDENTIAL_RECOVERY_SCHEMA_VERSION = 2;
const LEGACY_CREDENTIAL_RECOVERY_SCHEMA_VERSION = 1;
const RESTORE_GUARD_PREFIX = '.mcp-credentials.restore-';
const RESTORE_GUARD_PATTERN = /^\.mcp-credentials\.restore-([a-f0-9]{32})-([1-9]\d*)$/;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY || 0)
  | NOFOLLOW;
const CREDENTIAL_PUBLICATION_REVISION = Symbol('credentialPublicationRevision');
const credentialRollbackStates = new WeakMap();
const PROJECT_CLAIM_PREFIX = '__spala_project_claim__:';

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
    recoveryPath: `${filePath}.recovery`,
  };
}

export function credentialStorePath(env = process.env, workspaceRoot) {
  return credentialStoreLocation(env, workspaceRoot).filePath;
}

function validateProjectId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\0\r\n/\\]/.test(value)) {
    throw new Error('projectId must be a non-empty identifier without path separators.');
  }
  const projectId = value.trim();
  if (projectId.startsWith(PROJECT_CLAIM_PREFIX)) {
    throw new Error('projectId uses a reserved installer namespace.');
  }
  return projectId;
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
  let before;
  try {
    before = expectedState || assertCredentialPath(location);
  } catch (error) {
    const target = lstatOrUndefined(location.filePath);
    const lock = lstatOrUndefined(location.lockPath);
    const staleLockedPartial = error
      && typeof error === 'object'
      && error.code === 'EACCES'
      && target
      && target.isFile()
      && target.nlink === 1n
      && (Number(target.mode) & 0o777) === 0
      && lock
      && lock.isDirectory()
      && Number(lock.mtimeMs) <= Date.now() - CREDENTIAL_STORE_STALE_LOCK_MS;
    if (!staleLockedPartial) throw error;

    assertPrivateRegularFile(target, 'Spala credential store');
    const recovery = readRecoveryRevision(location);
    if (!recovery) throw error;
    const targetIdentity = identity(target);
    fs.chmodSync(location.filePath, 0o600);
    const readable = lstatOrUndefined(location.filePath);
    if (
      !readable
      || !identitiesMatch(identity(readable), targetIdentity)
      || (Number(readable.mode) & 0o777) !== 0o600
    ) {
      throw changedError('Spala credential store');
    }
    before = assertCredentialPath(location);
  }
  fs.mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  const created = assertCredentialPath(location, before, { allowMissingChange: true });
  const directoryStat = fs.lstatSync(location.directory);
  if (!directoryStat.isDirectory()) {
    throw new Error('Spala credential directory must be a directory.');
  }
  if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
    const credentialStat = lstatOrUndefined(location.filePath);
    if (credentialStat && Number(credentialStat.uid) !== process.getuid()) {
      throw new Error('Spala credential store is owned by another user.');
    }
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
  const location = credentialStoreLocation(env, workspaceRoot);
  return withStoreLock(location, () => readRecoveredStoreAtLocation(location));
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

function revisionsMatch(left, right) {
  return Boolean(left && right)
    && identitiesMatch(left.identity, right.identity)
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.content.equals(right.content);
}

function attachPublicationRevision(value, revision) {
  if (value && typeof value === 'object') {
    Object.defineProperty(value, CREDENTIAL_PUBLICATION_REVISION, {
      configurable: false,
      enumerable: false,
      value: revision,
      writable: false,
    });
  }
  return value;
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

function readNamedRevision(name, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(name, fs.constants.O_RDONLY | NOFOLLOW);
    const revision = readDescriptorRevision(descriptor, label);
    if (!statMatchesRevision(lstatOrUndefined(name), revision)) {
      throw changedError(label);
    }
    return revision;
  } catch (error) {
    if (error && typeof error === 'object' && ['ELOOP', 'EMLINK'].includes(error.code)) {
      throw new Error('Spala credential store path must not contain symbolic links.');
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readNamedRevisionOrUndefined(name, label) {
  try {
    return readNamedRevision(name, label);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function readNamedStoreRevision(name, label) {
  const revision = readNamedRevision(name, label);
  return { ...revision, store: parseStoreRevision(revision.content, label) };
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

function changedProjectIds(current, updated) {
  const projectIds = new Set([
    ...Object.keys(current.projects),
    ...Object.keys(updated.projects),
  ]);
  return [...projectIds]
    .filter(projectId => (
      JSON.stringify(current.projects[projectId])
      !== JSON.stringify(updated.projects[projectId])
    ))
    .sort();
}

function recoveryMetadata(recovery) {
  return {
    authoritativeProjectIds: recovery?.authoritativeProjectIds || [],
    projectGenerations: recovery?.projectGenerations || {},
    transactionId: recovery?.transactionId,
  };
}

function createRecoveryTransaction(recovery, current, updated) {
  const transactionId = randomBytes(16).toString('hex');
  const changed = changedProjectIds(current, updated);
  const projectGenerations = new Map(
    Object.entries(recovery?.projectGenerations || {}),
  );
  for (const projectId of changed) projectGenerations.set(projectId, transactionId);
  return {
    authoritativeProjectIds: [...new Set([
      ...(recovery?.authoritativeProjectIds || []),
      ...changed,
    ])].sort(),
    projectGenerations: Object.fromEntries(
      [...projectGenerations.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
    transactionId,
  };
}

function mergeRecoveryStore(recovery, observed) {
  const authoritative = new Set(recovery.authoritativeProjectIds);
  const projects = { ...recovery.store.projects };
  for (const [projectId, credential] of Object.entries(observed.projects)) {
    if (authoritative.has(projectId)) continue;
    projects[projectId] = credential;
  }
  return {
    schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION,
    projects,
  };
}

function mergeStoreWithAuthority(recovery, observed) {
  const merged = mergeStoreProjects(recovery.store, observed);
  for (const projectId of recovery.authoritativeProjectIds) {
    if (Object.hasOwn(recovery.store.projects, projectId)) {
      merged.projects[projectId] = recovery.store.projects[projectId];
    } else {
      delete merged.projects[projectId];
    }
  }
  return merged;
}

function storeContent(store) {
  return Buffer.from(`${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function recoveryChecksum(store, metadata) {
  const content = metadata?.transactionId
    ? Buffer.from(JSON.stringify({
      authoritativeProjectIds: metadata.authoritativeProjectIds,
      ...(metadata.projectGenerations === undefined
        ? {}
        : { projectGenerations: metadata.projectGenerations }),
      store,
      transactionId: metadata.transactionId,
    }), 'utf8')
    : storeContent(store);
  return createHash('sha256').update(content).digest('hex');
}

function recoveryContent(store, metadata) {
  if (!metadata?.transactionId) {
    return Buffer.from(`${JSON.stringify({
      schemaVersion: LEGACY_CREDENTIAL_RECOVERY_SCHEMA_VERSION,
      store,
      checksum: recoveryChecksum(store),
    }, null, 2)}\n`, 'utf8');
  }
  return Buffer.from(`${JSON.stringify({
    schemaVersion: CREDENTIAL_RECOVERY_SCHEMA_VERSION,
    transactionId: metadata.transactionId,
    authoritativeProjectIds: metadata.authoritativeProjectIds,
    projectGenerations: metadata.projectGenerations || {},
    store,
    checksum: recoveryChecksum(store, metadata),
  }, null, 2)}\n`, 'utf8');
}

function parseRecoveryRevision(content) {
  let recovery;
  try {
    recovery = JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error('Spala credential recovery state is invalid or incomplete.');
  }
  const keys = recovery && typeof recovery === 'object' && !Array.isArray(recovery)
    ? Object.keys(recovery).sort()
    : [];
  const legacy = recovery?.schemaVersion === LEGACY_CREDENTIAL_RECOVERY_SCHEMA_VERSION;
  const transactional = recovery?.schemaVersion
    === TRANSACTIONAL_CREDENTIAL_RECOVERY_SCHEMA_VERSION;
  const current = recovery?.schemaVersion === CREDENTIAL_RECOVERY_SCHEMA_VERSION;
  const expectedKeys = legacy
    ? 'checksum,schemaVersion,store'
    : current
      ? 'authoritativeProjectIds,checksum,projectGenerations,schemaVersion,store,transactionId'
      : 'authoritativeProjectIds,checksum,schemaVersion,store,transactionId';
  const generationEntries = current
    && recovery.projectGenerations
    && typeof recovery.projectGenerations === 'object'
    && !Array.isArray(recovery.projectGenerations)
    ? Object.entries(recovery.projectGenerations)
    : [];
  if (
    (!legacy && !transactional && !current)
    || keys.join(',') !== expectedKeys
    || typeof recovery.checksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(recovery.checksum)
    || (
      (transactional || current)
      && (
        typeof recovery.transactionId !== 'string'
        || !/^[a-f0-9]{32}$/.test(recovery.transactionId)
        || !Array.isArray(recovery.authoritativeProjectIds)
        || recovery.authoritativeProjectIds.some(projectId => (
          typeof projectId !== 'string'
          || !projectId
          || projectId.trim() !== projectId
          || projectId.length > 200
          || /[\0\r\n/\\]/.test(projectId)
        ))
        || [...new Set(recovery.authoritativeProjectIds)].sort()
          .join('\0') !== recovery.authoritativeProjectIds.join('\0')
      )
    )
    || (
      current
      && (
        !recovery.projectGenerations
        || typeof recovery.projectGenerations !== 'object'
        || Array.isArray(recovery.projectGenerations)
        || generationEntries.some(([projectId, generation]) => (
          typeof projectId !== 'string'
          || !projectId
          || projectId.trim() !== projectId
          || projectId.length > 200
          || /[\0\r\n/\\]/.test(projectId)
          || !recovery.authoritativeProjectIds.includes(projectId)
          || typeof generation !== 'string'
          || !/^[a-f0-9]{32}$/.test(generation)
        ))
      )
    )
  ) {
    throw new Error('Spala credential recovery state has an unsupported format.');
  }
  const store = parseStoreRevision(
    Buffer.from(JSON.stringify(recovery.store), 'utf8'),
    'Spala credential recovery state',
  );
  const metadata = transactional || current
    ? {
      authoritativeProjectIds: recovery.authoritativeProjectIds,
      ...(current ? { projectGenerations: recovery.projectGenerations } : {}),
      transactionId: recovery.transactionId,
    }
    : undefined;
  if (recoveryChecksum(store, metadata) !== recovery.checksum) {
    throw new Error('Spala credential recovery state failed integrity validation.');
  }
  return {
    authoritativeProjectIds: metadata?.authoritativeProjectIds || [],
    checksum: recovery.checksum,
    projectGenerations: metadata?.projectGenerations || {},
    store,
    transactionId: metadata?.transactionId,
  };
}

function assertRecoveryPath(location, filePath = location.recoveryPath) {
  return assertSafePath(
    filePath,
    location.homePath,
    'Spala credential recovery path',
  );
}

function readRecoveryRevision(location) {
  assertRecoveryPath(location);
  const revision = readNamedRevisionOrUndefined(
    location.recoveryPath,
    'Spala credential recovery state',
  );
  if (!revision) return undefined;
  const recovery = parseRecoveryRevision(revision.content);
  return { ...revision, ...recovery };
}

function fsyncCurrentDirectory() {
  let descriptor;
  try {
    descriptor = fs.openSync('.', DIRECTORY_FLAGS);
    fs.fsyncSync(descriptor);
  } catch (error) {
    const unsupported = error
      && typeof error === 'object'
      && ['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code);
    if (!unsupported) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function publishRecoveryStore(location, store, verifyDirectory, metadata) {
  const existing = readRecoveryRevision(location);
  const content = recoveryContent(store, metadata);
  if (existing?.content.equals(content)) return existing;

  const recoveryName = path.basename(location.recoveryPath);
  const temporaryName = `${recoveryName}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const temporaryPath = path.join(location.directory, temporaryName);
  let descriptor;
  let temporaryIdentity;
  try {
    assertRecoveryPath(location, temporaryPath);
    verifyDirectory();
    descriptor = fs.openSync(
      temporaryName,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_WRONLY
        | NOFOLLOW,
      process.platform === 'win32' ? 0o600 : 0o000,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertPrivateRegularFile(opened, 'Spala credential recovery temporary file');
    temporaryIdentity = identity(opened);
    if (!identitiesMatch(identity(lstatOrUndefined(temporaryName)), temporaryIdentity)) {
      throw changedError('Spala credential recovery temporary file');
    }
    writeAll(descriptor, content);
    fs.fsyncSync(descriptor);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.chmodSync(temporaryName, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    const prepared = readNamedRevision(
      temporaryName,
      'Spala credential recovery temporary file',
    );
    if (
      !identitiesMatch(prepared.identity, temporaryIdentity)
      || !prepared.content.equals(content)
    ) {
      throw changedError('Spala credential recovery temporary file');
    }

    verifyDirectory();
    const current = readNamedRevisionOrUndefined(
      recoveryName,
      'Spala credential recovery state',
    );
    if (
      (existing && !revisionsMatch(current, existing))
      || (!existing && current)
    ) {
      throw changedError('Spala credential recovery state');
    }
    fs.renameSync(temporaryName, recoveryName);
    temporaryIdentity = undefined;
    fsyncCurrentDirectory();
    verifyDirectory();

    const published = readRecoveryRevision(location);
    if (!published?.content.equals(content)) {
      throw changedError('Spala credential recovery state');
    }
    return published;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    removeOwnedEntry(
      temporaryName,
      temporaryIdentity,
      'Spala credential recovery temporary file',
      { ignoreMismatch: true },
    );
  }
}

function removeRecoveryRevisionIfCurrent(location, revision) {
  if (!revision) return false;
  const recoveryName = path.basename(location.recoveryPath);
  const current = lstatOrUndefined(recoveryName);
  if (!current) return true;
  if (!statMatchesRevision(current, revision)) return false;
  fs.unlinkSync(recoveryName);
  fsyncCurrentDirectory();
  return true;
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
  transactionId,
  sequenceOffset = 0,
) {
  verifyDirectory();
  const before = readNamedStoreRevisionOrUndefined(targetName, 'Spala credential store');
  if (!before) return false;
  observe(before.store);

  if (!transactionId) {
    throw new Error('Spala credential recovery transaction is invalid or incomplete.');
  }
  const guardName = `${RESTORE_GUARD_PREFIX}${transactionId}-${sequenceOffset + guards.length + 1}`;
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
  let removed = false;
  for (const guard of guards) {
    if (!guard.active) continue;
    removeOwnedEntry(
      guard.name,
      guard.identity,
      'Spala credential store recovery file',
    );
    guard.active = false;
    removed = true;
  }
  if (removed) fsyncCurrentDirectory();
}

function discoverRestoreGuards(location, recovery, verifyDirectory) {
  verifyDirectory();
  const names = fs.readdirSync('.')
    .filter(name => name.startsWith(RESTORE_GUARD_PREFIX));
  if (!names.length) return [];
  if (!recovery?.transactionId) {
    throw new Error('Spala credential store recovery files are ambiguous.');
  }

  const guards = names.map(name => {
    const match = RESTORE_GUARD_PATTERN.exec(name);
    if (!match || match[1] !== recovery.transactionId) {
      throw new Error('Spala credential store recovery file is malformed or ambiguous.');
    }
    return {
      active: true,
      name,
      sequence: Number(match[2]),
    };
  }).sort((left, right) => left.sequence - right.sequence);

  for (let index = 0; index < guards.length; index += 1) {
    if (!Number.isSafeInteger(guards[index].sequence)) {
      throw new Error('Spala credential store recovery files are ambiguous.');
    }
    const revision = readNamedStoreRevision(
      guards[index].name,
      'Spala credential store recovery file',
    );
    guards[index] = {
      ...guards[index],
      identity: revision.identity,
      revision,
      store: revision.store,
    };
  }
  verifyDirectory();
  return guards;
}

function recoverObservedStore(
  location,
  targetName,
  initialStore,
  guards,
  directoryIdentity,
  transactionId,
  guardSequenceOffset = 0,
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
      isolateNamedStore(
        location,
        targetName,
        guards,
        observe,
        verifyDirectory,
        transactionId,
        guardSequenceOffset,
      );
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

function writeStore(
  location,
  baseStore,
  expectedState,
  update,
  initialResult,
  beforeCandidate,
  transactionId,
  guardSequenceOffset = 0,
) {
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
          isolateNamedStore(
            location,
            targetName,
            guards,
            observe,
            verifyDirectory,
            transactionId,
            guardSequenceOffset,
          );
          candidateResult = update(observed);
          beforeCandidate?.(candidateResult.store, verifyDirectory);
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
          return attachPublicationRevision(initialResult.value, {
            ...final,
            transactionId,
          });
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
          transactionId,
          guardSequenceOffset,
        );
      } catch (recoveryError) {
        if (error && typeof error === 'object') error.recoveryError = recoveryError;
      }
      if (!recovered && error && typeof error === 'object') error.changed = true;
      throw error;
    }
  });
}

function readRecoveredStoreAtLocation(location) {
  const directoryIdentity = identity(fs.statSync('.', { bigint: true }));
  const verifyDirectory = () => {
    verifyAnchoredDirectory(location, directoryIdentity);
    assertCredentialPath(location, undefined, { allowTargetChange: true });
    assertRecoveryPath(location);
  };
  const recovery = readRecoveryRevision(location);
  const restoreGuards = discoverRestoreGuards(location, recovery, verifyDirectory);
  let canonical;
  let invalidCanonical;
  try {
    canonical = readStoreAtLocation(location);
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message === 'Spala credential store is invalid JSON.'
        || error.message === 'Spala credential store has an unsupported format.'
      )
    ) {
      invalidCanonical = error;
    } else {
      throw error;
    }
  }

  if (!recovery) {
    if (invalidCanonical) throw invalidCanonical;
    return {
      ...canonical,
      recovery: undefined,
    };
  }

  const targetName = path.basename(location.filePath);
  const rawCanonical = readNamedRevisionOrUndefined(targetName, 'Spala credential store');
  let mergedStore = recovery.store;
  for (const guard of restoreGuards) {
    mergedStore = mergeRecoveryStore(
      { ...recovery, store: mergedStore },
      guard.store,
    );
  }
  if (canonical) {
    mergedStore = mergeRecoveryStore(
      { ...recovery, store: mergedStore },
      canonical.store,
    );
  }
  const metadata = recovery.transactionId
    ? recoveryMetadata(recovery)
    : {
      authoritativeProjectIds: recovery.authoritativeProjectIds,
      projectGenerations: recovery.projectGenerations,
      transactionId: randomBytes(16).toString('hex'),
    };
  let durableRecovery = publishRecoveryStore(
    location,
    mergedStore,
    verifyDirectory,
    metadata,
  );
  const canonicalMatches = canonical
    && rawCanonical
    && rawCanonical.content.equals(storeContent(mergedStore));
  if (canonicalMatches) {
    cleanupGuards(restoreGuards);
    return {
      ...canonical,
      store: mergedStore,
      recovery: durableRecovery,
    };
  }

  if (invalidCanonical && rawCanonical) {
    removeOwnedEntry(
      targetName,
      rawCanonical.identity,
      'Spala credential store',
    );
  }
  const pathState = assertCredentialPath(location);
  const baseStore = canonical?.store || emptyStore();
  const repair = observed => {
    const repaired = mergeStoreWithAuthority(
      { ...recovery, store: mergedStore },
      observed,
    );
    const changed = !storeContent(repaired).equals(storeContent(observed));
    return {
      changed,
      store: repaired,
      value: { changed },
    };
  };
  const initialResult = repair(baseStore);
  if (initialResult.changed || !rawCanonical) {
    writeStore(
      location,
      baseStore,
      pathState,
      repair,
      initialResult,
      candidateStore => {
        durableRecovery = publishRecoveryStore(
          location,
          candidateStore,
          verifyDirectory,
          metadata,
        );
      },
      metadata.transactionId,
      restoreGuards.at(-1)?.sequence || 0,
    );
  }

  const repairedCanonical = readStoreAtLocation(location);
  const finalStore = mergeRecoveryStore(
    durableRecovery,
    repairedCanonical.store,
  );
  durableRecovery = publishRecoveryStore(
    location,
    finalStore,
    verifyDirectory,
    metadata,
  );
  cleanupGuards(restoreGuards);
  return {
    ...repairedCanonical,
    store: finalStore,
    recovery: durableRecovery,
  };
}

function updateStore(env, workspaceRoot, update) {
  const location = credentialStoreLocation(env, workspaceRoot);
  return withStoreLock(location, () => {
    const { pathState, recovery, store } = readRecoveredStoreAtLocation(location);
    const result = update(store);
    if (!result.changed) return result.value;
    const transaction = createRecoveryTransaction(recovery, store, result.store);
    const directoryIdentity = identity(fs.statSync('.', { bigint: true }));
    const verifyDirectory = () => {
      verifyAnchoredDirectory(location, directoryIdentity);
      assertCredentialPath(location, undefined, { allowTargetChange: true });
      assertRecoveryPath(location);
    };
    let durableRecovery = publishRecoveryStore(
      location,
      result.store,
      verifyDirectory,
      transaction,
    );
    try {
      const value = writeStore(
        location,
        store,
        pathState,
        update,
        result,
        candidateStore => {
          durableRecovery = publishRecoveryStore(
            location,
            candidateStore,
            verifyDirectory,
            transaction,
          );
        },
        transaction.transactionId,
      );
      const finalCanonical = readStoreAtLocation(location);
      const finalStore = mergeStoreWithAuthority(
        durableRecovery,
        finalCanonical.store,
      );
      publishRecoveryStore(location, finalStore, verifyDirectory, transaction);
      return value;
    } catch (error) {
      try {
        publishRecoveryStore(location, store, verifyDirectory, transaction);
      } catch (recoveryError) {
        let removed = false;
        try {
          removed = removeRecoveryRevisionIfCurrent(location, durableRecovery);
        } catch {
          removed = false;
        }
        if (!removed && error && typeof error === 'object') {
          error.recoveryError = recoveryError;
          error.changed = true;
        }
      }
      throw error;
    }
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
  let previousCredential;
  let capturedPrevious = false;
  const result = updateStore(env, workspaceRoot, store => {
    if (!capturedPrevious) {
      previousCredential = Object.hasOwn(store.projects, id)
        ? structuredClone(store.projects[id])
        : null;
      capturedPrevious = true;
    }
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
  const publicationRevision = result[CREDENTIAL_PUBLICATION_REVISION];
  if (!result.changed || !publicationRevision) return result;

  const revision = Object.freeze({ projectId: id });
  credentialRollbackStates.set(revision, {
    credential: structuredClone(credential),
    generation: publicationRevision.transactionId,
    previousCredential,
  });
  return { ...result, revision };
}

export function storeProjectCredentialAndRetire(
  { projectId, mcpUrl, bearerToken, expiresAt, previousProjectId },
  env = process.env,
  workspaceRoot,
) {
  const id = validateProjectId(projectId);
  const previousId = previousProjectId === undefined || previousProjectId === null
    ? undefined
    : validateProjectId(previousProjectId);
  if (!previousId || previousId === id) {
    return storeProjectCredential({ projectId: id, mcpUrl, bearerToken, expiresAt }, env, workspaceRoot);
  }

  const url = normalizeMcpUrl(mcpUrl, '', true);
  const bearer = validateBearer(bearerToken);
  const expiry = validateExpiresAt(expiresAt);
  if (Date.parse(expiry) <= Date.now()) throw new Error('Bootstrap response did not include a valid future credential expiry.');
  const credential = { mcpUrl: url, bearerToken: bearer, expiresAt: expiry, status: 'active' };
  let previousCredentials;
  let capturedPrevious = false;
  const result = updateStore(env, workspaceRoot, store => {
    if (!capturedPrevious) {
      previousCredentials = Object.fromEntries([id, previousId].map(currentId => [
        currentId,
        Object.hasOwn(store.projects, currentId)
          ? structuredClone(store.projects[currentId])
          : null,
      ]));
      capturedPrevious = true;
    }
    const projects = { ...store.projects, [id]: credential };
    delete projects[previousId];
    const changed = JSON.stringify(store.projects[id]) !== JSON.stringify(credential)
      || Object.hasOwn(store.projects, previousId);
    return {
      changed,
      store: changed
        ? { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects }
        : store,
      value: {
        changed,
        projectId: id,
        retiredProjectId: previousId,
        expiresAt: expiry,
        status: 'active',
      },
    };
  });
  const publicationRevision = result[CREDENTIAL_PUBLICATION_REVISION];
  if (!result.changed || !publicationRevision) return result;

  const changedIds = [id, previousId].filter(projectId => (
    JSON.stringify(previousCredentials[projectId])
    !== JSON.stringify(projectId === id ? credential : null)
  ));
  const revision = Object.freeze({ projectId: id, projectIds: Object.freeze(changedIds) });
  credentialRollbackStates.set(revision, {
    expectedCredentials: Object.fromEntries(changedIds.map(projectId => [
      projectId,
      projectId === id ? structuredClone(credential) : null,
    ])),
    generation: publicationRevision.transactionId,
    previousCredentials: Object.fromEntries(changedIds.map(projectId => [
      projectId,
      previousCredentials[projectId],
    ])),
  });
  return { ...result, revision };
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

export function rollbackProjectCredentialIfRevision(revision, env = process.env, workspaceRoot) {
  const rollback = credentialRollbackStates.get(revision);
  if (!rollback || revision.projectId === undefined) {
    throw new Error('Credential rollback requires a valid publication revision.');
  }
  const id = validateProjectId(revision.projectId);
  const projectIds = Array.isArray(revision.projectIds)
    ? revision.projectIds.map(validateProjectId)
    : [id];
  const expectedCredentials = rollback.expectedCredentials || { [id]: rollback.credential };
  const previousCredentials = rollback.previousCredentials || { [id]: rollback.previousCredential };
  const rollbackResult = ({ changed, restoredProjectIds = [], supersededProjectIds = [] }) => ({
    changed,
    projectId: id,
    ...(projectIds.length > 1 ? { restoredProjectIds } : {}),
    superseded: supersededProjectIds.length > 0,
    ...(projectIds.length > 1 ? { supersededProjectIds } : {}),
  });
  const credentialMatches = (store, projectId, expected) => {
    const observed = Object.hasOwn(store.projects, projectId) ? store.projects[projectId] : null;
    return JSON.stringify(observed) === JSON.stringify(expected);
  };
  const location = credentialStoreLocation(env, workspaceRoot);
  return withStoreLock(location, () => {
    const { pathState, recovery, store } = readRecoveredStoreAtLocation(location);
    const restorableProjectIds = projectIds.filter(projectId => {
      const currentGeneration = recovery
        && Object.hasOwn(recovery.projectGenerations, projectId)
        ? recovery.projectGenerations[projectId]
        : undefined;
      return currentGeneration === rollback.generation
        && credentialMatches(store, projectId, expectedCredentials[projectId]);
    });
    const supersededProjectIds = projectIds.filter(projectId => !restorableProjectIds.includes(projectId));
    if (restorableProjectIds.length === 0) {
      credentialRollbackStates.delete(revision);
      return rollbackResult({ changed: false, supersededProjectIds });
    }

    const update = observed => {
      const projects = { ...observed.projects };
      const restoredProjectIds = [];
      const nowSupersededProjectIds = [...supersededProjectIds];
      for (const projectId of restorableProjectIds) {
        if (!credentialMatches(observed, projectId, expectedCredentials[projectId])) {
          nowSupersededProjectIds.push(projectId);
          continue;
        }
        if (previousCredentials[projectId] === null) delete projects[projectId];
        else projects[projectId] = structuredClone(previousCredentials[projectId]);
        restoredProjectIds.push(projectId);
      }
      if (restoredProjectIds.length === 0) {
        return {
          changed: false,
          store: observed,
          value: rollbackResult({ changed: false, supersededProjectIds: nowSupersededProjectIds }),
        };
      }
      return {
        changed: true,
        store: { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects },
        value: rollbackResult({ changed: true, restoredProjectIds, supersededProjectIds: nowSupersededProjectIds }),
      };
    };
    const result = update(store);
    if (!result.changed) return result.value;
    const transaction = createRecoveryTransaction(recovery, store, result.store);
    const directoryIdentity = identity(fs.statSync('.', { bigint: true }));
    const verifyDirectory = () => {
      verifyAnchoredDirectory(location, directoryIdentity);
      assertCredentialPath(location, undefined, { allowTargetChange: true });
      assertRecoveryPath(location);
    };
    let durableRecovery = publishRecoveryStore(
      location,
      result.store,
      verifyDirectory,
      transaction,
    );
    credentialRollbackStates.delete(revision);
    const value = writeStore(
      location,
      store,
      pathState,
      update,
      result,
      candidateStore => {
        durableRecovery = publishRecoveryStore(
          location,
          candidateStore,
          verifyDirectory,
          transaction,
        );
      },
      transaction.transactionId,
    );
    const finalCanonical = readStoreAtLocation(location);
    publishRecoveryStore(
      location,
      mergeStoreWithAuthority(durableRecovery, finalCanonical.store),
      verifyDirectory,
      transaction,
    );
    return value;
  });
}

export function removeProjectCredential(projectId, env = process.env, workspaceRoot) {
  const id = validateProjectId(projectId);
  let previousCredential;
  let capturedPrevious = false;
  const result = updateStore(env, workspaceRoot, store => {
    if (!Object.hasOwn(store.projects, id)) {
      return { changed: false, store, value: { changed: false, projectId: id } };
    }
    if (!capturedPrevious) {
      previousCredential = structuredClone(store.projects[id]);
      capturedPrevious = true;
    }
    const projects = { ...store.projects };
    delete projects[id];
    return {
      changed: true,
      store: { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects },
      value: { changed: true, projectId: id },
    };
  });
  const publicationRevision = result[CREDENTIAL_PUBLICATION_REVISION];
  if (!result.changed || !publicationRevision) return result;

  const revision = Object.freeze({ projectId: id });
  credentialRollbackStates.set(revision, {
    expectedCredentials: { [id]: null },
    generation: publicationRevision.transactionId,
    previousCredentials: { [id]: previousCredential },
  });
  return { ...result, revision };
}

function validateClaimRequestId(value) {
  if (typeof value !== 'string' || !/^claim_[A-Za-z0-9_-]{20,80}$/.test(value)) {
    throw new Error('bootstrapRequestId is invalid. Prepare a fresh project authorization.');
  }
  return value;
}

function claimStorageKey(requestId) {
  return `${PROJECT_CLAIM_PREFIX}${validateClaimRequestId(requestId)}`;
}

function isActiveClaim(value, now = Date.now()) {
  return value
    && value.kind === 'project_claim'
    && Number.isFinite(Date.parse(String(value.expiresAt || '')))
    && Date.parse(value.expiresAt) > now;
}

export function createProjectClaimRequest(binding, env = process.env, workspaceRoot) {
  const projectId = validateProjectId(binding.projectId);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const requestId = `claim_${randomBytes(18).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const claim = {
    kind: 'project_claim',
    projectId,
    projectUrl: String(binding.projectUrl),
    mcpUrl: normalizeMcpUrl(binding.mcpUrl, '', true),
    serverName: String(binding.serverName),
    verifier,
    challenge,
    expiresAt,
  };
  return updateStore(env, workspaceRoot, store => {
    const projects = { ...store.projects };
    for (const [key, value] of Object.entries(projects)) {
      if (!key.startsWith(PROJECT_CLAIM_PREFIX)) continue;
      // Versions before the claim protocol allowed project IDs in this
      // namespace. Preserve those credentials; only claim-shaped records are
      // eligible for expiry cleanup.
      if (value?.kind !== 'project_claim') continue;
      if (!isActiveClaim(value)) delete projects[key];
    }
    projects[claimStorageKey(requestId)] = claim;
    const changed = JSON.stringify(projects) !== JSON.stringify(store.projects);
    return {
      changed,
      store: changed ? { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects } : store,
      value: { requestId, challenge, expiresAt },
    };
  });
}

export function readProjectClaimRequest(requestId, binding, env = process.env, workspaceRoot) {
  const id = validateClaimRequestId(requestId);
  const { store } = readStore(env, workspaceRoot);
  const claim = store.projects[claimStorageKey(id)];
  if (!isActiveClaim(claim)) {
    throw new Error('The local project authorization request is missing or expired. Prepare it again.');
  }
  const expected = {
    projectId: validateProjectId(binding.projectId),
    projectUrl: String(binding.projectUrl),
    mcpUrl: normalizeMcpUrl(binding.mcpUrl, '', true),
    serverName: String(binding.serverName),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (claim[key] !== value) throw new Error('The local project authorization request does not match this project binding.');
  }
  if (typeof claim.verifier !== 'string' || claim.verifier.length < 43 || claim.verifier.length > 128) {
    throw new Error('The local project authorization verifier is invalid. Prepare it again.');
  }
  return { requestId: id, verifier: claim.verifier, challenge: claim.challenge, expiresAt: claim.expiresAt };
}

export function removeProjectClaimRequest(requestId, env = process.env, workspaceRoot) {
  const id = validateClaimRequestId(requestId);
  const key = claimStorageKey(id);
  return updateStore(env, workspaceRoot, store => {
    if (!Object.hasOwn(store.projects, key)) {
      return { changed: false, store, value: { changed: false, requestId: id } };
    }
    const projects = { ...store.projects };
    delete projects[key];
    return {
      changed: true,
      store: { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects },
      value: { changed: true, requestId: id },
    };
  });
}
