import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import {
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

test('failed pending bind does not roll back a later successful concurrent bind', async () => {
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
    'https://concurrent-a.spala.ai/mcp/bootstrap/opaque/consume\n',
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
    storeProjectCredential: () => {
      throw new Error('intentional credential persistence failure');
    },
  });

  await fetchStarted.promise;
  assert.equal(readProjectBinding(workspace).binding.projectId, 'project-concurrent-a');

  await runCli(bindArgs({
    projectId: 'project-concurrent-b',
    projectUrl: 'https://concurrent-b.spala.ai/',
    mcpUrl: 'https://concurrent-b.spala.ai/mcp?scope=builder%2Cproject%2Cdata',
    switchProject: true,
  }), {}, workspace, quietStreams());

  finishFetch.resolve();
  await assert.rejects(firstBind, /intentional credential persistence failure|rollback was incomplete/);
  assert.equal(readProjectBinding(workspace).binding.projectId, 'project-concurrent-b');
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
      const originalLinkSync = fs.linkSync;
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
      fs.linkSync = (sourcePath, destinationPath) => {
        if (path.resolve(String(destinationPath)) === filePath) injectLaterWriter('link');
        return originalLinkSync(sourcePath, destinationPath);
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
        fs.linkSync = originalLinkSync;
        fs.lstatSync = originalLstatSync;
        fs.renameSync = originalRenameSync;
        fs.unlinkSync = originalUnlinkSync;
      }

      assert.equal(
        injectedAction,
        testCase.previousBinding ? 'link' : 'unlink',
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

test('rollback rejects symbolic and hard-linked binding targets without moving them', async t => {
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
    const failedWrite = writeProjectBinding(workspace, binding('rollback-hardlink'));
    const filePath = path.join(workspace, '.spala', 'project.json');
    const aliasPath = path.join(workspace, 'project-alias.json');
    fs.linkSync(filePath, aliasPath);

    assert.throws(
      () => rollbackProjectBinding(workspace, failedWrite.revision),
      /hard-linked/,
    );
    const targetStat = fs.statSync(filePath, { bigint: true });
    const aliasStat = fs.statSync(aliasPath, { bigint: true });
    assert.equal(targetStat.ino, aliasStat.ino);
    assert.equal(targetStat.nlink, 2n);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), binding('rollback-hardlink'));
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
