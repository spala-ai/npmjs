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
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

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
  if (stat.nlink !== 1) throw new Error(`${label} must not have multiple hard links.`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} is owned by another user.`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
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
  if (process.platform !== 'win32') fs.chmodSync(location.directory, 0o700);
  return assertCredentialPath(location, created);
}

function waitForStoreLock(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, Math.min(CREDENTIAL_STORE_LOCK_RETRY_MS, remaining));
  return true;
}

function acquireStoreLock(location) {
  const deadline = Date.now() + CREDENTIAL_STORE_LOCK_TIMEOUT_MS;

  while (true) {
    assertCredentialPath(location);
    assertLockPath(location);
    try {
      const release = lockfile.lockSync(location.filePath, {
        realpath: false,
        retries: 0,
        stale: CREDENTIAL_STORE_STALE_LOCK_MS,
        update: CREDENTIAL_STORE_STALE_LOCK_MS / 2,
      });
      try {
        assertCredentialPath(location);
        assertLockPath(location);
        const lockStat = fs.lstatSync(location.lockPath);
        if (!lockStat.isDirectory()) {
          throw new Error('Spala credential store lock must be a directory.');
        }
        if (typeof process.getuid === 'function' && lockStat.uid !== process.getuid()) {
          throw new Error('Spala credential store lock is owned by another user.');
        }
        if (process.platform !== 'win32') fs.chmodSync(location.lockPath, 0o700);
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
  ensureStoreDirectory(location);
  const release = acquireStoreLock(location);
  try {
    return action();
  } finally {
    release();
  }
}

function readStoreAtLocation(location) {
  const pathState = assertCredentialPath(location);
  if (pathState.firstMissing) {
    return { filePath: location.filePath, location, pathState, store: emptyStore() };
  }

  let descriptor;
  let body;
  try {
    descriptor = fs.openSync(
      location.filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = fs.fstatSync(descriptor);
    assertPrivateRegularFile(before, 'Spala credential store');
    assertCredentialPath(location, pathState);
    body = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    assertPrivateRegularFile(after, 'Spala credential store');
    if (!sameFileVersion(before, after)) {
      throw new Error('Spala credential store changed while it was read.');
    }
    assertCredentialPath(location, pathState);
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

function removeTemporary(temporary) {
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
  }
}

function writeStore(location, store, expectedState) {
  const pathState = ensureStoreDirectory(location, expectedState);
  const temporary = path.join(
    location.directory,
    `.mcp-credentials.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  let descriptor;
  let temporaryState;
  try {
    assertSafePath(temporary, location.homePath, 'Spala credential store temporary path');
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.chmodSync(temporary, 0o600);
    fs.fsyncSync(descriptor);
    const temporaryStat = fs.fstatSync(descriptor);
    assertPrivateRegularFile(temporaryStat, 'Spala credential store temporary file');
    temporaryState = assertSafePath(
      temporary,
      location.homePath,
      'Spala credential store temporary path',
    );
    const namedTemporary = fs.lstatSync(temporary);
    if (temporaryStat.dev !== namedTemporary.dev || temporaryStat.ino !== namedTemporary.ino) {
      throw new Error('Spala credential store temporary file changed before it was written.');
    }
    fs.closeSync(descriptor);
    descriptor = undefined;

    assertCredentialPath(location, pathState);
    assertSafePath(
      temporary,
      location.homePath,
      'Spala credential store temporary path',
      temporaryState,
    );
    fs.renameSync(temporary, location.filePath);
    const writtenState = assertCredentialPath(location);
    const written = fs.lstatSync(location.filePath);
    assertPrivateRegularFile(written, 'Spala credential store');
    return writtenState;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    removeTemporary(temporary);
  }
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
  ensureStoreDirectory(location, pathState);
  const probe = path.join(location.directory, `.write-probe-${process.pid}-${Date.now()}`);
  let descriptor;
  try {
    assertSafePath(probe, location.homePath, 'Spala credential store write probe');
    descriptor = fs.openSync(
      probe,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    assertPrivateRegularFile(fs.fstatSync(descriptor), 'Spala credential store write probe');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    removeTemporary(probe);
  }
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
