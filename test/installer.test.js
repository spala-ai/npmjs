import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runBoundedCommand, runCli } from '../src/cli.js';
import {
  buildCommandHints,
  buildProxyCommandHints,
  createDoctorReport,
  createInstallPlan,
  createProxyInstallPlan,
  createUninstallPlan,
  installPlan,
  normalizeMcpUrl,
  PUBLIC_LEGACY_SERVER_NAMES,
  PUBLIC_MCP_URL,
  PUBLIC_SERVER_NAME,
  rollbackInstallPlan,
  serverNameFromUrl,
} from '../src/installer.js';
import { credentialStorePath, projectCredentialStatus, readProjectCredential, storeProjectCredential } from '../src/credentialStore.js';
import { runProxy } from '../src/proxy.js';
import { Readable } from 'node:stream';
import {
  findWorkspaceRoot,
  readProjectBinding,
  writeProjectBinding,
} from '../src/workspace.js';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spala-mcp-install-'));
}

function trustedChildCwd() {
  return fs.realpathSync(path.dirname(process.execPath));
}

function writeCodexRegistration(root, serverName, mcpUrl) {
  const configDir = path.join(root, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(configPath, [
    `[mcp_servers.${serverName}]`,
    `url = ${JSON.stringify(mcpUrl)}`,
    '',
  ].join('\n'));
  return configPath;
}

function oauthAuthorizationUrl(extra = {}, mcpUrl = PUBLIC_MCP_URL) {
  const endpoint = new URL(mcpUrl);
  endpoint.pathname = mcpUrl === PUBLIC_MCP_URL
    ? '/oauth/authorize'
    : `${endpoint.pathname.replace(/\/+$/, '')}/oauth/authorize`;
  endpoint.search = new URLSearchParams({
    response_type: 'code',
    client_id: 'codex-native-client',
    redirect_uri: 'http://127.0.0.1:43123/callback',
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
    state: 'review-state',
    scope: 'api',
    resource: mcpUrl,
    ...extra,
  }).toString();
  return endpoint.toString();
}

function captureError(action, pattern) {
  let caught;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, 'Expected action to throw an Error.');
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}

async function captureAsyncError(action, pattern) {
  let caught;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, 'Expected action to reject with an Error.');
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}

function ttyInput(chunks, initialRawMode = false) {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = initialRawMode;
  stdin.rawModes = [];
  stdin.setRawMode = enabled => {
    stdin.rawModes.push(enabled);
    stdin.isRaw = enabled;
  };
  stdin.resume = () => {
    queueMicrotask(() => {
      for (const chunk of chunks) stdin.emit('data', chunk);
    });
  };
  stdin.pause = () => {};
  return stdin;
}

test('normalizes missing scope without replacing an existing scope', () => {
  assert.equal(
    normalizeMcpUrl('https://example.test/mcp', 'builder,project,data'),
    'https://example.test/mcp?scope=builder%2Cproject%2Cdata',
  );
  assert.equal(
    normalizeMcpUrl('https://example.test/mcp?scope=api', 'builder,project,data'),
    'https://example.test/mcp?scope=api',
  );
});

test('can preserve the public MCP URL without adding project scope', () => {
  assert.equal(
    normalizeMcpUrl(PUBLIC_MCP_URL, ''),
    PUBLIC_MCP_URL,
  );
});

test('semantic public URL variants always canonicalize URL, scope, install scope, and name', () => {
  const variants = [
    `${PUBLIC_MCP_URL}/`,
    `${PUBLIC_MCP_URL}///?scope=builder%2Cproject%2Cdata`,
    'https://MCP.SPALA.AI:443/mcp/?scope=api',
  ];
  for (const variant of variants) {
    assert.equal(normalizeMcpUrl(variant, 'builder,project,data', true), PUBLIC_MCP_URL);
    const home = tempHome();
    const plan = createInstallPlan({
      clientSelection: 'gemini',
      env: { SPALA_MCP_INSTALL_HOME: home },
      exactUrl: true,
      mcpUrl: variant,
      scope: 'builder,project,data',
      serverName: 'noncanonical-public-name',
    });
    assert.equal(plan.mcpUrl, PUBLIC_MCP_URL);
    assert.equal(plan.serverName, PUBLIC_SERVER_NAME);
    assert.equal(plan.installScope, 'user');
    assert.deepEqual(JSON.parse(plan.writes[0].content).mcpServers[PUBLIC_SERVER_NAME], {
      httpUrl: PUBLIC_MCP_URL,
    });
  }
});

test('exact URL mode validates without canonicalizing or adding scope', () => {
  const scoped = 'https://example.test/mcp/?scope=builder%2Cproject%2Cdata';
  assert.equal(normalizeMcpUrl(scoped, '', true), scoped);
  assert.equal(normalizeMcpUrl('https://example.test/mcp', '', true), 'https://example.test/mcp');
});

test('rejects unsafe MCP URLs', () => {
  assert.throws(() => normalizeMcpUrl('file:///tmp/mcp'), /must use https/);
  assert.throws(() => normalizeMcpUrl('javascript:alert(1)'), /must use https/);
  assert.throws(() => normalizeMcpUrl('https://user:pass@example.test/mcp'), /embedded credentials/);
  assert.throws(() => normalizeMcpUrl('https://example.test/mcp#token'), /fragment/);
  assert.throws(() => normalizeMcpUrl('https://example.test/mcp?token=secret'), /unsupported query parameter/);
  assert.equal(normalizeMcpUrl('http://localhost:3000/mcp', ''), 'http://localhost:3000/mcp');
  assert.equal(normalizeMcpUrl('http://[::1]:3000/mcp', ''), 'http://[::1]:3000/mcp');
});

test('shell command hints safely quote command substitution characters', () => {
  const hints = buildCommandHints('spala_public_mcp', 'https://mcp.spala.ai/mcp?x=$(touch /tmp/nope)');
  assert.equal(hints.codexAdd, null);
  assert.equal(hints.codexLogin, null);
  assert.match(hints.geminiCli, /--scope user/);
  assert.deepEqual(hints.argv.codexAdd, null);
});

test('public MCP command hints match the live manifest scope contract', () => {
  const hints = buildCommandHints(PUBLIC_SERVER_NAME, PUBLIC_MCP_URL);
  assert.match(hints.codexAdd, /npx.*--yes.*@spala-ai\/mcp-install@0\.1\.14/);
  assert.equal(hints.codexLogin, null);
  assert.deepEqual(hints.argv.codexLogin, null);
});

test('project MCP command hints do not force public api scope', () => {
  const hints = buildCommandHints('spala-shared-spala-ai-p123', 'https://shared.spala.ai/p123/mcp?scope=builder,project,data');
  assert.equal(hints.codexAdd, null);
  assert.equal(hints.codexLogin, null);
  assert.deepEqual(hints.argv.codexLogin, null);
});

test('derives a stable server name from the MCP host', () => {
  assert.equal(
    serverNameFromUrl('https://p4cd33.ukraine.spala.ai/mcp?scope=api'),
    'spala-p4cd33-ukraine-spala-ai',
  );
  assert.equal(
    serverNameFromUrl('https://shared.spala.ai/pcad40/mcp?scope=builder,project,data'),
    'spala-shared-spala-ai-pcad40',
  );
});

test('plans public MCP installs with recommended name and no project scope', () => {
  const home = tempHome();
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  assert.equal(plan.serverName, PUBLIC_SERVER_NAME);
  assert.equal(plan.mcpUrl, PUBLIC_MCP_URL);
  assert.deepEqual(JSON.parse(plan.writes[0].content).mcpServers['spala_public_mcp'], {
    httpUrl: PUBLIC_MCP_URL,
  });
});

test('plans exact handoff URL installs without adding a default scope', () => {
  const home = tempHome();
  const exactUrl = 'https://shared.spala.ai/p123/mcp/';
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    exactUrl: true,
    mcpUrl: exactUrl,
    serverName: 'spala-project',
  });

  assert.equal(plan.mcpUrl, exactUrl);
  assert.equal(plan.installScope, 'workspace');
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.skipped[0].client, 'gemini');
  assert.equal(plan.skipped[0].commandRequired, true);
});

test('refuses to overwrite same server name with a different URL', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    mcpServers: {
      'spala_public_mcp': { url: 'https://shared.spala.ai/p123/mcp' },
    },
  }));

  assert.throws(
    () => createInstallPlan({
      clientSelection: 'gemini',
      env: { SPALA_MCP_INSTALL_HOME: home },
      mcpUrl: PUBLIC_MCP_URL,
      scope: '',
      serverName: PUBLIC_SERVER_NAME,
    }),
    /Refusing to replace existing MCP server/,
  );
});

test('writes antigravity serverUrl config and preserves existing servers', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini', 'antigravity');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'mcp_config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      existing: { serverUrl: 'https://old.example/mcp' },
    },
  }, null, 2));

  const plan = createInstallPlan({
    clientSelection: 'antigravity',
    env: { SPALA_MCP_INSTALL_HOME: home },
    installScope: 'user',
    mcpUrl: 'https://project.example/mcp?scope=builder,project,data',
  });
  const result = installPlan(plan);
  const next = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  assert.equal(result.writes.length, 1);
  assert.equal(next.mcpServers.existing.serverUrl, 'https://old.example/mcp');
  assert.equal(next.mcpServers['spala-project-example'].serverUrl, 'https://project.example/mcp?scope=builder,project,data');
  assert.ok(result.writes[0].backupPath);
  assert.ok(fs.existsSync(result.writes[0].backupPath));
  assert.equal((fs.statSync(result.writes[0].backupPath).mode & 0o777), 0o600);
});

test('dry run does not write files', () => {
  const home = tempHome();
  const plan = createInstallPlan({
    clientSelection: 'windsurf',
    dryRun: true,
    env: { SPALA_MCP_INSTALL_HOME: home },
    installScope: 'user',
    mcpUrl: 'https://project.example/mcp',
  });

  assert.equal(plan.writes.length, 1);
  assert.equal(fs.existsSync(path.join(home, '.codeium', 'windsurf', 'mcp_config.json')), false);
});

test('does not overwrite non-object config roots or buckets', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify([]));
  assert.throws(
    () => createInstallPlan({
      clientSelection: 'gemini',
      env: { SPALA_MCP_INSTALL_HOME: home },
      mcpUrl: PUBLIC_MCP_URL,
      scope: '',
      serverName: PUBLIC_SERVER_NAME,
    }),
    /Config root must be a JSON object/,
  );

  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ mcpServers: [] }));
  assert.throws(
    () => createInstallPlan({
      clientSelection: 'gemini',
      env: { SPALA_MCP_INSTALL_HOME: home },
      mcpUrl: PUBLIC_MCP_URL,
      scope: '',
      serverName: PUBLIC_SERVER_NAME,
    }),
    /mcpServers must be a JSON object/,
  );
});

test('all writable JSON clients reject symbolic-link config files without leaking target values', () => {
  const userClients = [
    'antigravity',
    'antigravity-cli',
    'gemini',
    'windsurf',
    'cline',
    'claude-desktop',
    'zed',
  ];

  const exercise = (label, options) => {
    const initial = createInstallPlan(options);
    const configPath = initial.writes[0].path;
    const secret = `symlink-secret-${label}`;
    const externalPath = path.join(options.env.SPALA_MCP_INSTALL_HOME, `outside-${label}.json`);
    const externalBody = JSON.stringify({ mcpServers: { external: { token: secret } } });
    fs.writeFileSync(externalPath, externalBody);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.symlinkSync(externalPath, configPath);

    const planningError = captureError(() => createInstallPlan(options), /symbolic links/);
    const applyError = captureError(() => installPlan(initial), /symbolic links/);
    assert.doesNotMatch(planningError.message, new RegExp(secret));
    assert.doesNotMatch(applyError.message, new RegExp(secret));
    assert.equal(fs.lstatSync(configPath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(externalPath, 'utf8'), externalBody);
  };

  for (const client of userClients) {
    const home = tempHome();
    exercise(client, {
      clientSelection: client,
      env: {
        SPALA_MCP_INSTALL_HOME: home,
        ...(client === 'claude-desktop' ? { SPALA_MCP_INSTALL_PLATFORM: 'darwin' } : {}),
      },
      mcpUrl: PUBLIC_MCP_URL,
      scope: '',
      serverName: PUBLIC_SERVER_NAME,
    });
  }

  const workspace = tempHome();
  const home = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  exercise('roo', {
    clientSelection: 'roo',
    cwd: workspace,
    env: { SPALA_MCP_INSTALL_HOME: home },
    exactUrl: true,
    installScope: 'workspace',
    mcpUrl: 'https://shared.spala.ai/p123/mcp',
    scope: '',
    serverName: 'spala_project_p123',
  });
});

test('JSON writes reject a symlinked parent introduced before planning or application', () => {
  const home = tempHome();
  const options = {
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  };
  const plan = createInstallPlan(options);
  const configPath = plan.writes[0].path;
  const outside = tempHome();
  const secret = 'parent-link-secret-do-not-print';
  const outsideConfig = path.join(outside, path.basename(configPath));
  const outsideBody = JSON.stringify({ mcpServers: { external: { token: secret } } });
  fs.writeFileSync(outsideConfig, outsideBody);
  fs.symlinkSync(outside, path.dirname(configPath));

  const planningError = captureError(() => createInstallPlan(options), /symbolic links/);
  const applyError = captureError(() => installPlan(plan), /symbolic links/);
  assert.doesNotMatch(planningError.message, new RegExp(secret));
  assert.doesNotMatch(applyError.message, new RegExp(secret));
  assert.equal(fs.lstatSync(path.dirname(configPath)).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outsideConfig, 'utf8'), outsideBody);
});

test('Codex config paths reject symlinked parents during planning, doctor, uninstall, and apply', () => {
  const home = tempHome();
  const options = {
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  };
  const plan = createInstallPlan(options);
  const outside = tempHome();
  const secret = 'codex-parent-secret-do-not-print';
  const outsideConfig = path.join(outside, 'config.toml');
  const outsideBody = `private_note = ${JSON.stringify(secret)}\n`;
  fs.writeFileSync(outsideConfig, outsideBody);
  fs.symlinkSync(outside, path.join(home, '.codex'));

  const planningError = captureError(() => createInstallPlan(options), /symbolic links/);
  const applyError = captureError(() => installPlan(plan), /symbolic links/);
  const uninstallError = captureError(() => createUninstallPlan({
    cleanupDuplicates: true,
    ...options,
  }), /symbolic links/);
  const report = createDoctorReport({ ...options, installScope: 'user' });

  assert.match(report.clients[0].issues[0], /unsafe_config_path: .*symbolic links/);
  for (const output of [planningError.message, applyError.message, uninstallError.message, JSON.stringify(report)]) {
    assert.doesNotMatch(output, new RegExp(secret));
  }
  assert.equal(fs.lstatSync(path.join(home, '.codex')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outsideConfig, 'utf8'), outsideBody);
});

test('Codex managed skill paths reject symlinked parents during planning, doctor, uninstall, and apply', () => {
  const home = tempHome();
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'config.toml'), [
    `[mcp_servers.${PUBLIC_SERVER_NAME}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
  ].join('\n'));
  const options = {
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  };
  const plan = createInstallPlan(options);
  assert.equal(plan.writes[0].action, 'unchanged');
  assert.equal(plan.writes[1].component, 'skill');

  const outside = tempHome();
  const outsideSkillDir = path.join(outside, 'spala-backend');
  const outsideSkill = path.join(outsideSkillDir, 'SKILL.md');
  const secret = 'codex-skill-parent-secret-do-not-print';
  fs.mkdirSync(outsideSkillDir);
  fs.writeFileSync(outsideSkill, `unmanaged ${secret}\n`);
  fs.symlinkSync(outside, path.join(codexDir, 'skills'));

  const planningError = captureError(() => createInstallPlan(options), /symbolic links/);
  const applyError = captureError(() => installPlan(plan), /symbolic links/);
  const uninstallError = captureError(() => createUninstallPlan(options), /symbolic links/);
  const report = createDoctorReport({ ...options, installScope: 'user' });

  assert.match(report.clients[0].issues[0], /unsafe_config_path: .*symbolic links/);
  for (const output of [planningError.message, applyError.message, uninstallError.message, JSON.stringify(report)]) {
    assert.doesNotMatch(output, new RegExp(secret));
  }
  assert.equal(fs.lstatSync(path.join(codexDir, 'skills')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outsideSkill, 'utf8'), `unmanaged ${secret}\n`);
});

test('hard-linked config targets and hard-linked parent files are rejected without mutation', () => {
  const home = tempHome();
  const outside = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const outsideConfig = path.join(outside, 'outside-settings.json');
  const secret = 'hardlink-secret-must-not-leak';
  const source = `{"mcpServers":{"external":{"token":"${secret}"}}}\n`;
  fs.mkdirSync(configDir);
  fs.writeFileSync(outsideConfig, source);
  fs.linkSync(outsideConfig, configPath);
  const options = {
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  };

  const installError = captureError(() => createInstallPlan(options), /hard-linked/);
  const report = createDoctorReport({ ...options, installScope: 'user' });
  assert.match(report.clients[0].issues[0], /hard-linked/);
  assert.doesNotMatch(installError.message, new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  assert.equal(fs.readFileSync(outsideConfig, 'utf8'), source);

  const parentHome = tempHome();
  const outsideParent = path.join(outside, 'outside-parent-file');
  const linkedParent = path.join(parentHome, '.gemini');
  fs.writeFileSync(outsideParent, secret);
  fs.linkSync(outsideParent, linkedParent);
  const parentError = captureError(() => createInstallPlan({
    ...options,
    env: { SPALA_MCP_INSTALL_HOME: parentHome },
  }), /directory parents/);
  assert.doesNotMatch(parentError.message, new RegExp(secret));
  assert.equal(fs.readFileSync(outsideParent, 'utf8'), secret);

  const applyHome = tempHome();
  const applyDir = path.join(applyHome, '.gemini');
  const applyPath = path.join(applyDir, 'settings.json');
  const outsideAlias = path.join(outside, 'post-plan-alias.json');
  fs.mkdirSync(applyDir);
  fs.writeFileSync(applyPath, source);
  const applyPlan = createInstallPlan({
    ...options,
    env: { SPALA_MCP_INSTALL_HOME: applyHome },
  });
  fs.linkSync(applyPath, outsideAlias);
  captureError(() => installPlan(applyPlan), /hard-linked/);
  assert.equal(fs.readFileSync(applyPath, 'utf8'), source);
  assert.equal(fs.readFileSync(outsideAlias, 'utf8'), source);
});

test('Codex managed skill hard links are rejected by install and uninstall', () => {
  const home = tempHome();
  const options = {
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  };
  installPlan(createInstallPlan(options));
  const skillPath = path.join(home, '.codex', 'skills', 'spala-backend', 'SKILL.md');
  const outsideSkill = path.join(tempHome(), 'outside-skill.md');
  const source = fs.readFileSync(skillPath, 'utf8');
  fs.renameSync(skillPath, outsideSkill);
  fs.linkSync(outsideSkill, skillPath);

  captureError(() => createInstallPlan(options), /hard-linked/);
  captureError(() => createUninstallPlan(options), /hard-linked/);
  assert.equal(fs.readFileSync(outsideSkill, 'utf8'), source);
});

test('hard link added after the final target check is rejected and the target name is restored', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const outsideAlias = path.join(tempHome(), 'outside-alias.json');
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  fs.mkdirSync(configDir);
  fs.writeFileSync(configPath, original, { mode: 0o640 });
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  captureError(() => installPlan(plan, {
    fileOperationHook: stage => {
      if (stage === 'after_target_final_check_before_detach') {
        fs.linkSync(configPath, outsideAlias);
      }
    },
  }), /hard-linked/);

  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.readFileSync(outsideAlias, 'utf8'), original);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
});

test('planned JSON and Codex writes reject real parent directory replacement before apply', () => {
  const cases = [
    {
      client: 'gemini',
      configDirectory: home => path.join(home, '.gemini'),
      configName: 'settings.json',
      original: '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n',
      replacement: '{"mcpServers":{"replacement":{"url":"https://replacement.test/mcp"}}}\n',
    },
    {
      client: 'codex',
      configDirectory: home => path.join(home, '.codex'),
      configName: 'config.toml',
      original: 'model = "gpt-5.6"\n',
      replacement: 'model = "replacement"\n',
    },
  ];

  for (const fixture of cases) {
    const home = tempHome();
    const configDirectory = fixture.configDirectory(home);
    const originalDirectory = `${configDirectory}-inspected`;
    const configPath = path.join(configDirectory, fixture.configName);
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(configPath, fixture.original);
    const plan = createInstallPlan({
      clientSelection: fixture.client,
      env: { SPALA_MCP_INSTALL_HOME: home },
      mcpUrl: PUBLIC_MCP_URL,
      scope: '',
      serverName: PUBLIC_SERVER_NAME,
    });

    fs.renameSync(configDirectory, originalDirectory);
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(configPath, fixture.replacement);

    const error = captureError(() => installPlan(plan), /changed after it was inspected/);
    assert.doesNotMatch(error.message, /replacement\.test|replacement"/);
    assert.equal(fs.readFileSync(path.join(originalDirectory, fixture.configName), 'utf8'), fixture.original);
    assert.equal(fs.readFileSync(configPath, 'utf8'), fixture.replacement);
    assert.deepEqual(
      fs.readdirSync(configDirectory),
      [fixture.configName],
      `${fixture.client} replacement directory must not receive backups or temporary files`,
    );
  }
});

test('planned Codex skill update rejects real skill parent replacement before apply', () => {
  const home = tempHome();
  const options = {
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  };
  installPlan(createInstallPlan(options));

  const skillsDirectory = path.join(home, '.codex', 'skills');
  const originalSkillsDirectory = `${skillsDirectory}-inspected`;
  const skillPath = path.join(skillsDirectory, 'spala-backend', 'SKILL.md');
  const inspectedSkill = `${fs.readFileSync(skillPath, 'utf8')}\n# force a managed update\n`;
  fs.writeFileSync(skillPath, inspectedSkill);
  const plan = createInstallPlan(options);
  assert.equal(plan.writes.find(write => write.component === 'skill').action, 'update');

  const replacementSkill = 'replacement skill must remain untouched\n';
  fs.renameSync(skillsDirectory, originalSkillsDirectory);
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, replacementSkill);

  captureError(() => installPlan(plan), /changed after it was inspected/);
  assert.equal(
    fs.readFileSync(path.join(originalSkillsDirectory, 'spala-backend', 'SKILL.md'), 'utf8'),
    inspectedSkill,
  );
  assert.equal(fs.readFileSync(skillPath, 'utf8'), replacementSkill);
  assert.deepEqual(fs.readdirSync(path.dirname(skillPath)), ['SKILL.md']);
});

test('planned config creation rejects a regular file inserted before apply', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir, { recursive: true });
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  const replacement = '{"mcpServers":{"replacement":{"url":"https://replacement.test/mcp"}}}\n';
  fs.writeFileSync(configPath, replacement);

  captureError(() => installPlan(plan), /changed after it was inspected/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), replacement);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
});

test('planned writes reject same-inode content edits made after planning', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir, { recursive: true });
  const original = '{"mcpServers":{"external":{"url":"https://one.test/mcp"}}}\n';
  const concurrent = '{"mcpServers":{"external":{"url":"https://two.test/mcp"}}}\n';
  fs.writeFileSync(configPath, original);
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  const inode = fs.statSync(configPath).ino;

  fs.writeFileSync(configPath, concurrent);

  assert.equal(fs.statSync(configPath).ino, inode);
  captureError(() => installPlan(plan), /changed after it was inspected/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), concurrent);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
});

test('backup tampering fails closed without changing the original target', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir, { recursive: true });
  const original = '{"mcpServers":{"external":{"url":"https://one.test/mcp"}}}\n';
  const concurrent = '{"mcpServers":{"external":{"url":"https://two.test/mcp"}}}\n';
  fs.writeFileSync(configPath, original);
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  const inode = fs.statSync(configPath).ino;

  captureError(
    () => installPlan(plan, {
      fileOperationHook(stage, operation) {
        if (stage === 'after_backup_created') fs.writeFileSync(operation.backupPath, concurrent);
      },
    }),
    /changed after it was inspected/,
  );

  assert.equal(fs.statSync(configPath).ino, inode);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
});

test('same-inode edit after the final check is detached, detected, and restored unchanged', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const original = '{"mcpServers":{"external":{"url":"https://one.test/mcp"}}}\n';
  const concurrent = '{"mcpServers":{"external":{"url":"https://concurrent.test/mcp"}}}\n';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);
  const originalInode = fs.statSync(configPath).ino;
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  captureError(() => installPlan(plan, {
    fileOperationHook: stage => {
      if (stage === 'after_target_final_check_before_detach') {
        fs.writeFileSync(configPath, concurrent);
      }
    },
  }), /changed after it was inspected/);

  assert.equal(fs.statSync(configPath).ino, originalInode);
  assert.equal(fs.readFileSync(configPath, 'utf8'), concurrent);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
});

test('same-inode edit in the final atomic-replace window is detected and restored', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const original = '{"mcpServers":{"external":{"url":"https://one.test/mcp"}}}\n';
  const concurrent = '{"mcpServers":{"external":{"url":"https://final-window.test/mcp"}}}\n';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  captureError(() => installPlan(plan, {
    fileOperationHook: stage => {
      if (stage === 'after_target_guard_opened_before_atomic_replace') {
        fs.writeFileSync(configPath, concurrent);
      }
    },
  }), /changed after it was inspected/);

  assert.equal(fs.readFileSync(configPath, 'utf8'), concurrent);
  assert.equal(fs.statSync(configPath).nlink, 1);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
});

test('post-write concurrent edits are preserved and leave the original backup recoverable', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir, { recursive: true });
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  fs.writeFileSync(configPath, original);
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  const error = captureError(
    () => installPlan(plan, {
      fileOperationHook(stage) {
        if (stage === 'after_target_write_before_validation') {
          fs.writeFileSync(configPath, '{"corrupted":true}\n');
        }
      },
    }),
    /changed after it was inspected/,
  );

  assert.equal(error.changed, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{"corrupted":true}\n');
  const entries = fs.readdirSync(configDir);
  assert.equal(entries.some(name => name.includes('.bak-')), true);
  assert.equal(entries.some(name => name.includes('.tmp-') || name.endsWith('.spala-install.lock')), false);
});

test('fsynced temporary replacement never overwrites a target changed before atomic rename', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  const secret = 'inserted-target-secret-must-not-leak';
  const inserted = `{"mcpServers":{"inserted":{"token":"${secret}"}}}\n`;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  const error = captureError(() => installPlan(plan, {
    fileOperationHook: stage => {
      if (stage === 'after_target_check_before_write') fs.writeFileSync(configPath, inserted);
    },
  }), /changed after it was inspected/);

  assert.equal(Boolean(error.changed), false);
  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.equal(fs.readFileSync(configPath, 'utf8'), inserted);
  assert.equal(fs.readdirSync(configDir).some(name => name.includes('.bak-')), false);
  assert.equal(
    fs.readdirSync(configDir).some(name => name.includes('.tmp-') || name.endsWith('.spala-install.lock')),
    false,
  );
});

test('failure after fsyncing a same-directory temporary leaves the original inode untouched', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);
  const originalInode = fs.statSync(configPath).ino;
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  captureError(() => installPlan(plan, {
    fileOperationHook: stage => {
      if (stage === 'after_temporary_created') throw new Error('injected pre-detach failure');
    },
  }), /injected pre-detach failure/);

  assert.equal(fs.statSync(configPath).ino, originalInode);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
});

test('a parent swap after the final target check does not redirect the file-descriptor write', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const displacedDir = `${configDir}-displaced`;
  const configPath = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir, { recursive: true });
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  const replacement = '{"mcpServers":{"replacement":{"url":"https://replacement.test/mcp"}}}\n';
  fs.writeFileSync(configPath, original);
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  captureError(
    () => installPlan(plan, {
      fileOperationHook(stage) {
        if (stage !== 'after_target_check_before_write') return;
        fs.renameSync(configDir, displacedDir);
        fs.mkdirSync(configDir);
        fs.writeFileSync(configPath, replacement);
      },
    }),
    /changed after it was inspected/,
  );

  assert.equal(fs.readFileSync(configPath, 'utf8'), replacement);
  assert.equal(fs.readFileSync(path.join(displacedDir, 'settings.json'), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
  assert.deepEqual(fs.readdirSync(displacedDir), ['settings.json']);
});

test('failed creation rollback removes every operation-created directory deepest-first', () => {
  const home = tempHome();
  const configRoot = path.join(home, '.codeium');
  const plan = createInstallPlan({
    clientSelection: 'windsurf',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  captureError(
    () => installPlan(plan, {
      fileOperationHook(stage) {
        if (stage === 'after_target_create_before_validation') {
          throw new Error('forced post-create validation failure');
        }
      },
    }),
    /forced post-create validation failure/,
  );

  assert.equal(fs.existsSync(configRoot), false);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('rollback refuses a real parent directory replacement', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const originalDirectory = `${configDir}-installed`;
  const configPath = path.join(configDir, 'settings.json');
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);
  const result = installPlan(createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  }));

  const replacement = '{"mcpServers":{"replacement":{"url":"https://replacement.test/mcp"}}}\n';
  fs.renameSync(configDir, originalDirectory);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, replacement);

  const rollback = rollbackInstallPlan(result);
  assert.equal(rollback.ok, false);
  assert.match(rollback.errors[0].message, /changed after it was inspected/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), replacement);
  assert.match(fs.readFileSync(path.join(originalDirectory, 'settings.json'), 'utf8'), /spala_public_mcp/);
});

test('final unlink parent replacement preserves both directories and cleans owned artifacts', () => {
  const home = tempHome();
  const options = {
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  };
  installPlan(createInstallPlan(options));
  const uninstall = createUninstallPlan(options);
  const skillWrite = uninstall.writes.find(write => write.component === 'skill');
  assert.ok(skillWrite);
  const skillPath = skillWrite.path;
  const skillDir = path.dirname(skillPath);
  const inspectedSkillDir = `${skillDir}-inspected`;
  const original = fs.readFileSync(skillPath, 'utf8');
  const secret = 'replacement-skill-secret-must-not-leak';
  const replacement = `${secret}\n`;
  let injected = false;

  const error = captureError(() => installPlan({
    ...uninstall,
    writes: [skillWrite],
  }, {
    fileOperationHook: (stage, operation) => {
      if (injected || stage !== 'after_target_detach_before_unlink' || operation.path !== skillPath) return;
      injected = true;
      fs.renameSync(skillDir, inspectedSkillDir);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillPath, replacement);
    },
  }), /changed after it was inspected/);

  assert.equal(injected, true);
  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.equal(fs.readFileSync(skillPath, 'utf8'), replacement);
  assert.equal(fs.readFileSync(path.join(inspectedSkillDir, 'SKILL.md'), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(skillDir), ['SKILL.md']);
  assert.deepEqual(fs.readdirSync(inspectedSkillDir), ['SKILL.md']);
});

test('rollback copy rejects final target replacement without leaving transient artifacts', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const installedPath = `${configPath}.installed`;
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  const secret = 'rollback-replacement-secret-must-not-leak';
  const replacement = `{"mcpServers":{"replacement":{"token":"${secret}"}}}\n`;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);
  const result = installPlan(createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  }));
  const installed = fs.readFileSync(configPath, 'utf8');
  let injected = false;

  const rollback = rollbackInstallPlan(result, {
    fileOperationHook: (stage, operation) => {
      if (injected || stage !== 'after_target_restore_check_before_write' || operation.path !== configPath) return;
      injected = true;
      fs.renameSync(configPath, installedPath);
      fs.writeFileSync(configPath, replacement);
    },
  });

  assert.equal(injected, true);
  assert.equal(rollback.ok, false);
  assert.match(rollback.errors[0].message, /changed after it was inspected/);
  assert.doesNotMatch(rollback.errors[0].message, new RegExp(secret));
  assert.equal(fs.readFileSync(configPath, 'utf8'), replacement);
  assert.equal(fs.readFileSync(installedPath, 'utf8'), installed);
  assert.equal(
    fs.readdirSync(configDir).some(name => name.includes('.tmp-') || name.endsWith('.spala-install.lock')),
    false,
  );
  assert.equal(fs.readdirSync(configDir).some(name => name.includes('.bak-')), true);
});

test('current write is rolled back when backup creation fails after opening the artifact', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const secret = 'backup-failure-secret-must-not-leak';
  const original = `{"mcpServers":{"external":{"token":"${secret}"}}}\n`;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  const error = captureError(() => installPlan(plan, {
    fileOperationHook: stage => {
      if (stage === 'after_backup_opened') throw new Error('injected backup creation failure');
    },
  }), /injected backup creation failure/);

  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
});

test('current create cleans its temporary artifact and new parent after mid-helper failure', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const secret = 'temporary-failure-secret-must-not-leak';
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  const error = captureError(() => installPlan(plan, {
    fileOperationHook: stage => {
      if (stage === 'after_temporary_opened') {
        throw new Error('injected temporary creation failure');
      }
    },
  }), /injected temporary creation failure/);

  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.equal(fs.existsSync(configDir), false);
});

test('rollback restores the original inode mode and mtime after a committed write fails', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  const originalTime = new Date('2001-02-03T04:05:06.000Z');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original, { mode: 0o640 });
  fs.chmodSync(configPath, 0o640);
  fs.utimesSync(configPath, originalTime, originalTime);
  const originalStat = fs.statSync(configPath);
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  captureError(() => installPlan(plan, {
    fileOperationHook: stage => {
      if (stage === 'after_target_write') throw new Error('injected committed-write failure');
    },
  }), /injected committed-write failure/);

  const restored = fs.statSync(configPath);
  assert.notEqual(restored.ino, originalStat.ino);
  assert.equal(restored.mode & 0o777, 0o640);
  assert.ok(Math.abs(restored.mtimeMs - originalTime.getTime()) < 2);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
});

test('rollback restores mode and timestamps from durable backup metadata without in-memory state', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  const originalTime = new Date('2002-03-04T05:06:07.000Z');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original, { mode: 0o640 });
  fs.chmodSync(configPath, 0o640);
  fs.utimesSync(configPath, originalTime, originalTime);

  const result = installPlan(createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  }));
  result.writes[0].originalMetadata = undefined;
  const rollback = rollbackInstallPlan(result);

  assert.equal(rollback.ok, true);
  const restored = fs.statSync(configPath);
  assert.equal(restored.mode & 0o777, 0o640);
  assert.ok(Math.abs(restored.mtimeMs - originalTime.getTime()) < 2);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
});

test('atomic replacement recovers cleanly from crashes at every durable transaction phase', () => {
  const crashStages = [
    'after_lock_next_opened',
    'after_lock_next_created',
    'before_lock_publish',
    'after_lock_link_before_temp_cleanup',
    'after_lock_created',
    'after_backup_created',
    'after_temporary_created',
    'after_journal_next_opened',
    'after_journal_next_created',
    'before_journal_publish',
    'after_journal_rename_before_publish_state',
    'after_journal_prepared',
    'after_atomic_replace_before_validation',
    'after_journal_next_opened:2',
    'after_journal_next_created:2',
    'before_journal_publish:2',
    'after_journal_rename_before_publish_state:2',
    'after_journal_committed',
    'before_journal_cleanup',
    'after_journal_cleanup',
    'after_lock_cleanup',
  ];

  for (const crashStage of crashStages) {
    const home = tempHome();
    const configDir = path.join(home, '.gemini');
    const configPath = path.join(configDir, 'settings.json');
    const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, original, { mode: 0o640 });
    fs.chmodSync(configPath, 0o640);

    const crashed = spawnSync(
      process.execPath,
      [path.resolve('fixtures/crash-worker.js'), home, crashStage],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.equal(crashed.status, 86, `${crashStage}: ${crashed.stderr}`);
    assert.equal(fs.existsSync(configPath), true, `${crashStage}: target must remain available`);
    assert.equal(fs.statSync(configPath).nlink, 1, `${crashStage}: target must never be hard-linked`);

    const recoveryPlan = createInstallPlan({
      clientSelection: 'gemini',
      env: { SPALA_MCP_INSTALL_HOME: home },
      mcpUrl: PUBLIC_MCP_URL,
      scope: '',
      serverName: PUBLIC_SERVER_NAME,
    });
    installPlan(recoveryPlan);

    const installed = fs.readFileSync(configPath, 'utf8');
    assert.match(installed, new RegExp(PUBLIC_SERVER_NAME), crashStage);
    assert.equal(fs.statSync(configPath).nlink, 1, crashStage);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o640, crashStage);
    const entries = fs.readdirSync(configDir);
    const transactionMetadata = entries.filter(name => (
      /\.spala-install\.(?:lock|journal|tmp|restore)/.test(name)
    ));
    if (crashStage === 'after_lock_next_opened') {
      assert.equal(transactionMetadata.length, 1, crashStage);
      assert.match(transactionMetadata[0], /\.spala-install\.lock-next-/);
      assert.equal(fs.statSync(path.join(configDir, transactionMetadata[0])).nlink, 1, crashStage);
    } else {
      assert.deepEqual(transactionMetadata, [], crashStage);
    }
    const backups = entries.filter(name => name.includes('.bak-') && !name.endsWith('.spala-meta.json'));
    assert.ok(backups.length >= 1, crashStage);
    for (const backup of backups) {
      assert.equal(fs.statSync(path.join(configDir, backup)).nlink, 1, crashStage);
      assert.equal(fs.statSync(path.join(configDir, backup)).mode & 0o777, 0o600, crashStage);
      assert.equal(fs.existsSync(path.join(configDir, `${backup}.spala-meta.json`)), true, crashStage);
    }
  }
});

test('stale recovery refuses unknown lock metadata without touching target or leaking values', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const lockPath = `${configPath}.spala-install.lock`;
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  const secret = 'unknown-lock-secret-must-not-leak';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  fs.writeFileSync(lockPath, JSON.stringify({ token: secret }));

  const error = captureError(() => installPlan(plan), /not recognized installer transaction metadata/);
  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), JSON.stringify({ token: secret }));
});

test('stale recovery preserves attacker-extended otherwise valid transaction metadata', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const lockPath = `${configPath}.spala-install.lock`;
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  const secret = 'extended-metadata-secret-must-not-leak';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);

  const crashed = spawnSync(
    process.execPath,
    [path.resolve('fixtures/crash-worker.js'), home, 'after_lock_created'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  record.attackerField = secret;
  const attackerBody = `${JSON.stringify(record)}\n`;
  fs.writeFileSync(lockPath, attackerBody);

  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  const error = captureError(() => installPlan(plan), /not recognized installer transaction metadata/);
  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), attackerBody);
});

test('stale recovery uses owner nonce, process start identity, and a maximum lock age', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const lockPath = `${configPath}.spala-install.lock`;
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);

  const crashed = spawnSync(
    process.execPath,
    [path.resolve('fixtures/crash-worker.js'), home, 'after_lock_created'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.match(record.owner.nonce, /^[a-f0-9]{32}$/);
  assert.ok(Object.hasOwn(record.owner, 'startIdentity'));
  if (record.owner.startIdentity !== null) {
    assert.match(record.owner.startIdentity, /^linux:[a-f0-9-]+:\d+$/i);
  }

  record.owner.pid = process.pid;
  record.owner.startIdentity = null;
  record.createdAt = Date.now() - 60 * 60 * 1000;
  fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`);

  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  installPlan(plan);
  assert.match(fs.readFileSync(configPath, 'utf8'), new RegExp(PUBLIC_SERVER_NAME));
  assert.equal(fs.existsSync(lockPath), false);
});

test('stale recovery detects live PID reuse from process start identity where supported', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const lockPath = `${configPath}.spala-install.lock`;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, '{"mcpServers":{}}\n');

  const crashed = spawnSync(
    process.execPath,
    [path.resolve('fixtures/crash-worker.js'), home, 'after_lock_created'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (record.owner.startIdentity === null) return;

  record.owner.pid = process.pid;
  fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`);
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  installPlan(plan);
  assert.equal(fs.existsSync(lockPath), false);
});

test('cwd restoration fails closed when descriptor restoration is unavailable after path rebind', () => {
  const repositoryCwd = process.cwd();
  const invocationCwd = tempHome();
  const displacedCwd = `${invocationCwd}-inspected`;
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const original = '{"mcpServers":{"external":{"url":"https://example.test/mcp"}}}\n';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);
  process.chdir(invocationCwd);
  try {
    const plan = createInstallPlan({
      clientSelection: 'gemini',
      cwd: invocationCwd,
      env: { SPALA_MCP_INSTALL_HOME: home },
      mcpUrl: PUBLIC_MCP_URL,
      scope: '',
      serverName: PUBLIC_SERVER_NAME,
    });
    const error = captureError(() => installPlan(plan, {
      fileOperationHook: stage => {
        if (stage !== 'after_target_write') return;
        fs.renameSync(invocationCwd, displacedCwd);
        fs.mkdirSync(invocationCwd);
        fs.writeFileSync(path.join(invocationCwd, 'untrusted'), 'replacement cwd');
      },
    }), /working directory changed/);

    assert.doesNotMatch(error.message, /replacement cwd/);
    assert.notEqual(fs.statSync('.').ino, fs.statSync(invocationCwd).ino);
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  } finally {
    process.chdir(repositoryCwd);
  }
});

test('invalid JSON errors and doctor reports do not include config values', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  const secret = 'invalid-json-secret-do-not-print';
  const source = `{"mcpServers":{"external":{"token":"${secret}",}},}`;
  fs.writeFileSync(configPath, source);
  const options = {
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  };

  const error = captureError(() => createInstallPlan(options), /JSON client config is invalid/);
  assert.doesNotMatch(error.message, new RegExp(secret));
  const report = createDoctorReport({
    ...options,
    installScope: 'user',
  });
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  assert.equal(fs.readFileSync(configPath, 'utf8'), source);
});

test('public duplicate cleanup removes only known legacy aliases at the exact public URL', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      [PUBLIC_LEGACY_SERVER_NAMES[0]]: { url: PUBLIC_MCP_URL },
      spala_old_same: { url: PUBLIC_MCP_URL },
      [PUBLIC_LEGACY_SERVER_NAMES[1]]: { url: `${PUBLIC_MCP_URL}/` },
      old_other: { url: 'https://shared.spala.ai/p123/mcp' },
      external: { url: 'https://example.com/mcp' },
    },
  }, null, 2));

  const plan = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.deepEqual(plan.writes[0].removedDuplicates, [{ name: PUBLIC_LEGACY_SERVER_NAMES[0] }]);
  installPlan(plan);
  const next = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(next.mcpServers[PUBLIC_LEGACY_SERVER_NAMES[0]], undefined);
  assert.equal(next.mcpServers.spala_old_same.url, PUBLIC_MCP_URL);
  assert.equal(next.mcpServers[PUBLIC_LEGACY_SERVER_NAMES[1]].url, `${PUBLIC_MCP_URL}/`);
  assert.equal(next.mcpServers.old_other.url, 'https://shared.spala.ai/p123/mcp');
  assert.equal(next.mcpServers.external.url, 'https://example.com/mcp');
  assert.equal(next.mcpServers['spala_public_mcp'].httpUrl, PUBLIC_MCP_URL);
});

test('public duplicate cleanup preserves legacy entries with conflicting endpoint fields without leaking them', async () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  const secret = 'conflicting-alias-secret-do-not-print';
  const projectUrl = 'https://shared.spala.ai/p123/mcp';
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      [PUBLIC_LEGACY_SERVER_NAMES[0]]: {
        httpUrl: PUBLIC_MCP_URL,
        url: projectUrl,
        token: secret,
      },
    },
  }, null, 2));

  let output = '';
  await runCli(
    ['--public', '--client', 'gemini', '--yes', '--dry-run', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );

  assert.deepEqual(JSON.parse(output).writes[0].removedDuplicates, []);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.doesNotMatch(output, /shared\.spala\.ai\/p123/);
  const unchanged = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(unchanged.mcpServers[PUBLIC_LEGACY_SERVER_NAMES[0]].url, projectUrl);
});

test('JSON install and uninstall preserve unrelated large integers and source bytes', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  const preserved = [
    '  "largeInteger": 9007199254740993,\r\n',
    '  "escaped": "keep\\\\u0041-as-text",\r\n',
    '  "nested": { "decimal": 1.2300e+45 }\r\n',
  ].join('');
  const source = [
    '{\r\n',
    preserved,
    '  ,"mcpServers": {\r\n',
    `    ${JSON.stringify(PUBLIC_LEGACY_SERVER_NAMES[0])}: {"httpUrl":${JSON.stringify(PUBLIC_MCP_URL)}},\r\n`,
    '    "external": { "url": "https://example.test/mcp" }\r\n',
    '  }\r\n',
    '}\r\n',
  ].join('');
  fs.writeFileSync(configPath, source);

  const install = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.match(install.writes[0].content, /9007199254740993/);
  assert.ok(install.writes[0].content.includes(preserved));
  installPlan(install);
  assert.ok(fs.readFileSync(configPath, 'utf8').includes(preserved));

  const uninstall = createUninstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  installPlan(uninstall);
  const finalSource = fs.readFileSync(configPath, 'utf8');
  assert.match(finalSource, /9007199254740993/);
  assert.ok(finalSource.includes(preserved));
  assert.match(finalSource, /"external": \{ "url": "https:\/\/example\.test\/mcp" \}/);
});

test('JSON endpoint migration changes only installer-owned fields and preserves unknown config', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const secret = 'custom-client-auth-must-be-preserved';
  const source = [
    '{',
    '  "telemetry": {"counter": 9007199254740993},',
    '  "mcpServers": {',
    `    "${PUBLIC_SERVER_NAME}": {`,
    `      "url": ${JSON.stringify(PUBLIC_MCP_URL)},`,
    `      "headers": {"Authorization": ${JSON.stringify(secret)}},`,
    '      "disabled": true,',
    '      "timeoutMs": 12345',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, source);

  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.match(plan.writes[0].content, /"httpUrl":"https:\/\/mcp\.spala\.ai\/mcp"/);
  assert.doesNotMatch(plan.writes[0].content, /^\s*"url":/m);
  assert.match(plan.writes[0].content, /"headers": \{"Authorization": "custom-client-auth-must-be-preserved"\}/);
  assert.match(plan.writes[0].content, /"disabled": true/);
  assert.match(plan.writes[0].content, /9007199254740993/);
  installPlan(plan);

  const installed = fs.readFileSync(configPath, 'utf8');
  assert.match(installed, /9007199254740993/);
  assert.match(installed, new RegExp(secret));
  const parsed = JSON.parse(installed);
  assert.equal(parsed.mcpServers[PUBLIC_SERVER_NAME].httpUrl, PUBLIC_MCP_URL);
  assert.equal(parsed.mcpServers[PUBLIC_SERVER_NAME].url, undefined);
  assert.equal(parsed.mcpServers[PUBLIC_SERVER_NAME].headers.Authorization, secret);
  assert.equal(parsed.mcpServers[PUBLIC_SERVER_NAME].disabled, true);
  assert.equal(parsed.mcpServers[PUBLIC_SERVER_NAME].timeoutMs, 12345);
});

test('blank JSON installs as an empty config but rollback restores exact original whitespace', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  const configPath = path.join(configDir, 'settings.json');
  const original = ' \t\r\n  \n';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);
  const plan = createInstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  assert.equal(plan.writes[0].originalContent, original);
  assert.equal(plan.writes[0].action, 'update');
  assert.equal(JSON.parse(plan.writes[0].content).mcpServers[PUBLIC_SERVER_NAME].httpUrl, PUBLIC_MCP_URL);
  const result = installPlan(plan);
  assert.equal(fs.readFileSync(result.writes[0].backupPath, 'utf8'), original);
  assert.equal(rollbackInstallPlan(result).ok, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
});

test('JSON public ownership ignores unsupported and project-shaped legacy aliases across operations', async () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  const secret = 'unknown-json-alias-secret-do-not-print';
  const projectUrl = 'https://shared.spala.ai/p123/mcp';
  const source = JSON.stringify({
    mcpServers: {
      [PUBLIC_SERVER_NAME]: { httpUrl: PUBLIC_MCP_URL },
      [PUBLIC_LEGACY_SERVER_NAMES[0]]: {
        command: 'pnpm',
        args: ['dlx', 'project-proxy', projectUrl],
        privateNote: secret,
      },
      [PUBLIC_LEGACY_SERVER_NAMES[1]]: {
        httpUrl: PUBLIC_MCP_URL,
        command: 'project-proxy',
        args: [projectUrl],
      },
    },
  }, null, 2);
  fs.writeFileSync(configPath, source);

  const plan = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.equal(plan.writes[0].action, 'unchanged');
  assert.deepEqual(plan.writes[0].removedDuplicates, []);

  const report = createDoctorReport({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    installScope: 'user',
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.equal(report.summary.duplicates, 0);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));

  let output = '';
  await runCli(
    ['--public', '--client', 'gemini', '--dry-run', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );
  assert.doesNotMatch(output, new RegExp(secret));
  assert.deepEqual(JSON.parse(output).writes[0].removedDuplicates, []);

  const uninstall = createUninstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.deepEqual(uninstall.writes[0].removedEntries, [{ name: PUBLIC_SERVER_NAME }]);
  installPlan(uninstall);
  const remaining = fs.readFileSync(configPath, 'utf8');
  assert.match(remaining, new RegExp(PUBLIC_LEGACY_SERVER_NAMES[0]));
  assert.match(remaining, new RegExp(PUBLIC_LEGACY_SERVER_NAMES[1]));
  assert.match(remaining, new RegExp(secret));
});

test('JSON public ownership preserves legacy aliases with extra unsupported fields', () => {
  for (const extra of [
    { privateNote: 'custom-direct-config' },
    { headers: { authorization: 'client-managed' } },
  ]) {
    const home = tempHome();
    const configDir = path.join(home, '.gemini');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'settings.json');
    const alias = {
      url: PUBLIC_MCP_URL,
      ...extra,
    };
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        [PUBLIC_SERVER_NAME]: { httpUrl: PUBLIC_MCP_URL },
        [PUBLIC_LEGACY_SERVER_NAMES[0]]: alias,
      },
    }, null, 2));

    const options = {
      cleanupDuplicates: true,
      clientSelection: 'gemini',
      env: { SPALA_MCP_INSTALL_HOME: home },
      mcpUrl: PUBLIC_MCP_URL,
      scope: '',
      serverName: PUBLIC_SERVER_NAME,
    };
    const install = createInstallPlan(options);
    assert.equal(install.writes[0].action, 'unchanged');
    assert.deepEqual(install.writes[0].removedDuplicates, []);

    const report = createDoctorReport({ ...options, installScope: 'user' });
    assert.equal(report.summary.duplicates, 0);

    const uninstall = createUninstallPlan(options);
    assert.deepEqual(uninstall.writes[0].removedEntries, [{ name: PUBLIC_SERVER_NAME }]);
    installPlan(uninstall);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers[PUBLIC_LEGACY_SERVER_NAMES[0]],
      alias,
    );
  }
});

test('public confirmed Codex reconciliation runs native login when the canonical registration is present', async () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(configPath, [
    'model = "gpt-5.6"',
    '',
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[0]}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[1]}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
    '[mcp_servers.spala_project_p123]',
    'url = "https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata"',
    '',
    '[mcp_servers.spala_unrelated_same_url]',
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
    `[mcp_servers.${PUBLIC_SERVER_NAME}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
  ].join('\n'));

  const calls = [];
  let output = '';
  await runCli(
    ['--public', '--yes', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
    {
      runCommand: async request => {
        calls.push(request);
        return { stdout: 'authenticated' };
      },
    },
  );

  const parsed = JSON.parse(output);
  assert.equal(parsed.command, 'project-init');
  assert.equal(parsed.changed, true);
  assert.deepEqual(parsed.result[0].removedDuplicates, PUBLIC_LEGACY_SERVER_NAMES.map(name => ({ name })));
  assert.equal(calls.length, 1);
  assert.equal(parsed.account.status, 'authenticated');

  const reconciled = fs.readFileSync(configPath, 'utf8');
  assert.doesNotMatch(reconciled, new RegExp(`mcp_servers\\.${PUBLIC_LEGACY_SERVER_NAMES[0]}`));
  assert.doesNotMatch(reconciled, new RegExp(`mcp_servers\\.${PUBLIC_LEGACY_SERVER_NAMES[1]}`));
  assert.equal((reconciled.match(new RegExp(`\\[mcp_servers\\.${PUBLIC_SERVER_NAME}]`, 'g')) || []).length, 1);
  assert.match(reconciled, /\[mcp_servers\.spala_project_p123]/);
  assert.match(reconciled, /\[mcp_servers\.spala_unrelated_same_url]/);

  output = '';
  await runCli(
    ['--public', '--yes', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
    {
      runCommand: async request => {
        calls.push(request);
        return { stdout: 'authenticated' };
      },
    },
  );

  const rerun = JSON.parse(output);
  assert.equal(rerun.changed, false);
  assert.equal(calls.length, 2);
  assert.equal(rerun.account.status, 'authenticated');
  assert.equal(fs.readFileSync(configPath, 'utf8'), reconciled);
});

test('public Codex install runs native login when it adds the canonical registration', async () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.toml'), [
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[0]}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
  ].join('\n'));

  const calls = [];
  let output = '';
  await runCli(
    ['--public', '--yes', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
    {
      runCommand: async request => {
        calls.push(request);
        return { stdout: 'authenticated' };
      },
    },
  );

  const parsed = JSON.parse(output);
  assert.equal(parsed.account.status, 'authenticated');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['mcp', 'login', PUBLIC_SERVER_NAME, '--scopes', 'api']);
});

test('public Codex reconciliation preserves a legacy alias that targets a project MCP', () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const projectUrl = 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata';
  fs.writeFileSync(configPath, [
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[0]}]`,
    `url = ${JSON.stringify(projectUrl)}`,
    '',
  ].join('\n'));

  const plan = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  installPlan(plan);

  const reconciled = fs.readFileSync(configPath, 'utf8');
  assert.match(reconciled, new RegExp(`\\[mcp_servers\\.${PUBLIC_LEGACY_SERVER_NAMES[0]}]`));
  assert.match(reconciled, new RegExp(JSON.stringify(projectUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(reconciled, new RegExp(`\\[mcp_servers\\.${PUBLIC_SERVER_NAME}]`));
});

test('Codex ownership ignores literal-string and stdio project legacy aliases across operations', () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const literalAlias = [
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[0]}]`,
    `url = '${PUBLIC_MCP_URL}'`,
    '',
  ].join('\n');
  const stdioAlias = [
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[1]}]`,
    'command = "pnpm"',
    'args = ["dlx", "project-proxy", "https://shared.spala.ai/p123/mcp"]',
    '',
  ].join('\n');
  const canonical = [
    `[mcp_servers.${PUBLIC_SERVER_NAME}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
  ].join('\n');
  const source = `${literalAlias}${stdioAlias}${canonical}`;
  fs.writeFileSync(configPath, source);

  const install = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.equal(install.writes[0].action, 'unchanged');
  assert.deepEqual(install.writes[0].removedDuplicates, []);
  assert.equal(install.writes[0].content, source);

  const report = createDoctorReport({
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    installScope: 'user',
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.equal(report.clients[0].installed, true);
  assert.deepEqual(report.clients[0].duplicates, []);

  const uninstall = createUninstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.deepEqual(uninstall.writes[0].removedEntries, [{ name: PUBLIC_SERVER_NAME }]);
  installPlan(uninstall);
  assert.equal(fs.readFileSync(configPath, 'utf8'), `${literalAlias}${stdioAlias}`);
});

test('Codex alias reconciliation ignores table-shaped text inside basic and literal multiline strings', () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const source = [
    '[notes]',
    'basic = """',
    `[mcp_servers . "${PUBLIC_LEGACY_SERVER_NAMES[0]}"]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '"""',
    "literal = '''",
    `[[mcp_servers . '${PUBLIC_LEGACY_SERVER_NAMES[1]}']]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    "'''",
    '',
    `[mcp_servers.${PUBLIC_SERVER_NAME}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
  ].join('\n');
  fs.writeFileSync(configPath, source);

  const plan = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  assert.equal(plan.writes[0].action, 'unchanged');
  assert.deepEqual(plan.writes[0].removedDuplicates, []);
  assert.equal(plan.writes[0].content, source);
});

test('Codex alias reconciliation preserves unrelated bytes and mixed newline formatting', () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const prefix = [
    '# root comment\r\n',
    'model = "gpt-5.6"\r\n',
    '\r\n',
    '[features]\n',
    'web_search = true\n',
    '\n',
    '\n',
    '\n',
    '# preserve this spacing and comment\n',
  ].join('');
  const legacyBlock = [
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[0]}]\r\n`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}\r\n`,
    '# remove with the legacy table\r\n',
    '\r\n',
  ].join('');
  const suffix = [
    `[mcp_servers.${PUBLIC_SERVER_NAME}]\r\n`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}\r\n`,
    '\r\n',
    '[mcp_servers.spala_project_p123]\n',
    'url = "https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata"\n',
  ].join('');
  const source = `${prefix}${legacyBlock}${suffix}`;
  const expected = `${prefix}${suffix}`;
  fs.writeFileSync(configPath, source);

  const plan = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  assert.equal(plan.writes[0].content, expected);
  installPlan(plan);
  assert.equal(fs.readFileSync(configPath, 'utf8'), expected);
});

test('automatic Codex alias reconciliation preserves customized legacy subtrees until explicit uninstall', () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const exactLegacy = [
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[0]}]\n`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}\n`,
    'private_note = "keep"\n',
    'authorization = "custom"\n',
    '\n',
  ].join('');
  const legacyChild = [
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[0]}.headers]\n`,
    'authorization = "legacy"\n',
    '\n',
  ].join('');
  const unrelated = [
    '[features]\n',
    'web_search = true\n',
    '\n',
  ].join('');
  const laterLegacyDescendant = [
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[0]}.headers.extra]\n`,
    'trace = "legacy"\n',
    '\n',
  ].join('');
  const canonical = [
    `[mcp_servers.${PUBLIC_SERVER_NAME}]\n`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}\n`,
    '\n',
  ].join('');
  const project = [
    '[mcp_servers.spala_project_p123]\n',
    'url = "https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata"\n',
  ].join('');
  const source = `${exactLegacy}${legacyChild}${unrelated}${laterLegacyDescendant}${canonical}${project}`;
  fs.writeFileSync(configPath, source);

  const plan = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  const expected = source;
  assert.equal(plan.writes[0].action, 'unchanged');
  assert.deepEqual(plan.writes[0].removedDuplicates, []);
  assert.equal(plan.writes[0].content, expected);
  const doctor = createDoctorReport({
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    installScope: 'user',
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.deepEqual(doctor.clients[0].duplicates, []);

  const uninstall = createUninstallPlan({
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_LEGACY_SERVER_NAMES[0],
  });
  const explicitlyRemoved = `${unrelated}${canonical}${project}`;
  assert.deepEqual(uninstall.writes[0].removedEntries, [{ name: PUBLIC_LEGACY_SERVER_NAMES[0] }]);
  assert.equal(uninstall.writes[0].content, explicitlyRemoved);
  installPlan(uninstall);
  assert.equal(fs.readFileSync(configPath, 'utf8'), explicitlyRemoved);
});

test('Codex alias removal preserves detached comments belonging to the following table', () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const source = [
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[0]}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '# alias-local comment',
    '',
    '# project registration retained by the user',
    '# keep both comment lines',
    '[mcp_servers.spala_project_p123]',
    'url = "https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata"',
    '',
    `[mcp_servers.${PUBLIC_SERVER_NAME}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
  ].join('\n');
  fs.writeFileSync(configPath, source);

  const plan = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  assert.deepEqual(plan.writes[0].removedDuplicates, [{ name: PUBLIC_LEGACY_SERVER_NAMES[0] }]);
  assert.doesNotMatch(plan.writes[0].content, /alias-local comment/);
  assert.match(plan.writes[0].content, /# project registration retained by the user\n# keep both comment lines\n\[mcp_servers\.spala_project_p123]/);
  installPlan(plan);
  assert.equal(fs.readFileSync(configPath, 'utf8'), plan.writes[0].content);
});

test('Codex alias reconciliation matches quoted dotted keys and whitespace around dots semantically', () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const legacyOne = [
    `[ "mcp_servers" . '${PUBLIC_LEGACY_SERVER_NAMES[0]}' ] # literal alias key\n`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}\n`,
    '\n',
  ].join('');
  const legacyTwo = [
    `['mcp_servers' . "${PUBLIC_LEGACY_SERVER_NAMES[1]}"]\n`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}\n`,
    '\n',
  ].join('');
  const canonical = [
    `[ 'mcp_servers' . "${PUBLIC_SERVER_NAME}" ]\n`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}\n`,
    '\n',
  ].join('');
  fs.writeFileSync(configPath, `${legacyOne}${legacyTwo}${canonical}`);

  const plan = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  assert.deepEqual(plan.writes[0].removedDuplicates, PUBLIC_LEGACY_SERVER_NAMES.map(name => ({ name })));
  assert.equal(plan.writes[0].content, canonical);
});

test('Codex alias reconciliation preserves unsupported exact legacy server tables', () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const source = [
    `[[mcp_servers . "${PUBLIC_LEGACY_SERVER_NAMES[0]}"]]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
  ].join('\n');
  fs.writeFileSync(configPath, source);

  const plan = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.deepEqual(plan.writes[0].removedDuplicates, []);
  assert.ok(plan.writes[0].content.startsWith(source));
  installPlan(plan);
  const installed = fs.readFileSync(configPath, 'utf8');
  assert.ok(installed.startsWith(source));
  assert.match(installed, new RegExp(`\\[mcp_servers\\.${PUBLIC_SERVER_NAME}]`));
});

test('Codex install fails closed for dotted-key and inline-table MCP definitions without leaking values', () => {
  const secret = 'review-secret-do-not-print';
  const unsupportedCanonicalFixtures = [
    [
      `mcp_servers . "${PUBLIC_SERVER_NAME}" . url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
      `mcp_servers . "${PUBLIC_SERVER_NAME}" . token = ${JSON.stringify(secret)}`,
      '',
    ].join('\n'),
    [
      '[mcp_servers]',
      `${JSON.stringify(PUBLIC_SERVER_NAME)} = { url = ${JSON.stringify(PUBLIC_MCP_URL)}, token = ${JSON.stringify(secret)} }`,
      '',
    ].join('\n'),
  ];

  for (const source of unsupportedCanonicalFixtures) {
    const home = tempHome();
    const configDir = path.join(home, '.codex');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.toml');
    fs.writeFileSync(configPath, source);

    const error = captureError(() => createInstallPlan({
      cleanupDuplicates: true,
      clientSelection: 'codex',
      env: { SPALA_MCP_INSTALL_HOME: home },
      mcpUrl: PUBLIC_MCP_URL,
      scope: '',
      serverName: PUBLIC_SERVER_NAME,
    }), /dotted keys or inline values/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.equal(fs.readFileSync(configPath, 'utf8'), source);
    assert.deepEqual(fs.readdirSync(configDir), ['config.toml']);
  }

  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const unknownLegacy = [
    `mcp_servers . "${PUBLIC_LEGACY_SERVER_NAMES[0]}" . url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    `mcp_servers . "${PUBLIC_LEGACY_SERVER_NAMES[0]}" . token = ${JSON.stringify(secret)}`,
    '',
    `[mcp_servers.${PUBLIC_SERVER_NAME}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
  ].join('\n');
  fs.writeFileSync(configPath, unknownLegacy);

  const plan = createInstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.equal(plan.writes[0].action, 'unchanged');
  assert.deepEqual(plan.writes[0].removedDuplicates, []);
  assert.equal(plan.writes[0].content, unknownLegacy);
});

test('Codex install preserves nested continuation arrays whose lines begin with brackets', () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const source = [
    'matrix = [',
    '[',
    '"[mcp_servers.not_a_header]",',
    '],',
    ']',
    '',
    '[features]',
    'web_search = true',
    '',
  ].join('\n');
  fs.writeFileSync(configPath, source);

  const plan = createInstallPlan({
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  assert.ok(plan.writes[0].content.startsWith(source));
  assert.match(plan.writes[0].content, new RegExp(`\\[mcp_servers\\.${PUBLIC_SERVER_NAME}]`));
});

test('Codex doctor and uninstall use exact known public aliases only', () => {
  const home = tempHome();
  const configDir = path.join(home, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const preserved = [
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[1]}]`,
    `url = ${JSON.stringify(`${PUBLIC_MCP_URL}/`)}`,
    '',
    '[mcp_servers.spala_unknown_same_url]',
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
    '[mcp_servers.spala_project_p123]',
    'url = "https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata"',
    '',
  ].join('\n');
  fs.writeFileSync(configPath, [
    `[mcp_servers.${PUBLIC_SERVER_NAME}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
    `[mcp_servers.${PUBLIC_LEGACY_SERVER_NAMES[0]}]`,
    `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
    '',
    preserved,
  ].join('\n'));

  const report = createDoctorReport({
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    installScope: 'user',
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.equal(report.summary.duplicates, 1);
  assert.deepEqual(report.clients[0].duplicates, [{ name: PUBLIC_LEGACY_SERVER_NAMES[0] }]);

  const plan = createUninstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'codex',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.deepEqual(plan.writes[0].removedEntries, [
    { name: PUBLIC_SERVER_NAME },
    { name: PUBLIC_LEGACY_SERVER_NAMES[0] },
  ]);
  installPlan(plan);
  assert.equal(fs.readFileSync(configPath, 'utf8'), preserved);
});

test('public confirmed JSON install is idempotent after alias reconciliation', async () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      [PUBLIC_LEGACY_SERVER_NAMES[0]]: { httpUrl: PUBLIC_MCP_URL },
      project: { httpUrl: 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata' },
    },
  }, null, 2));

  let output = '';
  await runCli(
    ['--public', '--client', 'gemini', '--yes', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );
  const first = JSON.parse(output);
  assert.equal(first.changed, true);
  const reconciled = fs.readFileSync(configPath, 'utf8');

  output = '';
  await runCli(
    ['--public', '--client', 'gemini', '--yes', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );
  const rerun = JSON.parse(output);
  assert.equal(rerun.changed, false);
  assert.equal(rerun.result.length, 0);
  assert.equal(fs.readFileSync(configPath, 'utf8'), reconciled);
});

test('interactive public confirmation plans and applies the same alias reconciliation as --yes', async () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  const source = JSON.stringify({
    mcpServers: {
      [PUBLIC_LEGACY_SERVER_NAMES[0]]: { httpUrl: PUBLIC_MCP_URL },
      project: { httpUrl: 'https://shared.spala.ai/p123/mcp' },
    },
  }, null, 2);
  fs.writeFileSync(configPath, source);

  let dryRunOutput = '';
  await runCli(
    ['--public', '--client', 'gemini', '--dry-run', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { dryRunOutput += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );
  assert.deepEqual(JSON.parse(dryRunOutput).writes[0].removedDuplicates, [
    { name: PUBLIC_LEGACY_SERVER_NAMES[0] },
  ]);
  assert.equal(fs.readFileSync(configPath, 'utf8'), source);

  let noOutput = '';
  await runCli(
    ['--public', '--client', 'gemini'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { noOutput += chunk; } },
      stderr: { write: () => {} },
      stdin: ttyInput(['n\n']),
    },
  );
  assert.match(noOutput, new RegExp(`cleanup: remove ${PUBLIC_LEGACY_SERVER_NAMES[0]}`));
  assert.match(noOutput, /No files changed/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), source);

  let yesOutput = '';
  await runCli(
    ['--public', '--client', 'gemini'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { yesOutput += chunk; } },
      stderr: { write: () => {} },
      stdin: ttyInput(['yes\n']),
    },
  );
  const reconciled = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.match(yesOutput, new RegExp(`cleanup: remove ${PUBLIC_LEGACY_SERVER_NAMES[0]}`));
  assert.equal(reconciled.mcpServers[PUBLIC_LEGACY_SERVER_NAMES[0]], undefined);
  assert.equal(reconciled.mcpServers[PUBLIC_SERVER_NAME].httpUrl, PUBLIC_MCP_URL);
  assert.equal(reconciled.mcpServers.project.httpUrl, 'https://shared.spala.ai/p123/mcp');
});

test('explicit and implicit public installs refuse a noncanonical server name', async () => {
  for (const argv of [
    ['--public', '--name', 'spala_custom_public', '--yes', '--json'],
    ['--name', 'spala_custom_public', '--yes', '--json'],
  ]) {
    await assert.rejects(
      runCli(
        argv,
        {},
        process.cwd(),
        {
          stdout: { write: () => {} },
          stderr: { write: () => {} },
          stdin: { isTTY: false },
        },
      ),
      /public MCP server name is fixed to spala_public_mcp/,
    );
  }
});

test('exact public endpoint URLs and local manifests use canonical public reconciliation', async () => {
  const invocations = [
    ['--url', PUBLIC_MCP_URL],
    ['--url', `${PUBLIC_MCP_URL}/?scope=api`, '--exact-url'],
    ['--manifest', 'public-manifest.json'],
  ];

  for (const argv of invocations) {
    const home = tempHome();
    const configDir = path.join(home, '.gemini');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
      mcpServers: {
        [PUBLIC_LEGACY_SERVER_NAMES[0]]: { url: PUBLIC_MCP_URL },
      },
    }, null, 2));
    fs.writeFileSync(path.join(home, 'public-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      mcpUrl: `${PUBLIC_MCP_URL}///?scope=builder%2Cproject%2Cdata`,
      serverName: PUBLIC_LEGACY_SERVER_NAMES[0],
    }));

    let output = '';
    await runCli(
      [...argv, '--client', 'gemini', '--dry-run', '--json'],
      { SPALA_MCP_INSTALL_HOME: home },
      home,
      {
        stdout: { write: chunk => { output += chunk; } },
        stderr: { write: () => {} },
        stdin: { isTTY: false },
      },
    );

    const plan = JSON.parse(output);
    assert.equal(plan.serverName, PUBLIC_SERVER_NAME);
    assert.equal(plan.mcpUrl, PUBLIC_MCP_URL);
    assert.equal(plan.installScope, 'user');
    assert.deepEqual(plan.writes[0].removedDuplicates, [{ name: PUBLIC_LEGACY_SERVER_NAMES[0] }]);
  }
});

test('uninstall removes only matching target and preserves non-Spala entries', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      'spala_public_mcp': { url: PUBLIC_MCP_URL },
      spala_other: { url: 'https://shared.spala.ai/p123/mcp' },
      external: { url: 'https://example.com/mcp' },
    },
  }, null, 2));

  const plan = createUninstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.deepEqual(plan.writes[0].removedEntries, [{ name: PUBLIC_SERVER_NAME }]);
  installPlan(plan);
  const next = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(next.mcpServers['spala_public_mcp'], undefined);
  assert.equal(next.mcpServers.spala_other.url, 'https://shared.spala.ai/p123/mcp');
  assert.equal(next.mcpServers.external.url, 'https://example.com/mcp');
});

test('uninstall cleanup removes only exact known public aliases', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      'spala_public_mcp': { url: PUBLIC_MCP_URL },
      [PUBLIC_LEGACY_SERVER_NAMES[0]]: { url: PUBLIC_MCP_URL },
      [PUBLIC_LEGACY_SERVER_NAMES[1]]: { url: `${PUBLIC_MCP_URL}/` },
      spala_old_public: { url: PUBLIC_MCP_URL },
      spala_project: { url: 'https://shared.spala.ai/p123/mcp' },
    },
  }, null, 2));

  const plan = createUninstallPlan({
    cleanupDuplicates: true,
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.deepEqual(plan.writes[0].removedEntries, [
    { name: PUBLIC_SERVER_NAME },
    { name: PUBLIC_LEGACY_SERVER_NAMES[0] },
  ]);
  installPlan(plan);
  const next = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(next.mcpServers['spala_public_mcp'], undefined);
  assert.equal(next.mcpServers[PUBLIC_LEGACY_SERVER_NAMES[0]], undefined);
  assert.equal(next.mcpServers[PUBLIC_LEGACY_SERVER_NAMES[1]].url, `${PUBLIC_MCP_URL}/`);
  assert.equal(next.mcpServers.spala_old_public.url, PUBLIC_MCP_URL);
  assert.equal(next.mcpServers.spala_project.url, 'https://shared.spala.ai/p123/mcp');
});

test('doctor reports only exact known public aliases without mutation', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      'spala_public_mcp': { url: PUBLIC_MCP_URL },
      [PUBLIC_LEGACY_SERVER_NAMES[0]]: { url: PUBLIC_MCP_URL },
      [PUBLIC_LEGACY_SERVER_NAMES[1]]: { url: `${PUBLIC_MCP_URL}/` },
      spala_duplicate: { url: PUBLIC_MCP_URL },
      spala_project: { url: 'https://shared.spala.ai/p123/mcp' },
    },
  }, null, 2));

  const report = createDoctorReport({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    installScope: 'user',
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.equal(report.ok, false);
  assert.equal(report.summary.duplicates, 1);
  assert.deepEqual(report.clients[0].duplicates, [{ name: PUBLIC_LEGACY_SERVER_NAMES[0] }]);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers[PUBLIC_LEGACY_SERVER_NAMES[1]].url, `${PUBLIC_MCP_URL}/`);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.spala_duplicate.url, PUBLIC_MCP_URL);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.spala_project.url, 'https://shared.spala.ai/p123/mcp');
});

test('doctor checks the user-scope Codex target and fails wrong URL for expected name', () => {
  const emptyHome = tempHome();
  const emptyReport = createDoctorReport({
    env: { SPALA_MCP_INSTALL_HOME: emptyHome },
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  const codex = emptyReport.clients.find(client => client.client === 'codex');
  assert.equal(emptyReport.ok, false);
  assert.equal(codex.skipped, false);
  assert.deepEqual(codex.issues, ['expected_server_missing']);

  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    mcpServers: {
      'spala_public_mcp': { url: 'https://shared.spala.ai/p123/mcp' },
    },
  }));
  const wrongReport = createDoctorReport({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.equal(wrongReport.ok, false);
  assert.deepEqual(wrongReport.clients[0].issues, ['expected_server_url_mismatch']);
});

test('doctor and uninstall treat encoded and raw scope values as the same MCP URL', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      'spala-shared-spala-ai-p123': { httpUrl: 'https://shared.spala.ai/p123/mcp?scope=builder,project,data' },
    },
  }, null, 2));

  const report = createDoctorReport({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    installScope: 'user',
    mcpUrl: 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata',
    serverName: 'spala-shared-spala-ai-p123',
  });
  assert.equal(report.ok, true);

  const plan = createUninstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    installScope: 'user',
    mcpUrl: 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata',
    serverName: 'spala-shared-spala-ai-p123',
  });
  assert.deepEqual(plan.writes[0].removedEntries, [{ name: 'spala-shared-spala-ai-p123' }]);
});

test('name-only uninstall is limited to Spala-owned entries', () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    mcpServers: {
      github: { url: 'https://api.githubcopilot.com/mcp' },
      spala_project: { url: 'https://example.com/mcp' },
      'spala-shared-spala-ai-p123': { httpUrl: 'https://shared.spala.ai/p123/mcp?scope=builder,project,data' },
    },
  }, null, 2));

  assert.throws(
    () => createUninstallPlan({
      clientSelection: 'gemini',
      env: { SPALA_MCP_INSTALL_HOME: home },
      serverName: 'github',
    }),
    /Name-only uninstall is limited/,
  );

  const unsafeSpalaName = createUninstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    serverName: 'spala_project',
  });
  assert.equal(unsafeSpalaName.writes.length, 0);

  const safeSpalaName = createUninstallPlan({
    clientSelection: 'gemini',
    env: { SPALA_MCP_INSTALL_HOME: home },
    serverName: 'spala-shared-spala-ai-p123',
  });
  assert.deepEqual(safeSpalaName.writes[0].removedEntries, [{ name: 'spala-shared-spala-ai-p123' }]);
});

test('name-only duplicate cleanup is rejected because it lacks a target URL', () => {
  assert.throws(
    () => createUninstallPlan({
      cleanupDuplicates: true,
      clientSelection: 'gemini',
      env: { SPALA_MCP_INSTALL_HOME: tempHome() },
      serverName: PUBLIC_SERVER_NAME,
    }),
    /--cleanup-duplicates requires/,
  );
});

test('claude desktop uses mcp-remote bridge config without secrets', () => {
  const home = tempHome();
  const plan = createInstallPlan({
    clientSelection: 'claude-desktop',
    env: { SPALA_MCP_INSTALL_HOME: home, SPALA_MCP_INSTALL_PLATFORM: 'darwin' },
    installScope: 'user',
    mcpUrl: 'https://project.example/mcp',
  });
  installPlan(plan);

  const configPath = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(config.mcpServers['spala-project-example'], {
    command: 'pnpm',
    args: ['dlx', 'mcp-remote@0.1.38', 'https://project.example/mcp?scope=builder%2Cproject%2Cdata'],
  });
});

test('client selection accepts underscore aliases for dashed client names', () => {
  const home = tempHome();
  const plan = createInstallPlan({
    clientSelection: 'claude_desktop',
    env: { SPALA_MCP_INSTALL_HOME: home, SPALA_MCP_INSTALL_PLATFORM: 'darwin' },
    installScope: 'user',
    mcpUrl: 'https://project.example/mcp',
    scope: 'builder,project,data',
  });

  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.writes[0].client, 'claude-desktop');
});

test('zed uses native remote URL config', () => {
  const home = tempHome();
  const plan = createInstallPlan({
    clientSelection: 'zed',
    env: { SPALA_MCP_INSTALL_HOME: home },
    installScope: 'user',
    mcpUrl: 'https://project.example/mcp?scope=builder,project,data',
  });
  installPlan(plan);

  const configPath = path.join(home, '.config', 'zed', 'settings.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(config.context_servers['spala-project-example'], {
    url: 'https://project.example/mcp?scope=builder,project,data',
  });
});

test('antigravity cli uses its dedicated config directory', () => {
  const home = tempHome();
  const plan = createInstallPlan({
    clientSelection: 'antigravity-cli',
    env: { SPALA_MCP_INSTALL_HOME: home },
    installScope: 'user',
    mcpUrl: 'https://project.example/mcp?scope=builder,project,data',
  });
  installPlan(plan);

  const configPath = path.join(home, '.gemini', 'antigravity-cli', 'mcp_config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(config.mcpServers['spala-project-example'], {
    serverUrl: 'https://project.example/mcp?scope=builder,project,data',
  });
});

test('windows platform simulation uses windows config paths', () => {
  const home = 'C:\\Users\\alice';
  const plan = createInstallPlan({
    clientSelection: 'claude_desktop',
    env: { SPALA_MCP_INSTALL_HOME: home, SPALA_MCP_INSTALL_PLATFORM: 'win32' },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });

  assert.equal(plan.writes[0].path, 'C:\\Users\\alice\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
});

test('cli defaults to public MCP when no URL is provided', async () => {
  const home = tempHome();
  let output = '';
  await runCli(
    ['--client', 'gemini', '--dry-run'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );

  assert.match(output, new RegExp(`Spala MCP server: ${PUBLIC_SERVER_NAME}`));
  assert.match(output, new RegExp(`MCP URL: ${PUBLIC_MCP_URL}`));
  assert.doesNotMatch(output, /scope=builder/);
});

test('command-style init installs the public MCP and returns reload guidance', async () => {
  const home = tempHome();
  let output = '';
  await runCli(
    ['init', '--client', 'gemini', '--yes', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );

  const parsed = JSON.parse(output);
  assert.equal(parsed.command, 'init');
  assert.equal(parsed.outcome, 'installed');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mcpUrl, PUBLIC_MCP_URL);
  assert.equal(parsed.commands, undefined);
  assert.deepEqual(parsed.nextSteps, [
    {
      action: 'restart_required',
      client: 'gemini',
      dynamicReload: false,
      instruction: 'Start a new Gemini CLI session to load the updated MCP configuration.',
    },
    {
      action: 'call_tool',
      server: PUBLIC_SERVER_NAME,
      tool: 'spala_start',
      instruction: 'After the client reload, call spala_start as the protected first MCP call. This is setup-only until spala_start reaches project readiness and the project MCP is verified. Before readiness, inspect only .spala/project.json if it exists; do not web-search, inspect app files, load frontend/design skills, plan, scaffold, code, test, or QA. Do not call account_status, project_list, or any other MCP tool before spala_start. Follow exactly the one nextAction returned by spala_start, and call spala_start again only when that action explicitly requests it after a state transition. Ask account, organization, and project values in the terminal. OAuth and payment or upgrade actions are browser actions only.',
    },
  ]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8')).mcpServers[PUBLIC_SERVER_NAME].httpUrl, PUBLIC_MCP_URL);
});

test('command-style init writes public Codex config and managed skill for user scope', async () => {
  const home = tempHome();
  const calls = [];
  let output = '';
  await runCli(
    ['init', '--client', 'codex', '--yes', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
    {
      runCommand: async request => {
        calls.push(request);
        return { stdout: 'authenticated' };
      },
    },
  );

  const parsed = JSON.parse(output);
  assert.equal(parsed.outcome, 'installed');
  assert.equal(parsed.installScope, 'user');
  assert.deepEqual(parsed.account, { status: 'authenticated', verified: true, owner: 'installer' });
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], outputStream: undefined }, {
    command: 'codex',
    args: ['mcp', 'login', PUBLIC_SERVER_NAME, '--scopes', 'api'],
    cwd: trustedChildCwd(),
    timeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 64 * 1024,
    outputStream: undefined,
  });
  assert.equal(typeof calls[0].outputStream?.write, 'function');
  assert.deepEqual(parsed.nextSteps.map(step => step.action), ['restart_required', 'call_tool']);
  assert.deepEqual(parsed.nextSteps[1], {
    action: 'call_tool',
    server: PUBLIC_SERVER_NAME,
    tool: 'spala_start',
    instruction: 'After the client reload, call spala_start as the protected first MCP call. This is setup-only until spala_start reaches project readiness and the project MCP is verified. Before readiness, inspect only .spala/project.json if it exists; do not web-search, inspect app files, load frontend/design skills, plan, scaffold, code, test, or QA. Do not call account_status, project_list, or any other MCP tool before spala_start. Follow exactly the one nextAction returned by spala_start, and call spala_start again only when that action explicitly requests it after a state transition. Ask account, organization, and project values in the terminal. OAuth and payment or upgrade actions are browser actions only.',
  });
  assert.equal(parsed.nextSteps.some(step => step.action === 'configure_client'), false);
  assert.equal(parsed.nextSteps.some(step => step.action === 'authenticate_client'), false);

  const codexConfig = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.spala_public_mcp]/);
  assert.match(codexConfig, new RegExp(JSON.stringify(PUBLIC_MCP_URL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const skill = fs.readFileSync(path.join(home, '.codex', 'skills', 'spala-backend', 'SKILL.md'), 'utf8');
  assert.match(skill, /managed-by:@spala-ai\/mcp-install/);
  assert.match(skill, /Mandatory FIRST only when using Spala as the backend provider for a customer application/);
  assert.match(skill, /For any other\s+task, this skill does not apply/);
  assert.doesNotMatch(skill, /platform source|platform code|runtime, editor, SDKs/i);
  assert.match(skill, /spala_start[\s\S]*protected first call/);
  assert.match(skill, /again only when that action explicitly requests it/);
  assert.match(skill, /only workspace file you may inspect is `\.spala\/project\.json`/);
  assert.match(skill, /`\.spala\/project\.json` is valid, automatically reuse/i);
  assert.match(skill, /codex mcp get spala_public_mcp/);
  assert.match(skill, /If the user supplies an exact project MCP URL, use it directly/);
  assert.match(skill, /inspect `\.spala\/project\.json` first/);
  assert.match(skill, /public-MCP authentication failure does not block work when the bound project MCP succeeds/);
  assert.match(skill, /binding is valid but its named MCP is missing/);
  assert.match(skill, /--url "<exact-user-url>" --exact-url/);
  assert.match(skill, /offer an explicit account switch/);
  assert.match(skill, /If it succeeds, do not run `init` or `login`; continue directly to its `spala_start`/);
  assert.match(skill, /If and only if it reports that the server does not exist/);
  assert.match(skill, /login --client codex --url "<binding\.mcpUrl>" --exact-url --name "<binding\.serverName>" --json/);

  output = '';
  await runCli(
    ['--public', '--yes', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
    {
      runCommand: async request => {
        calls.push(request);
        return { stdout: 'already authenticated' };
      },
    },
  );

  const rerun = JSON.parse(output);
  assert.equal(rerun.outcome, 'installed');
  assert.equal(rerun.changed, false);
  assert.deepEqual(rerun.account, { status: 'authenticated', verified: true, owner: 'installer' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ['mcp', 'login', PUBLIC_SERVER_NAME, '--scopes', 'api']);
});

test('failed init authentication reports changed and explicit init safely retries authentication', async () => {
  const home = tempHome();
  const retryCommand = 'pnpm dlx @spala-ai/mcp-install@0.1.14 login --client codex --json';
  const secret = 'oauth-failure-code-must-not-leak';
  let errorOutput = '';
  const error = await captureAsyncError(() => runCli(
    ['init', '--client', 'codex', '--yes', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: () => {} },
      stderr: { write: chunk => { errorOutput += chunk; } },
      stdin: { isTTY: false },
    },
    {
      runCommand: async request => {
        request.outputStream.write(`authorization code: ${secret}\n`);
        throw new Error(`codex failed with ${secret}`);
      },
    },
  ), /configuration was changed and retained, but browser authentication did not finish/);

  assert.equal(error.changed, true);
  assert.equal(error.retryCommand, retryCommand);
  assert.equal((`${error.message} ${error.retryCommand}`.match(/pnpm dlx/g) || []).length, 1);
  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.doesNotMatch(errorOutput, new RegExp(secret));
  assert.match(
    fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'),
    /\[mcp_servers\.spala_public_mcp]/,
  );

  let output = '';
  let calls = 0;
  await runCli(
    ['init', '--client', 'codex', '--yes', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
    {
      runCommand: async () => {
        calls += 1;
        return { stdout: 'authenticated' };
      },
    },
  );
  const retried = JSON.parse(output);
  assert.equal(calls, 1);
  assert.equal(retried.changed, false);
  assert.equal(retried.account.status, 'authenticated');
});

test('unchanged canonical --public --yes retries missing or expired native OAuth without inspecting credentials', async () => {
  const retryCommand = 'pnpm dlx @spala-ai/mcp-install@0.1.14 login --client codex --json';

  for (const authState of ['missing', 'expired']) {
    const home = tempHome();
    await runCli(
      ['init', '--client', 'codex', '--yes', '--json'],
      { SPALA_MCP_INSTALL_HOME: home },
      process.cwd(),
      {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        stdin: { isTTY: false },
      },
      { runCommand: async () => ({ stdout: 'authenticated' }) },
    );

    const configPath = path.join(home, '.codex', 'config.toml');
    const skillPath = path.join(home, '.codex', 'skills', 'spala-backend', 'SKILL.md');
    const originalConfig = fs.readFileSync(configPath);
    const originalSkill = fs.readFileSync(skillPath);
    const calls = [];
    const secret = `${authState}-oauth-detail-must-not-leak`;
    let errorOutput = '';
    const error = await captureAsyncError(() => runCli(
      ['--public', '--yes', '--json'],
      { SPALA_MCP_INSTALL_HOME: home },
      process.cwd(),
      {
        stdout: { write: () => {} },
        stderr: { write: chunk => { errorOutput += chunk; } },
        stdin: { isTTY: false },
      },
      {
        runCommand: async request => {
          calls.push(request);
          request.outputStream.write(`${authState} authorization code: ${secret}\n`);
          throw new Error(`${authState} Codex OAuth credential: ${secret}`);
        },
      },
    ), /configuration was retained unchanged, but browser authentication did not finish/);

    assert.equal(calls.length, 1);
    assert.deepEqual({ ...calls[0], outputStream: undefined }, {
      command: 'codex',
      args: ['mcp', 'login', PUBLIC_SERVER_NAME, '--scopes', 'api'],
      cwd: trustedChildCwd(),
      timeoutMs: 10 * 60 * 1000,
      maxOutputBytes: 64 * 1024,
      outputStream: undefined,
    });
    assert.equal(error.changed, false);
    assert.equal(error.retryCommand, retryCommand);
    assert.equal((`${error.message} ${error.retryCommand}`.match(/pnpm dlx/g) || []).length, 1);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.doesNotMatch(errorOutput, new RegExp(secret));
    assert.deepEqual(fs.readFileSync(configPath), originalConfig);
    assert.deepEqual(fs.readFileSync(skillPath), originalSkill);
  }
});

test('unchanged canonical setup reparses the exact Codex registration immediately before native login', async () => {
  for (const substitution of [
    [
      `[mcp_servers.${PUBLIC_SERVER_NAME}]`,
      'url = "https://replacement.example/mcp"',
      '',
    ].join('\n'),
    [
      '[mcp_servers.substituted_public_name]',
      `url = ${JSON.stringify(PUBLIC_MCP_URL)}`,
      '',
    ].join('\n'),
  ]) {
    const home = tempHome();
    await runCli(
      ['init', '--client', 'codex', '--yes', '--json'],
      { SPALA_MCP_INSTALL_HOME: home },
      process.cwd(),
      {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        stdin: { isTTY: false },
      },
      { runCommand: async () => ({ stdout: 'authenticated' }) },
    );

    const configPath = path.join(home, '.codex', 'config.toml');
    let calls = 0;
    const error = await captureAsyncError(() => runCli(
      ['--public', '--yes', '--json'],
      { SPALA_MCP_INSTALL_HOME: home },
      process.cwd(),
      {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        stdin: { isTTY: false },
      },
      {
        beforeCodexAuthenticationValidation() {
          fs.writeFileSync(configPath, substitution);
        },
        runCommand: async () => {
          calls += 1;
          return { stdout: 'authenticated' };
        },
      },
    ), /registration changed before authentication/);

    assert.equal(calls, 0);
    assert.equal(error.changed, false);
    assert.equal(error.retryCommand, undefined);
    assert.equal(fs.readFileSync(configPath, 'utf8'), substitution);
  }
});

test('native failed init JSON reports one exact retry command without child output', () => {
  const home = tempHome();
  const fakeBin = tempHome();
  const secret = 'native-oauth-code-must-not-leak';
  const codexPath = path.join(fakeBin, 'codex');
  fs.writeFileSync(codexPath, [
    '#!/bin/sh',
    `printf 'authorization code: ${secret}\\n' >&2`,
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  const result = spawnSync(
    process.execPath,
    [path.resolve('bin/spala-mcp-install.js'), 'init', '--client', 'codex', '--yes', '--json'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        SPALA_MCP_INSTALL_HOME: home,
      },
    },
  );

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.changed, true);
  assert.deepEqual(payload.nextSteps, [{
    action: 'run_command',
    command: 'pnpm dlx @spala-ai/mcp-install@0.1.14 login --client codex --json',
  }]);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});

test('command-style status reports the configured public MCP and endpoint check', async () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    mcpServers: { [PUBLIC_SERVER_NAME]: { httpUrl: PUBLIC_MCP_URL } },
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  let output = '';
  try {
    await runCli(
      ['status', '--client', 'gemini', '--json'],
      { SPALA_MCP_INSTALL_HOME: home },
      process.cwd(),
      {
        stdout: { write: chunk => { output += chunk; } },
        stderr: { write: () => {} },
        stdin: { isTTY: false },
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const parsed = JSON.parse(output);
  assert.equal(parsed.command, 'status');
  assert.equal(parsed.outcome, 'ready');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.endpoint.ok, true);
  assert.deepEqual(parsed.account, {
    status: 'client_managed',
    verified: false,
    server: PUBLIC_SERVER_NAME,
    tool: 'account_status',
    instruction: 'Configuration checks intentionally do not read MCP-client OAuth credentials. Codex public init owns the one browser sign-in. After reload, call spala_start as the protected first MCP call; before readiness inspect only .spala/project.json if it exists and do not web-search, inspect app files, load frontend/design skills, plan, scaffold, code, test, or QA. Follow its one nextAction and repeat spala_start only when that action explicitly requests it. If authorization has expired, run exactly one installer login command that opens the browser. OAuth and payment or upgrade actions are browser actions only; do not start parallel logins, manually open an authorization URL, inspect credential stores, or hand-roll MCP HTTP calls.',
  });
  assert.deepEqual(parsed.nextSteps.map(step => step.tool), ['spala_start']);
  assert.equal(parsed.nextSteps[0].tool, 'spala_start');
  assert.match(parsed.nextSteps[0].instruction, /protected first MCP call/);
});

test('command-style login delegates public MCP OAuth to Codex without handling credentials', async () => {
  const home = tempHome();
  writeCodexRegistration(home, PUBLIC_SERVER_NAME, PUBLIC_MCP_URL);
  const calls = [];
  const safeAuthorizationUrl = oauthAuthorizationUrl();
  let output = '';
  let errorOutput = '';
  await runCli(
    ['login', '--client', 'codex', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: chunk => { errorOutput += chunk; } },
      stdin: { isTTY: false },
    },
    {
      runCommand: async request => {
        calls.push(request);
        request.outputStream.write('access_token=fake-review-token\n');
        request.outputStream.write('authorization code: fake-review-code\n');
        request.outputStream.write('Open this URL in your browser: https://auth.example.test/rejected?code=fake-code\n');
        request.outputStream.write('Open this URL in your browser: https://auth.example.test/rejected?access_token=fake-token\n');
        request.outputStream.write('arbitrary diagnostic https://auth.example.test/arbitrary\n');
        request.outputStream.write('{"accessToken":"fake-json-token","url":"https://auth.example.test/leak"}\n');
        request.outputStream.write('{"client_secret":"fake-client-secret","url":"https://auth.example.test/leak"}\n');
        request.outputStream.write(`Open this URL in your browser: ${oauthAuthorizationUrl({ authorization_code: 'fake-authorization-code' })}\n`);
        request.outputStream.write(`Open this URL in your browser: ${oauthAuthorizationUrl({ auth_code: 'fake-auth-code' })}\n`);
        request.outputStream.write(`Open this URL in your browser: ${oauthAuthorizationUrl({ device_code: 'fake-device-code' })}\n`);
        request.outputStream.write(`Open this URL in your browser: ${oauthAuthorizationUrl({ user_code: 'fake-user-code' })}\n`);
        request.outputStream.write(`Open this URL in your browser: ${oauthAuthorizationUrl({ unknown: 'fake-unknown-value' })}\n`);
        request.outputStream.write(`Open this URL in your browser: ${oauthAuthorizationUrl({ redirect_uri: 'https://callback.example/access-token?secret=fake-nested-token' })}\n`);
        request.outputStream.write(`Open this URL in your browser: ${oauthAuthorizationUrl({ state: '%61ccess_token%3Dfake-nested-state' })}\n`);
        request.outputStream.write(`Open this URL in your browser: ${safeAuthorizationUrl.replace('state=review-state', '%61ccess_token=fake-encoded-name')}\n`);
        request.outputStream.write(`Open this URL in your browser: ${safeAuthorizationUrl.replace('state=review-state', '%2561ccess_token=fake-double-encoded-name')}\n`);
        request.outputStream.write(`Open this URL in your browser: ${safeAuthorizationUrl.replace('state=review-state', 'state=%2561ccess_token%253Dfake-double-encoded-value')}\n`);
        request.outputStream.write(`Open this URL in your browser: ${safeAuthorizationUrl.replace('resource=https%3A%2F%2Fmcp.spala.ai%2Fmcp', `resource=${encodeURIComponent(`${PUBLIC_MCP_URL}/`)}`)}\n`);
        request.outputStream.write(`Open this URL in your browser: ${safeAuthorizationUrl.replace(/&resource=[^&]+/, '')}\n`);
        request.outputStream.write(`Open this URL in your browser: ${safeAuthorizationUrl.replace('state=review-state', 'state=bad%ZZencoding')}\n`);
        request.outputStream.write(`Open this URL in your browser: ${oauthAuthorizationUrl()}#access_token=fake-fragment-token\n`);
        request.outputStream.write(`Open this URL in your browser: ${oauthAuthorizationUrl().replace('/oauth/authorize?', '/oauth/token?')}\n`);
        request.outputStream.write(`Open this URL in your browser: ${oauthAuthorizationUrl().replace('/oauth/authorize?', '/oauth/%61uthorize?')}\n`);
        request.outputStream.write('Authorize `spala_public_mcp` by opening this URL in your browser:\n');
        request.outputStream.write(`${safeAuthorizationUrl}\n`);
        request.outputStream.write(`If your browser did not open, navigate to this URL to authenticate: ${safeAuthorizationUrl}\n`);
        request.outputStream.write('authenticated token=fake-status-token\n');
        request.outputStream.write('Successfully authenticated.\n');
        return { stdout: 'authenticated' };
      },
    },
  );

  const parsed = JSON.parse(output);
  assert.equal(parsed.command, 'login');
  assert.equal(parsed.outcome, 'authenticated');
  assert.equal(parsed.account.verified, true);
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], outputStream: undefined }, {
    command: 'codex',
    args: ['mcp', 'login', PUBLIC_SERVER_NAME, '--scopes', 'api'],
    cwd: trustedChildCwd(),
    timeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 64 * 1024,
    outputStream: undefined,
  });
  assert.match(errorOutput, new RegExp(`^Open this browser URL: ${safeAuthorizationUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal((errorOutput.match(/^Open this browser URL:/gm) || []).length, 1);
  assert.match(errorOutput, /^Browser authentication completed\.$/m);
  assert.doesNotMatch(errorOutput, /fake-review-token|fake-review-code|fake-code|fake-token|fake-json-token|fake-client-secret|fake-status-token|fake-authorization-code|fake-auth-code|fake-device-code|fake-user-code|fake-unknown-value|fake-nested-token|fake-nested-state|fake-encoded-name|fake-double-encoded|access[_-]?token|client[_-]?secret/i);
  assert.doesNotMatch(errorOutput, /auth\.example\.test\/(?:leak|rejected|arbitrary)/);
  assert.doesNotMatch(output, /auth\.example\.test/);
  assert.doesNotMatch(output, /authenticated'|access_token|refresh_token/i);
});

test('native Codex child execution uses a trusted static cwd after invocation path rebind', async () => {
  const invocationCwd = tempHome();
  const displacedCwd = `${invocationCwd}-displaced`;
  const home = tempHome();
  writeCodexRegistration(home, PUBLIC_SERVER_NAME, PUBLIC_MCP_URL);
  let output = '';
  await runCli(
    ['login', '--client', 'codex', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    invocationCwd,
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
    {
      runCommand: async request => {
        fs.renameSync(invocationCwd, displacedCwd);
        fs.mkdirSync(invocationCwd);
        assert.equal(request.cwd, trustedChildCwd());
        assert.notEqual(request.cwd, invocationCwd);
        assert.notEqual(request.cwd, displacedCwd);
        return { stdout: 'already authenticated' };
      },
    },
  );

  assert.equal(JSON.parse(output).outcome, 'authenticated');
});

test('OAuth failures discard arbitrary child output and error details', async () => {
  const home = tempHome();
  writeCodexRegistration(home, PUBLIC_SERVER_NAME, PUBLIC_MCP_URL);
  const secret = 'oauth-error-token-and-code';
  let errorOutput = '';
  const error = await captureAsyncError(() => runCli(
    ['login', '--client', 'codex', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: () => {} },
      stderr: { write: chunk => { errorOutput += chunk; } },
      stdin: { isTTY: false },
    },
    {
      runCommand: async request => {
        request.outputStream.write(`Open this URL in your browser: https://auth.example.test/rejected?code=${secret}\n`);
        request.outputStream.write(`diagnostic ${secret}\n`);
        throw new Error(`codex exited with authorization code ${secret}`);
      },
    },
  ), /^Codex could not complete Spala browser authentication\.$/);

  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.doesNotMatch(errorOutput, new RegExp(secret));
  assert.equal(errorOutput, '');
});

test('command-style login targets an exact bound project MCP without public scopes', async () => {
  const workspace = tempHome();
  const projectMcpUrl = 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata';
  writeCodexRegistration(workspace, 'spala_project_p123', projectMcpUrl);
  const calls = [];
  let output = '';
  let errorOutput = '';
  await runCli(
    [
      'login',
      '--client', 'codex',
      '--url', projectMcpUrl,
      '--exact-url',
      '--name', 'spala_project_p123',
      '--json',
    ],
    {},
    workspace,
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: chunk => { errorOutput += chunk; } },
      stdin: { isTTY: false },
    },
    {
      runCommand: async request => {
        calls.push(request);
        request.outputStream.write(`Open this URL in your browser: ${oauthAuthorizationUrl({}, projectMcpUrl)}\n`);
        return { stdout: 'authenticated' };
      },
    },
  );

  const parsed = JSON.parse(output);
  assert.equal(parsed.serverName, 'spala_project_p123');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['mcp', 'login', 'spala_project_p123']);
  assert.equal(parsed.account.server, 'spala_project_p123');
  assert.equal(parsed.account.tool, 'spala_start');
  assert.equal(errorOutput, `Open this browser URL: ${oauthAuthorizationUrl({}, projectMcpUrl)}\n`);
  assert.deepEqual(parsed.nextSteps, [{
    action: 'call_tool',
    server: 'spala_project_p123',
    tool: 'spala_start',
    instruction: 'Call spala_start on the selected project MCP as the protected first call, then follow its returned nextAction.',
  }]);
});

test('explicit public and exact project login reparse the selected registration immediately before spawn', async () => {
  const cases = [
    {
      label: 'public',
      root: tempHome(),
      cwd: process.cwd(),
      env(root) {
        return { SPALA_MCP_INSTALL_HOME: root };
      },
      serverName: PUBLIC_SERVER_NAME,
      mcpUrl: PUBLIC_MCP_URL,
      args: ['login', '--client', 'codex', '--json'],
    },
    {
      label: 'project',
      root: tempHome(),
      cwd: undefined,
      env() {
        return {};
      },
      serverName: 'spala_project_p123',
      mcpUrl: 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata',
      args: [
        'login',
        '--client', 'codex',
        '--url', 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata',
        '--exact-url',
        '--name', 'spala_project_p123',
        '--json',
      ],
    },
  ];

  for (const fixture of cases) {
    const configPath = writeCodexRegistration(fixture.root, fixture.serverName, fixture.mcpUrl);
    fixture.cwd ||= fixture.root;
    for (const substitution of [
      [
        `[mcp_servers.${fixture.serverName}]`,
        'url = "https://replacement.example/mcp"',
        '',
      ].join('\n'),
      [
        `[mcp_servers.substituted_${fixture.label}_name]`,
        `url = ${JSON.stringify(fixture.mcpUrl)}`,
        '',
      ].join('\n'),
    ]) {
      writeCodexRegistration(fixture.root, fixture.serverName, fixture.mcpUrl);
      let calls = 0;
      const error = await captureAsyncError(() => runCli(
        fixture.args,
        fixture.env(fixture.root),
        fixture.cwd,
        {
          stdout: { write: () => {} },
          stderr: { write: () => {} },
          stdin: { isTTY: false },
        },
        {
          beforeCodexAuthenticationValidation() {
            fs.writeFileSync(configPath, substitution);
          },
          runCommand: async () => {
            calls += 1;
            return { stdout: 'authenticated' };
          },
        },
      ), /registration changed before authentication/);

      assert.equal(error.configurationValidation, true, fixture.label);
      assert.equal(calls, 0, fixture.label);
      assert.equal(fs.readFileSync(configPath, 'utf8'), substitution, fixture.label);
    }
  }
});

test('bounded command streams child output while preserving captured output', async () => {
  let streamed = '';
  const result = await runBoundedCommand({
    command: process.execPath,
    args: ['-e', "process.stdout.write('authorization URL\\n'); process.stderr.write('waiting for approval\\n');"],
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    outputStream: { write: chunk => { streamed += chunk.toString(); } },
  });

  assert.match(streamed, /authorization URL/);
  assert.match(streamed, /waiting for approval/);
  assert.equal(result.stdout, 'authorization URL\n');
  assert.equal(result.stderr, 'waiting for approval\n');
});

test('command-style login explains that non-Codex clients authenticate on project_list', async () => {
  await assert.rejects(
    runCli(
      ['login', '--client', 'claude-code', '--json'],
      {},
      process.cwd(),
      { stdout: { write: () => {} }, stderr: { write: () => {} }, stdin: { isTTY: false } },
    ),
    /start browser authentication when the agent calls project_list/,
  );
});

test('command-style status marks an unconfigured public MCP as not configured', async () => {
  const home = tempHome();
  const originalFetch = globalThis.fetch;
  const previousExitCode = process.exitCode;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  let output = '';
  try {
    await runCli(
      ['status', '--client', 'gemini', '--json'],
      { SPALA_MCP_INSTALL_HOME: home },
      process.cwd(),
      {
        stdout: { write: chunk => { output += chunk; } },
        stderr: { write: () => {} },
        stdin: { isTTY: false },
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const parsed = JSON.parse(output);
  assert.equal(parsed.outcome, 'not_configured');
  assert.equal(parsed.ok, false);
  assert.equal(process.exitCode, 1);
  process.exitCode = previousExitCode;
});

test('command-style status reads Codex MCP metadata without exposing client-managed credentials', async () => {
  const originalFetch = globalThis.fetch;
  const previousExitCode = process.exitCode;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  const calls = [];
  let output = '';
  try {
    await runCli(
      ['status', '--client', 'codex', '--json'],
      {},
      process.cwd(),
      {
        stdout: { write: chunk => { output += chunk; } },
        stderr: { write: () => {} },
        stdin: { isTTY: false },
      },
      {
        runCommand: async request => {
          calls.push(request);
          return {
            stdout: JSON.stringify({
              name: PUBLIC_SERVER_NAME,
              url: PUBLIC_MCP_URL,
              token: 'do-not-print',
            }),
          };
        },
      },
    );

    const parsed = JSON.parse(output);
    const codex = parsed.clients.find(client => client.client === 'codex');
    assert.equal(parsed.outcome, 'ready');
    assert.equal(codex.status, 'configured');
    assert.equal(codex.auth, 'client_managed');
    assert.equal(codex.probe, 'get');
    assert.deepEqual(parsed.nextSteps.map(step => step.tool), ['spala_start']);
    assert.equal(parsed.nextSteps[0].tool, 'spala_start');
    assert.match(parsed.nextSteps[0].instruction, /protected first MCP call/);
    assert.ok(parsed.nextSteps.every(step => step.action !== 'configure_client' && step.action !== 'restart_client'));
    assert.doesNotMatch(output, /do-not-print/);
    assert.deepEqual(calls, [{
      command: 'codex',
      args: ['mcp', 'get', PUBLIC_SERVER_NAME, '--json'],
      cwd: trustedChildCwd(),
      timeoutMs: 3000,
      maxOutputBytes: 64 * 1024,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    process.exitCode = previousExitCode;
  }
});

test('command-style status detects mismatched and absent Codex MCP registrations', async () => {
  const originalFetch = globalThis.fetch;
  const previousExitCode = process.exitCode;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    let output = '';
    await runCli(
      ['status', '--client', 'codex', '--json'],
      {},
      process.cwd(),
      { stdout: { write: chunk => { output += chunk; } }, stderr: { write: () => {} }, stdin: { isTTY: false } },
      { runCommand: async () => ({ stdout: JSON.stringify({ name: PUBLIC_SERVER_NAME, url: 'https://other.example/mcp' }) }) },
    );
    let parsed = JSON.parse(output);
    assert.equal(parsed.outcome, 'needs_action');
    assert.equal(parsed.clients[0].status, 'mismatched');
    assert.deepEqual(parsed.clients[0].issues, ['expected_server_url_mismatch']);

    output = '';
    const calls = [];
    await runCli(
      ['status', '--client', 'codex', '--json'],
      {},
      process.cwd(),
      { stdout: { write: chunk => { output += chunk; } }, stderr: { write: () => {} }, stdin: { isTTY: false } },
      {
        runCommand: async request => {
          calls.push(request);
          if (request.args[1] === 'get') throw Object.assign(new Error('not found'), { code: 1 });
          return { stdout: JSON.stringify([]) };
        },
      },
    );
    parsed = JSON.parse(output);
    assert.equal(parsed.outcome, 'not_configured');
    assert.equal(parsed.clients[0].status, 'not_configured');
    assert.equal(parsed.clients[0].auth, 'client_managed');
    assert.deepEqual(calls.map(call => call.args), [
      ['mcp', 'get', PUBLIC_SERVER_NAME, '--json'],
      ['mcp', 'list', '--json'],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    process.exitCode = previousExitCode;
  }
});

test('command-style status retains Codex command guidance when the Codex CLI is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const previousExitCode = process.exitCode;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  let output = '';
  try {
    await runCli(
      ['status', '--client', 'codex', '--json'],
      {},
      process.cwd(),
      { stdout: { write: chunk => { output += chunk; } }, stderr: { write: () => {} }, stdin: { isTTY: false } },
      { runCommand: async () => { throw Object.assign(new Error('missing binary'), { code: 'ENOENT' }); } },
    );
    const parsed = JSON.parse(output);
    assert.equal(parsed.outcome, 'unknown');
    assert.equal(parsed.clients[0].status, 'unknown');
    assert.equal(parsed.clients[0].auth, 'unknown');
    assert.deepEqual(parsed.nextSteps.map(step => step.action), ['install', 'verify']);
    assert.equal(parsed.nextSteps.some(step => step.action === 'configure_client'), false);
    assert.equal(parsed.nextSteps.some(step => step.action === 'authenticate_client'), false);
  } finally {
    globalThis.fetch = originalFetch;
    process.exitCode = previousExitCode;
  }
});

test('command-style init and status keep project MCP operations on legacy flags', async () => {
  for (const argv of [
    ['init', '--url', 'https://project.example/mcp'],
    ['status', '--manifest', 'project-manifest.json'],
  ]) {
    await assert.rejects(
      runCli(
        argv,
        {},
        process.cwd(),
        { stdout: { write: () => {} }, stderr: { write: () => {} }, stdin: { isTTY: false } },
      ),
      /public MCP only/,
    );
  }
});

test('cli json output does not include full next config or secrets', async () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    mcpServers: {
      secret_service: {
        url: 'https://example.com/mcp',
        token: 'do-not-print',
      },
    },
  }));
  let output = '';
  await runCli(
    ['--client', 'gemini', '--json', '--dry-run'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );

  assert.doesNotMatch(output, /do-not-print/);
  assert.doesNotMatch(output, /"next"\s*:/);
  const parsed = JSON.parse(output);
  assert.equal(parsed.writes[0].client, 'gemini');
});

test('cli uninstall json does not print removed entry URLs', async () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    mcpServers: {
      spala_secret: { url: 'https://shared.spala.ai/p123/mcp?scope=builder,project,data' },
    },
  }));
  let output = '';
  await runCli(
    ['--uninstall', '--client', 'gemini', '--name', 'spala_secret', '--dry-run', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );

  assert.doesNotMatch(output, /shared\.spala\.ai\/p123/);
  assert.equal(JSON.parse(output).writes[0].removedEntries[0].name, 'spala_secret');
});

test('cli derives project server name for doctor and uninstall URL flows', async () => {
  const home = tempHome();
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      'spala-project-example': { httpUrl: 'https://project.example/mcp?scope=builder%2Cproject%2Cdata' },
    },
  }, null, 2));

  let doctorOutput = '';
  await runCli(
    ['--doctor', '--client', 'gemini', '--url', 'https://project.example/mcp', '--install-scope', 'user', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { doctorOutput += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );
  const doctor = JSON.parse(doctorOutput);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.expected.serverName, 'spala-project-example');

  let uninstallOutput = '';
  await runCli(
    ['--uninstall', '--client', 'gemini', '--url', 'https://project.example/mcp', '--install-scope', 'user', '--dry-run', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { uninstallOutput += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );
  const uninstall = JSON.parse(uninstallOutput);
  assert.equal(uninstall.serverName, 'spala-project-example');
  assert.equal(uninstall.writes[0].removedEntries[0].name, 'spala-project-example');

  let uninstallByNameOutput = '';
  await runCli(
    ['--uninstall', '--client', 'gemini', '--name', 'spala-project-example', '--dry-run', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { uninstallByNameOutput += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );
  assert.equal(JSON.parse(uninstallByNameOutput).writes.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers['spala-project-example'].httpUrl, 'https://project.example/mcp?scope=builder%2Cproject%2Cdata');
});

test('cli loads local manifest and rejects remote manifest', async () => {
  const home = tempHome();
  const manifestPath = path.join(home, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    mcpUrl: 'https://shared.spala.ai/p123/mcp',
    serverName: 'spala_project_p123',
    scope: '',
  }));
  let output = '';
  await runCli(
    ['--manifest', manifestPath, '--client', 'gemini', '--dry-run', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.serverName, 'spala_project_p123');
  assert.equal(parsed.mcpUrl, 'https://shared.spala.ai/p123/mcp');

  await assert.rejects(
    runCli(
      ['--manifest', 'https://mcp.spala.ai/mcp/install-manifest'],
      {},
      process.cwd(),
      {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        stdin: { isTTY: false },
      },
    ),
    /only accepts local files/,
  );

  const badManifestPath = path.join(home, 'bad-manifest.json');
  fs.writeFileSync(badManifestPath, JSON.stringify({
    schemaVersion: 1,
    mcpUrl: PUBLIC_MCP_URL,
    command: 'do-not-accept',
  }));
  await assert.rejects(
    runCli(
      ['--manifest', badManifestPath],
      {},
      process.cwd(),
      {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        stdin: { isTTY: false },
      },
    ),
    /unsupported fields: command/,
  );
});

test('cli rejects ambiguous public and URL install flags', async () => {
  await assert.rejects(
    runCli(
      ['--public', '--url', 'https://project.example/mcp'],
      {},
      process.cwd(),
      {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        stdin: { isTTY: false },
      },
    ),
    /Use either --public or --url, not both/,
  );
});

test('cli exact URL mode preserves the authenticated handoff URL', async () => {
  const home = tempHome();
  const exactUrl = 'https://shared.spala.ai/p123/mcp/?scope=builder%2Cproject%2Cdata';
  let output = '';
  await runCli(
    ['--url', exactUrl, '--exact-url', '--client', 'gemini', '--dry-run', '--json'],
    { SPALA_MCP_INSTALL_HOME: home },
    process.cwd(),
    {
      stdout: { write: chunk => { output += chunk; } },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    },
  );

  assert.equal(JSON.parse(output).mcpUrl, exactUrl);

  await assert.rejects(
    runCli(
      ['--url', exactUrl, '--exact-url', '--scope', 'api'],
      {},
      process.cwd(),
      { stdout: { write: () => {} }, stderr: { write: () => {} }, stdin: { isTTY: false } },
    ),
    /cannot be combined with --scope/,
  );
  await assert.rejects(
    runCli(
      ['--exact-url'],
      {},
      process.cwd(),
      { stdout: { write: () => {} }, stderr: { write: () => {} }, stdin: { isTTY: false } },
    ),
    /requires --url/,
  );
});

test('exact project handoff writes Codex workspace config and requires a new session', async () => {
  const exactUrl = 'https://shared.spala.ai/p123/mcp/?scope=builder%2Cproject%2Cdata';
  const workspace = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  let output = '';
  await runCli(
    ['--url', exactUrl, '--exact-url', '--client', 'codex', '--yes', '--json'],
    {},
    workspace,
    { stdout: { write: chunk => { output += chunk; } }, stderr: { write: () => {} }, stdin: { isTTY: false } },
  );

  const parsed = JSON.parse(output);
  assert.equal(parsed.command, 'project-init');
  assert.equal(parsed.outcome, 'installed');
  assert.equal(parsed.installScope, 'workspace');
  assert.deepEqual(parsed.nextSteps.map(step => step.action), [
    'restart_required',
    'verify',
  ]);
  assert.equal(parsed.nextSteps[0].dynamicReload, false);
  const codexConfig = fs.readFileSync(path.join(workspace, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.spala-shared-spala-ai-p123]/);
  assert.match(codexConfig, new RegExp(JSON.stringify(exactUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('project Roo verification checks the exact workspace URL, not public status', async () => {
  const workspace = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  const exactUrl = 'https://shared.spala.ai/p123/mcp';
  let output = '';
  await runCli(
    ['--url', exactUrl, '--exact-url', '--client', 'roo', '--yes', '--json'],
    {},
    workspace,
    { stdout: { write: chunk => { output += chunk; } }, stderr: { write: () => {} }, stdin: { isTTY: false } },
  );

  const verify = JSON.parse(output).nextSteps.find(step => step.action === 'verify');
  assert.deepEqual(verify.argv, [
    'spala-ai', '--check', '--client', 'roo', '--url', exactUrl, '--exact-url', '--json',
  ]);
});

test('cli rejects explicit empty URL instead of defaulting to public MCP', async () => {
  await assert.rejects(
    runCli(
      ['--url', ''],
      {},
      process.cwd(),
      {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        stdin: { isTTY: false },
      },
    ),
    /--url requires a value/,
  );
});

test('cli rejects missing values for value-taking options', async () => {
  for (const flag of ['--url', '--manifest', '--scope', '--client', '--name']) {
    await assert.rejects(
      runCli(
        [flag, '--dry-run'],
        {},
        process.cwd(),
        {
          stdout: { write: () => {} },
          stderr: { write: () => {} },
          stdin: { isTTY: false },
        },
      ),
      new RegExp(`${flag} requires a value`),
    );
  }
});

test('workspace binding is discovered from nested directories and contains only credential-free project identity', () => {
  const workspace = tempHome();
  const nested = path.join(workspace, 'apps', 'web', 'src');
  fs.mkdirSync(path.join(workspace, '.git'));
  fs.mkdirSync(nested, { recursive: true });
  const binding = {
    schemaVersion: 1,
    projectId: 'project-123',
    projectUrl: 'https://shared.spala.ai/p123/',
    mcpUrl: 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata',
    serverName: 'spala-shared-spala-ai-p123',
  };

  assert.equal(findWorkspaceRoot(nested), workspace);
  const result = writeProjectBinding(nested, binding);
  assert.equal(result.changed, true);
  assert.deepEqual(readProjectBinding(nested).binding, binding);
  const bindingPath = path.join(workspace, '.spala', 'project.json');
  const stored = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['mcpUrl', 'projectId', 'projectUrl', 'schemaVersion', 'serverName']);
  assert.equal((fs.statSync(bindingPath).mode & 0o777), 0o600);
  assert.doesNotMatch(JSON.stringify(stored), /token|secret|password|authorization|\/Users\//i);
});

test('workspace binding refuses project drift unless switch is explicit', () => {
  const workspace = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  const first = {
    schemaVersion: 1,
    projectId: 'project-a',
    projectUrl: 'https://shared.spala.ai/pa/',
    mcpUrl: 'https://shared.spala.ai/pa/mcp',
    serverName: 'spala-shared-spala-ai-pa',
  };
  const second = {
    schemaVersion: 1,
    projectId: 'project-b',
    projectUrl: 'https://shared.spala.ai/pb/',
    mcpUrl: 'https://shared.spala.ai/pb/mcp',
    serverName: 'spala-shared-spala-ai-pb',
  };
  writeProjectBinding(workspace, first);
  assert.throws(() => writeProjectBinding(workspace, second), /already bound.*--switch/);
  writeProjectBinding(workspace, second, { switchProject: true });
  assert.equal(readProjectBinding(workspace).binding.projectId, 'project-b');
});

test('workspace binding rejects credentials, secret parameters, extra fields, and symlinks', () => {
  const workspace = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  const base = {
    schemaVersion: 1,
    projectId: 'project-123',
    projectUrl: 'https://shared.spala.ai/p123/',
    mcpUrl: 'https://shared.spala.ai/p123/mcp',
    serverName: 'spala-shared-spala-ai-p123',
  };
  assert.throws(() => writeProjectBinding(workspace, { ...base, mcpUrl: 'https://user:pass@shared.spala.ai/p123/mcp' }), /credentials/);
  assert.throws(() => writeProjectBinding(workspace, { ...base, mcpUrl: 'https://shared.spala.ai/p123/mcp?token=secret' }), /unsupported query/);
  assert.throws(() => writeProjectBinding(workspace, { ...base, accessToken: 'secret' }), /unsupported fields/);
  assert.throws(() => writeProjectBinding(workspace, {
    ...base,
    projectUrl: 'https://example.com/p123/',
    mcpUrl: 'https://example.com/p123/mcp',
  }), /Spala project host/);
  const target = path.join(workspace, 'outside');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(workspace, '.spala'));
  assert.throws(() => writeProjectBinding(workspace, base), /symbolic link/);
});

test('Codex project install preserves unrelated TOML and refuses a mismatched existing server', () => {
  const workspace = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  const configDir = path.join(workspace, '.codex');
  fs.mkdirSync(configDir);
  const configPath = path.join(configDir, 'config.toml');
  const original = 'model = "gpt-5.6"\n\n[features]\nweb_search = true\n\n[[profiles]]\nname = "review"\n';
  fs.writeFileSync(configPath, original);
  const url = 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata';
  const plan = createInstallPlan({
    clientSelection: 'codex',
    cwd: workspace,
    exactUrl: true,
    mcpUrl: url,
    serverName: 'spala-shared-spala-ai-p123',
  });
  installPlan(plan);
  const updated = fs.readFileSync(configPath, 'utf8');
  assert.ok(updated.startsWith(original));
  assert.match(updated, /\[mcp_servers\.spala-shared-spala-ai-p123]/);
  assert.match(updated, /url = "https:\/\/shared\.spala\.ai\/p123\/mcp\?scope=builder%2Cproject%2Cdata"/);
  assert.throws(() => createInstallPlan({
    clientSelection: 'codex',
    cwd: workspace,
    exactUrl: true,
    mcpUrl: 'https://shared.spala.ai/p999/mcp',
    serverName: 'spala-shared-spala-ai-p123',
  }), /different URL/);
});

test('project command hints use project scope for Claude Code and Gemini CLI', () => {
  const hints = buildCommandHints('spala-project', 'https://shared.spala.ai/p123/mcp', 'workspace');
  assert.equal(hints.codexAdd, null);
  assert.equal(hints.argv.codexAdd, null);
  assert.deepEqual(hints.argv.claudeCode, [
    'claude', 'mcp', 'add', '--transport', 'http', '--scope', 'project', 'spala-project', 'https://shared.spala.ai/p123/mcp',
  ]);
  assert.deepEqual(hints.argv.geminiCli, [
    'gemini', 'mcp', 'add', 'spala-project', '--transport', 'http', '--scope', 'project', 'https://shared.spala.ai/p123/mcp',
  ]);
});

test('project workspace installs fail closed instead of writing unsupported global configs', () => {
  const workspace = tempHome();
  const home = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  for (const client of ['antigravity', 'antigravity-cli', 'windsurf', 'cline', 'claude-desktop', 'zed']) {
    const plan = createInstallPlan({
      clientSelection: client,
      cwd: workspace,
      env: { SPALA_MCP_INSTALL_HOME: home },
      exactUrl: true,
      mcpUrl: 'https://shared.spala.ai/p123/mcp',
    });
    assert.equal(plan.writes.length, 0, client);
    assert.equal(plan.skipped[0].unsupportedScope, true, client);
  }
  assert.equal(fs.readdirSync(home).length, 0);
});

test('public and project defaults keep install scope separate from MCP tool scope', () => {
  const home = tempHome();
  const workspace = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  const publicPlan = createInstallPlan({
    clientSelection: 'gemini',
    cwd: workspace,
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: PUBLIC_MCP_URL,
    scope: '',
    serverName: PUBLIC_SERVER_NAME,
  });
  assert.equal(publicPlan.installScope, 'user');
  assert.match(publicPlan.writes[0].path, /\.gemini\/settings\.json$/);
  const projectPlan = createInstallPlan({
    clientSelection: 'roo',
    cwd: workspace,
    env: { SPALA_MCP_INSTALL_HOME: home },
    mcpUrl: 'https://shared.spala.ai/p123/mcp',
    scope: 'builder,project,data',
  });
  assert.equal(projectPlan.installScope, 'workspace');
  assert.match(projectPlan.mcpUrl, /scope=builder%2Cproject%2Cdata/);
  assert.equal(projectPlan.writes[0].path, path.join(workspace, '.roo', 'mcp.json'));
});

test('project bind, status, and unbind operate from nested workspace directories', async () => {
  const workspace = tempHome();
  const nested = path.join(workspace, 'src', 'feature');
  fs.mkdirSync(path.join(workspace, '.git'));
  fs.mkdirSync(nested, { recursive: true });
  const io = () => {
    let output = '';
    return {
      streams: { stdout: { write: chunk => { output += chunk; } }, stderr: { write: () => {} }, stdin: { isTTY: false } },
      output: () => output,
    };
  };

  const bindIo = io();
  await runCli([
    'project', 'bind',
    '--project-id', 'project-123',
    '--project-url', 'https://shared.spala.ai/p123/',
    '--url', 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata',
    '--client', 'codex',
    '--yes',
    '--json',
  ], {}, nested, bindIo.streams);
  const bound = JSON.parse(bindIo.output());
  assert.equal(bound.outcome, 'bound');
  assert.equal(bound.bindingFile, '.spala/project.json');
  assert.equal(bound.installScope, 'workspace');
  assert.equal(bound.nextSteps[0].dynamicReload, false);
  assert.ok(bound.nextSteps.every(step => step.action !== 'authenticate_client' && step.action !== 'approve'));
  assert.doesNotMatch(bindIo.output(), /grant|access.?token|refresh.?token|authorization|cookie/i);
  assert.equal(fs.existsSync(path.join(workspace, '.codex', 'config.toml')), true);

  const statusIo = io();
  await runCli(['project', 'status', '--json'], {}, nested, statusIo.streams);
  assert.equal(JSON.parse(statusIo.output()).binding.projectId, 'project-123');

  const unbindIo = io();
  await runCli(['project', 'unbind', '--yes', '--json'], {}, nested, unbindIo.streams);
  assert.equal(JSON.parse(unbindIo.output()).outcome, 'unbound');
  assert.equal(fs.existsSync(path.join(workspace, '.spala', 'project.json')), false);
});

test('project bind rejects bootstrap grants instead of accepting them through process arguments', async () => {
  const workspace = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  await assert.rejects(
    runCli([
      'project', 'bind',
      '--project-id', 'project-123',
      '--project-url', 'https://shared.spala.ai/p123/',
      '--url', 'https://shared.spala.ai/p123/mcp',
      '--client', 'codex',
      '--grant', 'must-not-be-consumed',
      '--yes',
      '--json',
    ], {}, workspace, {
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      stdin: { isTTY: false },
    }),
    error => {
      assert.match(error.message, /Unknown argument: --grant/);
      assert.doesNotMatch(error.message, /must-not-be-consumed/);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(workspace, '.spala', 'project.json')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.codex', 'config.toml')), false);
});

test('agentic project bind consumes bootstrap once and keeps all secrets outside workspace and output', async () => {
  const workspace = tempHome();
  const credentialHome = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.codex', 'config.toml'), '[projects]\ntrust_level = "trusted"\n');
  const bootstrapUrl = 'https://shared.spala.ai/p123/mcp/bootstrap/consume/one-time-id?nonce=opaque';
  const bearerToken = 'mcp_test_secret_that_must_never_leak';
  let calls = 0;
  let output = '';

  await runCli([
    'project', 'bind',
    '--project-id', 'project-123',
    '--project-url', 'https://shared.spala.ai/p123/',
    '--url', 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata',
    '--bootstrap-stdin',
    '--client', 'codex',
    '--yes',
    '--json',
  ], { SPALA_MCP_CREDENTIAL_HOME: credentialHome }, workspace, {
    stdout: { write: chunk => { output += chunk; } },
    stderr: { write: () => {} },
    stdin: Readable.from([`${bootstrapUrl}\n`]),
  }, {
    fetch: async (url, options) => {
      calls += 1;
      assert.equal(url, bootstrapUrl);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, undefined);
      return new Response(JSON.stringify({
        access_token: bearerToken,
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        mcp_url: 'https://shared.spala.ai/p123/mcp/?scope=builder%2Cproject%2Cdata',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(calls, 1);
  const payload = JSON.parse(output);
  assert.equal(payload.agenticCredentialConfigured, true);
  assert.equal(payload.plan.proxy.transport, 'stdio');
  assert.doesNotMatch(output, new RegExp(bearerToken));
  assert.doesNotMatch(output, /one-time-id|nonce=opaque/);

  const bindingBody = fs.readFileSync(path.join(workspace, '.spala', 'project.json'), 'utf8');
  const codexBody = fs.readFileSync(path.join(workspace, '.codex', 'config.toml'), 'utf8');
  assert.doesNotMatch(bindingBody, /one-time-id|nonce=opaque|mcp_test_secret/);
  assert.doesNotMatch(codexBody, /one-time-id|nonce=opaque|mcp_test_secret|shared\.spala\.ai/);
  assert.match(codexBody, /\[projects]/);
  assert.match(codexBody, /command = "pnpm"/);
  assert.match(codexBody, /"proxy","--project-id","project-123"/);

  const storePath = credentialStorePath({ SPALA_MCP_CREDENTIAL_HOME: credentialHome });
  assert.equal((fs.statSync(storePath).mode & 0o777), 0o600);
  assert.equal((fs.statSync(path.dirname(storePath)).mode & 0o777), 0o700);
  const stored = readProjectCredential('project-123', { SPALA_MCP_CREDENTIAL_HOME: credentialHome });
  assert.equal(stored.bearerToken, bearerToken);
  assert.equal(stored.mcpUrl, 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata');
});

test('agentic project bind reads a bootstrap URL from a TTY without echoing it and restores raw mode', async () => {
  const workspace = tempHome();
  const credentialHome = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  const bootstrapUrl = 'https://shared.spala.ai/p123/mcp/bootstrap/consume/tty-secret?nonce=opaque';
  const stdin = ttyInput([bootstrapUrl, '\n']);
  let stdout = '';
  let stderr = '';
  let calls = 0;

  await runCli([
    'project', 'bind',
    '--project-id', 'project-123',
    '--project-url', 'https://shared.spala.ai/p123/',
    '--url', 'https://shared.spala.ai/p123/mcp',
    '--bootstrap-stdin',
    '--client', 'codex',
    '--yes',
    '--json',
  ], { SPALA_MCP_CREDENTIAL_HOME: credentialHome }, workspace, {
    stdout: { write: chunk => { stdout += chunk; } },
    stderr: { write: chunk => { stderr += chunk; } },
    stdin,
  }, {
    fetch: async url => {
      calls += 1;
      assert.equal(url, bootstrapUrl);
      assert.equal(stdin.isRaw, false);
      return new Response(JSON.stringify({
        access_token: 'mcp_tty_secret',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        mcp_url: 'https://shared.spala.ai/p123/mcp',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(stdin.rawModes, [true, false]);
  assert.equal(stdin.isRaw, false);
  assert.equal(stdout.includes(bootstrapUrl), false);
  assert.equal(stderr.includes(bootstrapUrl), false);
  assert.doesNotMatch(`${stdout}\n${stderr}`, /tty-secret|nonce=opaque/);
});

test('Ctrl-C while reading a TTY bootstrap leaves project and credential files untouched', async () => {
  const workspace = tempHome();
  const credentialHome = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  const stdin = ttyInput(['\u0003']);
  let stdout = '';
  let stderr = '';
  let calls = 0;

  await assert.rejects(runCli([
    'project', 'bind',
    '--project-id', 'project-123',
    '--project-url', 'https://shared.spala.ai/p123/',
    '--url', 'https://shared.spala.ai/p123/mcp',
    '--bootstrap-stdin',
    '--client', 'codex',
    '--yes',
    '--json',
  ], { SPALA_MCP_CREDENTIAL_HOME: credentialHome }, workspace, {
    stdout: { write: chunk => { stdout += chunk; } },
    stderr: { write: chunk => { stderr += chunk; } },
    stdin,
  }, {
    fetch: async () => {
      calls += 1;
      throw new Error('must not run');
    },
  }), /authorization was cancelled/);

  assert.equal(calls, 0);
  assert.deepEqual(stdin.rawModes, [true, false]);
  assert.equal(stdin.isRaw, false);
  assert.equal(stdout, '');
  assert.doesNotMatch(stderr, /https?:|credential|token/i);
  assert.equal(fs.existsSync(path.join(workspace, '.spala', 'project.json')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.codex', 'config.toml')), false);
  assert.equal(fs.existsSync(credentialStorePath({ SPALA_MCP_CREDENTIAL_HOME: credentialHome })), false);
});

test('rejected bootstrap is redacted and leaves no binding, client config, or credential', async () => {
  const workspace = tempHome();
  const credentialHome = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  const bootstrapUrl = 'https://shared.spala.ai/p123/bootstrap/consume/do-not-print?nonce=secretish';
  let calls = 0;
  await assert.rejects(
    runCli([
      'project', 'bind',
      '--project-id', 'project-123',
      '--project-url', 'https://shared.spala.ai/p123/',
      '--url', 'https://shared.spala.ai/p123/mcp',
      '--bootstrap-stdin',
      '--client', 'codex',
      '--yes',
    ], { SPALA_MCP_CREDENTIAL_HOME: credentialHome }, workspace, {
      stdout: { write: () => {} }, stderr: { write: () => {} }, stdin: Readable.from([`${bootstrapUrl}\n`]),
    }, {
      fetch: async () => {
        calls += 1;
        return new Response('server-body-secret', { status: 410 });
      },
    }),
    error => {
      assert.match(error.message, /HTTP 410/);
      assert.doesNotMatch(error.message, /do-not-print|nonce|server-body-secret/);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(workspace, '.spala', 'project.json')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.codex', 'config.toml')), false);
  assert.equal(fs.existsSync(credentialStorePath({ SPALA_MCP_CREDENTIAL_HOME: credentialHome })), false);
});

test('bootstrap response must bind the exact requested MCP URL', async () => {
  const workspace = tempHome();
  const credentialHome = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));

  await assert.rejects(
    runCli([
      'project', 'bind',
      '--project-id', 'project-123',
      '--project-url', 'https://shared.spala.ai/p123/',
      '--url', 'https://shared.spala.ai/p123/mcp?scope=builder%2Cproject%2Cdata',
      '--bootstrap-stdin',
      '--client', 'codex',
      '--yes',
    ], { SPALA_MCP_CREDENTIAL_HOME: credentialHome }, workspace, {
      stdout: { write: () => {} }, stderr: { write: () => {} }, stdin: Readable.from(['https://shared.spala.ai/p123/mcp/agent-instructions/opaque/consume\n']),
    }, {
      fetch: async () => new Response(JSON.stringify({
        access_token: 'mcp_never_store_this',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        mcp_url: 'https://shared.spala.ai/p999/mcp?scope=builder%2Cproject%2Cdata',
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    }),
    /did not match the requested MCP endpoint/,
  );

  assert.equal(fs.existsSync(path.join(workspace, '.spala', 'project.json')), false);
  assert.equal(fs.existsSync(credentialStorePath({ SPALA_MCP_CREDENTIAL_HOME: credentialHome })), false);
});

test('agentic bind rejects command-only clients before reading or consuming the capability', async () => {
  const workspace = tempHome();
  const credentialHome = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  let reads = 0;
  let calls = 0;
  const stdin = Readable.from((async function* () { reads += 1; yield 'https://shared.spala.ai/p123/mcp/agent-instructions/opaque/consume\n'; })());
  await assert.rejects(runCli([
    'project', 'bind',
    '--project-id', 'project-123',
    '--project-url', 'https://shared.spala.ai/p123/',
    '--url', 'https://shared.spala.ai/p123/mcp',
    '--bootstrap-stdin',
    '--client', 'claude-code',
    '--yes',
  ], { SPALA_MCP_CREDENTIAL_HOME: credentialHome }, workspace, {
    stdout: { write: () => {} }, stderr: { write: () => {} }, stdin,
  }, { fetch: async () => { calls += 1; throw new Error('must not run'); } }), /No verified workspace-scoped target|does not support workspace/);
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('agentic bind rejects credential storage inside the workspace before consumption', async () => {
  const workspace = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  fs.mkdirSync(path.join(workspace, '.codex'));
  let calls = 0;
  await assert.rejects(runCli([
    'project', 'bind',
    '--project-id', 'project-123',
    '--project-url', 'https://shared.spala.ai/p123/',
    '--url', 'https://shared.spala.ai/p123/mcp',
    '--bootstrap-stdin',
    '--client', 'codex',
    '--yes',
  ], { SPALA_MCP_CREDENTIAL_HOME: workspace }, workspace, {
    stdout: { write: () => {} }, stderr: { write: () => {} },
    stdin: Readable.from(['https://shared.spala.ai/p123/mcp/agent-instructions/opaque/consume\n']),
  }, { fetch: async () => { calls += 1; throw new Error('must not run'); } }), /outside the project workspace/);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(workspace, '.spala', 'project.json')), false);
});

test('expired stored credentials are reported as unavailable', () => {
  const credentialHome = tempHome();
  const filePath = credentialStorePath({ SPALA_MCP_CREDENTIAL_HOME: credentialHome });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    schemaVersion: 1,
    projects: {
      'project-123': {
        mcpUrl: 'https://shared.spala.ai/p123/mcp',
        bearerToken: 'expired-secret',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        status: 'active',
      },
    },
  })}\n`, { mode: 0o600 });
  const status = projectCredentialStatus('project-123', { SPALA_MCP_CREDENTIAL_HOME: credentialHome });
  assert.equal(status.configured, false);
  assert.equal(status.status, 'expired');
  assert.match(status.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('proxy reads its user credential and forwards bearer auth without printing it', async () => {
  const credentialHome = tempHome();
  const bearerToken = 'mcp_proxy_secret';
  storeProjectCredential({
    projectId: 'project-123',
    mcpUrl: 'https://shared.spala.ai/p123/mcp',
    bearerToken,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { SPALA_MCP_CREDENTIAL_HOME: credentialHome });
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const response = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
  let output = '';
  let fetchCalls = 0;
  await runProxy({
    projectId: 'project-123',
    env: { SPALA_MCP_CREDENTIAL_HOME: credentialHome },
    stdin: Readable.from([`${JSON.stringify(request)}\n`]),
    stdout: { write: chunk => { output += chunk; } },
    fetchImpl: async (url, options) => {
      fetchCalls += 1;
      assert.equal(url, 'https://shared.spala.ai/p123/mcp');
      assert.equal(options.headers.authorization, `Bearer ${bearerToken}`);
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), request);
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(JSON.parse(output), response);
  assert.doesNotMatch(output, new RegExp(bearerToken));
});

test('agentic proxy plans are workspace-only and command hints contain no credentials or remote URL', () => {
  const workspace = tempHome();
  fs.mkdirSync(path.join(workspace, '.git'));
  const plan = createProxyInstallPlan({
    clientSelection: 'roo',
    cwd: workspace,
    projectId: 'project-123',
    serverName: 'spala-project',
  });
  assert.equal(plan.installScope, 'workspace');
  assert.equal(plan.writes[0].path, path.join(workspace, '.roo', 'mcp.json'));
  assert.deepEqual(JSON.parse(plan.writes[0].content).mcpServers['spala-project'], {
    command: 'pnpm',
    args: ['dlx', '@spala-ai/mcp-install@0.1.14', 'proxy', '--project-id', 'project-123'],
  });
  const commands = buildProxyCommandHints('spala-project', 'project-123');
  const serialized = JSON.stringify(commands);
  assert.doesNotMatch(serialized, /https?:|bearer|token|bootstrap/i);

  const unsupported = createProxyInstallPlan({
    clientSelection: 'windsurf',
    cwd: workspace,
    projectId: 'project-123',
    serverName: 'spala-project',
  });
  assert.equal(unsupported.writes.length, 0);
  assert.equal(unsupported.skipped[0].unsupportedScope, true);
});
