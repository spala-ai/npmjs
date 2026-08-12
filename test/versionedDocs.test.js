import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('README installer commands resolve the current npm release dynamically', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const pinnedSpecs = readme.match(/@spala-ai\/mcp-install@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g) || [];
  const dynamicCommands = readme.match(/(?:npx --yes|pnpm dlx) @spala-ai\/mcp-install(?:\s|`)/g) || [];

  assert.deepEqual(pinnedSpecs, [], 'README must not pin installer commands to a package version');
  assert.ok(dynamicCommands.length > 0, 'README must contain an unversioned installer command');
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(packageJson.author, 'Spala AI <info@spala.ai>');
});
