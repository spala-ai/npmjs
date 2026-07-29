import readline from 'node:readline';
import { projectCredentialStatus, readProjectCredential } from './credentialStore.js';
import { findWorkspaceRoot } from './workspace.js';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
// Project MCP calls are interactive; a hung backend must surface quickly,
// not stall the whole client for ten minutes.
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

function boundedIntFromEnv(env, name, fallback, minimum, maximum) {
  const raw = Number.parseInt(env?.[name] ?? '', 10);
  return Number.isFinite(raw) && raw >= minimum && raw <= maximum ? raw : fallback;
}

function writeLine(stdout, text) {
  // Invariant: this promise always settles — including when the stream closes
  // or errors SYNCHRONOUSLY inside write(). Listeners are therefore attached
  // before write() is called, never after.
  if (stdout.destroyed || stdout.writableEnded) return Promise.resolve();
  if (typeof stdout.once !== 'function') {
    stdout.write(`${text}\n`);
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (typeof stdout.removeListener === 'function') {
        stdout.removeListener('drain', settle);
        stdout.removeListener('close', settle);
        stdout.removeListener('error', settle);
      }
      resolve();
    };
    stdout.once('drain', settle);
    stdout.once('close', settle);
    stdout.once('error', settle);
    let accepted;
    try {
      accepted = stdout.write(`${text}\n`);
    } catch {
      accepted = true;
    }
    if (accepted !== false || stdout.destroyed) settle();
  });
}

function responseMessages(contentType, body) {
  if (!body.trim()) return [];
  if (contentType.includes('text/event-stream')) {
    return body
      .split(/\r?\n\r?\n/)
      .flatMap(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()))
      .filter(Boolean)
      .map(value => JSON.parse(value));
  }
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function emitMessages(messages, stdout) {
  for (const message of messages) await writeLine(stdout, JSON.stringify(message));
}

async function boundedText(response, maxBodyBytes) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        bytes += value.byteLength ?? value.length ?? 0;
        if (bytes > maxBodyBytes) {
          await reader.cancel?.().catch(() => {});
          throw safeRemoteError('MCP proxy response exceeded the configured size limit.');
        }
        text += decoder.decode(value, { stream: true });
      }
      if (done) return text + decoder.decode();
    }
  }
  const text = await response.text();
  if (text.length > maxBodyBytes) {
    throw safeRemoteError('MCP proxy response exceeded the configured size limit.');
  }
  return text;
}

// Invariants: a FINITE stream (POST response) is capped by cumulative raw
// bytes; a PERSISTENT stream (GET event channel) is capped per event only —
// total session traffic is legitimately unbounded there. Both limits count
// raw UTF-8 bytes, never decoded characters.
async function emitSseStream(body, stdout, { maxTotalBytes, maxEventBytes }) {
  if (!body?.getReader) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  const oversized = async () => {
    await reader.cancel?.().catch(() => {});
    throw safeRemoteError('MCP proxy event stream exceeded the configured size limit.');
  };
  const emitEvent = async event => {
    if (Buffer.byteLength(event, 'utf8') > maxEventBytes) await oversized();
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (data) await emitMessages([JSON.parse(data)], stdout);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (value) totalBytes += value.byteLength ?? value.length ?? 0;
    if (maxTotalBytes !== null && totalBytes > maxTotalBytes) await oversized();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || '\n\n';
      buffer = buffer.slice(boundary + separator.length);
      await emitEvent(event);
      boundary = buffer.search(/\r?\n\r?\n/);
    }
    // The unterminated remainder is a single in-flight event; cap it too.
    if (Buffer.byteLength(buffer, 'utf8') > maxEventBytes) await oversized();
    if (done) break;
  }
  if (buffer.trim()) await emitEvent(buffer);
}

async function emitResponse(response, stdout, maxBodyBytes) {
  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType.includes('text/event-stream') && response.body?.getReader) {
    await emitSseStream(response.body, stdout, { maxTotalBytes: maxBodyBytes, maxEventBytes: maxBodyBytes });
    return;
  }
  await emitMessages(responseMessages(contentType, await boundedText(response, maxBodyBytes)), stdout);
}

function safeRemoteError(message) {
  return new Error(message, { cause: undefined });
}

export async function runProxy({ projectId, env = process.env, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, fetchImpl = globalThis.fetch }) {
  if (!projectId) throw new Error('proxy requires --project-id.');
  if (typeof fetchImpl !== 'function') throw new Error('MCP proxy is unavailable in this Node runtime.');
  const maxBodyBytes = boundedIntFromEnv(env, 'SPALA_MCP_PROXY_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, 65_536, 1_073_741_824);
  const requestTimeoutMs = boundedIntFromEnv(env, 'SPALA_MCP_PROXY_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 3_600_000);
  const workspaceRoot = findWorkspaceRoot(cwd);
  // Missing credentials are a configuration error and still fail the spawn.
  // An expired-but-present credential must NOT kill the proxy: the server
  // stays up, requests answer with an actionable error, and a re-bind heals
  // the live session without a client restart.
  let credential = null;
  if (projectCredentialStatus(projectId, env, workspaceRoot).status === 'expired') {
    process.stderr?.write?.(`Spala MCP proxy: stored credential for project ${projectId} is expired; requests will error until the project is re-bound.\n`);
  } else {
    credential = readProjectCredential(projectId, env, workspaceRoot);
  }
  let sessionId;
  let protocolVersion = DEFAULT_PROTOCOL_VERSION;
  let eventStream;
  const eventAbort = new AbortController();
  const input = readline.createInterface({ input: stdin, crlfDelay: Infinity });

  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        throw new Error('MCP proxy received invalid JSON on stdin.');
      }
      if (request?.method === 'initialize' && typeof request?.params?.protocolVersion === 'string') {
        protocolVersion = request.params.protocolVersion;
      }
      // Re-read the stored credential on every request. Long-lived proxies
      // outlive short-TTL bearers; a re-bind refreshes the store and the
      // running proxy must pick it up without a restart. When the credential
      // is expired or missing, answer the request with an actionable JSON-RPC
      // error instead of hanging against the backend or killing the process —
      // a later re-bind then heals the live session.
      try {
        credential = readProjectCredential(projectId, env, workspaceRoot);
      } catch (credentialError) {
        if (request?.id !== undefined && request?.id !== null) {
          await emitMessages([{
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32000,
              message: `${credentialError instanceof Error ? credentialError.message : 'Stored project credential is unavailable.'} Re-run the project bind (project_connect) for project ${projectId}; the running proxy picks up fresh credentials automatically.`,
            },
          }], stdout);
        }
        continue;
      }
      const headers = {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${credential.bearerToken}`,
        'content-type': 'application/json',
        'mcp-protocol-version': protocolVersion,
      };
      if (sessionId) headers['mcp-session-id'] = sessionId;
      let response;
      try {
        response = await fetchImpl(credential.mcpUrl, {
          method: 'POST',
          redirect: 'error',
          headers,
          body: JSON.stringify(request),
          ...(typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(requestTimeoutMs) } : {}),
        });
      } catch {
        throw safeRemoteError('MCP proxy could not reach the project backend.');
      }
      if (!response?.ok && response?.status !== 202) {
        throw safeRemoteError(`MCP proxy request failed with HTTP ${response?.status || 'error'}.`);
      }
      const returnedSession = response.headers?.get?.('mcp-session-id');
      if (returnedSession) sessionId = returnedSession;
      if (sessionId && !eventStream) {
        const eventHeaders = {
          accept: 'text/event-stream',
          authorization: `Bearer ${credential.bearerToken}`,
          'mcp-protocol-version': protocolVersion,
          'mcp-session-id': sessionId,
        };
        eventStream = (async () => {
          try {
            const eventResponse = await fetchImpl(credential.mcpUrl, {
              method: 'GET',
              redirect: 'error',
              headers: eventHeaders,
              signal: eventAbort.signal,
            });
            if (eventResponse?.ok && (eventResponse.headers?.get?.('content-type') || '').includes('text/event-stream')) {
              // Persistent channel: per-event cap only; no cumulative cap.
              await emitSseStream(eventResponse.body, stdout, { maxTotalBytes: null, maxEventBytes: maxBodyBytes });
            }
          } catch {
            // The GET channel is optional; request/response traffic continues over POST.
          }
        })();
      }
      if (response.status === 202 || response.status === 204) continue;
      try {
        await emitResponse(response, stdout, maxBodyBytes);
      } catch (error) {
        if (error instanceof Error && error.message.includes('size limit')) throw error;
        throw safeRemoteError('MCP proxy received an invalid response from the project backend.');
      }
    }
  } finally {
    eventAbort.abort();
    if (eventStream) await eventStream;
  }
}
