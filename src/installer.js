import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectCodexToml, planCodexTomlInstall, planCodexTomlProxyInstall, planCodexTomlUninstall } from './codexToml.js';
import { planCodexSkillInstall, planCodexSkillUninstall } from './codexSkill.js';
import {
  applyJsonEdits,
  nodeMatchesValue,
  parseLosslessJson,
  propertiesNamed,
  propertyInsertionEdit,
  propertyInsertionsEdit,
  propertyRemovalEdits,
  stringArrayNodeValues,
} from './losslessJson.js';
import { assertSafePath } from './pathSafety.js';
import { applySafeFileWrite, recoverSafeFileWrite, rollbackSafeFileWrite } from './safeFileOps.js';
import { findWorkspaceRoot } from './workspace.js';

export const WRITABLE_CLIENTS = [
  'antigravity',
  'antigravity-cli',
  'gemini',
  'windsurf',
  'cline',
  'roo',
  'claude-desktop',
  'zed',
  'cursor',
];

// Clients whose USER-scoped public install is applied via a printed client CLI
// command instead of a config-file write. Scope matters: claude-code is
// command-only at user scope but workspace-WRITABLE (.mcp.json) for project
// binds — clientInstallCapabilities() reports the per-scope truth.
export const COMMAND_ONLY_CLIENTS = [
  'claude-code',
];

export const INSTALL_SCOPES = ['user', 'workspace'];

export const DEFAULT_PROJECT_SCOPE = 'builder,project,data';
export const PUBLIC_MCP_URL = 'https://mcp.spala.ai/mcp';
export const PUBLIC_SERVER_NAME = 'spala_public_mcp';
export const PUBLIC_LEGACY_SERVER_NAMES = [
  'spala_mcp_spala_ai',
  'spala-mcp-spala-ai',
];
export const MCP_REMOTE_VERSION = '0.1.38';
export { INSTALLER_PACKAGE_SPEC } from './packageSpec.js';
import { INSTALLER_PACKAGE_SPEC } from './packageSpec.js';

export const CLIENT_LABELS = {
  antigravity: 'Antigravity',
  'antigravity-cli': 'Antigravity CLI',
  gemini: 'Gemini CLI',
  windsurf: 'Windsurf',
  cline: 'Cline',
  roo: 'Roo Code',
  'claude-desktop': 'Claude Desktop',
  zed: 'Zed',
  codex: 'Codex CLI',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
};

function homeDir(env) {
  return env.SPALA_MCP_INSTALL_HOME || env.HOME || env.USERPROFILE || os.homedir();
}

function appDataDir(env) {
  return env.APPDATA || joinPath(env, homeDir(env), 'AppData', 'Roaming');
}

function platform(env) {
  return env.SPALA_MCP_INSTALL_PLATFORM || process.platform;
}

function joinPath(env, ...parts) {
  return platform(env) === 'win32' ? path.win32.join(...parts) : path.join(...parts);
}

function claudeDesktopPath(env) {
  const home = homeDir(env);
  if (platform(env) === 'win32') {
    return joinPath(env, appDataDir(env), 'Claude', 'claude_desktop_config.json');
  }
  if (platform(env) === 'darwin') {
    return joinPath(env, home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return joinPath(env, home, '.config', 'Claude', 'claude_desktop_config.json');
}

const ALL_CLIENTS = Object.keys(CLIENT_LABELS);

function installMode(client, installScope) {
  if (installScope === 'workspace') {
    if (client === 'codex' || client === 'roo' || client === 'claude-code' || client === 'cursor') return 'writable';
    if (client === 'gemini') return 'command';
    return 'unsupported';
  }
  if (client === 'codex') return 'writable';
  if (client === 'claude-code') return 'command';
  if (client === 'roo') return 'unsupported';
  return WRITABLE_CLIENTS.includes(client) ? 'writable' : 'unsupported';
}

export function clientInstallCapabilities() {
  return ALL_CLIENTS.map(client => ({
    name: client,
    label: CLIENT_LABELS[client],
    user: installMode(client, 'user'),
    workspace: installMode(client, 'workspace'),
  }));
}

function targetPath(client, env, workspaceRoot, installScope = 'user') {
  const home = homeDir(env);
  if (installScope === 'workspace') {
    if (client === 'codex') return joinPath(env, workspaceRoot, '.codex', 'config.toml');
    if (client === 'roo') return joinPath(env, workspaceRoot, '.roo', 'mcp.json');
    if (client === 'claude-code') return joinPath(env, workspaceRoot, '.mcp.json');
    if (client === 'cursor') return joinPath(env, workspaceRoot, '.cursor', 'mcp.json');
    return null;
  }
  switch (client) {
    case 'codex':
      return joinPath(env, home, '.codex', 'config.toml');
    case 'cursor':
      return joinPath(env, home, '.cursor', 'mcp.json');
    case 'antigravity':
      return joinPath(env, home, '.gemini', 'antigravity', 'mcp_config.json');
    case 'antigravity-cli':
      return joinPath(env, home, '.gemini', 'antigravity-cli', 'mcp_config.json');
    case 'gemini':
      return joinPath(env, home, '.gemini', 'settings.json');
    case 'windsurf':
      return joinPath(env, home, '.codeium', 'windsurf', 'mcp_config.json');
    case 'cline':
      return joinPath(env, home, '.cline', 'mcp.json');
    case 'claude-desktop':
      return claudeDesktopPath(env);
    case 'zed':
      return joinPath(env, home, '.config', 'zed', 'settings.json');
    default:
      return null;
  }
}

function configSafetyRoot(client, env, workspaceRoot, installScope) {
  if (installScope === 'workspace') return workspaceRoot;
  if (client === 'claude-desktop' && platform(env) === 'win32') return appDataDir(env);
  return homeDir(env);
}

export function codexRemoteRegistrationTarget({
  cwd = process.cwd(),
  env = process.env,
  installScope,
  mcpUrl,
}) {
  const resolvedInstallScope = normalizeInstallScope(installScope, mcpUrl);
  const workspaceRoot = findWorkspaceRoot(cwd);
  return {
    path: targetPath('codex', env, workspaceRoot, resolvedInstallScope),
    safetyRoot: configSafetyRoot('codex', env, workspaceRoot, resolvedInstallScope),
  };
}

function codexSkillPath(env) {
  return joinPath(env, homeDir(env), '.codex', 'skills', 'spala-backend', 'SKILL.md');
}

function parentLooksInstalled(filePath, client, workspaceRoot) {
  if (client === 'claude-code' && workspaceRoot) {
    return fs.existsSync(filePath)
      || fs.existsSync(path.join(workspaceRoot, '.claude'))
      || fs.existsSync(path.join(workspaceRoot, 'CLAUDE.md'));
  }
  return fs.existsSync(filePath) || fs.existsSync(path.dirname(filePath));
}

function normalizeClientName(name) {
  return String(name || '').trim().toLowerCase().replace(/_/g, '-');
}

function selectedClients(selection) {
  if (!selection || selection === 'all') return ALL_CLIENTS;
  return selection
    .split(',')
    .map(part => normalizeClientName(part))
    .filter(Boolean);
}

function normalizeInstallScope(value, mcpUrl) {
  const inferred = urlsMatch(mcpUrl, PUBLIC_MCP_URL) ? 'user' : 'workspace';
  const normalized = String(value || inferred).trim().toLowerCase();
  if (!INSTALL_SCOPES.includes(normalized)) {
    throw new Error(`Install scope must be one of: ${INSTALL_SCOPES.join(', ')}.`);
  }
  return normalized;
}

function shouldForceClient(selection) {
  return Boolean(selection && selection !== 'all');
}

function sanitizeServerName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'spala-project';
}

export function serverNameFromUrl(rawUrl) {
  let host = 'project';
  try {
    const url = new URL(rawUrl);
    const pathParts = url.pathname
      .split('/')
      .map(part => part.trim())
      .filter(Boolean);
    if (pathParts[pathParts.length - 1]?.toLowerCase() === 'mcp') pathParts.pop();
    const pathKey = pathParts.join('_');
    host = pathKey ? `${url.host}_${pathKey}` : url.host;
  } catch {
    host = String(rawUrl).replace(/^https?:\/\//, '');
  }
  const normalized = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `spala-${normalized || 'project'}`;
}

export function normalizeMcpUrl(rawUrl, scope = DEFAULT_PROJECT_SCOPE, preserveExact = false) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('MCP URL is required.');
  }
  const parsed = new URL(rawUrl);
  const isLocalHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('MCP URL must use https, except http://localhost for local testing.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP URL must not contain embedded credentials.');
  }
  if (parsed.hash) {
    throw new Error('MCP URL must not contain a fragment.');
  }
  const unsupportedParams = [...parsed.searchParams.keys()].filter(key => key !== 'scope');
  if (unsupportedParams.length) {
    throw new Error(`MCP URL contains unsupported query parameter(s): ${unsupportedParams.join(', ')}. Only scope is allowed.`);
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
  if (
    parsed.protocol === 'https:'
    && parsed.hostname.toLowerCase() === 'mcp.spala.ai'
    && !parsed.port
    && normalizedPath === '/mcp'
  ) {
    return PUBLIC_MCP_URL;
  }
  if (!parsed.searchParams.get('scope') && scope) {
    parsed.searchParams.set('scope', scope);
  }
  return preserveExact ? rawUrl.trim() : parsed.toString();
}

function directHttpConfig(url, key = 'url') {
  return { [key]: url };
}

function remoteBridgeConfig(url) {
  return {
    command: 'pnpm',
    args: ['dlx', `mcp-remote@${MCP_REMOTE_VERSION}`, url],
  };
}

function desiredPatch(client, serverName, mcpUrl) {
  switch (client) {
    case 'antigravity':
    case 'antigravity-cli':
    case 'windsurf':
      return { topKey: 'mcpServers', serverName, value: directHttpConfig(mcpUrl, 'serverUrl') };
    case 'cline':
    case 'roo':
    case 'cursor':
      return { topKey: 'mcpServers', serverName, value: directHttpConfig(mcpUrl, 'url') };
    case 'claude-code':
      return { topKey: 'mcpServers', serverName, value: { type: 'http', url: mcpUrl } };
    case 'gemini':
      return { topKey: 'mcpServers', serverName, value: directHttpConfig(mcpUrl, 'httpUrl') };
    case 'claude-desktop':
      return { topKey: 'mcpServers', serverName, value: remoteBridgeConfig(mcpUrl) };
    case 'zed':
      return {
        topKey: 'context_servers',
        serverName,
        value: directHttpConfig(mcpUrl),
      };
    default:
      return null;
  }
}

function configBucketKey(client) {
  return client === 'zed' ? 'context_servers' : 'mcpServers';
}

function entryUrlValues(value) {
  if (!value || typeof value !== 'object') return [];
  const urls = [];
  for (const key of ['httpUrl', 'url', 'serverUrl']) {
    if (typeof value[key] === 'string') urls.push(value[key]);
  }
  if (Array.isArray(value.args)) {
    urls.push(...value.args.filter(arg => typeof arg === 'string' && /^https?:\/\//.test(arg)));
  }
  return urls;
}

function valueUrl(value) {
  return entryUrlValues(value)[0];
}

export function normalizeComparableMcpUrl(urlString) {
  try {
    const parsed = new URL(normalizeMcpUrl(urlString, ''));
    parsed.hash = '';
    const scope = parsed.searchParams.get('scope');
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    if (scope !== null) parsed.searchParams.set('scope', scope);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isSpalaServerName(name) {
  return /^spala[_-]/i.test(name);
}

function isSpalaUrl(urlString) {
  try {
    const host = new URL(normalizeMcpUrl(urlString, '')).hostname.toLowerCase();
    return host === 'spala.ai' || host.endsWith('.spala.ai') || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function safeEntry(name) {
  return { name };
}

function urlsMatch(left, right) {
  const normalizedLeft = normalizeComparableMcpUrl(left || '');
  const normalizedRight = normalizeComparableMcpUrl(right || '');
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function mcpUrlsMatch(left, right) {
  return urlsMatch(left, right);
}

// Endpoint identity ignores the scope query: origin + path only. The scope a
// bootstrap response carries is authorization detail, not a different server,
// so a bare requested URL must accept a scoped response (and vice versa).
export function mcpEndpointsMatch(left, right) {
  const stripScope = value => {
    const normalized = normalizeComparableMcpUrl(value || '');
    if (!normalized) return undefined;
    const parsed = new URL(normalized);
    parsed.search = '';
    return parsed.toString();
  };
  const strippedLeft = stripScope(left);
  const strippedRight = stripScope(right);
  return Boolean(strippedLeft && strippedRight && strippedLeft === strippedRight);
}

function publicLegacyNamesForTarget(serverName, mcpUrl) {
  return serverName === PUBLIC_SERVER_NAME && urlsMatch(mcpUrl, PUBLIC_MCP_URL)
    ? PUBLIC_LEGACY_SERVER_NAMES
    : [];
}

function uniqueProperty(objectNode, key, label) {
  const matches = propertiesNamed(objectNode, key);
  if (matches.length > 1) throw new Error(`${label} contains duplicate ${key} keys; refusing to modify it.`);
  return matches[0];
}

function nodeEndpointUrls(node) {
  if (node?.type !== 'object') return undefined;
  const directProperties = ['httpUrl', 'url', 'serverUrl']
    .flatMap(key => propertiesNamed(node, key));
  const commandProperties = propertiesNamed(node, 'command');
  const argsProperties = propertiesNamed(node, 'args');
  if (commandProperties.length || argsProperties.length) {
    if (directProperties.length || commandProperties.length !== 1 || argsProperties.length !== 1) return undefined;
    if (commandProperties[0].value.type !== 'string') return undefined;
    const args = stringArrayNodeValues(argsProperties[0].value);
    if (!args) return undefined;
    return args.filter(arg => /^https?:\/\//.test(arg));
  }
  if (directProperties.length !== 1 || directProperties[0].value.type !== 'string') return undefined;
  return [directProperties[0].value.value];
}

function nodeEntryMatchesUrl(node, targetUrl) {
  const normalizedTarget = normalizeComparableMcpUrl(targetUrl);
  const urls = nodeEndpointUrls(node);
  return Boolean(normalizedTarget)
    && Array.isArray(urls)
    && urls.length > 0
    && urls.every(url => normalizeComparableMcpUrl(url) === normalizedTarget);
}

function isExactPublicLegacyNode(name, node, allowedNames) {
  if (!allowedNames.includes(name)) return false;
  const supportedValues = [
    { httpUrl: PUBLIC_MCP_URL },
    { url: PUBLIC_MCP_URL },
    { serverUrl: PUBLIC_MCP_URL },
    remoteBridgeConfig(PUBLIC_MCP_URL),
  ];
  return supportedValues.some(value => nodeMatchesValue(node, value));
}

function readJsonIfExists(filePath, safetyRoot) {
  const pathState = assertSafePath(filePath, safetyRoot, 'JSON client config path');
  if (!fs.existsSync(filePath)) {
    return { document: parseLosslessJson('{}'), existed: false, pathState };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  assertSafePath(filePath, safetyRoot, 'JSON client config path', pathState);
  try {
    return { document: parseLosslessJson(raw), existed: true, pathState };
  } catch {
    throw new Error('JSON client config is invalid; refusing to modify it.');
  }
}

const OWNED_JSON_SERVER_FIELDS = new Set(['httpUrl', 'url', 'serverUrl', 'command', 'args']);

function ownedJsonMergeEdits(serverNode, desiredValue) {
  if (serverNode.type !== 'object') {
    throw new Error('Existing MCP server configuration must be a JSON object.');
  }
  const desiredEntries = Object.entries(desiredValue);
  const desiredKeys = new Set(desiredEntries.map(([key]) => key));
  const removedProperties = [];
  const edits = [];

  for (const key of OWNED_JSON_SERVER_FIELDS) {
    const matches = propertiesNamed(serverNode, key);
    if (matches.length > 1) {
      throw new Error(`Existing MCP server configuration contains duplicate ${key} keys; refusing to modify it.`);
    }
    if (matches[0] && !desiredKeys.has(key)) removedProperties.push(matches[0]);
  }

  const missingEntries = [];
  for (const [key, value] of desiredEntries) {
    const property = propertiesNamed(serverNode, key)[0];
    if (!property) {
      missingEntries.push([key, JSON.stringify(value)]);
    } else if (!nodeMatchesValue(property.value, value)) {
      edits.push({
        start: property.value.start,
        end: property.value.end,
        text: JSON.stringify(value),
      });
    }
  }

  edits.push(...propertyRemovalEdits(serverNode, removedProperties));
  const insertion = propertyInsertionsEdit(
    serverNode,
    missingEntries,
    serverNode.properties.length - removedProperties.length,
  );
  if (insertion) edits.push(insertion);
  return edits;
}

function planWrite(client, filePath, safetyRoot, patch, dryRun, cleanupDuplicates = false, duplicateServerNames = []) {
  const { document, existed, pathState } = readJsonIfExists(filePath, safetyRoot);
  if (document.root.type !== 'object') throw new Error('Config root must be a JSON object.');
  const bucketProperty = uniqueProperty(document.root, patch.topKey, 'Config root');
  const edits = [];
  const removedDuplicates = [];

  if (!bucketProperty) {
    edits.push(propertyInsertionEdit(
      document.root,
      patch.topKey,
      JSON.stringify({ [patch.serverName]: patch.value }),
      document.root.properties.length,
    ));
  } else {
    if (bucketProperty.value.type !== 'object') throw new Error(`Config key ${patch.topKey} must be a JSON object.`);
    const bucket = bucketProperty.value;
    const removedProperties = [];
    if (cleanupDuplicates && valueUrl(patch.value) === PUBLIC_MCP_URL) {
      for (const name of duplicateServerNames) {
        if (name === patch.serverName) continue;
        const matches = propertiesNamed(bucket, name);
        if (matches.length !== 1 || !isExactPublicLegacyNode(name, matches[0].value, duplicateServerNames)) continue;
        removedProperties.push(matches[0]);
        removedDuplicates.push(safeEntry(name));
      }
    }

    const targetProperties = propertiesNamed(bucket, patch.serverName);
    if (targetProperties.length > 1) {
      throw new Error(`Config key ${patch.topKey} contains duplicate ${patch.serverName} keys; refusing to modify it.`);
    }
    const targetProperty = targetProperties[0];
    if (targetProperty) {
      const sameValue = nodeMatchesValue(targetProperty.value, patch.value);
      const sameUrl = nodeEntryMatchesUrl(targetProperty.value, valueUrl(patch.value));
      if (!sameValue && !sameUrl) {
        throw new Error(`Refusing to replace existing MCP server "${patch.serverName}" with a different configuration. Use --name for a new entry or uninstall the old entry first.`);
      }
      if (!sameValue) {
        edits.push(...ownedJsonMergeEdits(targetProperty.value, patch.value));
      }
    } else {
      edits.push(propertyInsertionEdit(
        bucket,
        patch.serverName,
        JSON.stringify(patch.value),
        bucket.properties.length - removedProperties.length,
      ));
    }
    edits.push(...propertyRemovalEdits(bucket, removedProperties));
  }

  const content = applyJsonEdits(document.source, edits);
  const originalContent = existed ? document.originalSource : undefined;
  const changed = content !== originalContent;
  return {
    client,
    path: filePath,
    action: existed ? (changed ? 'update' : 'unchanged') : 'create',
    backupPath: existed ? `${filePath}.bak-<timestamp>` : undefined,
    existed,
    content,
    originalContent,
    format: 'json',
    removedDuplicates,
    safetyRoot,
    pathLabel: 'JSON client config path',
    pathState,
    dryRun,
  };
}

export function createInstallPlan({ clientSelection = 'all', cleanupDuplicates = false, cwd = process.cwd(), dryRun = false, env = process.env, exactUrl = false, installScope, mcpUrl, scope = DEFAULT_PROJECT_SCOPE, serverName }) {
  const normalizedUrl = normalizeMcpUrl(mcpUrl, scope, exactUrl);
  const resolvedInstallScope = normalizeInstallScope(installScope, normalizedUrl);
  const workspaceRoot = findWorkspaceRoot(cwd);
  const safeServerName = normalizedUrl === PUBLIC_MCP_URL
    ? PUBLIC_SERVER_NAME
    : sanitizeServerName(serverName || serverNameFromUrl(normalizedUrl));
  const duplicateServerNames = cleanupDuplicates
    ? publicLegacyNamesForTarget(safeServerName, normalizedUrl)
    : [];
  const forced = shouldForceClient(clientSelection);
  const clients = selectedClients(clientSelection);
  const writes = [];
  const skipped = [];

  for (const client of clients) {
    const mode = installMode(client, resolvedInstallScope);
    if (mode === 'command') {
      skipped.push({ client, reason: `Use the printed ${resolvedInstallScope}-scoped command for this client.`, commandRequired: true });
      continue;
    }
    if (mode === 'unsupported') {
      skipped.push({ client, reason: `${CLIENT_LABELS[client] || client} has no verified ${resolvedInstallScope}-scoped installation target.`, unsupportedScope: true });
      continue;
    }

    const filePath = targetPath(client, env, workspaceRoot, resolvedInstallScope);
    const safetyRoot = configSafetyRoot(client, env, workspaceRoot, resolvedInstallScope);
    if (client === 'codex') {
      writes.push(planCodexTomlInstall(
        filePath,
        safeServerName,
        normalizedUrl,
        dryRun,
        duplicateServerNames,
        safetyRoot,
      ));
      if (resolvedInstallScope === 'user' && urlsMatch(normalizedUrl, PUBLIC_MCP_URL)) {
        writes.push(planCodexSkillInstall(codexSkillPath(env), dryRun, homeDir(env)));
      }
      continue;
    }
    const patch = desiredPatch(client, safeServerName, normalizedUrl);
    if (!filePath || !patch) {
      skipped.push({ client, reason: 'No config target is known for this client.' });
      continue;
    }
    if (!forced && !parentLooksInstalled(filePath, client, workspaceRoot)) {
      skipped.push({ client, reason: 'Config directory was not detected. Use --client to create it anyway.' });
      continue;
    }
    writes.push(planWrite(client, filePath, safetyRoot, patch, dryRun, cleanupDuplicates, duplicateServerNames));
  }

  return {
    cleanupDuplicates,
    dryRun,
    installScope: resolvedInstallScope,
    mcpUrl: normalizedUrl,
    serverName: safeServerName,
    workspaceRoot,
    writes,
    skipped,
  };
}

export function proxyCommandForProject(projectId, runner = 'pnpm') {
  const id = String(projectId || '').trim();
  if (!id || id.length > 200 || /[\0\r\n/\\]/.test(id)) throw new Error('projectId must be a non-empty identifier without path separators.');
  if (runner === 'npx') {
    return {
      command: 'npx',
      args: ['--yes', INSTALLER_PACKAGE_SPEC, 'proxy', '--project-id', id],
    };
  }
  return {
    command: 'pnpm',
    args: ['dlx', INSTALLER_PACKAGE_SPEC, 'proxy', '--project-id', id],
  };
}

export function createProxyInstallPlan({ clientSelection = 'all', cwd = process.cwd(), dryRun = false, env = process.env, projectId, serverName }) {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const safeServerName = sanitizeServerName(serverName);
  const proxy = proxyCommandForProject(projectId);
  const forced = shouldForceClient(clientSelection);
  const writes = [];
  const skipped = [];

  for (const client of selectedClients(clientSelection)) {
    const mode = installMode(client, 'workspace');
    if (mode === 'command') {
      skipped.push({ client, reason: 'Use the printed project-scoped stdio command for this client.', commandRequired: true });
      continue;
    }
    if (mode === 'unsupported') {
      skipped.push({ client, reason: `${CLIENT_LABELS[client] || client} has no verified workspace-scoped installation target.`, unsupportedScope: true });
      continue;
    }
    const filePath = targetPath(client, env, workspaceRoot, 'workspace');
    const safetyRoot = configSafetyRoot(client, env, workspaceRoot, 'workspace');
    if (client === 'codex') {
      writes.push(planCodexTomlProxyInstall(filePath, safeServerName, proxy.command, proxy.args, dryRun, safetyRoot));
      continue;
    }
    if (!['roo', 'claude-code', 'cursor'].includes(client) || !filePath) {
      skipped.push({ client, reason: 'No verified workspace stdio configuration target is available.', unsupportedScope: true });
      continue;
    }
    if (!forced && !parentLooksInstalled(filePath, client, workspaceRoot)) {
      skipped.push({ client, reason: 'Config directory was not detected. Use --client to create it anyway.' });
      continue;
    }
    const clientProxy = client === 'roo' ? proxy : proxyCommandForProject(projectId, 'npx');
    writes.push(planWrite(client, filePath, safetyRoot, {
      topKey: 'mcpServers',
      serverName: safeServerName,
      value: client === 'claude-code'
        ? { type: 'stdio', command: clientProxy.command, args: clientProxy.args }
        : { command: clientProxy.command, args: clientProxy.args },
    }, dryRun, false));
  }

  return {
    dryRun,
    installScope: 'workspace',
    proxy: { projectId: String(projectId), command: proxy.command, args: proxy.args },
    serverName: safeServerName,
    workspaceRoot,
    writes,
    skipped,
  };
}

export function createUninstallPlan({ clientSelection = 'all', cleanupDuplicates = false, cwd = process.cwd(), dryRun = false, env = process.env, installScope, mcpUrl, serverName = PUBLIC_SERVER_NAME }) {
  if (!serverName && !mcpUrl) {
    throw new Error('Uninstall requires --public, --url, --name, or --manifest to identify the target.');
  }
  const normalizedUrl = mcpUrl ? normalizeMcpUrl(mcpUrl, '') : undefined;
  const resolvedInstallScope = normalizeInstallScope(installScope, normalizedUrl || PUBLIC_MCP_URL);
  const workspaceRoot = findWorkspaceRoot(cwd);
  const rawServerName = String(serverName || '').trim();
  const safeServerName = sanitizeServerName(serverName || (normalizedUrl ? serverNameFromUrl(normalizedUrl) : PUBLIC_SERVER_NAME));
  const duplicateServerNames = cleanupDuplicates && normalizedUrl
    ? publicLegacyNamesForTarget(safeServerName, normalizedUrl)
    : [];
  const targetNames = new Set([safeServerName]);
  if (rawServerName) targetNames.add(rawServerName);
  if (!normalizedUrl && cleanupDuplicates) {
    throw new Error('--cleanup-duplicates requires --public, --url, or --manifest so duplicates can be matched by MCP URL.');
  }
  if (!normalizedUrl && ![...targetNames].some(isSpalaServerName)) {
    throw new Error('Name-only uninstall is limited to Spala-owned server names. Use --url or --public to identify the target.');
  }
  const forced = shouldForceClient(clientSelection);
  const clients = selectedClients(clientSelection);
  const writes = [];
  const skipped = [];

  for (const client of clients) {
    const mode = installMode(client, resolvedInstallScope);
    if (mode !== 'writable') {
      skipped.push({ client, reason: mode === 'command' ? `Remove this ${resolvedInstallScope}-scoped entry with the client CLI.` : `No verified ${resolvedInstallScope}-scoped target is available.`, commandRequired: mode === 'command', unsupportedScope: mode === 'unsupported' });
      continue;
    }
    const filePath = targetPath(client, env, workspaceRoot, resolvedInstallScope);
    const safetyRoot = configSafetyRoot(client, env, workspaceRoot, resolvedInstallScope);
    if (client === 'codex') {
      const write = normalizedUrl
        ? planCodexTomlUninstall(filePath, safeServerName, normalizedUrl, dryRun, duplicateServerNames, safetyRoot)
        : null;
      if (write) writes.push(write);
      else skipped.push({ client, reason: 'Config file or matching MCP table was not found.' });
      if (resolvedInstallScope === 'user' && normalizedUrl && urlsMatch(normalizedUrl, PUBLIC_MCP_URL)) {
        const skillWrite = planCodexSkillUninstall(codexSkillPath(env), dryRun, homeDir(env));
        if (skillWrite) writes.push(skillWrite);
      }
      continue;
    }
    assertSafePath(filePath, safetyRoot, 'JSON client config path');
    if (!filePath || !fs.existsSync(filePath)) {
      skipped.push({ client, reason: 'Config file was not found.' });
      continue;
    }
    if (!forced && !parentLooksInstalled(filePath)) {
      skipped.push({ client, reason: 'Config directory was not detected. Use --client to target it explicitly.' });
      continue;
    }
    const { document, existed, pathState } = readJsonIfExists(filePath, safetyRoot);
    const topKey = configBucketKey(client);
    if (document.root.type !== 'object') throw new Error('Config root must be a JSON object.');
    const bucketProperty = uniqueProperty(document.root, topKey, 'Config root');
    if (!bucketProperty) {
      skipped.push({ client, reason: `No ${cleanupDuplicates ? 'Spala MCP entries' : safeServerName} entry found.` });
      continue;
    }
    if (bucketProperty.value.type !== 'object') throw new Error(`Config key ${topKey} must be a JSON object.`);
    const bucket = bucketProperty.value;
    const removed = [];
    const removedProperties = [];
    for (const property of bucket.properties) {
      const matchesTargetName = targetNames.has(property.key) && (
        normalizedUrl
          ? nodeEntryMatchesUrl(property.value, normalizedUrl)
          : isSpalaServerName(property.key)
            && (nodeEndpointUrls(property.value)?.length || 0) > 0
            && nodeEndpointUrls(property.value).every(isSpalaUrl)
      );
      const matchesDuplicate = Boolean(normalizedUrl)
        && isExactPublicLegacyNode(property.key, property.value, duplicateServerNames);
      const shouldRemove = matchesTargetName || matchesDuplicate;
      if (!shouldRemove) continue;
      if (propertiesNamed(bucket, property.key).length !== 1) {
        throw new Error(`Config key ${topKey} contains duplicate ${property.key} keys; refusing to modify it.`);
      }
      removed.push(safeEntry(property.key));
      removedProperties.push(property);
    }
    if (removed.length === 0) {
      skipped.push({ client, reason: `No ${cleanupDuplicates ? 'Spala MCP entries' : safeServerName} entry found.` });
      continue;
    }
    const content = applyJsonEdits(document.source, propertyRemovalEdits(bucket, removedProperties));
    writes.push({
      client,
      path: filePath,
      action: 'uninstall',
      backupPath: existed ? `${filePath}.bak-<timestamp>` : undefined,
      existed,
      content,
      originalContent: document.originalSource,
      format: 'json',
      removedEntries: removed,
      safetyRoot,
      pathLabel: 'JSON client config path',
      pathState,
      dryRun,
    });
  }

  return {
    dryRun,
    installScope: resolvedInstallScope,
    mcpUrl: normalizedUrl,
    serverName: safeServerName,
    cleanupDuplicates,
    writes,
    skipped,
  };
}

export function createDoctorReport({ clientSelection = 'all', cwd = process.cwd(), env = process.env, installScope, mcpUrl = PUBLIC_MCP_URL, serverName = PUBLIC_SERVER_NAME }) {
  const normalizedUrl = normalizeMcpUrl(mcpUrl, '');
  const resolvedInstallScope = normalizeInstallScope(installScope, normalizedUrl);
  const workspaceRoot = findWorkspaceRoot(cwd);
  const clients = selectedClients(clientSelection);
  const safeServerName = sanitizeServerName(serverName);
  const duplicateServerNames = publicLegacyNamesForTarget(safeServerName, normalizedUrl);
  const forced = shouldForceClient(clientSelection);
  const report = {
    node: {
      version: process.version,
      ok: Number(process.versions.node.split('.')[0]) >= 18,
    },
    expected: {
      serverName: safeServerName,
      mcpUrl: normalizedUrl,
      installScope: resolvedInstallScope,
    },
    clients: [],
    summary: {
      configFiles: 0,
      validJson: 0,
      installed: 0,
      duplicates: 0,
      issues: 0,
    },
  };

  for (const client of clients) {
    const mode = installMode(client, resolvedInstallScope);
    const filePath = targetPath(client, env, workspaceRoot, resolvedInstallScope);
    const safetyRoot = configSafetyRoot(client, env, workspaceRoot, resolvedInstallScope);
    const item = {
      client,
      label: CLIENT_LABELS[client] || client,
      writable: mode === 'writable',
      commandOnly: mode === 'command',
      path: filePath,
      exists: false,
      validJson: false,
      installed: false,
      duplicates: [],
      issues: [],
      skipped: false,
    };

    if (!item.writable) {
      const issue = item.commandOnly ? 'command_only' : `unsupported_${resolvedInstallScope}_scope`;
      if (forced) {
        item.issues.push(issue);
        report.summary.issues += 1;
      } else {
        item.skipped = true;
        item.reason = issue;
      }
      report.clients.push(item);
      continue;
    }

    if (client === 'codex') {
      try {
        assertSafePath(filePath, safetyRoot, 'Codex config path');
        if (resolvedInstallScope === 'user' && urlsMatch(normalizedUrl, PUBLIC_MCP_URL)) {
          assertSafePath(codexSkillPath(env), homeDir(env), 'Codex managed skill path');
        }
      } catch (error) {
        item.issues.push(`unsafe_config_path: ${error instanceof Error ? error.message : String(error)}`);
        report.summary.issues += 1;
        report.clients.push(item);
        continue;
      }
      try {
        const state = inspectCodexToml(filePath, safeServerName, normalizedUrl, duplicateServerNames, safetyRoot);
        item.exists = state.exists;
        item.validJson = state.exists;
        item.installed = state.installed;
        item.duplicates = state.duplicates || [];
        if (state.exists) {
          report.summary.configFiles += 1;
          report.summary.validJson += 1;
        }
        if (state.installed) report.summary.installed += 1;
        else {
          item.issues.push(state.mismatch ? 'expected_server_url_mismatch' : 'expected_server_missing');
          report.summary.issues += 1;
        }
        if (item.duplicates.length) {
          item.issues.push('duplicate_spala_entries');
          report.summary.duplicates += item.duplicates.length;
          report.summary.issues += 1;
        }
      } catch (error) {
        item.issues.push(`invalid_toml: ${error instanceof Error ? error.message : String(error)}`);
        report.summary.issues += 1;
      }
      report.clients.push(item);
      continue;
    }
    try {
      assertSafePath(filePath, safetyRoot, 'JSON client config path');
      item.exists = Boolean(filePath && fs.existsSync(filePath));
    } catch (error) {
      item.issues.push(`unsafe_config_path: ${error instanceof Error ? error.message : String(error)}`);
      report.summary.issues += 1;
      report.clients.push(item);
      continue;
    }
    if (!item.exists) {
      if (forced) {
        item.issues.push('config_missing');
        report.summary.issues += 1;
      } else {
        item.skipped = true;
        item.reason = 'config_missing';
      }
      report.clients.push(item);
      continue;
    }

    report.summary.configFiles += 1;
    try {
      const { document } = readJsonIfExists(filePath, safetyRoot);
      if (document.root.type !== 'object') throw new Error('Config root must be a JSON object.');
      item.validJson = true;
      report.summary.validJson += 1;
      const topKey = configBucketKey(client);
      const bucketProperty = uniqueProperty(document.root, topKey, 'Config root');
      if (bucketProperty && bucketProperty.value.type !== 'object') throw new Error(`Config key ${topKey} must be a JSON object.`);
      const bucket = bucketProperty?.value;
      const targetProperty = bucket ? uniqueProperty(bucket, safeServerName, `Config key ${topKey}`) : undefined;
      const legacyEntries = bucket
        ? duplicateServerNames.flatMap(name => {
          const matches = propertiesNamed(bucket, name);
          return matches.length === 1 && isExactPublicLegacyNode(name, matches[0].value, duplicateServerNames)
            ? [safeEntry(name)]
            : [];
        })
        : [];
      item.installed = Boolean(targetProperty && nodeEntryMatchesUrl(targetProperty.value, normalizedUrl));
      if (item.installed) report.summary.installed += 1;
      if (legacyEntries.length) {
        item.duplicates = legacyEntries;
        item.issues.push('duplicate_spala_entries');
        report.summary.duplicates += legacyEntries.length;
        report.summary.issues += 1;
      }
      if (targetProperty && !item.installed) {
        item.issues.push('expected_server_url_mismatch');
        report.summary.issues += 1;
      } else if (!item.installed) {
        item.issues.push('expected_server_missing');
        report.summary.issues += 1;
      }
    } catch (error) {
      item.issues.push(`invalid_json: ${error instanceof Error ? error.message : String(error)}`);
      report.summary.issues += 1;
    }

    report.clients.push(item);
  }

  report.ok = report.node.ok && report.summary.issues === 0;
  return report;
}

export function installPlan(plan, { fileOperationHook } = {}) {
  if (plan.dryRun) return { writes: [] };
  const writes = [];
  const createdComponents = new Map();
  try {
    for (const write of plan.writes) {
      assertSafePath(write.path, write.safetyRoot, write.pathLabel, write.pathState);
    }
    for (const write of plan.writes) {
      recoverSafeFileWrite(write, fileOperationHook);
    }
    for (const write of plan.writes) {
      if (write.action === 'unchanged') continue;
      assertSafePath(write.path, write.safetyRoot, write.pathLabel, write.pathState);
    }
    for (const write of plan.writes) {
      if (write.action === 'unchanged') continue;
      let expectedPathState = write.pathState;
      const trustedMissingComponent = createdComponents.get(expectedPathState?.firstMissing);
      if (trustedMissingComponent) {
        const refreshed = assertSafePath(
          write.path,
          write.safetyRoot,
          write.pathLabel,
          expectedPathState,
          { allowMissingChange: true },
        );
        const expectedPaths = new Set(expectedPathState.components.map(component => component.path));
        const untrusted = refreshed.components
          .filter(component => !expectedPaths.has(component.path))
          .find(component => {
            const trusted = createdComponents.get(component.path);
            return !trusted
              || trusted.dev !== component.dev
              || trusted.ino !== component.ino
              || trusted.kind !== component.kind;
          });
        if (untrusted) {
          throw new Error(`${write.pathLabel || 'Installer path'} changed after it was inspected; refusing to continue.`);
        }
        expectedPathState = refreshed;
      }
      const parentExisted = fs.existsSync(path.dirname(write.path));
      const transaction = {
        ...write,
        appliedPathState: expectedPathState,
        artifacts: [],
        backupPath: undefined,
        createdDirectories: [],
        currentPathState: expectedPathState,
        parentExisted,
        targetMutated: false,
      };
      writes.push(transaction);
      const outcome = applySafeFileWrite(transaction, fileOperationHook);
      transaction.appliedPathState = outcome.pathState;
      for (const component of outcome.pathState.components) {
        if (!expectedPathState?.components.some(expected => expected.path === component.path)) {
          createdComponents.set(component.path, component);
        }
      }
    }
  } catch (error) {
    const rollback = rollbackInstallPlan({ writes }, { fileOperationHook });
    if (!rollback.ok && error && typeof error === 'object') error.changed = true;
    throw error;
  }
  return { writes };
}

export function rollbackInstallPlan(result, { fileOperationHook } = {}) {
  const errors = [];
  for (const write of [...(result?.writes || [])].reverse()) {
    errors.push(...rollbackSafeFileWrite(write, fileOperationHook));
  }
  return { ok: errors.length === 0, errors };
}

export function buildCommandHints(serverName, mcpUrl, installScope = 'user') {
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const isPublicMcp = normalizeComparableMcpUrl(mcpUrl) === normalizeComparableMcpUrl(PUBLIC_MCP_URL);
  const commandScope = installScope === 'workspace' ? 'project' : 'user';
  const codexAddArgs = isPublicMcp && installScope === 'user'
    ? ['npx', '--yes', INSTALLER_PACKAGE_SPEC, 'init', '--client', 'codex', '--yes', '--json']
    : null;
  const codexAdd = codexAddArgs?.map(quote).join(' ') || null;
  return {
    codexAdd,
    codexLogin: null,
    claudeCode: `claude mcp add --transport http --scope ${commandScope} ${quote(serverName)} ${quote(mcpUrl)}`,
    geminiCli: `gemini mcp add ${quote(serverName)} --transport http --scope ${commandScope} ${quote(mcpUrl)}`,
    argv: {
      codexAdd: codexAddArgs,
      codexLogin: null,
      claudeCode: ['claude', 'mcp', 'add', '--transport', 'http', '--scope', commandScope, serverName, mcpUrl],
      geminiCli: ['gemini', 'mcp', 'add', serverName, '--transport', 'http', '--scope', commandScope, mcpUrl],
    },
  };
}

export function buildProxyCommandHints(serverName, projectId) {
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const proxy = proxyCommandForProject(projectId);
  const claudeArgs = ['claude', 'mcp', 'add', '--transport', 'stdio', '--scope', 'project', serverName, '--', proxy.command, ...proxy.args];
  const geminiArgs = ['gemini', 'mcp', 'add', '--scope', 'project', serverName, proxy.command, ...proxy.args];
  return {
    claudeCode: claudeArgs.map(quote).join(' '),
    geminiCli: geminiArgs.map(quote).join(' '),
    argv: { claudeCode: claudeArgs, geminiCli: geminiArgs },
  };
}

export function formatClientList() {
  const lines = clientInstallCapabilities().map(client => `${client.name} (${client.label}): user=${client.user}, workspace=${client.workspace}`);
  return `Client install capabilities:\n  ${lines.join('\n  ')}`;
}
