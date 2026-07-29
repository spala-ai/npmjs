import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeMcpUrl } from './installer.js';

export const CREDENTIAL_STORE_SCHEMA_VERSION = 1;

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
  const directory = path.dirname(filePath);
  assertNotSymlink(directory, 'Spala credential directory');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  assertNotSymlink(filePath, 'Spala credential store');
  const temporary = path.join(directory, `.mcp-credentials.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
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

export function preflightCredentialStore(env = process.env, workspaceRoot) {
  const { filePath } = readStore(env, workspaceRoot);
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
  const url = normalizeMcpUrl(mcpUrl, '', true);
  const bearer = validateBearer(bearerToken);
  const expiry = validateExpiresAt(expiresAt);
  if (Date.parse(expiry) <= Date.now()) throw new Error('Bootstrap response did not include a valid future credential expiry.');
  const { filePath, store } = readStore(env, workspaceRoot);
  const credential = { mcpUrl: url, bearerToken: bearer, expiresAt: expiry, status: 'active' };
  if (JSON.stringify(store.projects[id]) === JSON.stringify(credential)) {
    return { changed: false, projectId: id, expiresAt: expiry, status: 'active' };
  }
  const next = {
    schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION,
    projects: {
      ...store.projects,
      [id]: credential,
    },
  };
  writeStore(filePath, next);
  return { changed: true, projectId: id, expiresAt: expiry, status: 'active' };
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

export function snapshotCredentialStore(env = process.env, workspaceRoot) {
  const { filePath } = readStore(env, workspaceRoot);
  const existed = fs.existsSync(filePath);
  return {
    filePath,
    existed,
    body: existed ? fs.readFileSync(filePath) : undefined,
    mode: existed ? fs.statSync(filePath).mode & 0o777 : undefined,
  };
}

export function restoreCredentialStore(snapshot) {
  if (!snapshot?.filePath) throw new Error('Credential store rollback requires a snapshot.');
  const directory = path.dirname(snapshot.filePath);
  assertNotSymlink(directory, 'Spala credential directory');
  assertNotSymlink(snapshot.filePath, 'Spala credential store');
  if (!snapshot.existed) {
    if (fs.existsSync(snapshot.filePath)) fs.unlinkSync(snapshot.filePath);
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      if (error && typeof error === 'object' && error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
    }
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.mcp-credentials.rollback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(temporary, snapshot.body, { flag: 'wx', mode: snapshot.mode || 0o600 });
    fs.renameSync(temporary, snapshot.filePath);
    fs.chmodSync(snapshot.filePath, snapshot.mode || 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function restoreProjectCredential(projectId, snapshot, env = process.env, workspaceRoot) {
  const id = validateProjectId(projectId);
  const { filePath, store } = readStore(env, workspaceRoot);
  const projects = { ...store.projects };
  if (snapshot === null) delete projects[id];
  else projects[id] = structuredClone(snapshot);
  writeStore(filePath, { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects });
}

export function removeProjectCredential(projectId, env = process.env, workspaceRoot) {
  const id = validateProjectId(projectId);
  const { filePath, store } = readStore(env, workspaceRoot);
  if (!Object.hasOwn(store.projects, id)) return { changed: false, projectId: id };
  const projects = { ...store.projects };
  delete projects[id];
  writeStore(filePath, { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects });
  return { changed: true, projectId: id };
}
