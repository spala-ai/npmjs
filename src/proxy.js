import readline from 'node:readline';
import { projectCredentialStatus, readProjectCredential } from './credentialStore.js';
import { mcpAuthorizationMatches } from './installer.js';
import { readProjectBinding } from './workspace.js';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_STDOUT_DRAIN_TIMEOUT_MS = 15_000;
const DEFAULT_FIRST_INPUT_TIMEOUT_MS = 30_000;
const DEFAULT_EVENT_STREAM_STOP_TIMEOUT_MS = 2_000;
const ERROR_RESPONSE_CANCEL_TIMEOUT_MS = 250;

class ProxyOutputError extends Error {}

function boundedIntFromEnv(env, name, fallback, minimum, maximum) {
  const raw = Number.parseInt(env?.[name] ?? '', 10);
  return Number.isFinite(raw) && raw >= minimum && raw <= maximum ? raw : fallback;
}

function writeLine(stdout, text, drainTimeoutMs, signal) {
  // Invariant: this promise always settles — including when the stream closes
  // or errors SYNCHRONOUSLY inside write(). Listeners are therefore attached
  // before write() is called, never after.
  if (stdout.destroyed || stdout.writableEnded) {
    return Promise.reject(new ProxyOutputError('MCP proxy stdout is closed.'));
  }
  if (signal?.aborted) {
    return Promise.reject(new ProxyOutputError('MCP proxy event delivery was cancelled.'));
  }
  if (typeof stdout.once !== 'function') {
    stdout.write(`${text}\n`);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const settle = error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (typeof stdout.removeListener === 'function') {
        stdout.removeListener('drain', onDrain);
        stdout.removeListener('close', onClose);
        stdout.removeListener('error', onError);
      }
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => settle();
    const onClose = () => settle(new ProxyOutputError('MCP proxy stdout closed before the response was delivered.'));
    const onError = () => settle(new ProxyOutputError('MCP proxy stdout failed.'));
    const onAbort = () => settle(new ProxyOutputError('MCP proxy event delivery was cancelled.'));
    stdout.once('drain', onDrain);
    stdout.once('close', onClose);
    stdout.once('error', onError);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    let accepted;
    try {
      accepted = stdout.write(`${text}\n`);
    } catch {
      settle(new ProxyOutputError('MCP proxy stdout failed.'));
      return;
    }
    if (accepted !== false || stdout.destroyed) {
      settle(stdout.destroyed || stdout.writableEnded
        ? new ProxyOutputError('MCP proxy stdout closed before the response was delivered.')
        : undefined);
      return;
    }
    if (settled) return;
    timer = setTimeout(() => {
      settle(new ProxyOutputError('MCP proxy stdout remained backpressured; restart the MCP connection.'));
    }, drainTimeoutMs);
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

async function emitMessages(messages, stdout, drainTimeoutMs, signal) {
  for (const message of messages) await writeLine(stdout, JSON.stringify(message), drainTimeoutMs, signal);
}

async function cancelResponseBody(response) {
  if (typeof response?.body?.cancel !== 'function') return;
  let timeout;
  try {
    await Promise.race([
      Promise.resolve().then(() => response.body.cancel()).catch(() => undefined),
      new Promise(resolve => { timeout = setTimeout(resolve, ERROR_RESPONSE_CANCEL_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
async function emitSseStream(body, stdout, { maxTotalBytes, maxEventBytes, drainTimeoutMs, onReader, signal }) {
  if (!body?.getReader) return;
  const reader = body.getReader();
  onReader?.(reader);
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
    if (data) await emitMessages([JSON.parse(data)], stdout, drainTimeoutMs, signal);
  };
  try {
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
  } finally {
    onReader?.(undefined);
  }
}

async function emitResponse(response, stdout, maxBodyBytes, drainTimeoutMs) {
  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType.includes('text/event-stream') && response.body?.getReader) {
    await emitSseStream(response.body, stdout, { maxTotalBytes: maxBodyBytes, maxEventBytes: maxBodyBytes, drainTimeoutMs });
    return;
  }
  await emitMessages(responseMessages(contentType, await boundedText(response, maxBodyBytes)), stdout, drainTimeoutMs);
}

function safeRemoteError(message) {
  return new Error(message, { cause: undefined });
}

export async function runProxy({ projectId, env = process.env, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, fetchImpl = globalThis.fetch }) {
  if (!projectId) throw new Error('proxy requires --project-id.');
  if (typeof fetchImpl !== 'function') throw new Error('MCP proxy is unavailable in this Node runtime.');
  const maxBodyBytes = boundedIntFromEnv(env, 'SPALA_MCP_PROXY_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, 65_536, 1_073_741_824);
  const requestTimeoutMs = boundedIntFromEnv(env, 'SPALA_MCP_PROXY_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 3_600_000);
  const stdoutDrainTimeoutMs = boundedIntFromEnv(env, 'SPALA_MCP_PROXY_STDOUT_TIMEOUT_MS', DEFAULT_STDOUT_DRAIN_TIMEOUT_MS, 100, 300_000);
  const firstInputTimeoutMs = boundedIntFromEnv(env, 'SPALA_MCP_PROXY_FIRST_INPUT_TIMEOUT_MS', DEFAULT_FIRST_INPUT_TIMEOUT_MS, 1_000, 300_000);
  const eventStreamStopTimeoutMs = boundedIntFromEnv(env, 'SPALA_MCP_PROXY_EVENT_STOP_TIMEOUT_MS', DEFAULT_EVENT_STREAM_STOP_TIMEOUT_MS, 50, 30_000);
  const { binding, workspaceRoot } = readProjectBinding(cwd, { required: true });
  if (binding.projectId !== projectId) {
    throw new Error('MCP proxy project does not match the current workspace binding. Rebind this workspace before retrying.');
  }
  if (projectCredentialStatus(projectId, env, workspaceRoot).status === 'expired') {
    process.stderr?.write?.(`Spala MCP proxy: stored credential for project ${projectId} is expired; requests will error until the project is re-bound.\n`);
  } else {
    readProjectCredential(projectId, env, workspaceRoot);
  }
  let sessionId;
  let protocolVersion = DEFAULT_PROTOCOL_VERSION;
  let eventStream;
  let eventAbort;
  let eventReader;
  let eventGeneration = 0;
  let credentialIdentity;
  let rejectEventFailure;
  const eventFailure = new Promise((_, reject) => { rejectEventFailure = reject; });
  eventFailure.catch(() => {});
  const input = readline.createInterface({ input: stdin, crlfDelay: Infinity });

  const stopEventStream = async () => {
    const stream = eventStream;
    const abort = eventAbort;
    const reader = eventReader;
    eventGeneration += 1;
    eventAbort = undefined;
    eventStream = undefined;
    eventReader = undefined;
    if (!stream && !reader) return;
    if (stream) {
      let settled = false;
      const observed = Promise.resolve(stream).finally(() => { settled = true; });
      await Promise.race([
        observed,
        new Promise(resolve => setImmediate(resolve)),
      ]);
      if (settled) return;
    }
    abort?.abort();
    const cancellation = typeof reader?.cancel === 'function'
      ? Promise.resolve().then(() => reader.cancel()).catch(() => undefined)
      : undefined;
    let timeout;
    try {
      await Promise.race([
        Promise.allSettled([
          stream,
          cancellation,
        ].filter(Boolean)),
        new Promise(resolve => {
          timeout = setTimeout(resolve, eventStreamStopTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const emitRecoverableError = async (request, message) => {
    if (request?.id === undefined || request?.id === null) return;
    await emitMessages([{
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32000, message },
    }], stdout, stdoutDrainTimeoutMs);
  };

  const iterator = input[Symbol.asyncIterator]();
  const nextInput = async first => {
    if (!first) return Promise.race([iterator.next(), eventFailure]);
    let timeout;
    try {
      return await Promise.race([
        iterator.next(),
        eventFailure,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('MCP proxy received no client input after startup. Restart the MCP connection.')), firstInputTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  try {
    let firstInput = true;
    while (true) {
      const next = await nextInput(firstInput);
      if (next.done) break;
      const line = next.value;
      if (!line.trim()) continue;
      firstInput = false;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        throw new Error('MCP proxy received invalid JSON on stdin.');
      }
      if (request?.method === 'initialize' && typeof request?.params?.protocolVersion === 'string') {
        protocolVersion = request.params.protocolVersion;
      }
      let credential;
      try {
        credential = readProjectCredential(projectId, env, workspaceRoot);
        if (!mcpAuthorizationMatches(binding.mcpUrl, credential.mcpUrl)) {
          throw new Error('The stored MCP credential endpoint or scope does not match the current workspace binding. Rebind this workspace with a fresh bootstrap capability.');
        }
      } catch (credentialError) {
        if (request?.id !== undefined && request?.id !== null) {
          await emitMessages([{
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32000,
              message: `${credentialError instanceof Error ? credentialError.message : 'Stored project credential is unavailable.'} Re-run project bind for project ${projectId}; the running proxy picks up fresh credentials automatically.`,
            },
          }], stdout, stdoutDrainTimeoutMs);
        }
        continue;
      }
      const nextCredentialIdentity = `${credential.mcpUrl}\n${credential.bearerToken}`;
      if (credentialIdentity && credentialIdentity !== nextCredentialIdentity) {
        await stopEventStream();
        sessionId = undefined;
      }
      credentialIdentity = nextCredentialIdentity;
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
        await emitRecoverableError(request, 'MCP proxy could not reach the project backend. Retry the request.');
        continue;
      }
      if (response?.status === 401) {
        await cancelResponseBody(response);
        await stopEventStream();
        sessionId = undefined;
        if (request?.id !== undefined && request?.id !== null) {
          await emitMessages([{
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32000,
              message: `The stored Spala project credential was rejected. Re-run project bind for project ${projectId}; the running proxy picks up the replacement credential automatically.`,
            },
          }], stdout, stdoutDrainTimeoutMs);
        }
        continue;
      }
      if (response?.status === 404 && sessionId) {
        await cancelResponseBody(response);
        await stopEventStream();
        sessionId = undefined;
        await emitRecoverableError(request, 'The MCP backend session expired. Retry the request to establish a new session.');
        continue;
      }
      if (!response?.ok && response?.status !== 202) {
        await cancelResponseBody(response);
        await emitRecoverableError(request, `MCP proxy request failed with HTTP ${response?.status || 'error'}. Retry the request.`);
        continue;
      }
      const returnedSession = response.headers?.get?.('mcp-session-id');
      if (returnedSession) sessionId = returnedSession;
      if (sessionId && !eventStream) {
        const generation = ++eventGeneration;
        const controller = new AbortController();
        eventAbort = controller;
        const eventHeaders = {
          accept: 'text/event-stream',
          authorization: `Bearer ${credential.bearerToken}`,
          'mcp-protocol-version': protocolVersion,
          'mcp-session-id': sessionId,
        };
        const stream = (async () => {
          try {
            const eventResponse = await fetchImpl(credential.mcpUrl, {
              method: 'GET',
              redirect: 'error',
              headers: eventHeaders,
              signal: controller.signal,
            });
            const eventContentType = eventResponse?.headers?.get?.('content-type') || '';
            if (eventResponse?.ok && eventContentType.includes('text/event-stream')) {
              // Persistent channel: per-event cap only; no cumulative cap.
              await emitSseStream(eventResponse.body, stdout, {
                maxTotalBytes: null,
                maxEventBytes: maxBodyBytes,
                drainTimeoutMs: stdoutDrainTimeoutMs,
                signal: controller.signal,
                onReader: reader => {
                  if (generation === eventGeneration) eventReader = reader;
                },
              });
            } else {
              await cancelResponseBody(eventResponse);
              if (eventResponse?.status === 404 && generation === eventGeneration) sessionId = undefined;
            }
          } catch (error) {
            if (error instanceof ProxyOutputError) rejectEventFailure(error);
            // GET transport failures are optional. Output failures are fatal
            // and wake the main stdin loop through eventFailure.
          }
        })();
        eventStream = stream;
        const clearSettledStream = () => {
          if (generation !== eventGeneration || eventStream !== stream) return;
          eventStream = undefined;
          eventAbort = undefined;
          eventReader = undefined;
        };
        stream.then(clearSettledStream, clearSettledStream);
      }
      if (response.status === 202 || response.status === 204) continue;
      try {
        await emitResponse(response, stdout, maxBodyBytes, stdoutDrainTimeoutMs);
      } catch (error) {
        if (error instanceof ProxyOutputError) throw error;
        if (error instanceof Error && error.message.includes('size limit')) throw error;
        throw safeRemoteError('MCP proxy received an invalid response from the project backend.');
      }
    }
  } finally {
    input.close();
    await stopEventStream();
  }
}
