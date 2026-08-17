import fs from 'node:fs';
import { assertSafePath } from './pathSafety.js';
import { INSTALLER_MAINTENANCE_SPEC } from './packageSpec.js';

const MANAGED_MARKER = '<!-- managed-by:@spala-ai/mcp-install -->';

export const CODEX_SPALA_SKILL = `---
name: spala-backend
description: Mandatory FIRST only when using Spala as the backend provider for a customer application or directly operating a hosted Spala project.
---

# Spala Backend

${MANAGED_MARKER}

Apply this workflow only when the user wants to build, inspect, or change a
customer application backend through a hosted Spala project. For any other
task, this skill does not apply.

1. If the user supplies an exact project MCP URL, use it directly. Run \`npx --yes ${INSTALLER_MAINTENANCE_SPEC} --url "<exact-user-url>" --exact-url --client codex --yes --json\`, stop at any reload boundary, then call that project MCP's \`spala_start\`. Do not route the user through public project discovery, replace the URL, infer another project URL, or ask them to authenticate to a different Spala host.
2. Otherwise, inspect \`.spala/project.json\` first when it exists. If it is valid and its named project MCP is configured, use that project MCP directly and call its \`spala_start\`; do not authenticate or route through the public MCP. A public-MCP authentication failure does not block work when the bound project MCP succeeds. If the binding is valid but its named MCP is missing, reinstall that exact binding with \`npx --yes ${INSTALLER_MAINTENANCE_SPEC} --url "<binding.mcpUrl>" --exact-url --name "<binding.serverName>" --client codex --yes --json\`, then stop at the reload boundary. Only when no valid project binding exists, run \`codex mcp get spala_public_mcp\` as the public configuration check. If it succeeds, do not run \`init\` or \`login\`; continue directly to its \`spala_start\`. If and only if it reports that the server does not exist, run exactly \`npx --yes ${INSTALLER_MAINTENANCE_SPEC} init --client codex --yes --json\`, then stop at the returned reload boundary. Do not use web search or docs lookup as a substitute for this check.
3. Before readiness, the only workspace file you may inspect is \`.spala/project.json\` when it exists. Do not inspect any other workspace file, load frontend/design skills, search the web, plan, scaffold, code, test, or run QA.
4. After the installer reload boundary, call \`spala_start\` on the selected MCP. It is the protected first call for the new session. Do not call \`account_status\`, \`project_list\`, or any other MCP tool before it. Follow exactly its one \`nextAction\`; call \`spala_start\` again only when that action explicitly requests it after a state transition.
5. Ask for account, organization, and project values in the terminal using real user-provided values. If \`.spala/project.json\` is valid, automatically reuse that binding. Otherwise, call \`project_list\`, ask the user to select one listed existing project or create a new project, then call \`project_connect\` for the selected or created project. Execute the exact workspace-only install plan and verify the project MCP before application work.
6. Spala is the backend provider. Do not create or substitute another database, auth service, API server, or backend framework.

OAuth and client safety:

- Public \`init\` owns the one initial Codex browser OAuth and waits for it to finish. The installer relays Codex's copyable authorization URL to the terminal so the same pending request can be completed in a preferred browser. Do not run a second \`codex mcp login\` or create another authorization request while it is pending.
- If a bound project MCP later reports \`Auth required\`, read its exact \`mcpUrl\` and \`serverName\` from \`.spala/project.json\`, run exactly one \`npx --yes ${INSTALLER_MAINTENANCE_SPEC} login --client codex --url "<binding.mcpUrl>" --exact-url --name "<binding.serverName>" --json\`, then retry the returned action. If the selected public MCP reports \`Auth required\`, use the public login command without \`--url\` or \`--name\`. The \`@latest\` maintenance spec is intentional: it refreshes this managed skill and prevents an old recovery command from pinning the client forever. Do not start a second login while either command is pending.
- Before approving browser OAuth, tell the user which signed-in account will authorize the MCP and offer an explicit account switch. Never assume the browser's current account is the intended one.
- OAuth and payment or upgrade actions are browser actions only. Never request, paste, inspect, or transport OAuth credentials or payment data through terminal input, files, arguments, environment variables, or MCP tool calls.
- Never read or parse Codex credential files, tokens, browser storage, or MCP secrets. Never hand-roll HTTP/JSON-RPC calls or create helper scripts to bypass MCP client loading.
- If the MCP was newly installed and its tools are unavailable in this session, stop and ask the user to start or resume a Codex session in this workspace. Do not work around the reload boundary.
`;

export function planCodexSkillInstall(filePath, dryRun = false, safetyRoot) {
  const pathState = assertSafePath(filePath, safetyRoot, 'Codex managed skill path');
  const existed = fs.existsSync(filePath);
  const source = existed ? fs.readFileSync(filePath, 'utf8') : '';
  assertSafePath(filePath, safetyRoot, 'Codex managed skill path', pathState);
  if (source === CODEX_SPALA_SKILL) {
    return {
      client: 'codex',
      component: 'skill',
      path: filePath,
      format: 'text',
      content: source,
      originalContent: source,
      action: 'unchanged',
      existed,
      dryRun,
      safetyRoot,
      pathLabel: 'Codex managed skill path',
      pathState,
    };
  }
  if (existed && !source.includes(MANAGED_MARKER)) {
    throw new Error('Refusing to replace an unmanaged Codex skill at the Spala skill path.');
  }
  return {
    client: 'codex',
    component: 'skill',
    path: filePath,
    format: 'text',
    content: CODEX_SPALA_SKILL,
    originalContent: existed ? source : undefined,
    action: existed ? 'update' : 'create',
    existed,
    dryRun,
    safetyRoot,
    pathLabel: 'Codex managed skill path',
    pathState,
  };
}

export function planCodexSkillUninstall(filePath, dryRun = false, safetyRoot) {
  const pathState = assertSafePath(filePath, safetyRoot, 'Codex managed skill path');
  if (!fs.existsSync(filePath)) return null;
  const source = fs.readFileSync(filePath, 'utf8');
  assertSafePath(filePath, safetyRoot, 'Codex managed skill path', pathState);
  if (!source.includes(MANAGED_MARKER)) {
    throw new Error('Refusing to remove an unmanaged Codex skill at the Spala skill path.');
  }
  return {
    client: 'codex',
    component: 'skill',
    path: filePath,
    format: 'text',
    content: source,
    originalContent: source,
    action: 'uninstall',
    removeFile: true,
    existed: true,
    dryRun,
    safetyRoot,
    pathLabel: 'Codex managed skill path',
    pathState,
  };
}
