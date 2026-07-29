import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import properLockfile from 'proper-lockfile';
import * as credentialStore from '../src/credentialStore.js';

const {
  credentialStorePath,
  readProjectCredential,
  rollbackProjectCredentialIfRevision,
  storeProjectCredential,
} = credentialStore;
const WORKER_FLAG = '--credential-store-worker';
const VERSION_015_COMMIT = 'bd7b94e47855f2dc1544fc47e10528261211d504';
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let version015ModulePath;

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

function prepareVersion015Module() {
  if (version015ModulePath) return version015ModulePath;
  const fixtureRoot = tempHome();
  const archivePath = path.join(fixtureRoot, 'mcp-install-0.1.15.tar');
  execFileSync(
    'git',
    ['archive', '--format=tar', `--output=${archivePath}`, VERSION_015_COMMIT],
    { cwd: REPOSITORY_ROOT },
  );
  execFileSync('tar', ['-xf', archivePath, '-C', fixtureRoot]);
  version015ModulePath = path.join(fixtureRoot, 'src', 'credentialStore.js');
  return version015ModulePath;
}

async function runWorker(options) {
  const env = { SPALA_MCP_CREDENTIAL_HOME: options.credentialHome };
  const storePath = credentialStorePath(env);

  if (options.writerVersion === '0.1.15') {
    const renameSync = fs.renameSync;
    if (options.pauseBeforeLegacyRename) {
      fs.renameSync = (source, destination, ...args) => {
        if (
          typeof source === 'string'
          && path.basename(source).startsWith('.mcp-credentials.tmp-')
          && destination === storePath
        ) {
          writeMarker(options.markerPath);
          waitForRelease(options.releasePath);
          const result = renameSync(source, destination, ...args);
          if (options.landedPath) writeMarker(options.landedPath);
          return result;
        }
        return renameSync(source, destination, ...args);
      };
    }
    const legacyStore = await import(pathToFileURL(options.version015ModulePath).href);
    const result = legacyStore.storeProjectCredential({
      projectId: options.projectId,
      mcpUrl: `https://${options.projectId}.spala.test/mcp`,
      bearerToken: options.bearerToken,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }, env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  installLockHooks(options);

  if (options.pauseAfterRestoreGuardRename) {
    const renameSync = fs.renameSync;
    let paused = false;
    fs.renameSync = (source, destination, ...args) => {
      const result = renameSync(source, destination, ...args);
      if (
        !paused
        && source === path.basename(storePath)
        && typeof destination === 'string'
        && destination.startsWith('.mcp-credentials.restore-')
      ) {
        paused = true;
        writeMarker(options.markerPath);
        waitForRelease(options.releasePath);
      }
      return result;
    };
  }

  if (options.pauseAfterRecoveryPublication) {
    const renameSync = fs.renameSync;
    let paused = false;
    const recoveryName = `${path.basename(storePath)}.recovery`;
    fs.renameSync = (source, destination, ...args) => {
      const result = renameSync(source, destination, ...args);
      if (
        !paused
        && typeof source === 'string'
        && source.startsWith(`${recoveryName}.tmp-`)
        && destination === recoveryName
      ) {
        paused = true;
        writeMarker(options.markerPath);
        waitForRelease(options.releasePath);
      }
      return result;
    };
  }

  if (options.pauseBeforeExclusiveCreation) {
    const openSync = fs.openSync;
    let paused = false;
    fs.openSync = (file, flags, ...args) => {
      if (
        !paused
        && file === path.basename(storePath)
        && (flags & fs.constants.O_CREAT) !== 0
        && (flags & fs.constants.O_EXCL) !== 0
      ) {
        paused = true;
        writeMarker(options.markerPath);
        waitForRelease(options.releasePath);
      }
      return openSync(file, flags, ...args);
    };
  }

  if (options.pauseDuringCanonicalWrite) {
    const openSync = fs.openSync;
    const writeSync = fs.writeSync;
    let canonicalDescriptor;
    let paused = false;
    fs.openSync = (file, flags, ...args) => {
      const descriptor = openSync(file, flags, ...args);
      if (
        file === path.basename(storePath)
        && (flags & fs.constants.O_CREAT) !== 0
        && (flags & fs.constants.O_EXCL) !== 0
      ) {
        canonicalDescriptor = descriptor;
      }
      return descriptor;
    };
    fs.writeSync = (descriptor, data, offset, length, ...args) => {
      if (!paused && descriptor === canonicalDescriptor && Buffer.isBuffer(data)) {
        paused = true;
        const written = writeSync(
          descriptor,
          data,
          offset,
          Math.max(1, Math.floor(length / 2)),
          ...args,
        );
        writeMarker(options.markerPath);
        waitForRelease(options.releasePath);
        return written;
      }
      return writeSync(descriptor, data, offset, length, ...args);
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
    await runWorker(JSON.parse(process.argv[3]));
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

function swapCredentialDirectory(storePath, outside, renameSync = fs.renameSync) {
  const directory = path.dirname(storePath);
  const parkedDirectory = `${directory}-inspected`;
  renameSync(directory, parkedDirectory);
  fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  return {
    parkedDirectory,
    restore() {
      fs.unlinkSync(directory);
      renameSync(parkedDirectory, directory);
    },
  };
}

function assertTreeDoesNotContain(root, secret) {
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        assert.equal(
          fs.readFileSync(entryPath).includes(Buffer.from(secret)),
          false,
          `${entryPath} retained the protected credential`,
        );
      }
    }
  };
  visit(root);
}

function assertNoCredentialArtifacts(directory) {
  assert.deepEqual(
    fs.readdirSync(directory).filter(name => (
      name.startsWith('.mcp-credentials.tmp-')
      || name.startsWith('.mcp-credentials.restore-')
    )),
    [],
  );
}

function storeFixtureCredential(
  credentialHome,
  projectId,
  bearerToken,
  expiresAt = new Date(Date.now() + 10 * 60_000).toISOString(),
) {
  return storeProjectCredential({
    projectId,
    mcpUrl: `https://${projectId}.spala.test/mcp`,
    bearerToken,
    expiresAt,
  }, { SPALA_MCP_CREDENTIAL_HOME: credentialHome });
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
  const firstMarker = path.join(coordination, 'first-before-publication');
  const firstRelease = path.join(coordination, 'release-first');
  const contentionMarker = path.join(coordination, 'second-contended');

  const first = startWorker({
    credentialHome,
    projectId: 'concurrent-project-a',
    bearerToken: 'mcp_concurrent_a',
    pauseBeforeExclusiveCreation: true,
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

if (process.argv[2] !== WORKER_FLAG) test('credential read rejects an active parent swap before opening the store', {
  skip: process.platform === 'win32',
}, () => {
  const credentialHome = tempHome();
  const outside = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'anchored-read-project';
  const protectedBearer = 'mcp_anchored_read_protected';
  const attackerBearer = 'mcp_attacker_controlled_read';
  storeFixtureCredential(credentialHome, projectId, protectedBearer);
  const storePath = credentialStorePath(env);
  fs.writeFileSync(path.join(outside, path.basename(storePath)), `${JSON.stringify({
    schemaVersion: 1,
    projects: {
      [projectId]: {
        mcpUrl: 'https://attacker-controlled.spala.test/mcp',
        bearerToken: attackerBearer,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        status: 'active',
      },
    },
  })}\n`, { mode: 0o600 });

  const openSync = fs.openSync;
  let swapped;
  let hookReached = false;
  fs.openSync = (file, flags, ...args) => {
    if (!hookReached && file === path.basename(storePath) && (flags & fs.constants.O_CREAT) === 0) {
      hookReached = true;
      swapped = swapCredentialDirectory(storePath, outside);
    }
    return openSync(file, flags, ...args);
  };
  try {
    assert.throws(
      () => readProjectCredential(projectId, env),
      /credential directory changed after it was inspected/,
    );
    assert.equal(hookReached, true);
    assertTreeDoesNotContain(outside, protectedBearer);
    assert.equal(
      fs.readFileSync(path.join(outside, path.basename(storePath)), 'utf8').includes(attackerBearer),
      true,
    );
  } finally {
    fs.openSync = openSync;
    swapped?.restore();
  }

  assert.equal(readProjectCredential(projectId, env).bearerToken, protectedBearer);
});

if (process.argv[2] !== WORKER_FLAG) test('credential lock chmod stays anchored during an active parent swap', {
  skip: process.platform === 'win32',
}, () => {
  const credentialHome = tempHome();
  const outside = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const protectedBearer = 'mcp_anchored_lock_protected';
  const existingBearer = 'mcp_anchored_lock_existing';
  const existingProject = 'anchored-lock-existing-project';
  storeFixtureCredential(credentialHome, existingProject, existingBearer);
  const storePath = credentialStorePath(env);
  const lockName = `${path.basename(storePath)}.lock`;

  const chmodSync = fs.chmodSync;
  let swapped;
  let hookReached = false;
  fs.chmodSync = (file, mode) => {
    if (!hookReached && file === lockName && mode === 0o700) {
      hookReached = true;
      swapped = swapCredentialDirectory(storePath, outside);
    }
    return chmodSync(file, mode);
  };
  try {
    assert.throws(
      () => storeFixtureCredential(credentialHome, 'anchored-lock-project', protectedBearer),
      /symbolic links|changed after it was inspected/,
    );
    assert.equal(hookReached, true);
    assert.equal(fs.existsSync(path.join(outside, lockName)), false);
    assert.equal(fs.existsSync(path.join(swapped.parkedDirectory, lockName)), false);
    assertTreeDoesNotContain(outside, protectedBearer);
    assertTreeDoesNotContain(swapped.parkedDirectory, protectedBearer);
  } finally {
    fs.chmodSync = chmodSync;
    swapped?.restore();
  }

  assert.equal(readProjectCredential(existingProject, env).bearerToken, existingBearer);
});

if (process.argv[2] !== WORKER_FLAG) test('exclusive credential creation stays anchored during a parent swap', {
  skip: process.platform === 'win32',
}, () => {
  const credentialHome = tempHome();
  const outside = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const protectedBearer = 'mcp_exclusive_creation_protected';
  const existingProject = 'existing-exclusive-create-project';
  const existingBearer = 'mcp_existing_exclusive_create';
  storeFixtureCredential(credentialHome, existingProject, existingBearer);
  const storePath = credentialStorePath(env);

  const openSync = fs.openSync;
  const renameSync = fs.renameSync;
  let swapped;
  let hookReached = false;
  fs.openSync = (file, flags, ...args) => {
    if (
      !hookReached
      && file === path.basename(storePath)
      && (flags & fs.constants.O_CREAT) !== 0
      && (flags & fs.constants.O_EXCL) !== 0
    ) {
      hookReached = true;
      swapped = swapCredentialDirectory(storePath, outside, renameSync);
    }
    return openSync(file, flags, ...args);
  };
  try {
    assert.throws(
      () => storeFixtureCredential(
        credentialHome,
        'exclusive-create-project',
        protectedBearer,
      ),
      /credential directory changed after it was inspected/,
    );
    assert.equal(hookReached, true);
    assertNoCredentialArtifacts(swapped.parkedDirectory);
    assertTreeDoesNotContain(outside, protectedBearer);
    assertTreeDoesNotContain(swapped.parkedDirectory, protectedBearer);
    assert.equal(
      fs.existsSync(path.join(swapped.parkedDirectory, `${path.basename(storePath)}.lock`)),
      false,
    );
  } finally {
    fs.openSync = openSync;
    swapped?.restore();
  }

  assert.equal(readProjectCredential(existingProject, env).bearerToken, existingBearer);
});

if (process.argv[2] !== WORKER_FLAG) test('descriptor credential write recovers after an active parent swap', {
  skip: process.platform === 'win32',
}, () => {
  const credentialHome = tempHome();
  const outside = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const protectedBearer = 'mcp_temp_write_protected';
  storeFixtureCredential(credentialHome, 'existing-temp-write-project', 'mcp_existing_temp_write');
  const storePath = credentialStorePath(env);

  const writeSync = fs.writeSync;
  let swapped;
  let hookReached = false;
  fs.writeSync = (descriptor, data, ...args) => {
    if (
      !hookReached
      && Buffer.isBuffer(data)
      && data.includes(Buffer.from(protectedBearer))
    ) {
      hookReached = true;
      swapped = swapCredentialDirectory(storePath, outside);
    }
    return writeSync(descriptor, data, ...args);
  };
  try {
    assert.throws(
      () => storeFixtureCredential(credentialHome, 'temp-write-project', protectedBearer),
      /credential directory changed after it was inspected/,
    );
    assert.equal(hookReached, true);
    assertNoCredentialArtifacts(swapped.parkedDirectory);
    assertTreeDoesNotContain(outside, protectedBearer);
    assertTreeDoesNotContain(swapped.parkedDirectory, protectedBearer);
    assert.equal(
      fs.existsSync(path.join(swapped.parkedDirectory, `${path.basename(storePath)}.lock`)),
      false,
    );
  } finally {
    fs.writeSync = writeSync;
    swapped?.restore();
  }

  assert.equal(
    readProjectCredential('existing-temp-write-project', env).bearerToken,
    'mcp_existing_temp_write',
  );
});

if (process.argv[2] !== WORKER_FLAG) test('credential publication merges a same-inode revision changed at isolation', {
  skip: process.platform === 'win32',
}, () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const protectedBearer = 'mcp_revision_guard_protected';
  const concurrentBearer = 'mcp_revision_guard_concurrent';
  const projectId = 'revision-guard-project';
  const newProject = 'new-revision-guard-project';
  storeFixtureCredential(credentialHome, projectId, 'mcp_revision_guard_original');
  const storePath = credentialStorePath(env);
  const concurrentStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  concurrentStore.projects[projectId].bearerToken = concurrentBearer;
  const concurrentBody = `${JSON.stringify(concurrentStore, null, 2)}\n`;

  const renameSync = fs.renameSync;
  let hookReached = false;
  fs.renameSync = (source, destination, ...args) => {
    if (
      !hookReached
      && source === path.basename(storePath)
      && typeof destination === 'string'
      && destination.startsWith('.mcp-credentials.restore-')
    ) {
      hookReached = true;
      fs.writeFileSync(source, concurrentBody, { mode: 0o600 });
    }
    return renameSync(source, destination, ...args);
  };
  try {
    const result = storeFixtureCredential(
      credentialHome,
      newProject,
      protectedBearer,
    );
    assert.equal(result.changed, true);
    assert.equal(hookReached, true);
  } finally {
    fs.renameSync = renameSync;
  }

  assert.equal(readProjectCredential(projectId, env).bearerToken, concurrentBearer);
  assert.equal(readProjectCredential(newProject, env).bearerToken, protectedBearer);
  assertNoCredentialArtifacts(path.dirname(storePath));
});

if (process.argv[2] !== WORKER_FLAG) test('publication merges the actual 0.1.15 writer that reads the isolated missing name', async () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const existingProject = 'legacy-missing-existing-project';
  const legacyProject = 'legacy-missing-concurrent-project';
  const intendedProject = 'legacy-missing-intended-project';
  const existingBearer = 'mcp_legacy_missing_existing';
  const legacyBearer = 'mcp_legacy_missing_concurrent';
  const intendedBearer = 'mcp_legacy_missing_intended';
  storeFixtureCredential(credentialHome, existingProject, existingBearer);
  const storePath = credentialStorePath(env);
  const legacyStore = await import(pathToFileURL(prepareVersion015Module()).href);

  const openSync = fs.openSync;
  let hookReached = false;
  fs.openSync = (file, flags, ...args) => {
    if (
      !hookReached
      && file === path.basename(storePath)
      && (flags & fs.constants.O_CREAT) !== 0
      && (flags & fs.constants.O_EXCL) !== 0
    ) {
      hookReached = true;
      legacyStore.storeProjectCredential({
        projectId: legacyProject,
        mcpUrl: `https://${legacyProject}.spala.test/mcp`,
        bearerToken: legacyBearer,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }, env);
    }
    return openSync(file, flags, ...args);
  };
  try {
    const result = storeFixtureCredential(
      credentialHome,
      intendedProject,
      intendedBearer,
    );
    assert.equal(result.changed, true);
    assert.equal(hookReached, true);
  } finally {
    fs.openSync = openSync;
  }

  assert.equal(readProjectCredential(existingProject, env).bearerToken, existingBearer);
  assert.equal(readProjectCredential(legacyProject, env).bearerToken, legacyBearer);
  assert.equal(readProjectCredential(intendedProject, env).bearerToken, intendedBearer);
  assertNoCredentialArtifacts(path.dirname(storePath));
});

if (process.argv[2] !== WORKER_FLAG) test('publication recovers an actual 0.1.15 rename during guard cleanup', async () => {
  const credentialHome = tempHome();
  const coordination = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const existingProject = 'legacy-cleanup-existing-project';
  const legacyProject = 'legacy-cleanup-concurrent-project';
  const intendedProject = 'legacy-cleanup-intended-project';
  const markerPath = path.join(coordination, 'legacy-ready');
  const releasePath = path.join(coordination, 'release-legacy');
  const landedPath = path.join(coordination, 'legacy-landed');
  storeFixtureCredential(credentialHome, existingProject, 'mcp_legacy_cleanup_existing');
  const storePath = credentialStorePath(env);
  const legacy = startWorker({
    credentialHome,
    writerVersion: '0.1.15',
    version015ModulePath: prepareVersion015Module(),
    projectId: legacyProject,
    bearerToken: 'mcp_legacy_cleanup_concurrent',
    pauseBeforeLegacyRename: true,
    markerPath,
    releasePath,
    landedPath,
  });
  await waitForPath(markerPath, legacy);

  const unlinkSync = fs.unlinkSync;
  let hookReached = false;
  fs.unlinkSync = file => {
    if (
      !hookReached
      && typeof file === 'string'
      && file.startsWith('.mcp-credentials.restore-')
    ) {
      hookReached = true;
      writeMarker(releasePath);
      waitForRelease(landedPath);
    }
    return unlinkSync(file);
  };
  let result;
  try {
    result = storeFixtureCredential(
      credentialHome,
      intendedProject,
      'mcp_legacy_cleanup_intended',
    );
  } finally {
    fs.unlinkSync = unlinkSync;
  }
  const legacyResult = await legacy.exited;
  assertSuccessfulWorker(legacyResult);

  assert.equal(hookReached, true);
  assert.equal(result.changed, true);
  assert.equal(
    readProjectCredential(existingProject, env).bearerToken,
    'mcp_legacy_cleanup_existing',
  );
  assert.equal(
    readProjectCredential(legacyProject, env).bearerToken,
    'mcp_legacy_cleanup_concurrent',
  );
  assert.equal(
    readProjectCredential(intendedProject, env).bearerToken,
    'mcp_legacy_cleanup_intended',
  );
  assertNoCredentialArtifacts(path.dirname(storePath));
});

if (process.argv[2] !== WORKER_FLAG) test('a prepared 0.1.15 rename landing after 0.1.16 returns is recovered on read', async () => {
  const credentialHome = tempHome();
  const coordination = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const existingProject = 'legacy-late-existing-project';
  const legacyProject = 'legacy-late-concurrent-project';
  const currentProject = 'legacy-late-current-project';
  const markerPath = path.join(coordination, 'legacy-ready');
  const releasePath = path.join(coordination, 'release-legacy');
  const landedPath = path.join(coordination, 'legacy-landed');
  storeFixtureCredential(credentialHome, existingProject, 'mcp_legacy_late_existing');
  const storePath = credentialStorePath(env);
  const legacy = startWorker({
    credentialHome,
    writerVersion: '0.1.15',
    version015ModulePath: prepareVersion015Module(),
    projectId: legacyProject,
    bearerToken: 'mcp_legacy_late_concurrent',
    pauseBeforeLegacyRename: true,
    markerPath,
    releasePath,
    landedPath,
  });
  await waitForPath(markerPath, legacy);

  const current = storeFixtureCredential(
    credentialHome,
    currentProject,
    'mcp_legacy_late_current',
  );
  assert.equal(current.changed, true);
  writeMarker(releasePath);
  await waitForPath(landedPath, legacy);
  assertSuccessfulWorker(await legacy.exited);
  const landed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(Object.hasOwn(landed.projects, currentProject), false);

  assert.equal(
    readProjectCredential(currentProject, env).bearerToken,
    'mcp_legacy_late_current',
  );
  assert.equal(
    readProjectCredential(legacyProject, env).bearerToken,
    'mcp_legacy_late_concurrent',
  );
  assert.equal(
    readProjectCredential(existingProject, env).bearerToken,
    'mcp_legacy_late_existing',
  );
  const recovered = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.deepEqual(Object.keys(recovered.projects).sort(), [
    currentProject,
    existingProject,
    legacyProject,
  ].sort());
});

if (process.argv[2] !== WORKER_FLAG) test('a same-project 0.1.15 rename landing after 0.1.16 returns cannot replace the new credential', async () => {
  const credentialHome = tempHome();
  const coordination = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'legacy-late-same-project';
  const markerPath = path.join(coordination, 'legacy-ready');
  const releasePath = path.join(coordination, 'release-legacy');
  const landedPath = path.join(coordination, 'legacy-landed');
  storeFixtureCredential(credentialHome, projectId, 'mcp_legacy_late_same_original');
  const storePath = credentialStorePath(env);
  const legacy = startWorker({
    credentialHome,
    writerVersion: '0.1.15',
    version015ModulePath: prepareVersion015Module(),
    projectId,
    bearerToken: 'mcp_legacy_late_same_stale',
    pauseBeforeLegacyRename: true,
    markerPath,
    releasePath,
    landedPath,
  });
  await waitForPath(markerPath, legacy);

  const current = storeFixtureCredential(
    credentialHome,
    projectId,
    'mcp_legacy_late_same_current',
  );
  assert.equal(current.changed, true);
  writeMarker(releasePath);
  await waitForPath(landedPath, legacy);
  assertSuccessfulWorker(await legacy.exited);
  assert.equal(
    JSON.parse(fs.readFileSync(storePath, 'utf8')).projects[projectId].bearerToken,
    'mcp_legacy_late_same_stale',
  );

  assert.equal(
    readProjectCredential(projectId, env).bearerToken,
    'mcp_legacy_late_same_current',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(storePath, 'utf8')).projects[projectId].bearerToken,
    'mcp_legacy_late_same_current',
  );
});

if (process.argv[2] !== WORKER_FLAG) test('process death after recovery publication repairs a missing canonical store', async () => {
  const credentialHome = tempHome();
  const coordination = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'crashed-before-canonical-project';
  const markerPath = path.join(coordination, 'recovery-published');
  const worker = startWorker({
    credentialHome,
    projectId,
    bearerToken: 'mcp_crashed_before_canonical',
    pauseAfterRecoveryPublication: true,
    markerPath,
    releasePath: path.join(coordination, 'never-release'),
  });
  await waitForPath(markerPath, worker);
  worker.child.kill('SIGKILL');
  const crashed = await worker.exited;
  assert.notEqual(crashed.code, 0);

  const storePath = credentialStorePath(env);
  assert.equal(fs.existsSync(storePath), false);
  assert.equal(fs.existsSync(`${storePath}.recovery`), true);
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(`${storePath}.lock`, staleTime, staleTime);

  assert.equal(
    readProjectCredential(projectId, env).bearerToken,
    'mcp_crashed_before_canonical',
  );
  assertCredentialPathKindsAndModes(storePath);
  assert.equal((fs.statSync(`${storePath}.recovery`).mode & 0o777), 0o600);
});

if (process.argv[2] !== WORKER_FLAG) test('restart removes a restore guard containing the historical credential after process death', async () => {
  const credentialHome = tempHome();
  const coordination = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'crashed-restore-guard-project';
  const historicalBearer = 'mcp_crashed_restore_guard_historical';
  const currentBearer = 'mcp_crashed_restore_guard_current';
  const markerPath = path.join(coordination, 'guard-renamed');
  storeFixtureCredential(credentialHome, projectId, historicalBearer);
  const storePath = credentialStorePath(env);
  const worker = startWorker({
    credentialHome,
    projectId,
    bearerToken: currentBearer,
    pauseAfterRestoreGuardRename: true,
    markerPath,
    releasePath: path.join(coordination, 'never-release'),
  });
  await waitForPath(markerPath, worker);
  worker.child.kill('SIGKILL');
  const crashed = await worker.exited;
  assert.notEqual(crashed.code, 0);

  const credentialDirectory = path.dirname(storePath);
  const guards = fs.readdirSync(credentialDirectory)
    .filter(name => name.startsWith('.mcp-credentials.restore-'));
  assert.equal(guards.length, 1);
  assert.equal(
    fs.readFileSync(path.join(credentialDirectory, guards[0]), 'utf8')
      .includes(historicalBearer),
    true,
  );
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(`${storePath}.lock`, staleTime, staleTime);

  assert.equal(readProjectCredential(projectId, env).bearerToken, currentBearer);
  assertNoCredentialArtifacts(credentialDirectory);
  assertTreeDoesNotContain(credentialDirectory, historicalBearer);
});

if (process.argv[2] !== WORKER_FLAG) test('process death during canonical write repairs a partial file from recovery state', async () => {
  const credentialHome = tempHome();
  const coordination = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'crashed-partial-canonical-project';
  const markerPath = path.join(coordination, 'canonical-partial');
  const worker = startWorker({
    credentialHome,
    projectId,
    bearerToken: 'mcp_crashed_partial_canonical',
    pauseDuringCanonicalWrite: true,
    markerPath,
    releasePath: path.join(coordination, 'never-release'),
  });
  await waitForPath(markerPath, worker);
  worker.child.kill('SIGKILL');
  const crashed = await worker.exited;
  assert.notEqual(crashed.code, 0);

  const storePath = credentialStorePath(env);
  assert.equal(fs.existsSync(storePath), true);
  assert.throws(() => JSON.parse(fs.readFileSync(storePath, 'utf8')));
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(`${storePath}.lock`, staleTime, staleTime);

  assert.equal(
    readProjectCredential(projectId, env).bearerToken,
    'mcp_crashed_partial_canonical',
  );
  const recovered = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(recovered.projects[projectId].bearerToken, 'mcp_crashed_partial_canonical');
  assertCredentialPathKindsAndModes(storePath);
});

if (process.argv[2] !== WORKER_FLAG) test('tampered credential recovery state fails closed without exposing secrets', () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'tampered-recovery-project';
  const bearerToken = 'mcp_tampered_recovery_secret';
  storeFixtureCredential(credentialHome, projectId, bearerToken);
  const recoveryPath = `${credentialStorePath(env)}.recovery`;
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
  recovery.checksum = '0'.repeat(64);
  fs.writeFileSync(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, { mode: 0o600 });

  let error;
  try {
    readProjectCredential(projectId, env);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.match(error.message, /integrity validation/);
  assert.doesNotMatch(error.message, new RegExp(bearerToken));
});

if (process.argv[2] !== WORKER_FLAG) test('same-project conflict is resolved in favor of the verified current operation', async () => {
  const credentialHome = tempHome();
  const coordination = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'legacy-same-project';
  const markerPath = path.join(coordination, 'legacy-ready');
  const releasePath = path.join(coordination, 'release-legacy');
  const landedPath = path.join(coordination, 'legacy-landed');
  storeFixtureCredential(credentialHome, projectId, 'mcp_legacy_same_original');
  const storePath = credentialStorePath(env);
  const legacy = startWorker({
    credentialHome,
    writerVersion: '0.1.15',
    version015ModulePath: prepareVersion015Module(),
    projectId,
    bearerToken: 'mcp_legacy_same_concurrent',
    pauseBeforeLegacyRename: true,
    markerPath,
    releasePath,
    landedPath,
  });
  await waitForPath(markerPath, legacy);

  const unlinkSync = fs.unlinkSync;
  let hookReached = false;
  fs.unlinkSync = file => {
    if (
      !hookReached
      && typeof file === 'string'
      && file.startsWith('.mcp-credentials.restore-')
    ) {
      hookReached = true;
      writeMarker(releasePath);
      waitForRelease(landedPath);
    }
    return unlinkSync(file);
  };
  let result;
  try {
    result = storeFixtureCredential(
      credentialHome,
      projectId,
      'mcp_legacy_same_intended',
    );
  } finally {
    fs.unlinkSync = unlinkSync;
  }
  const legacyResult = await legacy.exited;
  assertSuccessfulWorker(legacyResult);

  assert.equal(hookReached, true);
  assert.equal(result.changed, true);
  assert.equal(readProjectCredential(projectId, env).bearerToken, 'mcp_legacy_same_intended');
  assertNoCredentialArtifacts(path.dirname(storePath));
});

if (process.argv[2] !== WORKER_FLAG) test('partial exclusive descriptor failure restores the prior canonical revision', () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'partial-write-project';
  const protectedBearer = 'mcp_partial_write_rejected';
  storeFixtureCredential(credentialHome, projectId, 'mcp_partial_write_original');
  const storePath = credentialStorePath(env);
  const originalBody = fs.readFileSync(storePath, 'utf8');

  const openSync = fs.openSync;
  const writeSync = fs.writeSync;
  let canonicalDescriptor;
  let hookReached = false;
  fs.openSync = (file, flags, ...args) => {
    const descriptor = openSync(file, flags, ...args);
    if (
      file === path.basename(storePath)
      && (flags & fs.constants.O_CREAT) !== 0
      && (flags & fs.constants.O_EXCL) !== 0
    ) {
      canonicalDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.writeSync = (descriptor, data, offset, length, ...args) => {
    if (
      !hookReached
      && descriptor === canonicalDescriptor
      && Buffer.isBuffer(data)
      && data.includes(Buffer.from(protectedBearer))
    ) {
      hookReached = true;
      if (process.platform !== 'win32') {
        assert.equal(fs.fstatSync(descriptor).mode & 0o777, 0o000);
        assert.equal(fs.lstatSync(storePath).mode & 0o777, 0o000);
      }
      writeSync(descriptor, data, offset, Math.max(1, Math.floor(length / 2)), ...args);
      const error = new Error('Injected partial exclusive descriptor failure.');
      error.code = 'EIO';
      throw error;
    }
    return writeSync(descriptor, data, offset, length, ...args);
  };
  try {
    assert.throws(
      () => storeFixtureCredential(credentialHome, projectId, protectedBearer),
      /Injected partial exclusive descriptor failure/,
    );
  } finally {
    fs.openSync = openSync;
    fs.writeSync = writeSync;
  }

  assert.equal(hookReached, true);
  assert.equal(fs.readFileSync(storePath, 'utf8'), originalBody);
  assert.equal(readProjectCredential(projectId, env).bearerToken, 'mcp_partial_write_original');
  assertNoCredentialArtifacts(path.dirname(storePath));
});

if (process.argv[2] !== WORKER_FLAG) test('post-write hardlink failure does not leave the rejected credential canonical', {
  skip: process.platform === 'win32',
}, () => {
  const credentialHome = tempHome();
  const outside = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'post-write-hardlink-project';
  const protectedBearer = 'mcp_post_write_hardlink_rejected';
  storeFixtureCredential(credentialHome, projectId, 'mcp_post_write_hardlink_original');
  const storePath = credentialStorePath(env);
  const originalBody = fs.readFileSync(storePath, 'utf8');
  const secondLink = path.join(outside, 'rejected-credential-link.json');

  const openSync = fs.openSync;
  const fchmodSync = fs.fchmodSync;
  let canonicalDescriptor;
  let hookReached = false;
  fs.openSync = (file, flags, ...args) => {
    const descriptor = openSync(file, flags, ...args);
    if (
      file === path.basename(storePath)
      && (flags & fs.constants.O_CREAT) !== 0
      && (flags & fs.constants.O_EXCL) !== 0
    ) {
      canonicalDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.fchmodSync = (descriptor, mode) => {
    const result = fchmodSync(descriptor, mode);
    if (!hookReached && descriptor === canonicalDescriptor && mode === 0o600) {
      hookReached = true;
      fs.linkSync(storePath, secondLink);
    }
    return result;
  };
  try {
    assert.throws(
      () => storeFixtureCredential(credentialHome, projectId, protectedBearer),
      /multiple hard links/,
    );
  } finally {
    fs.openSync = openSync;
    fs.fchmodSync = fchmodSync;
  }

  assert.equal(hookReached, true);
  assert.equal(fs.readFileSync(storePath, 'utf8'), originalBody);
  assert.equal(
    readProjectCredential(projectId, env).bearerToken,
    'mcp_post_write_hardlink_original',
  );
  assert.equal(fs.readFileSync(secondLink, 'utf8').includes(protectedBearer), true);
  assertNoCredentialArtifacts(path.dirname(storePath));
});

if (process.argv[2] !== WORKER_FLAG) test('bounded publication contention fails closed and retains every valid guarded project', async () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const existingProject = 'bounded-existing-project';
  const legacyProject = 'bounded-legacy-project';
  const intendedProject = 'bounded-intended-project';
  const existingBearer = 'mcp_bounded_existing';
  const legacyBearer = 'mcp_bounded_legacy';
  const intendedBearer = 'mcp_bounded_intended';
  storeFixtureCredential(credentialHome, existingProject, existingBearer);
  const storePath = credentialStorePath(env);
  const legacyStore = await import(pathToFileURL(prepareVersion015Module()).href);

  const openSync = fs.openSync;
  let collisionCount = 0;
  fs.openSync = (file, flags, ...args) => {
    if (
      file === path.basename(storePath)
      && (flags & fs.constants.O_CREAT) !== 0
      && (flags & fs.constants.O_EXCL) !== 0
    ) {
      collisionCount += 1;
      legacyStore.storeProjectCredential({
        projectId: legacyProject,
        mcpUrl: `https://${legacyProject}.spala.test/mcp`,
        bearerToken: legacyBearer,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }, env);
    }
    return openSync(file, flags, ...args);
  };
  try {
    assert.throws(
      () => storeFixtureCredential(credentialHome, intendedProject, intendedBearer),
      /changed too many times during publication/,
    );
  } finally {
    fs.openSync = openSync;
  }

  assert.equal(collisionCount, 16);
  assert.equal(readProjectCredential(legacyProject, env).bearerToken, legacyBearer);
  assert.throws(() => readProjectCredential(intendedProject, env), /No agentic MCP credential/);

  assertNoCredentialArtifacts(path.dirname(storePath));
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

if (process.argv[2] !== WORKER_FLAG) test('credential rollback restores the prior value while its exact project generation is current', () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'owned-rollback-project';
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  storeFixtureCredential(credentialHome, projectId, 'mcp_owned_rollback_original', expiresAt);
  const publication = storeFixtureCredential(
    credentialHome,
    projectId,
    'mcp_owned_rollback_current',
    expiresAt,
  );

  assert.equal(publication.changed, true);
  assert.ok(publication.revision);
  assert.deepEqual(
    rollbackProjectCredentialIfRevision(publication.revision, env),
    { changed: true, projectId, superseded: false },
  );
  assert.equal(
    readProjectCredential(projectId, env).bearerToken,
    'mcp_owned_rollback_original',
  );
});

if (process.argv[2] !== WORKER_FLAG) test('credential rollback ownership is scoped to its project generation', () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'project-scoped-rollback';
  const otherProjectId = 'unrelated-project-publication';
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  storeFixtureCredential(credentialHome, projectId, 'mcp_project_scoped_original', expiresAt);
  const publication = storeFixtureCredential(
    credentialHome,
    projectId,
    'mcp_project_scoped_current',
    expiresAt,
  );
  const recoveryPath = `${credentialStorePath(env)}.recovery`;
  const ownedGeneration = JSON.parse(
    fs.readFileSync(recoveryPath, 'utf8'),
  ).projectGenerations[projectId];

  storeFixtureCredential(
    credentialHome,
    otherProjectId,
    'mcp_unrelated_project_publication',
    expiresAt,
  );
  const afterUnrelated = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
  assert.equal(afterUnrelated.projectGenerations[projectId], ownedGeneration);
  assert.notEqual(afterUnrelated.transactionId, ownedGeneration);

  assert.deepEqual(
    rollbackProjectCredentialIfRevision(publication.revision, env),
    { changed: true, projectId, superseded: false },
  );
  assert.equal(
    readProjectCredential(projectId, env).bearerToken,
    'mcp_project_scoped_original',
  );
  assert.equal(
    readProjectCredential(otherProjectId, env).bearerToken,
    'mcp_unrelated_project_publication',
  );
});

if (process.argv[2] !== WORKER_FLAG) test('credential rollback fails closed when project generation proof is missing', () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'missing-generation-proof';
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  storeFixtureCredential(credentialHome, projectId, 'mcp_missing_proof_original', expiresAt);
  const publication = storeFixtureCredential(
    credentialHome,
    projectId,
    'mcp_missing_proof_current',
    expiresAt,
  );
  const storePath = credentialStorePath(env);
  const publishedBody = fs.readFileSync(storePath, 'utf8');
  fs.unlinkSync(`${storePath}.recovery`);

  assert.deepEqual(
    rollbackProjectCredentialIfRevision(publication.revision, env),
    { changed: false, projectId, superseded: true },
  );
  assert.equal(fs.readFileSync(storePath, 'utf8'), publishedBody);
  assert.throws(
    () => rollbackProjectCredentialIfRevision(publication.revision, env),
    /valid publication revision/,
  );
});

if (process.argv[2] !== WORKER_FLAG) test('version 2 recovery journals migrate without claiming project generation ownership', () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'version-two-recovery';
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const storePath = credentialStorePath(env);
  const recoveryPath = `${storePath}.recovery`;
  storeFixtureCredential(credentialHome, projectId, 'mcp_version_two_recovery', expiresAt);
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const metadata = {
    authoritativeProjectIds: [projectId],
    transactionId: '2'.repeat(32),
  };
  const checksum = createHash('sha256').update(JSON.stringify({
    authoritativeProjectIds: metadata.authoritativeProjectIds,
    store,
    transactionId: metadata.transactionId,
  })).digest('hex');
  fs.writeFileSync(recoveryPath, `${JSON.stringify({
    schemaVersion: 2,
    transactionId: metadata.transactionId,
    authoritativeProjectIds: metadata.authoritativeProjectIds,
    store,
    checksum,
  }, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(recoveryPath, 0o600);

  assert.equal(
    readProjectCredential(projectId, env).bearerToken,
    'mcp_version_two_recovery',
  );
  const migrated = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.projectGenerations, {});

  storeFixtureCredential(credentialHome, projectId, 'mcp_version_three_recovery', expiresAt);
  const updated = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
  assert.match(updated.projectGenerations[projectId], /^[a-f0-9]{32}$/);
});

if (process.argv[2] !== WORKER_FLAG) test('credential rollback rejects an exact O to X to Y to byte-identical X ABA publication', () => {
  const credentialHome = tempHome();
  const env = { SPALA_MCP_CREDENTIAL_HOME: credentialHome };
  const projectId = 'credential-rollback-aba';
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const storePath = credentialStorePath(env);
  const recoveryPath = `${storePath}.recovery`;
  storeFixtureCredential(credentialHome, projectId, 'mcp_rollback_aba_original', expiresAt);

  const publicationA = storeFixtureCredential(
    credentialHome,
    projectId,
    'mcp_rollback_aba_x',
    expiresAt,
  );
  const firstXBody = fs.readFileSync(storePath, 'utf8');
  const firstXGeneration = JSON.parse(
    fs.readFileSync(recoveryPath, 'utf8'),
  ).projectGenerations[projectId];

  storeFixtureCredential(credentialHome, projectId, 'mcp_rollback_aba_y', expiresAt);
  const publicationC = storeFixtureCredential(
    credentialHome,
    projectId,
    'mcp_rollback_aba_x',
    expiresAt,
  );
  const secondXBody = fs.readFileSync(storePath, 'utf8');
  const secondXGeneration = JSON.parse(
    fs.readFileSync(recoveryPath, 'utf8'),
  ).projectGenerations[projectId];
  assert.equal(secondXBody, firstXBody);
  assert.notEqual(secondXGeneration, firstXGeneration);
  assert.notEqual(publicationC.revision, publicationA.revision);

  assert.deepEqual(
    rollbackProjectCredentialIfRevision(publicationA.revision, env),
    { changed: false, projectId, superseded: true },
  );
  assert.equal(fs.readFileSync(storePath, 'utf8'), secondXBody);
  assert.equal(readProjectCredential(projectId, env).bearerToken, 'mcp_rollback_aba_x');
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
