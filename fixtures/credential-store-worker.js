import fs from 'node:fs';
import path from 'node:path';
import {
  credentialStorePath,
  readProjectCredential,
  removeProjectCredential,
  storeProjectCredential,
} from '../src/credentialStore.js';

const options = JSON.parse(process.argv[2] || '{}');
if (!options.credentialHome || !options.operation) {
  throw new Error('credential-store-worker requires a credential home and operation.');
}

const credentialEnv = { SPALA_MCP_CREDENTIAL_HOME: options.credentialHome };
const journalPath = `${credentialStorePath(credentialEnv)}.journal`;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function waitForRelease(releasePath) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the credential-store test barrier.');
    Atomics.wait(waitBuffer, 0, 0, 10);
  }
}

function reachBarrier() {
  fs.writeFileSync(options.markerPath, 'ready\n', { flag: 'wx', mode: 0o600 });
  waitForRelease(options.releasePath);
}

if (options.hook === 'pause-before-first-claim') {
  const originalLinkSync = fs.linkSync;
  let paused = false;
  fs.linkSync = (source, destination) => {
    if (!paused && path.dirname(destination) === journalPath && /^\d+$/.test(path.basename(destination))) {
      paused = true;
      reachBarrier();
    }
    return originalLinkSync(source, destination);
  };
}

if (options.hook === 'crash-before-first-claim') {
  const originalLinkSync = fs.linkSync;
  fs.linkSync = (source, destination) => {
    if (path.dirname(destination) === journalPath && /^\d+$/.test(path.basename(destination))) {
      process.exit(86);
    }
    return originalLinkSync(source, destination);
  };
}

if (options.hook === 'pause-after-version-scan') {
  const originalReaddirSync = fs.readdirSync;
  let paused = false;
  fs.readdirSync = (directory, ...args) => {
    const entries = originalReaddirSync(directory, ...args);
    if (!paused
      && directory === journalPath
      && entries.some(name => typeof name === 'string' && /^\d+$/.test(name))) {
      paused = true;
      reachBarrier();
    }
    return entries;
  };
}

if (options.hook === 'pause-after-empty-version-scan') {
  const originalReaddirSync = fs.readdirSync;
  let paused = false;
  fs.readdirSync = (directory, ...args) => {
    const entries = originalReaddirSync(directory, ...args);
    if (!paused
      && directory === journalPath
      && !entries.some(name => typeof name === 'string' && /^\d+$/.test(name))) {
      paused = true;
      reachBarrier();
    }
    return entries;
  };
}

process.stdout.write('ready\n');

let result;
if (options.operation === 'store') {
  result = storeProjectCredential({
    projectId: options.projectId,
    mcpUrl: `https://${options.projectId}.spala.test/mcp`,
    bearerToken: options.bearerToken,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }, credentialEnv);
} else if (options.operation === 'read') {
  result = readProjectCredential(options.projectId, credentialEnv);
} else if (options.operation === 'remove') {
  result = removeProjectCredential(options.projectId, credentialEnv);
} else {
  throw new Error(`Unsupported credential-store worker operation: ${String(options.operation)}`);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
