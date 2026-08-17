import fs from 'node:fs';

// Single source of truth for the pinned installer spec: always this package's
// own version, so release bumps can never desync the entries and commands the
// installer writes (the 0.1.15/0.1.16 mismatch class of bug).
export const INSTALLER_PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
export const INSTALLER_PACKAGE_SPEC = `@spala-ai/mcp-install@${INSTALLER_PACKAGE_VERSION}`;

// Persistent local recovery instructions must not freeze clients on the
// installer version that originally wrote them. Project handoff argv remains
// exact-version pinned through INSTALLER_PACKAGE_SPEC; only human/agent-invoked
// maintenance commands use the npm latest channel.
export const INSTALLER_MAINTENANCE_SPEC = '@spala-ai/mcp-install@latest';
