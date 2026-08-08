import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('README installer commands pin the package version', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const specs = readme.match(/@spala-ai\/mcp-install@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g) || [];

  assert.ok(specs.length > 0);
  assert.deepEqual([...new Set(specs)], [`@spala-ai/mcp-install@${packageJson.version}`]);
});
