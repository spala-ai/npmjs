import readline from 'node:readline';
import { readProjectCredential } from './credentialStore.js';
import { findWorkspaceRoot } from './workspace.js';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

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

function emitMessages(messages, stdout) {
  for (const message of messages) stdout.write(`${JSON.stringify(message)}\n`);
}

async function emitSseStream(body, stdout) {
  if (!body?.getReader) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const emitEvent = event => {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (data) emitMessages([JSON.parse(data)], stdout);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || '\n\n';
      buffer = buffer.slice(boundary + separator.length);
      emitEvent(event);
      boundary = buffer.search(/\r?\n\r?\n/);
    }
    if (done) break;
  }
  if (buffer.trim()) emitEvent(buffer);
}

async function emitResponse(response, stdout) {
  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType.includes('text/event-stream') && response.body?.getReader) {
    await emitSseStream(response.body, stdout);
    return;
  }
  emitMessages(responseMessages(contentType, await response.text()), stdout);
}

function safeRemoteError(message) {
  return new Error(message, { cause: undefined });
}

export async function runProxy({ projectId, env = process.env, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, fetchImpl = globalThis.fetch }) {
  if (!projectId) throw new Error('proxy requires --project-id.');
  if (typeof fetchImpl !== 'function') throw new Error('MCP proxy is unavailable in this Node runtime.');
  const credential = readProjectCredential(projectId, env, findWorkspaceRoot(cwd));
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
              await emitSseStream(eventResponse.body, stdout);
            }
          } catch {
            // The GET channel is optional; request/response traffic continues over POST.
          }
        })();
      }
      if (response.status === 202 || response.status === 204) continue;
      try {
        await emitResponse(response, stdout);
      } catch {
        throw safeRemoteError('MCP proxy received an invalid response from the project backend.');
      }
    }
  } finally {
    eventAbort.abort();
    if (eventStream) await eventStream;
  }
}
