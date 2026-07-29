import fs from 'node:fs';

// Single source of truth for the pinned installer spec: always this package's
// own version, so release bumps can never desync the entries and commands the
// installer writes (the 0.1.15/0.1.16 mismatch class of bug).
export const INSTALLER_PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
export const INSTALLER_PACKAGE_SPEC = `@spala-ai/mcp-install@${INSTALLER_PACKAGE_VERSION}`;
