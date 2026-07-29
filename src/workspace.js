import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROJECT_BINDING_SCHEMA_VERSION = 1;
export const PROJECT_BINDING_RELATIVE_PATH = path.join('.spala', 'project.json');

const PROJECT_BINDING_FILE_NAME = 'project.json';
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY || 0)
  | NOFOLLOW;
const EXCLUSIVE_WRITE_FLAGS = fs.constants.O_CREAT
  | fs.constants.O_EXCL
  | fs.constants.O_WRONLY
  | NOFOLLOW;
const DIRECTORY_HANDLE_MARKER = Symbol('projectBindingDirectoryHandle');

const BINDING_KEYS = new Set([
  'schemaVersion',
  'projectId',
  'projectUrl',
  'mcpUrl',
  'serverName',
]);

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isWorkspaceMarker(directory) {
  return fs.existsSync(path.join(directory, '.git'))
    || fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'));
}

export function findWorkspaceRoot(cwd = process.cwd()) {
  let current = path.resolve(cwd);
  if (!isDirectory(current)) {
    throw new Error(`Workspace directory does not exist: ${current}`);
  }

  while (true) {
    if (fs.existsSync(path.join(current, PROJECT_BINDING_RELATIVE_PATH))) return current;
    if (isWorkspaceMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(cwd);
}

function validateIdentifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\0\r\n/\\]/.test(value)) {
    throw new Error(`${label} must be a non-empty identifier without path separators.`);
  }
  return value.trim();
}

function validateHttpsUrl(rawValue, label, { allowScope = false } = {}) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) throw new Error(`${label} is required.`);
  const parsed = new URL(rawValue.trim());
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Error(`${label} must use HTTPS, except localhost development URLs.`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must not contain credentials or a fragment.`);
  }
  const allowedParams = allowScope ? new Set(['scope']) : new Set();
  const unsupported = [...parsed.searchParams.keys()].filter(key => !allowedParams.has(key));
  if (unsupported.length) {
    throw new Error(`${label} contains unsupported query parameters: ${unsupported.join(', ')}.`);
  }
  return rawValue.trim();
}

export function validateProjectBinding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Project binding must be a JSON object.');
  }
  const unknown = Object.keys(input).filter(key => !BINDING_KEYS.has(key));
  if (unknown.length) throw new Error(`Project binding contains unsupported fields: ${unknown.join(', ')}.`);
  if (input.schemaVersion !== PROJECT_BINDING_SCHEMA_VERSION) {
    throw new Error(`Unsupported project binding schemaVersion: ${String(input.schemaVersion)}.`);
  }

  const projectId = validateIdentifier(input.projectId, 'projectId');
  const serverName = validateIdentifier(input.serverName, 'serverName');
  if (!/^[a-z0-9_-]+$/i.test(serverName)) {
    throw new Error('serverName may only contain letters, numbers, underscores, and hyphens.');
  }
  const projectUrl = validateHttpsUrl(input.projectUrl, 'projectUrl');
  const mcpUrl = validateHttpsUrl(input.mcpUrl, 'mcpUrl', { allowScope: true });
  const project = new URL(projectUrl);
  const mcp = new URL(mcpUrl);
  const projectHost = project.hostname.toLowerCase();
  const isSpalaHost = projectHost === 'spala.ai' || projectHost.endsWith('.spala.ai');
  const isLocalHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(projectHost);
  if (!isSpalaHost && !isLocalHost) throw new Error('projectUrl must identify a Spala project host.');
  const projectPath = `${project.pathname.replace(/\/+$/, '')}/`;
  if (project.origin !== mcp.origin || !`${mcp.pathname.replace(/\/+$/, '')}/`.startsWith(projectPath)) {
    throw new Error('mcpUrl must belong to the same project URL.');
  }
  if (!/\/mcp\/?$/i.test(mcp.pathname)) {
    throw new Error('mcpUrl must end in /mcp.');
  }

  return {
    schemaVersion: PROJECT_BINDING_SCHEMA_VERSION,
    projectId,
    projectUrl,
    mcpUrl,
    serverName,
  };
}

function bindingPath(workspaceRoot) {
  return path.join(workspaceRoot, PROJECT_BINDING_RELATIVE_PATH);
}

function pathKind(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'other';
}

function pathIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    kind: pathKind(stat),
  };
}

function samePathIdentity(left, right) {
  return Boolean(left && right)
    && left.device === right.device
    && left.inode === right.inode
    && left.kind === right.kind;
}

function lstatOrUndefined(filePath) {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function bindingDirectoryChangedError() {
  return new Error('.spala changed after it was inspected; refusing to continue.');
}

function chdirToDescriptor(descriptor, fallbackPath, expectedIdentity, label) {
  if (samePathIdentity(pathIdentity(fs.statSync('.', { bigint: true })), expectedIdentity)) return;

  const descriptorPath = process.platform === 'win32' ? undefined : `/dev/fd/${descriptor}`;
  if (descriptorPath) {
    try {
      process.chdir(descriptorPath);
      if (!samePathIdentity(pathIdentity(fs.statSync('.', { bigint: true })), expectedIdentity)) {
        throw new Error(`${label} changed after it was inspected; refusing to continue.`);
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
    || !samePathIdentity(pathIdentity(named), expectedIdentity)
  ) {
    throw new Error(`${label} changed after it was inspected; refusing to continue.`);
  }
  process.chdir(fallbackPath);
  if (!samePathIdentity(pathIdentity(fs.statSync('.', { bigint: true })), expectedIdentity)) {
    throw new Error(`${label} changed after it was inspected; refusing to continue.`);
  }
}

export function openProjectBindingDirectory(cwd = process.cwd()) {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const directoryPath = path.join(workspaceRoot, '.spala');
  assertNotSymlink(directoryPath, '.spala');
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });

  const descriptor = fs.openSync(directoryPath, DIRECTORY_FLAGS);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const directoryIdentity = pathIdentity(opened);
    const named = lstatOrUndefined(directoryPath);
    if (
      !opened.isDirectory()
      || !named
      || named.isSymbolicLink()
      || !named.isDirectory()
      || !samePathIdentity(pathIdentity(named), directoryIdentity)
    ) {
      throw bindingDirectoryChangedError();
    }
    return {
      [DIRECTORY_HANDLE_MARKER]: true,
      closed: false,
      descriptor,
      directoryIdentity,
      directoryPath,
      workspaceRoot,
    };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function closeProjectBindingDirectory(handle) {
  if (!handle?.[DIRECTORY_HANDLE_MARKER] || handle.closed) return;
  fs.closeSync(handle.descriptor);
  handle.closed = true;
}

function assertBindingDirectoryCurrent(handle) {
  const opened = fs.fstatSync(handle.descriptor, { bigint: true });
  const named = lstatOrUndefined(handle.directoryPath);
  if (
    !opened.isDirectory()
    || !samePathIdentity(pathIdentity(opened), handle.directoryIdentity)
    || !named
    || named.isSymbolicLink()
    || !named.isDirectory()
    || !samePathIdentity(pathIdentity(named), handle.directoryIdentity)
  ) {
    throw bindingDirectoryChangedError();
  }
}

function withAnchoredBindingDirectory(handle, action) {
  if (!handle?.[DIRECTORY_HANDLE_MARKER] || handle.closed) {
    throw new Error('Project binding directory handle is closed or invalid.');
  }

  const previousPath = process.cwd();
  const previousDescriptor = fs.openSync('.', DIRECTORY_FLAGS);
  const previousIdentity = pathIdentity(fs.fstatSync(previousDescriptor, { bigint: true }));
  let changedDirectory = false;
  let restorationError;
  try {
    const opened = fs.fstatSync(handle.descriptor, { bigint: true });
    if (
      !opened.isDirectory()
      || !samePathIdentity(pathIdentity(opened), handle.directoryIdentity)
    ) {
      throw bindingDirectoryChangedError();
    }
    chdirToDescriptor(
      handle.descriptor,
      handle.directoryPath,
      handle.directoryIdentity,
      '.spala',
    );
    changedDirectory = true;
    return action();
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
    fs.closeSync(previousDescriptor);
    if (restorationError) throw restorationError;
  }
}

function withProjectBindingDirectory(cwd, suppliedHandle, action) {
  const handle = suppliedHandle || openProjectBindingDirectory(cwd);
  if (
    suppliedHandle
    && path.resolve(findWorkspaceRoot(cwd)) !== path.resolve(handle.workspaceRoot)
  ) {
    throw new Error('Project binding directory handle belongs to a different workspace.');
  }
  try {
    return withAnchoredBindingDirectory(handle, () => action(handle));
  } finally {
    if (!suppliedHandle) closeProjectBindingDirectory(handle);
  }
}

function inspectBindingFile(filePath, label) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
  return stat;
}

function bindingRevisionFromStat(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    size: String(stat.size),
    modifiedNs: String(stat.mtimeNs),
  };
}

function bindingRevision(filePath, label = '.spala/project.json') {
  const stat = inspectBindingFile(filePath, label);
  if (stat.nlink !== 1n) throw new Error(`${label} must not be a hard-linked file.`);
  return bindingRevisionFromStat(stat);
}

function sameBindingRevision(left, right) {
  return Boolean(left && right)
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNs === right.modifiedNs;
}

function assertNotSymlink(filePath, label) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
}

export function readProjectBinding(cwd = process.cwd(), { required = false } = {}) {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const filePath = bindingPath(workspaceRoot);
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error('This workspace is not bound to a Spala project.');
    return { binding: null, workspaceRoot };
  }
  assertNotSymlink(path.dirname(filePath), '.spala');
  assertNotSymlink(filePath, '.spala/project.json');
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('.spala/project.json must be a regular file.');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid .spala/project.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { binding: validateProjectBinding(parsed), workspaceRoot };
}

function sameBinding(left, right) {
  return BINDING_KEYS.size === Object.keys(right).length
    && [...BINDING_KEYS].every(key => left[key] === right[key]);
}

function bindingConflictError() {
  return new Error('Workspace binding changed while the project bind was pending; refusing to replace it.');
}

function revisionForBinding(expectedBinding, expectedRevision) {
  const current = readStableBindingFile(
    PROJECT_BINDING_FILE_NAME,
    '.spala/project.json',
  );
  if (!current || (expectedRevision && !sameBindingRevision(current.revision, expectedRevision))) {
    throw bindingConflictError();
  }

  let parsed;
  try {
    parsed = JSON.parse(current.content.toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid .spala/project.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!sameBinding(validateProjectBinding(parsed), expectedBinding)) {
    throw bindingConflictError();
  }
  return current.revision;
}

export function planProjectBinding(cwd, input, { switchProject = false } = {}) {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const binding = validateProjectBinding(input);
  const existing = readProjectBinding(workspaceRoot).binding;
  if (existing && !sameBinding(existing, binding) && !switchProject) {
    throw new Error(`Workspace is already bound to project ${existing.projectId}. Pass --switch to replace it explicitly.`);
  }
  return {
    binding,
    changed: !existing || !sameBinding(existing, binding),
    existing,
    workspaceRoot,
  };
}

function prepareBindingFile(binding, purpose = 'tmp') {
  const temporary = `.project.json.${purpose}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = `${JSON.stringify(binding, null, 2)}\n`;
  try {
    fs.writeFileSync(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return {
      filePath: temporary,
      revision: bindingRevision(temporary, '.spala project binding temporary file'),
    };
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function discardBindingName(filePath, expectedRevision, label) {
  const stat = inspectBindingFile(filePath, label);
  if (!sameBindingRevision(bindingRevisionFromStat(stat), expectedRevision)) {
    throw new Error(`${label} changed after it was isolated; refusing to remove it.`);
  }
  if (stat.nlink !== 1n) throw new Error(`${label} must not be a hard-linked file.`);
  fs.unlinkSync(filePath);
}

function readStableBindingFile(filePath, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && ['ENOENT', 'ELOOP', 'EMLINK'].includes(error.code)
    ) {
      return null;
    }
    throw error;
  }

  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} must be a regular file.`);
    if (before.nlink !== 1n) throw new Error(`${label} must not be a hard-linked file.`);
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const revision = bindingRevisionFromStat(after);
    const named = lstatOrUndefined(filePath);
    if (
      !sameBindingRevision(bindingRevisionFromStat(before), revision)
      || String(before.ctimeNs) !== String(after.ctimeNs)
      || !named
      || named.isSymbolicLink()
      || !named.isFile()
      || named.nlink !== 1n
      || !sameBindingRevision(bindingRevisionFromStat(named), revision)
      || String(named.ctimeNs) !== String(after.ctimeNs)
    ) {
      return null;
    }
    return { content, revision };
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAll(descriptor, content) {
  let offset = 0;
  while (offset < content.length) {
    const written = fs.writeSync(
      descriptor,
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error('Could not write the complete project binding.');
    }
    offset += written;
  }
}

function syncCurrentDirectory() {
  const descriptor = fs.openSync('.', DIRECTORY_FLAGS);
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    const unsupported = error
      && typeof error === 'object'
      && ['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code);
    if (!unsupported) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeOwnedBindingName(filePath, ownedIdentity) {
  const named = lstatOrUndefined(filePath);
  if (
    !named
    || named.isSymbolicLink()
    || !samePathIdentity(pathIdentity(named), ownedIdentity)
  ) {
    return false;
  }
  fs.unlinkSync(filePath);
  syncCurrentDirectory();
  return true;
}

function verifyPublishedBinding(filePath, expectedRevision, expectedContent) {
  const published = readStableBindingFile(filePath, '.spala/project.json');
  if (
    !published
    || !sameBindingRevision(published.revision, expectedRevision)
    || !published.content.equals(expectedContent)
  ) {
    throw new Error('.spala/project.json changed while it was being published; refusing to continue.');
  }
  return published.revision;
}

function assertValidConcurrentBinding() {
  const winner = readStableBindingFile(
    PROJECT_BINDING_FILE_NAME,
    '.spala/project.json concurrent binding',
  );
  if (!winner) {
    throw new Error('A concurrent project binding could not be verified; preserving the prior binding guard.');
  }
  try {
    validateProjectBinding(JSON.parse(winner.content.toString('utf8')));
  } catch {
    throw new Error('A concurrent project binding was invalid; preserving the prior binding guard.');
  }
}

function publishBindingNoReplace(sourcePath, filePath, expectedRevision, label) {
  const source = readStableBindingFile(sourcePath, label);
  if (!source || !sameBindingRevision(source.revision, expectedRevision)) {
    throw new Error(`${label} changed before it was published; refusing to continue.`);
  }

  let descriptor;
  try {
    descriptor = fs.openSync(filePath, EXCLUSIVE_WRITE_FLAGS, 0o000);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
    return null;
  }

  let ownedIdentity;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    ownedIdentity = pathIdentity(opened);
    if (!opened.isFile()) {
      throw new Error('.spala/project.json must be a regular file.');
    }
    if (opened.nlink !== 1n) {
      throw new Error('.spala/project.json must not be a hard-linked file.');
    }

    writeAll(descriptor, source.content);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);

    const written = fs.fstatSync(descriptor, { bigint: true });
    if (
      !written.isFile()
      || written.nlink !== 1n
      || !samePathIdentity(pathIdentity(written), ownedIdentity)
      || written.size !== BigInt(source.content.length)
    ) {
      throw new Error('.spala/project.json changed while it was being published; refusing to continue.');
    }
    const publishedRevision = bindingRevisionFromStat(written);

    const sourceAfter = readStableBindingFile(sourcePath, label);
    if (
      !sourceAfter
      || !sameBindingRevision(sourceAfter.revision, expectedRevision)
      || !sourceAfter.content.equals(source.content)
    ) {
      throw new Error(`${label} changed while it was being published; refusing to continue.`);
    }

    verifyPublishedBinding(filePath, publishedRevision, source.content);
    syncCurrentDirectory();
    return verifyPublishedBinding(filePath, publishedRevision, source.content);
  } catch (error) {
    let cleanupError;
    try {
      if (ownedIdentity) removeOwnedBindingName(filePath, ownedIdentity);
    } catch (caught) {
      cleanupError = caught;
    }
    if (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Failed to clean the owned project binding publication: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

function restoreIsolatedBinding(isolatedPath, isolatedRevision, label) {
  const restoredRevision = publishBindingNoReplace(
    isolatedPath,
    PROJECT_BINDING_FILE_NAME,
    isolatedRevision,
    label,
  );
  if (!restoredRevision) assertValidConcurrentBinding();
  discardBindingName(isolatedPath, isolatedRevision, label);
  return restoredRevision;
}

function isolateProjectBinding(purpose, label) {
  const isolatedPath = `.project.json.${purpose}-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(PROJECT_BINDING_FILE_NAME, isolatedPath);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const isolatedStat = inspectBindingFile(isolatedPath, label);
  if (isolatedStat.nlink !== 1n) throw new Error(`${label} must not be a hard-linked file.`);
  return {
    filePath: isolatedPath,
    revision: bindingRevisionFromStat(isolatedStat),
  };
}

function recoverFailedReplacement(publishedRevision, previous) {
  const published = isolateProjectBinding(
    'failed-publication',
    '.spala/project.json failed publication guard',
  );
  if (!published) {
    discardBindingName(
      previous.filePath,
      previous.revision,
      '.spala/project.json revision guard',
    );
    return null;
  }

  const publishedIsOurs = sameBindingRevision(published.revision, publishedRevision);
  const winner = publishedIsOurs ? previous : published;
  const restoredRevision = restoreIsolatedBinding(
    winner.filePath,
    winner.revision,
    publishedIsOurs
      ? '.spala/project.json revision guard'
      : '.spala/project.json failed publication guard',
  );
  if (winner !== previous) {
    discardBindingName(
      previous.filePath,
      previous.revision,
      '.spala/project.json revision guard',
    );
  }
  if (winner !== published) {
    discardBindingName(
      published.filePath,
      published.revision,
      '.spala/project.json failed publication guard',
    );
  }
  return publishedIsOurs ? restoredRevision : null;
}

function finishDirectoryChangeRecovery(handle, error, restoredRevision, failureRollback) {
  if (restoredRevision && failureRollback) {
    rollbackBindingInCurrentDirectory(
      handle.workspaceRoot,
      restoredRevision,
      failureRollback.previousBinding,
    );
    if (error && typeof error === 'object') error.bindingRollbackCompleted = true;
    return;
  }
  if (restoredRevision && error && typeof error === 'object') {
    error.bindingRevisionAfterRecovery = restoredRevision;
  }
}

function replaceBindingIfRevision(
  handle,
  binding,
  expectedRevision,
  purpose = 'revision-update',
  failureRollback,
) {
  let currentStat;
  try {
    currentStat = inspectBindingFile(PROJECT_BINDING_FILE_NAME, '.spala/project.json');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw bindingConflictError();
    }
    throw error;
  }
  if (currentStat.nlink !== 1n) {
    throw new Error('.spala/project.json must not be a hard-linked file.');
  }
  if (!sameBindingRevision(bindingRevisionFromStat(currentStat), expectedRevision)) {
    throw bindingConflictError();
  }

  const prepared = prepareBindingFile(binding, purpose);
  let previous;

  try {
    assertBindingDirectoryCurrent(handle);
    previous = isolateProjectBinding(
      'revision-guard',
      '.spala/project.json revision guard',
    );
    if (!previous) throw bindingConflictError();
    if (!sameBindingRevision(previous.revision, expectedRevision)) {
      restoreIsolatedBinding(
        previous.filePath,
        previous.revision,
        '.spala/project.json revision guard',
      );
      previous = null;
      throw bindingConflictError();
    }

    try {
      assertBindingDirectoryCurrent(handle);
    } catch (error) {
      const restoredRevision = restoreIsolatedBinding(
        previous.filePath,
        previous.revision,
        '.spala/project.json revision guard',
      );
      previous = null;
      finishDirectoryChangeRecovery(handle, error, restoredRevision, failureRollback);
      throw error;
    }

    const publishedRevision = publishBindingNoReplace(
      prepared.filePath,
      PROJECT_BINDING_FILE_NAME,
      prepared.revision,
      '.spala project binding revision update temporary file',
    );
    if (!publishedRevision) {
      assertValidConcurrentBinding();
      discardBindingName(
        previous.filePath,
        previous.revision,
        '.spala/project.json revision guard',
      );
      previous = null;
      throw bindingConflictError();
    }

    try {
      assertBindingDirectoryCurrent(handle);
    } catch (error) {
      const restoredRevision = recoverFailedReplacement(publishedRevision, previous);
      previous = null;
      finishDirectoryChangeRecovery(handle, error, restoredRevision, failureRollback);
      throw error;
    }

    discardBindingName(
      previous.filePath,
      previous.revision,
      '.spala/project.json revision guard',
    );
    previous = null;
    return {
      binding,
      changed: true,
      revision: publishedRevision,
      workspaceRoot: handle.workspaceRoot,
    };
  } catch (error) {
    if (previous && fs.existsSync(previous.filePath)) {
      const restoredRevision = restoreIsolatedBinding(
        previous.filePath,
        previous.revision,
        '.spala/project.json revision guard',
      );
      if (restoredRevision && error && typeof error === 'object') {
        error.bindingRevisionAfterRecovery = restoredRevision;
      }
    }
    throw error;
  } finally {
    if (fs.existsSync(prepared.filePath)) {
      discardBindingName(
        prepared.filePath,
        prepared.revision,
        '.spala project binding revision update temporary file',
      );
    }
  }
}

export function writeProjectBinding(cwd, input, {
  switchProject = false,
  directoryHandle,
} = {}) {
  const { binding, changed, existing, workspaceRoot } = planProjectBinding(
    cwd,
    input,
    { switchProject },
  );
  return withProjectBindingDirectory(workspaceRoot, directoryHandle, handle => {
    assertBindingDirectoryCurrent(handle);
    if (!changed) {
      const revision = revisionForBinding(binding);
      assertBindingDirectoryCurrent(handle);
      return { binding, changed: false, revision, workspaceRoot };
    }

    if (existing) {
      const expectedRevision = revisionForBinding(existing);
      return replaceBindingIfRevision(handle, binding, expectedRevision, 'switch-update');
    }

    const prepared = prepareBindingFile(binding);
    try {
      const revision = publishBindingNoReplace(
        prepared.filePath,
        PROJECT_BINDING_FILE_NAME,
        prepared.revision,
        '.spala project binding temporary file',
      );
      if (!revision) throw bindingConflictError();
      try {
        assertBindingDirectoryCurrent(handle);
      } catch (error) {
        rollbackBindingInCurrentDirectory(handle.workspaceRoot, revision);
        throw error;
      }
      return { binding, changed: true, revision, workspaceRoot };
    } finally {
      if (fs.existsSync(prepared.filePath)) {
        discardBindingName(
          prepared.filePath,
          prepared.revision,
          '.spala project binding temporary file',
        );
      }
    }
  });
}

export function replaceProjectBindingIfRevision(
  cwd,
  input,
  expectedRevision,
  {
    directoryHandle,
    failureRollbackBinding,
    rollbackOnDirectoryChange = false,
  } = {},
) {
  const binding = validateProjectBinding(input);
  const workspaceRoot = directoryHandle?.workspaceRoot || findWorkspaceRoot(cwd);
  return withProjectBindingDirectory(
    workspaceRoot,
    directoryHandle,
    handle => replaceBindingIfRevision(
      handle,
      binding,
      expectedRevision,
      'revision-update',
      rollbackOnDirectoryChange
        ? { previousBinding: failureRollbackBinding || null }
        : null,
    ),
  );
}

export function assertProjectBindingRevision(
  cwd,
  input,
  expectedRevision,
  {
    directoryHandle,
    failureRollbackBinding,
    rollbackOnFailure = false,
  } = {},
) {
  const binding = validateProjectBinding(input);
  const workspaceRoot = directoryHandle?.workspaceRoot || findWorkspaceRoot(cwd);
  return withProjectBindingDirectory(
    workspaceRoot,
    directoryHandle,
    handle => {
      try {
        assertBindingDirectoryCurrent(handle);
        const revision = revisionForBinding(binding, expectedRevision);
        assertBindingDirectoryCurrent(handle);
        return { binding, revision, workspaceRoot };
      } catch (error) {
        if (rollbackOnFailure) {
          rollbackBindingInCurrentDirectory(
            workspaceRoot,
            expectedRevision,
            failureRollbackBinding || null,
          );
          if (error && typeof error === 'object') {
            error.bindingRollbackCompleted = true;
          }
        }
        throw error;
      }
    },
  );
}

function rollbackBindingInCurrentDirectory(workspaceRoot, expectedRevision, previousBinding = null) {
  let currentStat;
  try {
    currentStat = inspectBindingFile(PROJECT_BINDING_FILE_NAME, '.spala/project.json');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { changed: false, preserved: true, workspaceRoot };
    }
    throw error;
  }
  const binding = previousBinding ? validateProjectBinding(previousBinding) : null;
  if (currentStat.nlink !== 1n) {
    if (!sameBindingRevision(bindingRevisionFromStat(currentStat), expectedRevision)) {
      throw new Error('.spala/project.json must not be a hard-linked file.');
    }

    const removed = removeOwnedBindingName(
      PROJECT_BINDING_FILE_NAME,
      pathIdentity(currentStat),
    );
    if (!removed) {
      return { changed: false, preserved: true, workspaceRoot };
    }
    if (!binding) {
      return { binding: null, changed: true, preserved: false, revision: null, workspaceRoot };
    }

    const prepared = prepareBindingFile(binding, 'rollback-restore');
    try {
      const restoredRevision = publishBindingNoReplace(
        prepared.filePath,
        PROJECT_BINDING_FILE_NAME,
        prepared.revision,
        '.spala project binding rollback temporary file',
      );
      if (!restoredRevision) {
        assertValidConcurrentBinding();
        return { changed: false, preserved: true, workspaceRoot };
      }
      return {
        binding,
        changed: true,
        preserved: false,
        revision: restoredRevision,
        workspaceRoot,
      };
    } finally {
      if (fs.existsSync(prepared.filePath)) {
        discardBindingName(
          prepared.filePath,
          prepared.revision,
          '.spala project binding rollback temporary file',
        );
      }
    }
  }

  const prepared = binding ? prepareBindingFile(binding, 'rollback-restore') : null;
  let isolated;
  try {
    isolated = isolateProjectBinding(
      'rollback-guard',
      '.spala/project.json rollback guard',
    );
    if (!isolated) return { changed: false, preserved: true, workspaceRoot };

    if (!sameBindingRevision(isolated.revision, expectedRevision)) {
      restoreIsolatedBinding(
        isolated.filePath,
        isolated.revision,
        '.spala/project.json rollback guard',
      );
      isolated = null;
      return { changed: false, preserved: true, workspaceRoot };
    }

    if (prepared) {
      const restoredRevision = publishBindingNoReplace(
        prepared.filePath,
        PROJECT_BINDING_FILE_NAME,
        prepared.revision,
        '.spala project binding rollback temporary file',
      );
      if (!restoredRevision) assertValidConcurrentBinding();
      discardBindingName(
        isolated.filePath,
        isolated.revision,
        '.spala/project.json rollback guard',
      );
      isolated = null;
      if (!restoredRevision) {
        return { changed: false, preserved: true, workspaceRoot };
      }
      return {
        binding,
        changed: true,
        preserved: false,
        revision: restoredRevision,
        workspaceRoot,
      };
    }

    discardBindingName(
      isolated.filePath,
      isolated.revision,
      '.spala/project.json rollback guard',
    );
    isolated = null;
    return { binding: null, changed: true, preserved: false, revision: null, workspaceRoot };
  } catch (error) {
    if (isolated && fs.existsSync(isolated.filePath)) {
      restoreIsolatedBinding(
        isolated.filePath,
        isolated.revision,
        '.spala/project.json rollback guard',
      );
    }
    throw error;
  } finally {
    if (prepared && fs.existsSync(prepared.filePath)) {
      discardBindingName(
        prepared.filePath,
        prepared.revision,
        '.spala project binding rollback temporary file',
      );
    }
  }
}

export function rollbackProjectBinding(
  cwd,
  expectedRevision,
  previousBinding = null,
  { directoryHandle } = {},
) {
  const workspaceRoot = directoryHandle?.workspaceRoot || findWorkspaceRoot(cwd);
  return withProjectBindingDirectory(
    workspaceRoot,
    directoryHandle,
    () => rollbackBindingInCurrentDirectory(
      workspaceRoot,
      expectedRevision,
      previousBinding,
    ),
  );
}

export function removeProjectBinding(cwd = process.cwd()) {
  const { binding, workspaceRoot } = readProjectBinding(cwd);
  if (!binding) return { binding: null, changed: false, workspaceRoot };
  const filePath = bindingPath(workspaceRoot);
  assertNotSymlink(filePath, '.spala/project.json');
  fs.unlinkSync(filePath);
  return { binding, changed: true, workspaceRoot };
}
