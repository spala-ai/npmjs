import fs from 'node:fs';
import {
  DEFAULT_PROJECT_SCOPE,
  mcpEndpointsMatch,
  normalizeComparableMcpUrl,
} from './installer.js';

const MAX_BOOTSTRAP_CAPABILITY_BYTES = 16 * 1024;
const ALLOWED_PROJECT_SCOPES = new Set(DEFAULT_PROJECT_SCOPE.split(','));
const BOOTSTRAP_CAPABILITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

function isLocalHost(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

function hasAmbiguousPath(rawUrl, parsedUrl) {
  return rawUrl.includes('\\')
    || /%[0-9a-f]{2}/i.test(parsedUrl.pathname)
    || /%2e/i.test(rawUrl)
    || /\/{2,}/.test(parsedUrl.pathname)
    || /\/\.{1,2}(?:\/|[?#]|$)/.test(rawUrl);
}

export function validateBootstrapUrl(rawUrl, mcpUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error('Bootstrap capability did not contain a URL.');
  if (typeof mcpUrl !== 'string' || !mcpUrl.trim()) throw new Error('The requested MCP URL is invalid.');
  let bootstrap;
  let mcp;
  const trimmedBootstrapUrl = rawUrl.trim();
  const trimmedMcpUrl = mcpUrl.trim();
  try {
    bootstrap = new URL(trimmedBootstrapUrl);
    mcp = new URL(trimmedMcpUrl);
  } catch {
    throw new Error('The bootstrap capability or requested MCP URL is invalid.');
  }
  if (bootstrap.protocol !== 'https:' && !(bootstrap.protocol === 'http:' && isLocalHost(bootstrap.hostname))) {
    throw new Error('Bootstrap URL must use HTTPS, except localhost development URLs.');
  }
  if (bootstrap.username || bootstrap.password || bootstrap.hash || trimmedBootstrapUrl.includes('#')) {
    throw new Error('Bootstrap URL must not contain credentials or a fragment.');
  }
  if (bootstrap.search || trimmedBootstrapUrl.includes('?')) {
    throw new Error('Bootstrap URL must not contain query parameters.');
  }
  if (mcp.protocol !== 'https:' && !(mcp.protocol === 'http:' && isLocalHost(mcp.hostname))) {
    throw new Error('The requested MCP URL must use HTTPS, except localhost development URLs.');
  }
  if (mcp.username || mcp.password || mcp.hash || trimmedMcpUrl.includes('#')) {
    throw new Error('The requested MCP URL must not contain credentials or a fragment.');
  }
  if ([...mcp.searchParams.keys()].some(key => key !== 'scope')) {
    throw new Error('The requested MCP URL contains unsupported query parameters.');
  }
  if (hasAmbiguousPath(trimmedBootstrapUrl, bootstrap) || hasAmbiguousPath(trimmedMcpUrl, mcp)) {
    throw new Error('Bootstrap and MCP URL paths must not contain encoded or ambiguous path segments.');
  }

  const mcpPath = mcp.pathname.replace(/\/+$/, '') || '/';
  const capabilityPrefix = `${mcpPath}/agent-instructions/`;
  if (bootstrap.origin !== mcp.origin || !bootstrap.pathname.startsWith(capabilityPrefix)) {
    throw new Error('Bootstrap URL must belong to the exact requested MCP endpoint.');
  }
  const capabilityPath = bootstrap.pathname.slice(capabilityPrefix.length).split('/');
  if (
    capabilityPath.length !== 2
    || !BOOTSTRAP_CAPABILITY_ID_PATTERN.test(capabilityPath[0])
    || capabilityPath[1] !== 'consume'
  ) {
    throw new Error('Bootstrap URL must use the exact one-time capability consume path.');
  }
  return bootstrap.toString();
}

async function readCapabilityStream(stream) {
  let content = '';
  for await (const chunk of stream) {
    content += String(chunk);
    if (Buffer.byteLength(content) > MAX_BOOTSTRAP_CAPABILITY_BYTES) {
      throw new Error('Bootstrap capability input is too large.');
    }
  }
  return content;
}

async function readCapabilityTty(stdin, stderr) {
  if (typeof stdin.setRawMode !== 'function' || typeof stdin.on !== 'function') {
    throw new Error('--bootstrap-stdin requires a readable terminal or non-interactive stdin stream.');
  }

  const wasRaw = Boolean(stdin.isRaw);
  stderr?.write?.('Waiting for one-time Spala project authorization...\n');
  return new Promise((resolve, reject) => {
    let content = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for the one-time Spala project authorization.')), 60_000);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      try {
        stdin.setRawMode(wasRaw);
      } catch {}
      stdin.pause?.();
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve(content);
    };
    const onData = (chunk) => {
      const value = String(chunk);
      if (value.includes('\u0003')) return finish(new Error('One-time Spala project authorization was cancelled.'));
      content += value;
      if (Buffer.byteLength(content) > MAX_BOOTSTRAP_CAPABILITY_BYTES) {
        return finish(new Error('Bootstrap capability input is too large.'));
      }
      if (/\r|\n/.test(value)) finish();
    };
    const onEnd = () => finish();
    const onError = () => finish(new Error('Could not read the one-time Spala project authorization.'));

    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
    try {
      stdin.setRawMode(true);
      stdin.resume?.();
    } catch {
      finish(new Error('Could not secure terminal input for the one-time Spala project authorization.'));
    }
  });
}

export async function readBootstrapCapability({ stdin, fd, stderr } = {}) {
  let content;
  if (fd !== undefined) {
    if (!Number.isInteger(fd) || fd < 0) throw new Error('--bootstrap-fd must be a non-negative integer.');
    try {
      content = fs.readFileSync(fd, { encoding: 'utf8' });
    } catch {
      throw new Error('Could not read the bootstrap capability from the requested file descriptor.');
    }
  } else {
    if (!stdin) {
      throw new Error('--bootstrap-stdin requires a readable terminal or non-interactive stdin stream.');
    }
    if (stdin.isTTY) content = await readCapabilityTty(stdin, stderr);
    else {
      if (typeof stdin[Symbol.asyncIterator] !== 'function') {
        throw new Error('--bootstrap-stdin requires a readable terminal or non-interactive stdin stream.');
      }
      content = await readCapabilityStream(stdin);
    }
  }
  const values = content.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (values.length !== 1) throw new Error('Bootstrap capability input must contain exactly one URL.');
  return values[0];
}

export function parseProjectScopeSet(mcpUrl, label = 'The project MCP URL') {
  let parsed;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  const values = parsed.searchParams.getAll('scope');
  if (values.length === 0) return null;
  if (values.length !== 1) {
    throw new Error(`${label} contains duplicate project MCP scope parameters.`);
  }
  if (!values[0]) {
    throw new Error(`${label} contains an invalid project MCP scope.`);
  }
  const scopes = values[0].split(',');
  if (scopes.some(scope => !scope || !ALLOWED_PROJECT_SCOPES.has(scope))) {
    throw new Error(`${label} contains an unknown project MCP scope.`);
  }
  if (new Set(scopes).size !== scopes.length) {
    throw new Error(`${label} contains duplicate project MCP scopes.`);
  }
  return new Set(scopes);
}

export function projectScopeSetsEqual(left, right) {
  return left.size === right.size && [...left].every(scope => right.has(scope));
}

function validateBootstrapScopes(requested, response) {
  if (requested) {
    if (!response || !projectScopeSetsEqual(requested, response)) {
      throw new Error('The one-time project bootstrap response changed the requested MCP authorization scope.');
    }
    return;
  }
  if (response && !projectScopeSetsEqual(response, ALLOWED_PROJECT_SCOPES)) {
    throw new Error('A bare MCP URL may only adopt the canonical default project scope.');
  }
}

export async function consumeBootstrap({
  bootstrapUrl,
  mcpUrl,
  codeVerifier,
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000,
}) {
  const validatedUrl = validateBootstrapUrl(bootstrapUrl, mcpUrl);
  const requestedScopes = parseProjectScopeSet(mcpUrl, 'The requested MCP URL');
  if (codeVerifier !== undefined && (
    typeof codeVerifier !== 'string'
    || codeVerifier.length < 43
    || codeVerifier.length > 128
    || !/^[A-Za-z0-9._~-]+$/.test(codeVerifier)
  )) {
    throw new Error('The local project authorization verifier is invalid.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1000) {
    throw new Error('Bootstrap exchange timeout is invalid.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Bootstrap exchange is unavailable in this Node runtime.');
  const controller = new AbortController();
  let timeout;
  let response;
  let payload;
  let failureMessage;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('bootstrap timeout'));
    }, timeoutMs);
  });
  try {
    response = await Promise.race([
      fetchImpl(validatedUrl, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(codeVerifier !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(codeVerifier !== undefined ? { body: JSON.stringify({ codeVerifier }) } : {}),
      }),
      deadline,
    ]);
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : '';
      failureMessage = `The one-time project bootstrap exchange was rejected${status}. Request a fresh project connection.`;
      throw new Error('bootstrap rejected');
    }
    try {
      payload = await Promise.race([response.json(), deadline]);
    } catch {
      if (!controller.signal.aborted) {
        failureMessage = 'The one-time project bootstrap response was invalid. Request a fresh project connection.';
      }
      throw new Error('bootstrap body failed');
    }
  } catch {
    throw new Error(failureMessage || 'The one-time project bootstrap exchange failed. Request a fresh project connection.');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const bearerToken = payload?.access_token;
  if (typeof bearerToken !== 'string' || !bearerToken || bearerToken.length > 16 * 1024 || /[\0\r\n]/.test(bearerToken)) {
    throw new Error('The one-time project bootstrap response did not contain a valid MCP bearer.');
  }
  // Canonical endpoint form: validated https URL, trailing slash trimmed,
  // scope query preserved. This is what gets stored and bound.
  const rawResponseMcpUrl = payload?.mcp_url;
  const responseScopes = typeof rawResponseMcpUrl === 'string'
    ? parseProjectScopeSet(rawResponseMcpUrl, 'The bootstrap response MCP URL')
    : null;
  const responseMcpUrl = typeof rawResponseMcpUrl === 'string'
    ? normalizeComparableMcpUrl(rawResponseMcpUrl)
    : undefined;
  if (!responseMcpUrl || !mcpEndpointsMatch(responseMcpUrl, mcpUrl)) {
    throw new Error('The one-time project bootstrap response did not match the requested MCP endpoint.');
  }
  validateBootstrapScopes(requestedScopes, responseScopes);
  const expiresAt = payload?.expires_at;
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    throw new Error('The one-time project bootstrap response did not include a valid credential expiry.');
  }
  return { bearerToken, mcpUrl: responseMcpUrl, expiresAt: new Date(Date.parse(expiresAt)).toISOString() };
}
