import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeRegistrationRoot } from '../src/claudeRegistrationRoot.js';
import { findWorkspaceRoot } from '../src/workspace.js';
import {
  inspectClaudeLocalProxyRegistration, createClaudeLocalProxyRemovalPlan,
  createClaudeLocalProxyRestorePlan, installPlan, INSTALLER_PACKAGE_SPEC,
  MANAGED_PROXY_REGISTRATION_FLAG,
} from '../src/installer.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spala-worktree-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main repo');
  const linked = path.join(root, 'linked tree');
  fs.mkdirSync(main);
  const git = (...args) => execFileSync('git', args, { cwd: main, stdio: 'pipe' });
  git('init');
  git('-c', 'user.name=Spala AI', '-c', 'user.email=info@spala.ai', 'commit', '--allow-empty', '-m', 'fixture');
  git('worktree', 'add', '-b', 'linked', linked);
  return { root, main, linked };
}

const projectId = 'worktree-project';
const serverName = 'spala_project_worktree';
const registration = {
  type: 'stdio', command: 'pnpm',
  args: ['dlx', INSTALLER_PACKAGE_SPEC, 'proxy', '--project-id', projectId, MANAGED_PROXY_REGISTRATION_FLAG],
};

test('real worktrees share Claude identity but retain separate Spala workspaces', t => {
  const { root, main, linked } = fixture(t);
  const nested = path.join(linked, 'nested');
  fs.mkdirSync(nested);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(linked, alias, 'dir');
  assert.equal(claudeRegistrationRoot(main), main);
  assert.equal(claudeRegistrationRoot(linked), main);
  assert.equal(claudeRegistrationRoot(nested), main);
  assert.equal(claudeRegistrationRoot(alias), main);
  assert.equal(findWorkspaceRoot(nested), linked);
  assert.equal(claudeRegistrationRoot(root), root);
});

test('worktree inspection, targeted cleanup and restoration use the main registry key', t => {
  const { root, main, linked } = fixture(t);
  const configPath = path.join(root, '.claude.json');
  const unrelated = { type: 'stdio', command: 'echo', args: ['untouched'] };
  const config = { projects: {
    [main]: { mcpServers: { [serverName]: registration, unrelated } },
    [linked]: { mcpServers: { [serverName]: unrelated } },
  } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const args = { cwd: linked, env: { SPALA_MCP_INSTALL_HOME: root }, projectId, serverName };
  const inspected = inspectClaudeLocalProxyRegistration(args);
  assert.equal(inspected.configured, true);
  assert.equal(inspected.workspaceRoot, linked);
  assert.equal(inspected.registrationRoot, main);
  assert.equal(createClaudeLocalProxyRemovalPlan({ ...args, projectId: 'another-project' }).writes.length, 0);
  installPlan(createClaudeLocalProxyRemovalPlan(args));
  assert.equal(inspectClaudeLocalProxyRegistration(args).status, 'missing');
  const removed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(removed.projects[main].mcpServers, { unrelated });
  assert.deepEqual(removed.projects[linked], config.projects[linked]);
  installPlan(createClaudeLocalProxyRestorePlan({ ...args, registration }));
  assert.equal(inspectClaudeLocalProxyRegistration(args).configured, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), config);
  assert.throws(() => createClaudeLocalProxyRestorePlan({ ...args, registration }), /refusing to overwrite/);
});

test('a stale worktree key cannot satisfy verification or authorize cleanup', t => {
  const { root, linked } = fixture(t);
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ projects: {
    [linked]: { mcpServers: { [serverName]: registration } },
  } }));
  const args = { cwd: linked, env: { SPALA_MCP_INSTALL_HOME: root }, projectId, serverName };
  assert.equal(inspectClaudeLocalProxyRegistration(args).configured, false);
  assert.equal(createClaudeLocalProxyRemovalPlan(args).writes.length, 0);
});
