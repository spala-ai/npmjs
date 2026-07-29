import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROJECT_BINDING_SCHEMA_VERSION = 1;
export const PROJECT_BINDING_RELATIVE_PATH = path.join('.spala', 'project.json');

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

function prepareBindingFile(directory, binding, purpose = 'tmp') {
  const temporary = path.join(directory, `.project.json.${purpose}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function publishBindingNoReplace(sourcePath, filePath, expectedRevision, label) {
  try {
    fs.linkSync(sourcePath, filePath);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
    discardBindingName(sourcePath, expectedRevision, label);
    return false;
  }

  const stat = inspectBindingFile(sourcePath, label);
  if (!sameBindingRevision(bindingRevisionFromStat(stat), expectedRevision)) {
    throw new Error(`${label} changed while it was being published; refusing to remove it.`);
  }
  if (stat.nlink === 1n) {
    discardBindingName(sourcePath, expectedRevision, label);
    return false;
  }
  if (stat.nlink !== 2n) throw new Error(`${label} must not have unexpected hard links.`);
  fs.unlinkSync(sourcePath);
  return true;
}

function writeBindingFile(workspaceRoot, binding) {
  const directory = path.join(workspaceRoot, '.spala');
  assertNotSymlink(directory, '.spala');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = bindingPath(workspaceRoot);
  assertNotSymlink(filePath, '.spala/project.json');
  const prepared = prepareBindingFile(directory, binding);
  try {
    fs.renameSync(prepared.filePath, filePath);
    return prepared.revision;
  } finally {
    if (fs.existsSync(prepared.filePath)) fs.unlinkSync(prepared.filePath);
  }
}

export function writeProjectBinding(cwd, input, { switchProject = false } = {}) {
  const { binding, changed, workspaceRoot } = planProjectBinding(cwd, input, { switchProject });
  if (!changed) {
    return { binding, changed: false, revision: null, workspaceRoot };
  }

  const revision = writeBindingFile(workspaceRoot, binding);
  return { binding, changed: true, revision, workspaceRoot };
}

export function rollbackProjectBinding(cwd, expectedRevision, previousBinding = null) {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const filePath = bindingPath(workspaceRoot);
  const directory = path.dirname(filePath);
  assertNotSymlink(directory, '.spala');
  let currentStat;
  try {
    currentStat = inspectBindingFile(filePath, '.spala/project.json');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { changed: false, preserved: true, workspaceRoot };
    }
    throw error;
  }
  if (currentStat.nlink !== 1n) {
    throw new Error('.spala/project.json must not be a hard-linked file.');
  }

  const binding = previousBinding ? validateProjectBinding(previousBinding) : null;
  const prepared = binding ? prepareBindingFile(directory, binding, 'rollback-restore') : null;
  const isolatedPath = path.join(
    directory,
    `.project.json.rollback-guard-${process.pid}-${randomUUID()}`,
  );

  try {
    fs.renameSync(filePath, isolatedPath);
  } catch (error) {
    if (prepared) {
      discardBindingName(
        prepared.filePath,
        prepared.revision,
        '.spala project binding rollback temporary file',
      );
    }
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { changed: false, preserved: true, workspaceRoot };
    }
    throw error;
  }

  const isolatedStat = inspectBindingFile(isolatedPath, '.spala/project.json rollback guard');
  const isolatedRevision = bindingRevisionFromStat(isolatedStat);
  if (isolatedStat.nlink !== 1n) {
    if (prepared) {
      discardBindingName(
        prepared.filePath,
        prepared.revision,
        '.spala project binding rollback temporary file',
      );
    }
    throw new Error('.spala/project.json rollback guard must not be a hard-linked file.');
  }

  if (!sameBindingRevision(isolatedRevision, expectedRevision)) {
    try {
      publishBindingNoReplace(
        isolatedPath,
        filePath,
        isolatedRevision,
        '.spala/project.json rollback guard',
      );
    } finally {
      if (prepared) {
        discardBindingName(
          prepared.filePath,
          prepared.revision,
          '.spala project binding rollback temporary file',
        );
      }
    }
    return { changed: false, preserved: true, workspaceRoot };
  }

  if (prepared) {
    const restored = publishBindingNoReplace(
      prepared.filePath,
      filePath,
      prepared.revision,
      '.spala project binding rollback temporary file',
    );
    discardBindingName(
      isolatedPath,
      isolatedRevision,
      '.spala/project.json rollback guard',
    );
    if (!restored) return { changed: false, preserved: true, workspaceRoot };
    return {
      binding,
      changed: true,
      preserved: false,
      revision: prepared.revision,
      workspaceRoot,
    };
  }

  discardBindingName(
    isolatedPath,
    isolatedRevision,
    '.spala/project.json rollback guard',
  );
  return { binding: null, changed: true, preserved: false, revision: null, workspaceRoot };
}

export function removeProjectBinding(cwd = process.cwd()) {
  const { binding, workspaceRoot } = readProjectBinding(cwd);
  if (!binding) return { binding: null, changed: false, workspaceRoot };
  const filePath = bindingPath(workspaceRoot);
  assertNotSymlink(filePath, '.spala/project.json');
  fs.unlinkSync(filePath);
  return { binding, changed: true, workspaceRoot };
}
