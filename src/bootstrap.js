import fs from 'node:fs';
import { mcpEndpointsMatch, normalizeComparableMcpUrl } from './installer.js';

const MAX_BOOTSTRAP_CAPABILITY_BYTES = 16 * 1024;

function isLocalHost(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

export function validateBootstrapUrl(rawUrl, projectUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error('Bootstrap capability did not contain a URL.');
  const bootstrap = new URL(rawUrl.trim());
  const project = new URL(projectUrl);
  if (bootstrap.protocol !== 'https:' && !(bootstrap.protocol === 'http:' && isLocalHost(bootstrap.hostname))) {
    throw new Error('Bootstrap URL must use HTTPS, except localhost development URLs.');
  }
  if (bootstrap.username || bootstrap.password || bootstrap.hash) {
    throw new Error('Bootstrap URL must not contain credentials or a fragment.');
  }
  const projectPath = `${project.pathname.replace(/\/+$/, '')}/`;
  if (bootstrap.origin !== project.origin || !`${bootstrap.pathname.replace(/\/+$/, '')}/`.startsWith(projectPath)) {
    throw new Error('Bootstrap URL must belong to the exact project backend.');
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

export async function consumeBootstrap({ bootstrapUrl, projectUrl, mcpUrl, codeVerifier, fetchImpl = globalThis.fetch }) {
  const validatedUrl = validateBootstrapUrl(bootstrapUrl, projectUrl);
  if (codeVerifier !== undefined && (
    typeof codeVerifier !== 'string'
    || codeVerifier.length < 43
    || codeVerifier.length > 128
    || !/^[A-Za-z0-9._~-]+$/.test(codeVerifier)
  )) {
    throw new Error('The local project authorization verifier is invalid.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Bootstrap exchange is unavailable in this Node runtime.');
  let response;
  try {
    response = await fetchImpl(validatedUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...(codeVerifier !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(codeVerifier !== undefined ? { body: JSON.stringify({ codeVerifier }) } : {}),
    });
  } catch {
    throw new Error('The one-time project bootstrap exchange failed. Request a fresh project connection.');
  }
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : '';
    throw new Error(`The one-time project bootstrap exchange was rejected${status}. Request a fresh project connection.`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The one-time project bootstrap response was invalid. Request a fresh project connection.');
  }
  const bearerToken = payload?.access_token;
  if (typeof bearerToken !== 'string' || !bearerToken || bearerToken.length > 16 * 1024 || /[\0\r\n]/.test(bearerToken)) {
    throw new Error('The one-time project bootstrap response did not contain a valid MCP bearer.');
  }
  // Canonical endpoint form: validated https URL, trailing slash trimmed,
  // scope query preserved. This is what gets stored and bound.
  const responseMcpUrl = typeof payload?.mcp_url === 'string'
    ? normalizeComparableMcpUrl(payload.mcp_url)
    : undefined;
  if (!responseMcpUrl || !mcpEndpointsMatch(responseMcpUrl, mcpUrl)) {
    throw new Error('The one-time project bootstrap response did not match the requested MCP endpoint.');
  }
  const expiresAt = payload?.expires_at;
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    throw new Error('The one-time project bootstrap response did not include a valid credential expiry.');
  }
  return { bearerToken, mcpUrl: responseMcpUrl, expiresAt: new Date(Date.parse(expiresAt)).toISOString() };
}
