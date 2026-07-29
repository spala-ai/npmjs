import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import properLockfile from 'proper-lockfile';
import * as credentialStore from '../src/credentialStore.js';

const {
  credentialStorePath,
  readProjectCredential,
  storeProjectCredential,
} = credentialStore;
const WORKER_FLAG = '--credential-store-worker';
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function waitForRelease(releasePath) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the credential-store test release.');
    Atomics.wait(WAIT_BUFFER, 0, 0, 10);
  }
}

function writeMarker(markerPath) {
  fs.writeFileSync(markerPath, 'ready\n', { flag: 'wx', mode: 0o600 });
}

function installLockHooks(options) {
  const lockSync = properLockfile.lockSync;
  let contentionMarked = false;
  let lockPaused = false;
  properLockfile.lockSync = (...args) => {
    try {
      const release = lockSync(...args);
      if (options.pauseAfterLock && !lockPaused) {
        lockPaused = true;
        writeMarker(options.markerPath);
        waitForRelease(options.releasePath);
      }
      return release;
    } catch (error) {
      if (
        options.contentionMarkerPath
        && !contentionMarked
        && error
        && typeof error === 'object'
        && error.code === 'ELOCKED'
      ) {
        contentionMarked = true;
        writeMarker(options.contentionMarkerPath);
      }
      throw error;
    }
  };
}

function runWorker(options) {
  const env = { SPALA_MCP_CREDENTIAL_HOME: options.credentialHome };
  const storePath = credentialStorePath(env);
  installLockHooks(options);

  if (options.pauseBeforeRename) {
    const renameSync = fs.renameSync;
    let paused = false;
    fs.renameSync = (source, destination) => {
      if (!paused && path.resolve(destination) === storePath) {
        paused = true;
        writeMarker(options.markerPath);
        waitForRelease(options.releasePath);
      }
      return renameSync(source, destination);
    };
  }

  const result = storeProjectCredential({
    projectId: options.projectId,
    mcpUrl: `https://${options.projectId}.spala.test/mcp`,
    bearerToken: options.bearerToken,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }, env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[2] === WORKER_FLAG) {
  try {
    runWorker(JSON.parse(process.argv[3]));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spala-credential-concurrency-'));
}

function startWorker(options) {
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    WORKER_FLAG,
    JSON.stringify(options),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let result;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      result = { code, signal, stdout, stderr };
      resolve(result);
    });
  });
  return {
    child,
    exited,
    get result() {
      return result;
    },
  };
}

async function waitForPath(filePath, worker, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (worker.result) {
      assert.fail(`Credential worker exited before reaching its barrier: ${worker.result.stderr}`);
    }
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${path.basename(filePath)}.`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function assertSuccessfulWorker(result) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /bearer|token|secret/i);
}

function assertCredentialPathKindsAndModes(storePath) {
  const directoryStat = fs.statSync(path.dirname(storePath));
  const storeStat = fs.statSync(storePath);
  assert.equal(directoryStat.isDirectory(), true);
  assert.equal(storeStat.isFile(), true);
  if (process.platform !== 'win32') {
    assert.equal(directoryStat.mode & 0o777, 0o700);
    assert.equal(storeStat.mode & 0o777, 0o600);
  }
}

async function leaveCrashedLock(credentialHome, coordination) {
  const markerPath = path.join(coordination, 'lock-held');
  const releasePath = path.join(coordination, 'never-release');
  const worker = startWorker({
    credentialHome,
    projectId: 'crashed-lock-owner',
    bearerToken: 'mcp_crashed_lock_owner',
    pauseAfterLock: true,
    markerPath,
    releasePath,
  });
  await waitForPath(markerPath, worker);
  worker.child.kill('SIGKILL');
  const result = await worker.exited;
  assert.notEqual(result.code, 0);

  const storePath = credentialStorePath({ SPALA_MCP_CREDENTIAL_HOME: credentialHome });
  const lockPath = `${storePath}.lock`;
  assert.equal(fs.lstatSync(lockPath).isDirectory(), true);
  return lockPath;
}

if (process.argv[2] !== WORKER_FLAG) test('overlapping process writers serialize and preserve both flat-store projects', async () => {
  const credentialHome = tempHome();
  const coordination = tempHome();
  const firstMarker = path.join(coordination, 'first-before-rename');
  const firstRelease = path.join(coordination, 'release-first');
  const contentionMarker = path.join(coordination, 'second-contended');

  const first = startWorker({
    credentialHome,
    projectId: 'concurrent-project-a',
    bearerToken: 'mcp_concurrent_a',
    pauseBeforeRename: true,
    markerPath: firstMarker,
    releasePath: firstRelease,
  });
  await waitForPath(firstMarker, first);

  const second = startWorker({
    credentialHome,
    projectId: 'concurrent-project-b',
    bearerToken: 'mcp_concurrent_b',
    contentionMarkerPath: contentionMarker,
  });
  await waitForPath(contentionMarker, second);
  assert.equal(first.result, undefined);
  assert.equal(second.result, undefined);
  fs.writeFileSync(firstRelease, 'release\n', { flag: 'wx', mode: 0o600 });

  const [firstResult, secondResult] = await Promise.all([first.exited, second.exited]);
  assertSuccessfulWorker(firstResult);
  assertSuccessfulWorker(secondResult);

  const storePath = credentialStorePath({ SPALA_MCP_CREDENTIAL_HOME: credentialHome });
  const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.deepEqual(Object.keys(persisted).sort(), ['projects', 'schemaVersion']);
  assert.equal(persisted.schemaVersion, 1);
  assert.deepEqual(Object.keys(persisted.projects).sort(), [
    'concurrent-project-a',
    'concurrent-project-b',
  ]);
  assert.equal(persisted.projects['concurrent-project-a'].bearerToken, 'mcp_concurrent_a');
  assert.equal(persisted.projects['concurrent-project-b'].bearerToken, 'mcp_concurrent_b');
  assertCredentialPathKindsAndModes(storePath);
  assert.equal(fs.existsSync(`${storePath}.lock`), false);
});

if (process.argv[2] !== WORKER_FLAG) test('every configured-home credential parent rejects symlink redirection', () => {
  const fixtures = [
    {
      makeHome: (container, outside) => {
        const configuredHome = path.join(container, 'configured-home');
        fs.symlinkSync(outside, configuredHome, process.platform === 'win32' ? 'junction' : 'dir');
        return configuredHome;
      },
    },
    {
      makeHome: (container, outside) => {
        const configuredHome = path.join(container, 'configured-home');
        fs.mkdirSync(configuredHome);
        fs.symlinkSync(outside, path.join(configuredHome, '.config'), process.platform === 'win32' ? 'junction' : 'dir');
        return configuredHome;
      },
    },
    {
      makeHome: (container, outside) => {
        const configuredHome = path.join(container, 'configured-home');
        fs.mkdirSync(path.join(configuredHome, '.config'), { recursive: true });
        fs.symlinkSync(outside, path.join(configuredHome, '.config', 'spala'), process.platform === 'win32' ? 'junction' : 'dir');
        return configuredHome;
      },
    },
  ];

  for (const fixture of fixtures) {
    const container = tempHome();
    const outside = tempHome();
    const credentialHome = fixture.makeHome(container, outside);
    assert.throws(() => storeProjectCredential({
      projectId: 'must-not-escape',
      mcpUrl: 'https://must-not-escape.spala.test/mcp',
      bearerToken: 'mcp_must_not_escape',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }, { SPALA_MCP_CREDENTIAL_HOME: credentialHome }), /symbolic links/);
    assert.equal(fs.existsSync(path.join(outside, 'mcp-credentials.json')), false);
    assert.equal(fs.existsSync(path.join(outside, 'spala', 'mcp-credentials.json')), false);
  }
});

if (process.argv[2] !== WORKER_FLAG) test('a hard-linked credential store fails closed', {
  skip: process.platform === 'win32',
}, () => {
  const credentialHome = tempHome();
  const coordination = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  storeProjectCredential({
    projectId: 'original-project',
    mcpUrl: 'https://original-project.spala.test/mcp',
    bearerToken: 'mcp_original_project',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }, env);
  const storePath = credentialStorePath(env);
  const secondLink = path.join(coordination, 'credential-store-link.json');
  fs.linkSync(storePath, secondLink);
  const originalBody = fs.readFileSync(storePath, 'utf8');

  assert.throws(() => storeProjectCredential({
    projectId: 'must-not-be-written',
    mcpUrl: 'https://must-not-be-written.spala.test/mcp',
    bearerToken: 'mcp_must_not_be_written',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }, env), /hard-linked|multiple hard links/);

  assert.equal(fs.readFileSync(storePath, 'utf8'), originalBody);
  assert.equal(fs.readFileSync(secondLink, 'utf8'), originalBody);
  assert.equal(fs.statSync(storePath).nlink, 2);
});

if (process.argv[2] !== WORKER_FLAG) test('unsafe credential-store ownership and modes are rejected', {
  skip: process.platform === 'win32',
}, () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  storeProjectCredential({
    projectId: 'private-project',
    mcpUrl: 'https://private-project.spala.test/mcp',
    bearerToken: 'mcp_private_project',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }, env);
  const storePath = credentialStorePath(env);
  const getuid = process.getuid;
  process.getuid = () => getuid() + 1;
  try {
    assert.throws(
      () => readProjectCredential('private-project', env),
      /Spala credential store is owned by another user/,
    );
  } finally {
    process.getuid = getuid;
  }

  fs.chmodSync(storePath, 0o644);

  assert.throws(
    () => readProjectCredential('private-project', env),
    /must not be accessible by group or other users/,
  );
  assert.throws(() => storeProjectCredential({
    projectId: 'other-project',
    mcpUrl: 'https://other-project.spala.test/mcp',
    bearerToken: 'mcp_other_project',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }, env), /must not be accessible by group or other users/);
});

if (process.argv[2] !== WORKER_FLAG) test('proper-lockfile recovers a stale lock left by a crashed writer', async () => {
  const credentialHome = tempHome();
  const coordination = tempHome();
  const lockPath = await leaveCrashedLock(credentialHome, coordination);
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, staleTime, staleTime);

  const result = storeProjectCredential({
    projectId: 'stale-recovery-project',
    mcpUrl: 'https://stale-recovery-project.spala.test/mcp',
    bearerToken: 'mcp_stale_recovery',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }, { SPALA_MCP_CREDENTIAL_HOME: credentialHome });

  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(lockPath), false);
  const storePath = credentialStorePath({ SPALA_MCP_CREDENTIAL_HOME: credentialHome });
  const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.deepEqual(Object.keys(persisted).sort(), ['projects', 'schemaVersion']);
  assert.deepEqual(Object.keys(persisted.projects), ['stale-recovery-project']);
  assertCredentialPathKindsAndModes(storePath);
});

if (process.argv[2] !== WORKER_FLAG) test('credential reads and updates preserve the exact 0.1.15 flat schema', () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const storePath = credentialStorePath(env);
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const legacyCredential = {
    mcpUrl: 'https://flat-store.spala.test/mcp?scope=builder',
    bearerToken: 'mcp_flat_store_credential',
    expiresAt,
    status: 'active',
  };
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(storePath), 0o700);
  fs.writeFileSync(storePath, `${JSON.stringify({
    schemaVersion: 1,
    projects: {
      'flat-store-project': legacyCredential,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(storePath, 0o600);

  assert.equal(readProjectCredential('flat-store-project', env).bearerToken, legacyCredential.bearerToken);
  storeProjectCredential({
    projectId: 'new-flat-store-project',
    mcpUrl: 'https://new-flat-store.spala.test/mcp?scope=builder%2Cproject%2Cdata',
    bearerToken: 'mcp_new_flat_store_credential',
    expiresAt,
  }, env);

  const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.deepEqual(Object.keys(persisted).sort(), ['projects', 'schemaVersion']);
  assert.equal(persisted.schemaVersion, 1);
  assert.deepEqual(Object.keys(persisted.projects).sort(), [
    'flat-store-project',
    'new-flat-store-project',
  ]);
  assert.deepEqual(persisted.projects['flat-store-project'], legacyCredential);
  assert.deepEqual(
    Object.keys(persisted.projects['new-flat-store-project']).sort(),
    ['bearerToken', 'expiresAt', 'mcpUrl', 'status'],
  );
  assertCredentialPathKindsAndModes(storePath);
  assert.equal(Object.hasOwn(credentialStore, 'snapshotCredentialStore'), false);
  assert.equal(Object.hasOwn(credentialStore, 'restoreCredentialStore'), false);
  assert.equal(Object.hasOwn(credentialStore, 'restoreProjectCredential'), false);
});
