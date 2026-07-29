import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeMcpUrl } from './installer.js';

export const CREDENTIAL_STORE_SCHEMA_VERSION = 1;
const CREDENTIAL_STORE_LOCK_TIMEOUT_MS = 5_000;
const CREDENTIAL_STORE_STALE_LOCK_MS = 30_000;
const CREDENTIAL_STORE_LOCK_RETRY_MS = 10;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function homeDir(env) {
  return env.SPALA_MCP_CREDENTIAL_HOME || env.HOME || env.USERPROFILE || os.homedir();
}

export function credentialStorePath(env = process.env, workspaceRoot) {
  const filePath = path.resolve(path.join(homeDir(env), '.config', 'spala', 'mcp-credentials.json'));
  if (workspaceRoot) {
    const workspace = path.resolve(workspaceRoot);
    const relative = path.relative(workspace, filePath);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Spala credential storage must be outside the project workspace. Configure a user home outside this repository.');
    }
  }
  return filePath;
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

function assertNotSymlink(filePath, label) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
}

function emptyStore() {
  return { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects: {} };
}

function ensureStoreDirectory(filePath) {
  const directory = path.dirname(filePath);
  assertNotSymlink(directory, 'Spala credential directory');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && error.code === 'EPERM');
  }
}

function removeStaleStoreLock(lockPath) {
  let stat;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return true;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Spala credential store lock must be a regular file.');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Spala credential store lock is owned by another user.');
  }
  if (Date.now() - stat.mtimeMs < CREDENTIAL_STORE_STALE_LOCK_MS) return false;

  let record;
  try {
    record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    record = null;
  }
  if (processIsRunning(Number(record?.pid))) return false;

  const current = fs.lstatSync(lockPath);
  if (!sameIdentity(stat, current)) return false;
  fs.unlinkSync(lockPath);
  return true;
}

function withStoreLock(filePath, action) {
  const directory = ensureStoreDirectory(filePath);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + CREDENTIAL_STORE_LOCK_TIMEOUT_MS;
  let lockStat;

  while (!lockStat) {
    assertNotSymlink(lockPath, 'Spala credential store lock');
    let fd;
    try {
      fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      fs.fsyncSync(fd);
      lockStat = fs.fstatSync(fd);
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
      if (removeStaleStoreLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for another Spala credential update to finish.');
      }
      Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, CREDENTIAL_STORE_LOCK_RETRY_MS);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  try {
    return action();
  } finally {
    try {
      const current = fs.lstatSync(lockPath);
      if (!sameIdentity(lockStat, current)) {
        throw new Error('Spala credential store lock changed during the update.');
      }
      fs.unlinkSync(lockPath);
      try {
        fs.rmdirSync(directory);
      } catch (error) {
        if (error && typeof error === 'object' && error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
      }
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
    }
  }
}

function readStore(env, workspaceRoot) {
  const filePath = credentialStorePath(env, workspaceRoot);
  if (!fs.existsSync(filePath)) return { filePath, store: emptyStore() };
  assertNotSymlink(path.dirname(filePath), 'Spala credential directory');
  assertNotSymlink(filePath, 'Spala credential store');
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Spala credential store must be a regular file.');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error('Spala credential store is invalid JSON.');
  }
  if (!parsed || parsed.schemaVersion !== CREDENTIAL_STORE_SCHEMA_VERSION || !parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) {
    throw new Error('Spala credential store has an unsupported format.');
  }
  return { filePath, store: parsed };
}

function writeStore(filePath, store) {
  const directory = ensureStoreDirectory(filePath);
  assertNotSymlink(filePath, 'Spala credential store');
  const temporary = path.join(directory, `.mcp-credentials.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
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

function normalizeCredential({ mcpUrl, bearerToken, expiresAt }) {
  const url = normalizeMcpUrl(mcpUrl, '', true);
  const bearer = validateBearer(bearerToken);
  const expiry = validateExpiresAt(expiresAt);
  if (Date.parse(expiry) <= Date.now()) throw new Error('Bootstrap response did not include a valid future credential expiry.');
  return { mcpUrl: url, bearerToken: bearer, expiresAt: expiry, status: 'active' };
}

function credentialsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateStore(env, workspaceRoot, update) {
  const filePath = credentialStorePath(env, workspaceRoot);
  return withStoreLock(filePath, () => {
    const { store } = readStore(env, workspaceRoot);
    const result = update(store);
    if (result.changed) writeStore(filePath, result.store);
    return result.value;
  });
}

export function preflightCredentialStore(env = process.env, workspaceRoot) {
  const filePath = credentialStorePath(env, workspaceRoot);
  const directory = path.dirname(filePath);
  assertNotSymlink(directory, 'Spala credential directory');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  assertNotSymlink(filePath, 'Spala credential store');
  const probe = path.join(directory, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
  } finally {
    if (fs.existsSync(probe)) fs.unlinkSync(probe);
  }
  return { filePath };
}

export function storeProjectCredential({ projectId, mcpUrl, bearerToken, expiresAt }, env = process.env, workspaceRoot) {
  const id = validateProjectId(projectId);
  const credential = normalizeCredential({ mcpUrl, bearerToken, expiresAt });
  return updateStore(env, workspaceRoot, store => {
    const changed = !credentialsEqual(store.projects[id], credential);
    return {
      changed,
      store: changed
        ? {
          schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION,
          projects: { ...store.projects, [id]: credential },
        }
        : store,
      value: { changed, projectId: id, expiresAt: credential.expiresAt, status: 'active' },
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

export function restoreProjectCredentialIfCurrent(projectId, snapshot, expected, env = process.env, workspaceRoot) {
  const id = validateProjectId(projectId);
  const expectedCredential = normalizeCredential(expected);
  return updateStore(env, workspaceRoot, store => {
    const current = Object.hasOwn(store.projects, id) ? store.projects[id] : null;
    if (!credentialsEqual(current, expectedCredential)) {
      return {
        changed: false,
        store,
        value: { restored: false, projectId: id, reason: 'credential-changed' },
      };
    }
    const projects = { ...store.projects };
    if (snapshot === null) delete projects[id];
    else projects[id] = structuredClone(snapshot);
    return {
      changed: !credentialsEqual(current, snapshot),
      store: { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects },
      value: { restored: true, projectId: id },
    };
  });
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
