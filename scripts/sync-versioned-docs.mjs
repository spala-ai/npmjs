#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

const packagePath = new URL('../package.json', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const installerSpec = `@spala-ai/mcp-install@${packageJson.version}`;
const current = readFileSync(readmePath, 'utf8');
const pattern = /@spala-ai\/mcp-install@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;
const matches = current.match(pattern) || [];

if (matches.length === 0) {
  throw new Error('README.md contains no pinned @spala-ai/mcp-install command');
}

const synchronized = current.replace(pattern, installerSpec);
if (process.argv.includes('--check')) {
  if (synchronized !== current) {
    throw new Error(`README.md installer commands must use ${installerSpec}; run pnpm sync:versioned-docs`);
  }
  process.stdout.write(`[versioned-docs] ${matches.length} installer command(s) use ${installerSpec}\n`);
} else if (synchronized !== current) {
  writeFileSync(readmePath, synchronized);
  process.stdout.write(`[versioned-docs] synchronized README.md to ${installerSpec}\n`);
}
