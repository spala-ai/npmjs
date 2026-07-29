import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeMcpUrl } from './installer.js';

export const CREDENTIAL_STORE_SCHEMA_VERSION = 1;
const JOURNAL_VERSION_PATTERN = /^(0|[1-9]\d*)$/;
const RETIRED_VERSION_MARKER = '{"retired":true}\n';
const RETIRED_VERSION = Symbol('retired credential journal version');

function homeDir(env) {
  return env.SPALA_MCP_CREDENTIAL_HOME || env.HOME || env.USERPROFILE || os.homedir();
}

function canonicalizeExistingAncestor(filePath, symlinkDepth = 0) {
  let candidate = path.resolve(filePath);
  const missing = [];
  while (true) {
    try {
      const resolved = fs.realpathSync.native
        ? fs.realpathSync.native(candidate)
        : fs.realpathSync(candidate);
      return path.resolve(resolved, ...missing);
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
      const stat = statIfPresent(candidate);
      if (stat?.isSymbolicLink()) {
        if (symlinkDepth >= 40) {
          const loopError = new Error('Too many symbolic links while resolving credential storage.');
          loopError.code = 'ELOOP';
          throw loopError;
        }
        const target = fs.readlinkSync(candidate);
        const resolvedTarget = path.resolve(path.dirname(candidate), target);
        return canonicalizeExistingAncestor(path.resolve(resolvedTarget, ...missing), symlinkDepth + 1);
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missing.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function credentialStorePath(env = process.env, workspaceRoot) {
  const filePath = path.resolve(path.join(homeDir(env), '.config', 'spala', 'mcp-credentials.json'));
  if (workspaceRoot) {
    const workspace = path.resolve(workspaceRoot);
    const canonicalWorkspace = canonicalizeExistingAncestor(workspace);
    const canonicalFilePath = canonicalizeExistingAncestor(filePath);
    if (pathIsInside(workspace, filePath) || pathIsInside(canonicalWorkspace, canonicalFilePath)) {
      throw new Error('Spala credential storage must be outside the project workspace. Configure a user home outside this repository.');
    }
  }
  return filePath;
}

function credentialJournalPath(filePath) {
  return `${filePath}.journal`;
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

function statIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertOwnedByCurrentUser(stat, label) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} is owned by another user.`);
  }
}

function assertPrivateFileMode(stat, label) {
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users.`);
  }
}

function assertDirectory(directory, label, { optional = false } = {}) {
  const stat = statIfPresent(directory);
  if (!stat && optional) return undefined;
  if (!stat) throw new Error(`${label} does not exist.`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a directory and not a symbolic link.`);
  }
  assertOwnedByCurrentUser(stat, label);
  return stat;
}

function ensurePrivateDirectory(directory, label) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = assertDirectory(directory, label);
  fs.chmodSync(directory, 0o700);
  return stat;
}

function ensureStoreDirectory(filePath) {
  return ensurePrivateDirectory(path.dirname(filePath), 'Spala credential directory');
}

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return false;
  const fd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
  );
  let syncError;
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    syncError = error;
  }
  try {
    fs.closeSync(fd);
  } catch {
    if (!syncError) return true;
  }
  if (syncError) throw syncError;
  return true;
}

function ensureJournalDirectory(filePath) {
  const journalPath = credentialJournalPath(filePath);
  ensurePrivateDirectory(journalPath, 'Spala credential journal');
  fsyncDirectory(path.dirname(journalPath));
  return journalPath;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function credentialFileStat(filePath, label, { optional = false } = {}) {
  const stat = statIfPresent(filePath);
  if (!stat && optional) return undefined;
  if (!stat) throw new Error(`${label} does not exist.`);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
  assertOwnedByCurrentUser(stat, label);
  assertPrivateFileMode(stat, label);
  return stat;
}

function emptyStore() {
  return { schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, projects: {} };
}

function validateStore(parsed) {
  if (!parsed
    || parsed.schemaVersion !== CREDENTIAL_STORE_SCHEMA_VERSION
    || !parsed.projects
    || typeof parsed.projects !== 'object'
    || Array.isArray(parsed.projects)) {
    throw new Error('Spala credential store has an unsupported format.');
  }
  return parsed;
}

function retryReadError() {
  const error = new Error('Spala credential journal changed during read.');
  error.code = 'ERETRY';
  return error;
}

function isRetiredVersionMarker(parsed) {
  return parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && parsed.retired === true
    && Object.keys(parsed).length === 1;
}

function readStoreFile(filePath, {
  optional = false,
  retryMissing = false,
  allowRetired = false,
} = {}) {
  const before = credentialFileStat(filePath, 'Spala credential store', { optional: optional || retryMissing });
  if (!before) {
    if (retryMissing) throw retryReadError();
    return undefined;
  }

  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (retryMissing && error && typeof error === 'object' && error.code === 'ENOENT') {
      throw retryReadError();
    }
    if (error && typeof error === 'object' && error.code === 'ELOOP') {
      throw new Error('Spala credential store must not be a symbolic link.');
    }
    throw error;
  }

  let body;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error('Spala credential store must be a regular file.');
    assertOwnedByCurrentUser(opened, 'Spala credential store');
    assertPrivateFileMode(opened, 'Spala credential store');
    if (!sameIdentity(before, opened)) throw retryReadError();
    body = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Spala credential store is invalid JSON.');
  }
  if (allowRetired && isRetiredVersionMarker(parsed)) return RETIRED_VERSION;
  return validateStore(parsed);
}

function scanJournalVersions(journalPath) {
  return fs.readdirSync(journalPath)
    .filter(name => JOURNAL_VERSION_PATTERN.test(name))
    .map(name => ({ name, version: BigInt(name) }))
    .sort((left, right) => {
      if (left.version === right.version) return 0;
      return left.version > right.version ? -1 : 1;
    });
}

function inspectCredentialPaths(filePath) {
  const directory = path.dirname(filePath);
  const directoryStat = assertDirectory(directory, 'Spala credential directory', { optional: true });
  if (!directoryStat) {
    return { journalPath: credentialJournalPath(filePath), journalExists: false };
  }

  credentialFileStat(filePath, 'Spala credential store', { optional: true });
  const journalPath = credentialJournalPath(filePath);
  const journalStat = assertDirectory(journalPath, 'Spala credential journal', { optional: true });
  return { journalPath, journalExists: Boolean(journalStat) };
}

function journalHasVersion(filePath) {
  const journalPath = credentialJournalPath(filePath);
  const journalStat = assertDirectory(journalPath, 'Spala credential journal', { optional: true });
  return Boolean(journalStat && scanJournalVersions(journalPath).length > 0);
}

function journalHasHigherVersion(journalPath, version) {
  const highest = scanJournalVersions(journalPath)[0];
  return Boolean(highest && highest.version > version);
}

function readStore(env, workspaceRoot) {
  const filePath = credentialStorePath(env, workspaceRoot);
  while (true) {
    const { journalPath, journalExists } = inspectCredentialPaths(filePath);
    if (journalExists) {
      const versions = scanJournalVersions(journalPath);
      if (versions.length > 0) {
        const selected = versions[0];
        let store;
        try {
          store = readStoreFile(path.join(journalPath, selected.name), {
            retryMissing: true,
            allowRetired: true,
          });
        } catch (error) {
          if (journalHasHigherVersion(journalPath, selected.version)) continue;
          throw error;
        }
        if (journalHasHigherVersion(journalPath, selected.version)) continue;
        if (store === RETIRED_VERSION) {
          throw new Error('Spala credential journal current version is unexpectedly retired.');
        }
        return {
          filePath,
          journalPath,
          source: 'journal',
          version: selected.version,
          store,
        };
      }
    }

    let legacyStore;
    let fallbackError;
    try {
      legacyStore = readStoreFile(filePath, { optional: true });
    } catch (error) {
      fallbackError = error;
    }
    if (journalHasVersion(filePath)) continue;
    if (fallbackError) throw fallbackError;
    return {
      filePath,
      journalPath,
      source: legacyStore ? 'legacy' : 'empty',
      version: 0n,
      store: legacyStore || emptyStore(),
    };
  }
}

function writeStoreTemp(journalPath, store) {
  const temporary = path.join(journalPath, `.tmp-${process.pid}-${randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.writeFileSync(fd, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return temporary;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (!cleanupError || typeof cleanupError !== 'object' || cleanupError.code !== 'ENOENT') {
        error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
}

function unlinkCredentialFile(filePath, label) {
  const stat = credentialFileStat(filePath, label, { optional: true });
  if (!stat) return false;
  fs.unlinkSync(filePath);
  return true;
}

function retireJournalVersion(filePath) {
  const label = 'Spala credential journal version';
  const before = statIfPresent(filePath);
  if (!before) throw retryReadError();
  if (before.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  if (!before.isFile()) throw new Error(`${label} must be a regular file.`);
  assertOwnedByCurrentUser(before, label);

  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ELOOP') {
      throw new Error(`${label} must not be a symbolic link.`);
    }
    throw error;
  }

  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${label} must be a regular file.`);
    assertOwnedByCurrentUser(opened, label);
    if (!sameIdentity(before, opened)) throw retryReadError();
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, RETIRED_VERSION_MARKER, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function cleanupCommittedStore(filePath, journalPath, committedVersion, temporary) {
  const errors = [];
  const cleanup = action => {
    try {
      return action();
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') errors.push(error);
      return undefined;
    }
  };

  if (temporary) cleanup(() => fs.unlinkSync(temporary));
  let versions = [];
  cleanup(() => {
    versions = scanJournalVersions(journalPath);
  });
  for (const version of versions) {
    if (version.version < committedVersion) {
      cleanup(() => retireJournalVersion(path.join(journalPath, version.name)));
    }
  }
  const legacyRemoved = cleanup(() => unlinkCredentialFile(filePath, 'Spala credential store'));
  if (legacyRemoved) cleanup(() => fsyncDirectory(path.dirname(filePath)));
  return errors;
}

function warnAfterCommit() {
  try {
    process.emitWarning(
      'Credential update committed, but a historical version, temporary, or legacy credential file could not be retired.',
      { code: 'SPALA_CREDENTIAL_CLEANUP' },
    );
  } catch {
    // Warning delivery must not turn a committed credential update into a reported failure.
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
  ensureStoreDirectory(filePath);
  const journalPath = ensureJournalDirectory(filePath);
  credentialStorePath(env, workspaceRoot);

  while (true) {
    const snapshot = readStore(env, workspaceRoot);
    const result = update(snapshot.store);
    if (!result.changed && snapshot.source !== 'legacy') {
      fsyncDirectory(journalPath);
      if (snapshot.source === 'journal') {
        const cleanupErrors = cleanupCommittedStore(
          filePath,
          journalPath,
          snapshot.version,
          undefined,
        );
        if (cleanupErrors.length > 0) warnAfterCommit();
      }
      return result.value;
    }

    const temporary = writeStoreTemp(journalPath, result.store);
    const nextVersion = snapshot.version + 1n;
    const versionPath = path.join(journalPath, String(nextVersion));
    try {
      fs.linkSync(temporary, versionPath);
    } catch (error) {
      let cleanupError;
      try {
        fs.unlinkSync(temporary);
      } catch (caught) {
        if (!caught || typeof caught !== 'object' || caught.code !== 'ENOENT') {
          cleanupError = caught;
        }
      }
      if (cleanupError) throw cleanupError;
      if (error && typeof error === 'object' && error.code === 'EEXIST') continue;
      throw error;
    }

    try {
      fsyncDirectory(journalPath);
    } catch (error) {
      const durabilityError = new Error(
        'Credential update was claimed, but no durable journal barrier was achieved.',
        { cause: error },
      );
      durabilityError.code = 'SPALA_CREDENTIAL_DURABILITY';
      throw durabilityError;
    }

    const cleanupErrors = cleanupCommittedStore(filePath, journalPath, nextVersion, temporary);
    if (cleanupErrors.length > 0) warnAfterCommit();
    return result.value;
  }
}

function preflightJournalLink(journalPath) {
  const id = `${process.pid}-${randomUUID()}`;
  const source = path.join(journalPath, `.link-probe-source-${id}`);
  const target = path.join(journalPath, `.link-probe-target-${id}`);
  let fd;
  let operationError;
  try {
    fd = fs.openSync(
      source,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(source, target);
    fsyncDirectory(journalPath);
  } catch (error) {
    operationError = error;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        if (!operationError) operationError = error;
      }
    }
    for (const probe of [target, source]) {
      try {
        fs.unlinkSync(probe);
      } catch (error) {
        if ((!error || typeof error !== 'object' || error.code !== 'ENOENT') && !operationError) {
          operationError = error;
        }
      }
    }
    try {
      fsyncDirectory(journalPath);
    } catch (error) {
      if (!operationError) operationError = error;
    }
  }
  if (operationError) {
    const preflightError = new Error(
      'Spala credential storage could not verify required atomic hard-link support.',
      { cause: operationError },
    );
    preflightError.code = 'SPALA_CREDENTIAL_PREFLIGHT';
    throw preflightError;
  }
}

export function preflightCredentialStore(env = process.env, workspaceRoot) {
  const filePath = credentialStorePath(env, workspaceRoot);
  ensureStoreDirectory(filePath);
  credentialFileStat(filePath, 'Spala credential store', { optional: true });
  const journalPath = ensureJournalDirectory(filePath);
  credentialStorePath(env, workspaceRoot);
  preflightJournalLink(journalPath);
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
