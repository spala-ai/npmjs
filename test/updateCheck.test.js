import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateCheck, isNewerVersion, UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_URL } from '../src/updateCheck.js';

const manifest = version => new Response(JSON.stringify({ installer: { package: '@spala-ai/mcp-install', version } }));
const request = { id: 1, method: 'tools/call' };
const message = { id: 1, result: { content: [{ type: 'text', text: 'original' }], structuredContent: { count: 3 }, isError: false } };

test('compares numeric stable versions without downgrades or accepting remote command text', () => {
  assert.equal(isNewerVersion('0.1.100', '0.1.34'), true);
  for (const v of ['0.1.34', '0.1.9', '0.1.35-beta', '0.01.35', 'latest', '0.1.35; echo secret', '999999999999999999999.1.1']) {
    assert.equal(isNewerVersion(v, '0.1.34'), false, v);
  }
});

test('checks at startup and on activity every 15 minutes, announces once per newer version', async () => {
  let time = 0, calls = 0, version = '0.1.35';
  const check = createUpdateCheck({ installedVersion: '0.1.34', now: () => time, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, UPDATE_CHECK_URL);
    assert.deepEqual(options.headers, { accept: 'application/json' });
    assert.equal(options.redirect, 'error');
    return manifest(version);
  } });
  await Promise.all([check.check(), check.check()]);
  assert.equal(calls, 1);
  const decorated = check.decorate(message, request);
  assert.match(decorated.result.content[1].text, /0\.1\.34 → 0\.1\.35/);
  assert.deepEqual(decorated.result.structuredContent, message.result.structuredContent);
  assert.deepEqual(message.result.content, [{ type: 'text', text: 'original' }]);
  assert.equal(check.decorate(message, request), message);
  await check.check(); assert.equal(calls, 1);
  time += UPDATE_CHECK_INTERVAL_MS; await check.check(); assert.equal(calls, 2);
  assert.equal(check.decorate(message, request), message);
  time += UPDATE_CHECK_INTERVAL_MS; version = '0.1.36'; await check.check();
  assert.match(check.decorate(message, request).result.content[1].text, /0\.1\.36/);
});

test('initialize gets instructions, unrelated IDs and notifications are untouched', async () => {
  const check = createUpdateCheck({ installedVersion: '0.1.34', fetchImpl: async () => manifest('0.1.35') });
  await check.check();
  assert.equal(check.decorate(message, { id: 2, method: 'tools/call' }), message);
  const notification = { method: 'notifications/progress', params: {} };
  assert.equal(check.decorate(notification, request), notification);
  const init = check.decorate({ id: 1, result: { instructions: 'existing' } }, { id: 1, method: 'initialize' });
  assert.match(init.result.instructions, /^existing\nSpala installer update available/);
});

test('offline, invalid, oversized, wrong package and hung checks do not block or invent updates', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async () => new Response('invalid'),
    async () => new Response('x'.repeat(65537)),
    async () => new Response(JSON.stringify({ installer: { package: 'evil', version: '999.1.1' } })),
    async () => new Response('', { status: 503 }),
    async () => new Promise(() => {}),
    async () => manifest('0.1.34'),
    async () => manifest('0.1.33'),
  ]) {
    const check = createUpdateCheck({ installedVersion: '0.1.34', fetchImpl, timeoutMs: 10 });
    await check.check();
    assert.equal(check.decorate(message, request), message);
  }
});
