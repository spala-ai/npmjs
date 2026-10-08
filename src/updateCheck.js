import { INSTALLER_PACKAGE_VERSION } from './packageSpec.js';

export const UPDATE_CHECK_URL = 'https://mcp.spala.ai/mcp/install-manifest';
export const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isNewerVersion(candidate, installed) {
  const a = versionParts(candidate);
  const b = versionParts(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Only the service's tested installer pin is an upgrade target. Never execute
// commands supplied by a remote manifest or send project credentials to it.
export function createUpdateCheck({ fetchImpl = globalThis.fetch, now = Date.now, installedVersion = INSTALLER_PACKAGE_VERSION, timeoutMs = 1500 } = {}) {
  let nextCheck = -Infinity;
  let availableVersion;
  let announcedVersion;
  let checking;
  return {
    async check() {
      if (checking) return checking;
      if (now() < nextCheck) return;
      nextCheck = now() + UPDATE_CHECK_INTERVAL_MS;
      checking = (async () => {
        const controller = new AbortController();
        let timer;
        try {
          const result = await Promise.race([
            (async () => {
              const response = await fetchImpl(UPDATE_CHECK_URL, {
                headers: { accept: 'application/json' }, redirect: 'error', signal: controller.signal,
              });
              if (!response.ok) return undefined;
              const reader = response.body?.getReader();
              if (!reader) return undefined;
              const chunks = [];
              let bytes = 0;
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  bytes += value.byteLength;
                  if (bytes > 64 * 1024) { void reader.cancel().catch(() => {}); return undefined; }
                  chunks.push(Buffer.from(value));
                }
              } finally { reader.releaseLock(); }
              return JSON.parse(Buffer.concat(chunks).toString('utf8'));
            })(),
            new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, timeoutMs); }),
          ]);
          if (result?.installer?.package === '@spala-ai/mcp-install' && versionParts(result.installer.version)) {
            availableVersion = isNewerVersion(result.installer.version, installedVersion) ? result.installer.version : undefined;
          }
        } catch { /* Maintenance availability must not stop project work. */ }
        finally { clearTimeout(timer); }
      })();
      try { await checking; } finally { checking = undefined; }
    },
    decorate(message, request) {
      if (!availableVersion || availableVersion === announcedVersion || message?.id !== request?.id || !message?.result || message.error) return message;
      const notice = `Spala installer update available: ${installedVersion} → ${availableVersion}. Update this workspace's project MCP at a safe stopping point: call public project_connect for the currently bound project and current client, run the returned exact installer argv, then follow its reload instruction. Do not switch projects, edit credentials, run a parallel OAuth flow, or repeatedly retry in the old session. This is a maintenance notice; the project result is unchanged.`;
      let result;
      if (request.method === 'initialize') {
        result = { ...message.result, instructions: [message.result.instructions, notice].filter(Boolean).join('\n') };
      } else if (request.method === 'tools/call' && Array.isArray(message.result.content)) {
        result = { ...message.result, content: [...message.result.content, { type: 'text', text: notice }] };
      } else return message;
      announcedVersion = availableVersion;
      return { ...message, result };
    },
  };
}
