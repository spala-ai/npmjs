import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// Claude's local registry is shared by a repository's worktrees. This is not
// the Spala workspace root: bindings and recovery state stay in each worktree.
export function claudeRegistrationRoot(workspaceRoot) {
  const env = { ...process.env };
  // Resolve the directory supplied by the caller, not an inherited Git context.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  const result = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd: workspaceRoot, env, encoding: 'utf8', timeout: 5000,
    maxBuffer: 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) return workspaceRoot;
  const first = result.stdout.split('\0')[0];
  if (!first.startsWith('worktree ')) return workspaceRoot;
  const mainRoot = first.slice('worktree '.length);
  // Match Claude's physical path identity, including macOS /var symlinks.
  return fs.realpathSync(mainRoot);
}
