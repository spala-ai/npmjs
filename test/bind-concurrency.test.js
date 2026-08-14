import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { acquireProjectLifecycleLock, runCli } from '../src/cli.js';
import {
  planProjectBinding,
  readProjectBinding,
  rollbackProjectBinding,
  writeProjectBinding,
} from '../src/workspace.js';

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spala-bind-concurrency-'));
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function quietStreams(stdin = { isTTY: false }) {
  return {
    stdin,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  };
}

function bindArgs({
  projectId,
  projectUrl,
  mcpUrl,
  bootstrap = false,
  switchProject = false,
}) {
  return [
    'project',
    'bind',
    '--project-id',
    projectId,
    '--project-url',
    projectUrl,
    '--url',
    mcpUrl,
    ...(bootstrap ? ['--bootstrap-stdin'] : []),
    ...(switchProject ? ['--switch'] : []),
    '--client',
    'codex',
    '--yes',
    '--json',
  ];
}

function binding(name) {
  return {
    schemaVersion: 1,
    projectId: `project-${name}`,
    projectUrl: `https://${name}.spala.ai/`,
    mcpUrl: `https://${name}.spala.ai/mcp?scope=builder%2Cproject%2Cdata`,
    serverName: `spala-${name}-spala-ai`,
  };
}

test('lifecycle release preserves a replacement lock owned by another operation', async () => {
  const workspace = tempDirectory();
  const spalaDirectory = path.join(workspace, '.spala');
  const lockPath = path.join(spalaDirectory, '.project-lifecycle.lock');
  const displacedLockPath = path.join(spalaDirectory, '.project-lifecycle.lock.displaced');
  fs.mkdirSync(spalaDirectory, { mode: 0o700 });

  const lock = await acquireProjectLifecycleLock(workspace);
  fs.renameSync(lockPath, displacedLockPath);
  fs.mkdirSync(lockPath, { mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'replacement-owner'), 'new operation');

  await assert.rejects(lock.release(), /ownership changed|compromised/i);
  assert.equal(fs.readFileSync(path.join(lockPath, 'replacement-owner'), 'utf8'), 'new operation');
  assert.equal(fs.existsSync(displacedLockPath), true);
});

test('lifecycle acquisition never reclaims a stale-looking canonical lock', async () => {
  const workspace = tempDirectory();
  const spalaDirectory = path.join(workspace, '.spala');
  const lockPath = path.join(spalaDirectory, '.project-lifecycle.lock');
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'owner'), 'other process');
  const old = new Date(0);
  fs.utimesSync(lockPath, old, old);

  await assert.rejects(
    acquireProjectLifecycleLock(workspace, { retries: 0 }),
    /already being held|locked/i,
  );
  assert.equal(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8'), 'other process');
});

function crashReplacement(workspace, stage, {
  attemptedBinding = binding(`crash-${stage}-attempt`),
  originalBinding = binding(`crash-${stage}-original`),
} = {}) {
  fs.mkdirSync(path.join(workspace, '.git'));
  if (originalBinding) writeProjectBinding(workspace, originalBinding);
  const workspaceModuleUrl = new URL('../src/workspace.js', import.meta.url).href;
  const worker = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { writeProjectBinding } from ${JSON.stringify(workspaceModuleUrl)};

    const [workspace, stage, attemptedJson, hasOriginal] = process.argv.slice(1);
    const attempted = JSON.parse(attemptedJson);
    const originalRenameSync = fs.renameSync;
    const originalOpenSync = fs.openSync;
    const originalWriteSync = fs.writeSync;
    const originalFsyncSync = fs.fsyncSync;
    let publicationDescriptor;
    let publicationSyncs = 0;

    fs.renameSync = (sourcePath, destinationPath) => {
      const result = originalRenameSync(sourcePath, destinationPath);
      if (
        stage === 'after-guard'
        && path.basename(String(sourcePath)) === 'project.json'
        && path.basename(String(destinationPath)).startsWith('.project.json.revision-guard-')
      ) {
        process.exit(86);
      }
      return result;
    };
    fs.openSync = (filePath, flags, mode) => {
      const descriptor = originalOpenSync(filePath, flags, mode);
      if (
        path.basename(String(filePath)) === 'project.json'
        && (flags & fs.constants.O_EXCL) !== 0
      ) {
        publicationDescriptor = descriptor;
      }
      return descriptor;
    };
    fs.writeSync = (descriptor, buffer, offset, length, position) => {
      if (stage.startsWith('partial-') && descriptor === publicationDescriptor) {
        originalWriteSync(descriptor, buffer, offset, Math.min(length, 17), position);
        process.exit(86);
      }
      return originalWriteSync(descriptor, buffer, offset, length, position);
    };
    fs.fsyncSync = descriptor => {
      const result = originalFsyncSync(descriptor);
      if (stage === 'after-complete-publication' && descriptor === publicationDescriptor) {
        publicationSyncs += 1;
        if (publicationSyncs === 2) process.exit(86);
      }
      return result;
    };

    writeProjectBinding(
      workspace,
      attempted,
      { switchProject: hasOriginal === 'true' },
    );
    process.exit(87);
  `;
  const crashed = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      worker,
      workspace,
      stage,
      JSON.stringify(attemptedBinding),
      String(Boolean(originalBinding)),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
  assert.equal(crashed.status, 86, `${stage}: ${crashed.stderr}`);
  return { attemptedBinding, originalBinding };
}

function recoveryArtifacts(workspace) {
  return fs.readdirSync(path.join(workspace, '.spala'))
    .filter(name => (
      name.startsWith('.project.json.revision-guard-')
      || name.startsWith('.project.json.rollback-guard-')
      || name.startsWith('.project.json.failed-publication-')
    ));
}

test('dead replacement processes recover the prior binding for later read, plan, and bind', async t => {
  for (const recoveryAction of ['read', 'plan', 'bind']) {
    await t.test(recoveryAction, async () => {
      const workspace = tempDirectory();
      const { attemptedBinding, originalBinding } = crashReplacement(workspace, 'after-guard', {
        attemptedBinding: binding(`dead-guard-${recoveryAction}-attempt`),
        originalBinding: binding(`dead-guard-${recoveryAction}-original`),
      });
      assert.equal(
        fs.existsSync(path.join(workspace, '.spala', 'project.json')),
        false,
      );
      assert.equal(recoveryArtifacts(workspace).length, 1);

      if (recoveryAction === 'read') {
        const nested = path.join(workspace, 'packages', 'nested');
        fs.mkdirSync(nested, { recursive: true });
        fs.rmdirSync(path.join(workspace, '.git'));
        assert.deepEqual(readProjectBinding(nested).binding, originalBinding);
      } else if (recoveryAction === 'plan') {
        assert.throws(
          () => planProjectBinding(workspace, attemptedBinding),
          /already bound.*--switch/,
        );
      } else {
        await assert.rejects(
          runCli(bindArgs({
            projectId: attemptedBinding.projectId,
            projectUrl: attemptedBinding.projectUrl,
            mcpUrl: attemptedBinding.mcpUrl,
          }), {}, workspace, quietStreams()),
          /already bound.*--switch/,
        );
      }

      assert.deepEqual(readProjectBinding(workspace).binding, originalBinding);
      assert.deepEqual(recoveryArtifacts(workspace), []);
    });
  }
});

test('dead partial exclusive publication restores a guard and never becomes an unbound workspace', async t => {
  await t.test('replacement restores the prior binding before a later bind', () => {
    const workspace = tempDirectory();
    const { attemptedBinding, originalBinding } = crashReplacement(workspace, 'partial-replacement');
    const canonicalPath = path.join(workspace, '.spala', 'project.json');
    assert.equal(fs.statSync(canonicalPath).mode & 0o777, 0);
    assert.equal(recoveryArtifacts(workspace).length, 1);

    assert.throws(
      () => writeProjectBinding(workspace, attemptedBinding),
      /already bound.*--switch/,
    );
    assert.deepEqual(readProjectBinding(workspace).binding, originalBinding);
    assert.equal(fs.statSync(canonicalPath).mode & 0o777, 0o600);
    assert.deepEqual(recoveryArtifacts(workspace), []);
  });

  await t.test('initial partial publication with no guard fails closed', () => {
    const workspace = tempDirectory();
    const { attemptedBinding } = crashReplacement(workspace, 'partial-initial', {
      originalBinding: null,
    });
    const canonicalPath = path.join(workspace, '.spala', 'project.json');
    assert.equal(fs.statSync(canonicalPath).mode & 0o777, 0);

    assert.throws(
      () => writeProjectBinding(workspace, attemptedBinding),
      /Incomplete .* publication has no valid recovery guard/,
    );
    assert.equal(fs.existsSync(canonicalPath), true);
    assert.equal(fs.statSync(canonicalPath).mode & 0o777, 0);
  });
});

test('recovery preserves a complete or concurrent canonical winner', async t => {
  await t.test('completed publication from the dead owner', () => {
    const workspace = tempDirectory();
    const { attemptedBinding } = crashReplacement(workspace, 'after-complete-publication');
    assert.equal(recoveryArtifacts(workspace).length, 1);

    assert.deepEqual(readProjectBinding(workspace).binding, attemptedBinding);
    assert.deepEqual(recoveryArtifacts(workspace), []);
  });

  await t.test('independent concurrent winner', () => {
    const workspace = tempDirectory();
    crashReplacement(workspace, 'after-guard');
    const winnerBinding = binding('dead-guard-concurrent-winner');
    fs.writeFileSync(
      path.join(workspace, '.spala', 'project.json'),
      `${JSON.stringify(winnerBinding, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );

    assert.deepEqual(readProjectBinding(workspace).binding, winnerBinding);
    assert.deepEqual(recoveryArtifacts(workspace), []);
  });
});

test('stale recovery rejects linked, tampered, and ambiguous guards without data loss', {
  skip: process.platform === 'win32',
}, async t => {
  for (const artifactKind of ['symbolic link', 'hard link', 'tampered', 'ambiguous']) {
    await t.test(artifactKind, () => {
      const workspace = tempDirectory();
      const { originalBinding } = crashReplacement(workspace, 'after-guard', {
        originalBinding: binding(`recovery-${artifactKind.replaceAll(' ', '-')}`),
      });
      const spalaDirectory = path.join(workspace, '.spala');
      const guardPath = path.join(spalaDirectory, recoveryArtifacts(workspace)[0]);
      let preservedPath = guardPath;

      if (artifactKind === 'symbolic link') {
        preservedPath = path.join(workspace, 'preserved-recovery-guard.json');
        fs.renameSync(guardPath, preservedPath);
        fs.symlinkSync(preservedPath, guardPath);
      } else if (artifactKind === 'hard link') {
        preservedPath = path.join(workspace, 'recovery-guard-alias.json');
        fs.linkSync(guardPath, preservedPath);
      } else if (artifactKind === 'tampered') {
        fs.writeFileSync(
          guardPath,
          `${JSON.stringify(binding('tampered-recovery-substitute'), null, 2)}\n`,
          { mode: 0o600 },
        );
      } else {
        const secondName = recoveryArtifacts(workspace)[0]
          .replace(/[0-9a-f]{8}-[0-9a-f-]{27}$/i, randomUUID());
        fs.copyFileSync(guardPath, path.join(spalaDirectory, secondName));
      }

      assert.throws(
        () => readProjectBinding(workspace),
        /symbolic link|hard-linked|tampered|Ambiguous/,
      );
      assert.equal(
        fs.existsSync(path.join(spalaDirectory, 'project.json')),
        false,
      );
      assert.equal(fs.existsSync(preservedPath), true);
      if (artifactKind !== 'tampered') {
        assert.deepEqual(
          JSON.parse(fs.readFileSync(preservedPath, 'utf8')),
          originalBinding,
        );
      }
    });
  }
});

test('stale recovery stays anchored when the named .spala directory is replaced', {
  skip: process.platform === 'win32',
}, () => {
  const workspace = tempDirectory();
  crashReplacement(workspace, 'after-guard');
  const spalaDirectory = path.join(workspace, '.spala');
  const displacedDirectory = path.join(workspace, '.spala-displaced-recovery');
  const winnerBinding = binding('recovery-directory-winner');
  const originalOpenSync = fs.openSync;
  let swapped = false;

  fs.openSync = (filePath, flags, mode) => {
    const descriptor = originalOpenSync(filePath, flags, mode);
    if (!swapped && path.resolve(String(filePath)) === spalaDirectory) {
      swapped = true;
      fs.renameSync(spalaDirectory, displacedDirectory);
      fs.mkdirSync(spalaDirectory, { mode: 0o700 });
      fs.writeFileSync(
        path.join(spalaDirectory, 'project.json'),
        `${JSON.stringify(winnerBinding, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
    }
    return descriptor;
  };
  try {
    assert.throws(
      () => readProjectBinding(workspace),
      /\.spala changed after it was inspected/,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }

  assert.equal(swapped, true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(spalaDirectory, 'project.json'), 'utf8')),
    winnerBinding,
  );
  assert.equal(
    fs.readdirSync(displacedDirectory)
      .filter(name => name.startsWith('.project.json.revision-guard-'))
      .length,
    1,
  );
});

test('CLI dry-run and bind accept distinct custom presentation and MCP runtime URLs', async () => {
  const workspace = tempDirectory();
  fs.mkdirSync(path.join(workspace, '.git'));
  const projectUrl = 'https://console.customer-example.test/projects/project-custom/';
  const mcpUrl = 'https://edge.shared-runtime.test/v2/tenants/project-custom/mcp?scope=builder%2Cproject%2Cdata';
  const args = bindArgs({
    projectId: 'project-custom-runtime',
    projectUrl,
    mcpUrl,
  });
  let dryRunOutput = '';

  await runCli([...args, '--dry-run'], {}, workspace, {
    stdin: { isTTY: false },
    stdout: { write: value => { dryRunOutput += value; } },
    stderr: { write: () => {} },
  });
  const dryRun = JSON.parse(dryRunOutput);
  assert.equal(dryRun.outcome, 'planned');
  assert.equal(dryRun.binding.projectUrl, projectUrl);
  assert.equal(dryRun.binding.mcpUrl, mcpUrl);
  assert.equal(fs.existsSync(path.join(workspace, '.spala')), false);

  await runCli(args, {}, workspace, quietStreams());
  const stored = readProjectBinding(workspace).binding;
  assert.equal(stored.projectUrl, projectUrl);
  assert.equal(stored.mcpUrl, mcpUrl);
  assert.match(
    fs.readFileSync(path.join(workspace, '.codex', 'config.toml'), 'utf8'),
    /edge\.shared-runtime\.test\/v2\/tenants\/project-custom\/mcp/,
  );
});

test('independent project and MCP URL validation rejects unsafe and ambiguous forms', () => {
  const workspace = tempDirectory();
  fs.mkdirSync(path.join(workspace, '.git'));
  const base = {
    ...binding('independent-url-validation'),
    projectUrl: 'https://console.custom-domain.test/project/',
    mcpUrl: 'https://runtime.other-domain.test/shared/project/mcp',
  };
  for (const [field, value, pattern] of [
    ['projectUrl', 'http://console.custom-domain.test/project/', /HTTPS/],
    ['mcpUrl', 'ftp://runtime.other-domain.test/shared/project/mcp', /HTTPS/],
    ['projectUrl', 'https://@console.custom-domain.test/project/', /credentials/],
    ['mcpUrl', 'https://runtime.other-domain.test/shared/project/mcp#', /ambiguous|fragment/],
    ['mcpUrl', 'https:\\\\runtime.other-domain.test\\shared\\project\\mcp', /ambiguous|unsafe/],
    ['mcpUrl', 'https://runtime.other-domain.test/shared/project/mcp?scope=builder&scope=project', /duplicate scope/],
    ['projectUrl', 'https://console.custom-domain.test/project/?', /empty query/],
  ]) {
    assert.throws(
      () => writeProjectBinding(workspace, { ...base, [field]: value }),
      pattern,
    );
  }
  assert.equal(fs.existsSync(path.join(workspace, '.spala')), false);
});

test('failed pending bind releases the lifecycle lock before a later bind publishes', async () => {
  const workspace = tempDirectory();
  const credentialHome = tempDirectory();
  fs.mkdirSync(path.join(workspace, '.git'));
  writeProjectBinding(workspace, {
    schemaVersion: 1,
    projectId: 'project-original',
    projectUrl: 'https://concurrent-original.spala.ai/',
    mcpUrl: 'https://concurrent-original.spala.ai/mcp?scope=builder%2Cproject%2Cdata',
    serverName: 'spala-concurrent-original-spala-ai',
  });

  const fetchStarted = deferred();
  const finishFetch = deferred();
  const firstMcpUrl = 'https://concurrent-a.spala.ai/mcp?scope=builder%2Cproject%2Cdata';
  const firstBind = runCli(bindArgs({
    projectId: 'project-concurrent-a',
    projectUrl: 'https://concurrent-a.spala.ai/',
    mcpUrl: firstMcpUrl,
    bootstrap: true,
    switchProject: true,
  }), {
    SPALA_MCP_CREDENTIAL_HOME: credentialHome,
  }, workspace, quietStreams(Readable.from([
    'https://concurrent-a.spala.ai/mcp/agent-instructions/opaque/consume\n',
  ])), {
    fetch: async () => {
      fetchStarted.resolve();
      await finishFetch.promise;
      return new Response(JSON.stringify({
        access_token: 'mcp_concurrency_test_secret',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        mcp_url: firstMcpUrl,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    storeProjectCredentialAndRetire: () => {
      throw new Error('intentional credential persistence failure');
    },
  });

  await fetchStarted.promise;
  assert.equal(readProjectBinding(workspace).binding.projectId, 'project-concurrent-a');

  let secondSettled = false;
  const secondBind = runCli(bindArgs({
    projectId: 'project-concurrent-b',
    projectUrl: 'https://concurrent-b.spala.ai/',
    mcpUrl: 'https://concurrent-b.spala.ai/mcp?scope=builder%2Cproject%2Cdata',
    switchProject: true,
  }), {}, workspace, quietStreams()).finally(() => { secondSettled = true; });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondSettled, false, 'the later bind must wait for the active lifecycle transaction');

  finishFetch.resolve();
  await assert.rejects(firstBind, /intentional credential persistence failure|rollback was incomplete/);
  await secondBind;
  assert.equal(readProjectBinding(workspace).binding.projectId, 'project-concurrent-b');
});

test('scoped bootstrap canonicalization completes before a queued later bind publishes', async () => {
  const workspace = tempDirectory();
  const credentialHome = tempDirectory();
  fs.mkdirSync(path.join(workspace, '.git'));

  const fetchStarted = deferred();
  const finishFetch = deferred();
  const bareMcpUrl = 'https://canonical-concurrent-a.spala.ai/mcp';
  const scopedMcpUrl = `${bareMcpUrl}?scope=builder%2Cproject%2Cdata`;
  let credentialPersistenceAttempts = 0;
  const firstBind = runCli(bindArgs({
    projectId: 'project-canonical-concurrent-a',
    projectUrl: 'https://canonical-concurrent-a.spala.ai/',
    mcpUrl: bareMcpUrl,
    bootstrap: true,
  }), {
    SPALA_MCP_CREDENTIAL_HOME: credentialHome,
  }, workspace, quietStreams(Readable.from([
    'https://canonical-concurrent-a.spala.ai/mcp/agent-instructions/opaque/consume\n',
  ])), {
    fetch: async () => {
      fetchStarted.resolve();
      await finishFetch.promise;
      return new Response(JSON.stringify({
        access_token: 'mcp_canonical_concurrency_test_secret',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        mcp_url: scopedMcpUrl,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    storeProjectCredential: () => {
      credentialPersistenceAttempts += 1;
    },
  });

  await fetchStarted.promise;
  assert.equal(readProjectBinding(workspace).binding.mcpUrl, bareMcpUrl);

  let secondSettled = false;
  const secondBind = runCli(bindArgs({
    projectId: 'project-canonical-concurrent-b',
    projectUrl: 'https://canonical-concurrent-b.spala.ai/',
    mcpUrl: 'https://canonical-concurrent-b.spala.ai/mcp?scope=builder%2Cproject%2Cdata',
    switchProject: true,
  }), {}, workspace, quietStreams()).finally(() => { secondSettled = true; });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondSettled, false, 'the later bind must wait for bootstrap canonicalization');

  finishFetch.resolve();
  await firstBind;
  await secondBind;
  assert.equal(credentialPersistenceAttempts, 1);
  assert.equal(readProjectBinding(workspace).binding.projectId, 'project-canonical-concurrent-b');
});

test('parent .spala swap after bootstrap consume preserves the replacement binding and cleans the anchor', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = tempDirectory();
  const credentialHome = tempDirectory();
  fs.mkdirSync(path.join(workspace, '.git'));

  const scopedMcpUrl = 'https://parent-swap.spala.ai/mcp?scope=builder%2Cproject%2Cdata';
  const laterBinding = binding('parent-swap-winner');
  const spalaDirectory = path.join(workspace, '.spala');
  const displacedDirectory = path.join(workspace, '.spala-displaced');
  const originalOpenSync = fs.openSync;
  let bootstrapConsumed = false;
  let validationReached = false;
  let credentialPersistenceAttempts = 0;

  fs.openSync = (filePath, flags, mode) => {
    if (
      !validationReached
      && bootstrapConsumed
      && String(filePath) === 'project.json'
      && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0
    ) {
      validationReached = true;
      fs.renameSync(spalaDirectory, displacedDirectory);
      fs.mkdirSync(spalaDirectory, { mode: 0o700 });
      writeProjectBinding(workspace, laterBinding);
    }
    return originalOpenSync(filePath, flags, mode);
  };

  let bindError;
  try {
    bindError = await runCli(bindArgs({
      projectId: 'project-parent-swap',
      projectUrl: 'https://parent-swap.spala.ai/',
      mcpUrl: scopedMcpUrl,
      bootstrap: true,
    }), {
      SPALA_MCP_CREDENTIAL_HOME: credentialHome,
    }, workspace, quietStreams(Readable.from([
      'https://parent-swap.spala.ai/mcp/agent-instructions/opaque/consume\n',
    ])), {
      fetch: async () => {
        bootstrapConsumed = true;
        return new Response(JSON.stringify({
          access_token: 'mcp_parent_swap_test_secret',
          token_type: 'Bearer',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          mcp_url: scopedMcpUrl,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      storeProjectCredential: () => {
        credentialPersistenceAttempts += 1;
      },
    }).then(() => null, error => error);
  } finally {
    fs.openSync = originalOpenSync;
  }

  assert.match(bindError?.message || '', /\.spala changed after it was inspected/);
  assert.doesNotMatch(bindError.message, /rollback was incomplete/);
  assert.equal(bootstrapConsumed, true);
  assert.equal(validationReached, true);
  assert.equal(credentialPersistenceAttempts, 0);
  assert.deepEqual(readProjectBinding(workspace).binding, laterBinding);
  assert.deepEqual(fs.readdirSync(displacedDirectory), ['.project-lifecycle.lock']);
});

test('post-credential binding validation rejects success and preserves a concurrent winner', async () => {
  const workspace = tempDirectory();
  const credentialHome = tempDirectory();
  fs.mkdirSync(path.join(workspace, '.git'));

  const scopedMcpUrl = 'https://post-credential.spala.ai/mcp?scope=builder%2Cproject%2Cdata';
  const winnerBinding = binding('post-credential-winner');
  let stdout = '';
  let credentialPersistenceAttempts = 0;

  await assert.rejects(
    runCli(bindArgs({
      projectId: 'project-post-credential',
      projectUrl: 'https://post-credential.spala.ai/',
      mcpUrl: scopedMcpUrl,
      bootstrap: true,
    }), {
      SPALA_MCP_CREDENTIAL_HOME: credentialHome,
    }, workspace, {
      stdin: Readable.from([
        'https://post-credential.spala.ai/mcp/agent-instructions/opaque/consume\n',
      ]),
      stdout: { write: value => { stdout += value; } },
      stderr: { write: () => {} },
    }, {
      fetch: async () => new Response(JSON.stringify({
        access_token: 'mcp_post_credential_test_secret',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        mcp_url: scopedMcpUrl,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      storeProjectCredential: () => {
        credentialPersistenceAttempts += 1;
        writeProjectBinding(
          workspace,
          winnerBinding,
          { switchProject: true },
        );
      },
    }),
    /Workspace binding changed while the project bind was pending/,
  );

  assert.equal(credentialPersistenceAttempts, 1);
  assert.equal(stdout, '');
  assert.deepEqual(readProjectBinding(workspace).binding, winnerBinding);
  assert.deepEqual(fs.readdirSync(path.join(workspace, '.spala')), ['project.json']);
});

test('rollback preserves a writer landing after the isolated revision check', async t => {
  for (const testCase of [
    { name: 'restore previous binding', previousBinding: binding('rollback-original') },
    { name: 'remove newly created binding', previousBinding: null },
  ]) {
    await t.test(testCase.name, () => {
      const workspace = tempDirectory();
      fs.mkdirSync(path.join(workspace, '.git'));
      if (testCase.previousBinding) writeProjectBinding(workspace, testCase.previousBinding);

      const failedBinding = binding(`failed-${testCase.name.replaceAll(' ', '-')}`);
      const failedWrite = writeProjectBinding(
        workspace,
        failedBinding,
        { switchProject: Boolean(testCase.previousBinding) },
      );
      const laterBinding = binding(`later-${testCase.name.replaceAll(' ', '-')}`);
      const filePath = path.join(workspace, '.spala', 'project.json');
      const originalOpenSync = fs.openSync;
      const originalLstatSync = fs.lstatSync;
      const originalRenameSync = fs.renameSync;
      const originalUnlinkSync = fs.unlinkSync;
      let guardChecked = false;
      let injectedAction;

      fs.lstatSync = (filePath, options) => {
        const stat = originalLstatSync(filePath, options);
        const name = path.basename(String(filePath));
        if (options?.bigint === true && name.startsWith('.project.json.rollback-guard-')) {
          guardChecked = true;
        }
        return stat;
      };
      const injectLaterWriter = action => {
        if (injectedAction) return;
        assert.equal(guardChecked, true, 'rollback must verify the isolated guard before acting');
        injectedAction = action;
        writeProjectBinding(workspace, laterBinding, { switchProject: true });
      };
      fs.openSync = (targetPath, flags, mode) => {
        if (
          testCase.previousBinding
          && path.basename(String(targetPath)) === 'project.json'
          && (flags & fs.constants.O_EXCL) !== 0
        ) {
          injectLaterWriter('open');
        }
        return originalOpenSync(targetPath, flags, mode);
      };
      fs.renameSync = (sourcePath, destinationPath) => {
        if (path.resolve(String(destinationPath)) === filePath) injectLaterWriter('rename');
        return originalRenameSync(sourcePath, destinationPath);
      };
      fs.unlinkSync = targetPath => {
        const targetName = path.basename(String(targetPath));
        if (path.resolve(String(targetPath)) === filePath
          || targetName.startsWith('.project.json.rollback-guard-')) {
          injectLaterWriter('unlink');
        }
        return originalUnlinkSync(targetPath);
      };
      try {
        rollbackProjectBinding(
          workspace,
          failedWrite.revision,
          testCase.previousBinding,
        );
      } finally {
        fs.openSync = originalOpenSync;
        fs.lstatSync = originalLstatSync;
        fs.renameSync = originalRenameSync;
        fs.unlinkSync = originalUnlinkSync;
      }

      assert.equal(
        injectedAction,
        testCase.previousBinding ? 'open' : 'unlink',
        'the later writer must run immediately before rollback acts',
      );
      assert.deepEqual(readProjectBinding(workspace).binding, laterBinding);
      assert.equal(
        fs.readdirSync(path.join(workspace, '.spala'))
          .some(name => name.startsWith('.project.json.rollback-')),
        false,
      );
    });
  }
});

test('binding publication and rollback do not depend on hard links', () => {
  const workspace = tempDirectory();
  fs.mkdirSync(path.join(workspace, '.git'));
  const originalBinding = binding('copy-exclusive-original');
  const updatedBinding = binding('copy-exclusive-updated');
  const originalLinkSync = fs.linkSync;

  fs.linkSync = () => {
    const error = new Error('hard links are unsupported');
    error.code = 'EPERM';
    throw error;
  };
  try {
    writeProjectBinding(workspace, originalBinding);
    const updated = writeProjectBinding(
      workspace,
      updatedBinding,
      { switchProject: true },
    );
    rollbackProjectBinding(workspace, updated.revision, originalBinding);
  } finally {
    fs.linkSync = originalLinkSync;
  }

  assert.deepEqual(readProjectBinding(workspace).binding, originalBinding);
  assert.deepEqual(fs.readdirSync(path.join(workspace, '.spala')), ['project.json']);
});

test('binding publication cleans a partial exclusive write and restores the guarded binding', () => {
  const workspace = tempDirectory();
  fs.mkdirSync(path.join(workspace, '.git'));
  const originalBinding = binding('partial-write-original');
  const attemptedBinding = binding('partial-write-attempt');
  writeProjectBinding(workspace, originalBinding);

  const originalOpenSync = fs.openSync;
  const originalWriteSync = fs.writeSync;
  let publicationDescriptor;
  let partialWriteInjected = false;

  fs.openSync = (filePath, flags, mode) => {
    const descriptor = originalOpenSync(filePath, flags, mode);
    if (
      !partialWriteInjected
      && String(filePath) === 'project.json'
      && (flags & fs.constants.O_EXCL) !== 0
    ) {
      publicationDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.writeSync = (descriptor, buffer, offset, length, position) => {
    if (!partialWriteInjected && descriptor === publicationDescriptor) {
      partialWriteInjected = true;
      originalWriteSync(
        descriptor,
        buffer,
        offset,
        Math.min(length, 12),
        position,
      );
      throw new Error('injected partial exclusive-write failure');
    }
    return originalWriteSync(descriptor, buffer, offset, length, position);
  };
  try {
    assert.throws(
      () => writeProjectBinding(
        workspace,
        attemptedBinding,
        { switchProject: true },
      ),
      /injected partial exclusive-write failure/,
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.writeSync = originalWriteSync;
  }

  assert.equal(partialWriteInjected, true);
  assert.deepEqual(readProjectBinding(workspace).binding, originalBinding);
  assert.deepEqual(fs.readdirSync(path.join(workspace, '.spala')), ['project.json']);
});

test('binding publication removes its canonical name after a post-publication hardlink', () => {
  const workspace = tempDirectory();
  fs.mkdirSync(path.join(workspace, '.git'));
  const attemptedBinding = binding('post-publication-hardlink');
  const filePath = path.join(workspace, '.spala', 'project.json');
  const aliasPath = path.join(workspace, 'project-publication-alias.json');
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  let publicationDescriptor;
  let hardlinkInjected = false;

  fs.openSync = (targetPath, flags, mode) => {
    const descriptor = originalOpenSync(targetPath, flags, mode);
    if (
      String(targetPath) === 'project.json'
      && (flags & fs.constants.O_EXCL) !== 0
    ) {
      publicationDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.fsyncSync = descriptor => {
    const result = originalFsyncSync(descriptor);
    if (!hardlinkInjected && descriptor === publicationDescriptor) {
      hardlinkInjected = true;
      fs.linkSync(filePath, aliasPath);
    }
    return result;
  };
  try {
    assert.throws(
      () => writeProjectBinding(workspace, attemptedBinding),
      /changed while it was being published|hard-linked/,
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.fsyncSync = originalFsyncSync;
  }

  assert.equal(hardlinkInjected, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(aliasPath, 'utf8')), attemptedBinding);
  assert.deepEqual(fs.readdirSync(path.join(workspace, '.spala')), []);
});

test('binding publication preserves a concurrent winner replacing its owned descriptor', () => {
  const workspace = tempDirectory();
  fs.mkdirSync(path.join(workspace, '.git'));
  const attemptedBinding = binding('descriptor-attempt');
  const winnerBinding = binding('descriptor-winner');
  const originalOpenSync = fs.openSync;
  const originalWriteSync = fs.writeSync;
  let publicationDescriptor;
  let writerInjected = false;

  fs.openSync = (filePath, flags, mode) => {
    const descriptor = originalOpenSync(filePath, flags, mode);
    if (
      !writerInjected
      && String(filePath) === 'project.json'
      && (flags & fs.constants.O_EXCL) !== 0
    ) {
      publicationDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.writeSync = (descriptor, buffer, offset, length, position) => {
    if (!writerInjected && descriptor === publicationDescriptor) {
      writerInjected = true;
      const writerPath = `.project.json.writer-${process.pid}-${Date.now()}`;
      fs.unlinkSync('project.json');
      fs.writeFileSync(
        writerPath,
        `${JSON.stringify(winnerBinding, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      fs.renameSync(writerPath, 'project.json');
    }
    return originalWriteSync(descriptor, buffer, offset, length, position);
  };
  try {
    assert.throws(
      () => writeProjectBinding(workspace, attemptedBinding),
      /changed while it was being published/,
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.writeSync = originalWriteSync;
  }

  assert.equal(writerInjected, true);
  assert.deepEqual(readProjectBinding(workspace).binding, winnerBinding);
  assert.deepEqual(fs.readdirSync(path.join(workspace, '.spala')), ['project.json']);
});

test('rollback rejects symbolic targets and removes only an expected hardlinked canonical name', async t => {
  await t.test('symbolic link', () => {
    const workspace = tempDirectory();
    fs.mkdirSync(path.join(workspace, '.git'));
    const failedWrite = writeProjectBinding(workspace, binding('rollback-symlink'));
    const filePath = path.join(workspace, '.spala', 'project.json');
    const displacedPath = path.join(workspace, 'displaced-project.json');
    fs.renameSync(filePath, displacedPath);
    fs.symlinkSync(displacedPath, filePath);

    assert.throws(
      () => rollbackProjectBinding(workspace, failedWrite.revision),
      /symbolic link/,
    );
    assert.equal(fs.lstatSync(filePath).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(displacedPath, 'utf8')), binding('rollback-symlink'));
  });

  await t.test('hard link', () => {
    const workspace = tempDirectory();
    fs.mkdirSync(path.join(workspace, '.git'));
    const originalBinding = binding('rollback-hardlink-original');
    const attemptedBinding = binding('rollback-hardlink-attempt');
    writeProjectBinding(workspace, originalBinding);
    const failedWrite = writeProjectBinding(
      workspace,
      attemptedBinding,
      { switchProject: true },
    );
    const filePath = path.join(workspace, '.spala', 'project.json');
    const aliasPath = path.join(workspace, 'project-alias.json');
    fs.linkSync(filePath, aliasPath);

    const result = rollbackProjectBinding(
      workspace,
      failedWrite.revision,
      originalBinding,
    );
    assert.equal(result.changed, true);
    assert.deepEqual(readProjectBinding(workspace).binding, originalBinding);
    const aliasStat = fs.statSync(aliasPath, { bigint: true });
    assert.equal(aliasStat.nlink, 1n);
    assert.deepEqual(JSON.parse(fs.readFileSync(aliasPath, 'utf8')), attemptedBinding);
  });
});

test('explicit switch replaces bindings with unsupported or noncanonical scopes', async t => {
  const cases = [
    {
      name: 'unsupported future scope',
      scope: 'builder%2Cfuture',
      rejection: /unknown project MCP scope/,
    },
    {
      name: 'noncanonical narrowed scope',
      scope: 'builder%2Cproject',
      rejection: /already bound.*--switch/,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const workspace = tempDirectory();
      fs.mkdirSync(path.join(workspace, '.git'));
      const projectUrl = 'https://scope-recovery.spala.ai/';
      const requestedMcpUrl = 'https://scope-recovery.spala.ai/mcp';
      const legacyBinding = {
        schemaVersion: 1,
        projectId: 'project-scope-recovery',
        projectUrl,
        mcpUrl: `${requestedMcpUrl}?scope=${testCase.scope}`,
        serverName: 'spala-scope-recovery-spala-ai',
      };
      writeProjectBinding(workspace, legacyBinding);

      const args = bindArgs({
        projectId: legacyBinding.projectId,
        projectUrl,
        mcpUrl: requestedMcpUrl,
      });
      await assert.rejects(
        runCli(args, {}, workspace, quietStreams()),
        testCase.rejection,
      );
      assert.deepEqual(readProjectBinding(workspace).binding, legacyBinding);

      await runCli(
        bindArgs({
          projectId: legacyBinding.projectId,
          projectUrl,
          mcpUrl: requestedMcpUrl,
          switchProject: true,
        }),
        {},
        workspace,
        quietStreams(),
      );
      assert.equal(
        readProjectBinding(workspace).binding.mcpUrl,
        requestedMcpUrl,
      );
    });
  }
});
