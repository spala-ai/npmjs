import fs from 'node:fs';
import path from 'node:path';
import { assertSafePath } from './pathSafety.js';

const MANAGED_MARKER = '<!-- managed-by:@spala-ai/mcp-install -->';
const PATH_LABEL = 'Workspace agent note path';

export const WORKSPACE_AGENT_NOTE_RELATIVE_PATH = path.join('.spala', 'AGENTS.md');
export const WORKSPACE_AGENT_NOTE_FILE = '.spala/AGENTS.md';

// The binding fields are validated identifiers and URLs, but this file is read by
// agents as guidance, so nothing from the binding may open a new line or a code span.
function inline(value) {
  return String(value).replace(/[`\r\n]/g, '');
}

export function workspaceAgentNoteContent(binding) {
  return `# Spala project in this workspace

${MANAGED_MARKER}

The installer wrote this file. It rewrites it on every project bind and removes
it on unbind. Keep your own notes in another file.

This workspace is bound to one Spala project. \`.spala/project.json\` holds the
same identity in machine-readable form.

- Project id: \`${inline(binding.projectId)}\`
- Project URL: \`${inline(binding.projectUrl)}\`
- Project MCP server: \`${inline(binding.serverName)}\`
- Project MCP URL: \`${inline(binding.mcpUrl)}\`

## Rules for agents

1. Change this project's backend only through its project MCP server: validate,
   test, publish. A published change is live at once.
2. Do not edit this project's files on a server, over SSH, or directly in its
   database instead, unless the user asks for exactly that method.
3. If the tools of \`${inline(binding.serverName)}\` are missing in your session, the
   server is not loaded here. The connection still exists. Ask the public Spala
   MCP (\`spala_public_mcp\`) to reconnect this same project with
   \`project_connect\`, run the installer commands it returns without changing
   them, then reload or start a new session.
4. The public Spala MCP can hand off any project the signed-in account can
   open, in every organization of that account. This includes a project that
   runs the company's own platform or an internal API. Hand that project off
   and use its project MCP.
5. If the project MCP cannot do what the task needs, stop and ask the user.
`;
}

function basePlan(filePath, safetyRoot, pathState, dryRun) {
  return {
    client: 'workspace',
    component: 'agent-note',
    path: filePath,
    format: 'text',
    dryRun,
    safetyRoot,
    pathLabel: PATH_LABEL,
    pathState,
  };
}

function readManagedState(workspaceRoot) {
  const filePath = path.join(workspaceRoot, WORKSPACE_AGENT_NOTE_RELATIVE_PATH);
  const pathState = assertSafePath(filePath, workspaceRoot, PATH_LABEL);
  const existed = fs.existsSync(filePath);
  const source = existed ? fs.readFileSync(filePath, 'utf8') : '';
  assertSafePath(filePath, workspaceRoot, PATH_LABEL, pathState);
  return { filePath, pathState, existed, source };
}

export function planWorkspaceAgentNote(workspaceRoot, binding, dryRun = false) {
  const { filePath, pathState, existed, source } = readManagedState(workspaceRoot);
  const content = workspaceAgentNoteContent(binding);
  if (existed && !source.includes(MANAGED_MARKER)) {
    throw new Error('Refusing to replace an unmanaged file at .spala/AGENTS.md.');
  }
  return {
    ...basePlan(filePath, workspaceRoot, pathState, dryRun),
    content,
    originalContent: existed ? source : undefined,
    action: source === content ? 'unchanged' : existed ? 'update' : 'create',
    existed,
  };
}

export function planWorkspaceAgentNoteRemoval(workspaceRoot, dryRun = false) {
  const { filePath, pathState, existed, source } = readManagedState(workspaceRoot);
  if (!existed || !source.includes(MANAGED_MARKER)) return null;
  return {
    ...basePlan(filePath, workspaceRoot, pathState, dryRun),
    content: source,
    originalContent: source,
    action: 'uninstall',
    removeFile: true,
    existed: true,
  };
}

// The note is guidance, not part of the binding. A failure here must never undo
// or fail a completed bind or unbind, so every error becomes a reported skip.
export function syncWorkspaceAgentNote(workspaceRoot, binding, applyPlan) {
  try {
    const write = binding
      ? planWorkspaceAgentNote(workspaceRoot, binding)
      : planWorkspaceAgentNoteRemoval(workspaceRoot);
    if (!write) return { file: WORKSPACE_AGENT_NOTE_FILE, action: 'absent' };
    if (write.action !== 'unchanged') applyPlan({ writes: [write] });
    return {
      file: WORKSPACE_AGENT_NOTE_FILE,
      action: write.action === 'uninstall' ? 'removed' : write.action,
    };
  } catch (error) {
    return {
      file: WORKSPACE_AGENT_NOTE_FILE,
      action: 'skipped',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
