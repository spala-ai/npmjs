import readline from 'node:readline/promises';
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import {
  CLIENT_LABELS,
  COMMAND_ONLY_CLIENTS,
  DEFAULT_PROJECT_SCOPE,
  INSTALLER_MAINTENANCE_SPEC,
  INSTALLER_PACKAGE_SPEC,
  INSTALL_SCOPES,
  MANAGED_PROXY_REGISTRATION_FLAG,
  PUBLIC_MCP_URL,
  PUBLIC_SERVER_NAME,
  WRITABLE_CLIENTS,
  buildCommandHints,
  buildProxyCommandHints,
  clientInstallCapabilities,
  codexRemoteRegistrationTarget,
  createDoctorReport,
  createClaudeLocalProxyRemovalPlan,
  createClaudeLocalProxyRestorePlan,
  createInstallPlan,
  createProxyInstallPlan,
  createUninstallPlan,
  formatClientList,
  installPlan,
  inspectClaudeLocalProxyRegistration,
  mcpEndpointsMatch,
  mcpUrlsMatch,
  rollbackInstallPlan,
  normalizeMcpUrl,
  serverNameFromUrl,
} from './installer.js';
import { assertExactCodexRemoteRegistration } from './codexToml.js';
import {
  consumeBootstrap,
  parseProjectScopeSet,
  projectScopeSetsEqual,
  readBootstrapCapability,
} from './bootstrap.js';
import {
  hasProjectCredential,
  createProjectClaimRequest,
  preflightCredentialStore,
  readProjectClaimRequest,
  removeProjectCredential,
  removeProjectClaimRequest,
  rollbackProjectCredentialIfRevision,
  storeProjectCredential,
  storeProjectCredentialAndRetire,
} from './credentialStore.js';
import { runProxy } from './proxy.js';
import {
  PROJECT_BINDING_SCHEMA_VERSION,
  assertProjectBindingRevision,
  closeProjectBindingDirectory,
  openProjectBindingDirectory,
  planProjectBinding,
  readProjectBinding,
  removeProjectBindingIfRevision,
  replaceProjectBindingIfRevision,
  rollbackProjectBinding,
  writeProjectBinding,
} from './workspace.js';

const execFile = promisify(execFileCallback);
const COMMAND_TIMEOUT_MS = 3000;
const CLIENT_CONFIG_COMMAND_TIMEOUT_MS = 30_000;
const AUTH_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;
// Fail closed after a crashed owner. Automatic stale deletion cannot be made
// compare-and-delete atomic with portable Node filesystem APIs; reclaiming a
// canonical lock can therefore delete a newer owner's replacement.
const PROJECT_LIFECYCLE_LOCK_STALE_MS = Number.MAX_SAFE_INTEGER;
const PROJECT_LIFECYCLE_LOCK_UPDATE_MS = 5 * 60 * 1000;
const CODEX_URL_FIELDS = new Set(['url', 'serverurl', 'httpurl', 'mcpurl', 'endpoint']);
const DEFAULT_PROJECT_SCOPE_SET = new Set(DEFAULT_PROJECT_SCOPE.split(','));
const PROJECT_LIFECYCLE_LOCK = Symbol('projectLifecycleLock');
const localProjectLifecycleLocks = new Map();
export const SPALA_BACKEND_INTENT = {
  backendProvider: 'Once the user asks to use Spala, treat Spala as the workspace backend provider. Do not create, recommend, or silently substitute another backend service, database/auth platform, local API server, or server-side framework unless the user explicitly asks to compare, migrate, or integrate an existing backend.',
  setupOnly: 'An install, connect, configure, or setup request authorizes setup only: authenticate, complete required account data, create or select the intended project, bind its project MCP, verify the connection, then stop and report that Spala is ready. Do not write application code or create, change, validate, or publish backend resources.',
  buildRequest: 'Continue into implementation only when the user separately asks to build or change the application. Even then, complete account setup and verify the project MCP before writing application code. Frontend code may live in the user workspace, but database, authentication, APIs, server-side logic, and other backend resources must be built through the Spala project MCP rather than as a competing local backend.',
};

async function acquireLocalProjectLifecycleLock(workspaceRoot) {
  const key = path.resolve(workspaceRoot);
  const previous = localProjectLifecycleLocks.get(key) || Promise.resolve();
  let releaseTicket;
  const ticket = new Promise(resolve => { releaseTicket = resolve; });
  const tail = previous.then(() => ticket);
  localProjectLifecycleLocks.set(key, tail);
  await previous;
  return () => {
    releaseTicket();
    if (localProjectLifecycleLocks.get(key) === tail) localProjectLifecycleLocks.delete(key);
  };
}

export async function acquireProjectLifecycleLock(workspaceRoot, { retries = 100 } = {}) {
  const root = path.resolve(workspaceRoot);
  const releaseLocal = await acquireLocalProjectLifecycleLock(root);
  const directory = path.join(root, '.spala');
  const target = path.join(directory, 'project-lifecycle');
  const lockPath = path.join(directory, '.project-lifecycle.lock');
  let releaseFile;
  let ownedLockIdentity;
  let compromisedError;
  const guardedFs = Object.create(fs);
  guardedFs.mkdir = (candidate, ...args) => {
    const callback = args.pop();
    fs.mkdir(candidate, ...args, error => {
      if (error || path.resolve(String(candidate)) !== path.resolve(lockPath)) {
        callback(error);
        return;
      }
      fs.lstat(candidate, (statError, created) => {
        if (statError) {
          fs.rmdir(candidate, () => callback(statError));
          return;
        }
        ownedLockIdentity = {
          dev: created.dev,
          ino: created.ino,
          uid: created.uid,
          gid: created.gid,
        };
        callback(null);
      });
    });
  };
  guardedFs.rmdir = (candidate, callback) => {
    if (!ownedLockIdentity || path.resolve(String(candidate)) !== path.resolve(lockPath)) {
      fs.rmdir(candidate, callback);
      return;
    }
    fs.lstat(candidate, (error, current) => {
      if (error) {
        callback(error);
        return;
      }
      if (
        current.dev !== ownedLockIdentity.dev
        || current.ino !== ownedLockIdentity.ino
        || current.uid !== ownedLockIdentity.uid
        || current.gid !== ownedLockIdentity.gid
      ) {
        callback(Object.assign(
          new Error('Project lifecycle lock ownership changed before release.'),
          { code: 'ECOMPROMISED' },
        ));
        return;
      }
      fs.rmdir(candidate, callback);
    });
  };
  try {
    const before = fs.lstatSync(directory, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error('.spala must be a real directory before changing the project lifecycle.');
    }
    releaseFile = await lockfile.lock(target, {
      lockfilePath: lockPath,
      realpath: false,
      retries: { retries, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
      stale: PROJECT_LIFECYCLE_LOCK_STALE_MS,
      update: PROJECT_LIFECYCLE_LOCK_UPDATE_MS,
      fs: guardedFs,
      onCompromised: error => { compromisedError = error; },
    });
    const after = fs.lstatSync(directory, { bigint: true });
    if (
      after.isSymbolicLink()
      || !after.isDirectory()
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) {
      throw new Error('.spala changed while acquiring the project lifecycle lock.');
    }
    const lockStat = fs.lstatSync(lockPath);
    if (!lockStat.isDirectory()) throw new Error('Project lifecycle lock must be a directory.');
    if (typeof process.getuid === 'function' && lockStat.uid !== process.getuid()) {
      throw new Error('Project lifecycle lock is owned by another user.');
    }
    if (
      !ownedLockIdentity
      || lockStat.dev !== ownedLockIdentity.dev
      || lockStat.ino !== ownedLockIdentity.ino
      || lockStat.uid !== ownedLockIdentity.uid
      || lockStat.gid !== ownedLockIdentity.gid
    ) {
      throw new Error('Project lifecycle lock changed while it was acquired.');
    }
    if (process.platform !== 'win32') fs.chmodSync(lockPath, 0o700);
    return {
      [PROJECT_LIFECYCLE_LOCK]: true,
      workspaceRoot: root,
      async release() {
        try {
          try {
            await releaseFile();
          } catch (error) {
            throw compromisedError || error;
          }
          if (compromisedError) throw compromisedError;
        } finally {
          releaseLocal();
        }
      },
    };
  } catch (error) {
    if (releaseFile) await releaseFile().catch(() => undefined);
    releaseLocal();
    throw error;
  }
}

function assertProjectLifecycleLock(lock, workspaceRoot) {
  if (!lock?.[PROJECT_LIFECYCLE_LOCK] || lock.workspaceRoot !== path.resolve(workspaceRoot)) {
    throw new Error('Claude project registration mutation requires the workspace lifecycle lock.');
  }
}

function parseArgs(argv) {
  const args = {
    command: undefined,
    client: 'all',
    check: false,
    cleanupDuplicates: false,
    doctor: false,
    dryRun: false,
    exactUrl: false,
    installScope: undefined,
    json: false,
    manifest: undefined,
    managedProxyRegistration: false,
    printOnly: false,
    public: false,
    uninstall: false,
    yes: false,
    scope: DEFAULT_PROJECT_SCOPE,
    scopeProvided: false,
    projectId: undefined,
    projectUrl: undefined,
    bootstrapUrl: undefined,
    bootstrapClaim: undefined,
    bootstrapRequestId: undefined,
    bootstrapStdin: false,
    bootstrapFd: undefined,
    switchProject: false,
    name: undefined,
    url: undefined,
    urlProvided: false,
    help: false,
    listClients: false,
  };
  const requireValue = (flag, value) => {
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new Error(`${flag} requires a value.`);
    }
    return value;
  };

  let startIndex = 0;
  if (argv[0] === 'project') {
    const subcommand = argv[1];
    if (!['prepare', 'bind', 'status', 'unbind', 'disconnect'].includes(subcommand)) {
      throw new Error('Unknown project command. Use project prepare, project bind, project status, or project unbind.');
    }
    args.command = subcommand === 'disconnect' ? 'project-unbind' : `project-${subcommand}`;
    startIndex = 2;
  } else if (argv[0] === 'init') {
    args.command = 'init';
    startIndex = 1;
  } else if (argv[0] === 'status') {
    args.command = 'status';
    args.check = true;
    startIndex = 1;
  } else if (argv[0] === 'login') {
    args.command = 'login';
    startIndex = 1;
  } else if (argv[0] === 'proxy') {
    args.command = 'proxy';
    startIndex = 1;
  } else if (argv[0] && !argv[0].startsWith('-')) {
    throw new Error(`Unknown command: ${argv[0]}. Use init, status, login, or --help.`);
  }

  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--list-clients') args.listClients = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--cleanup-duplicates') args.cleanupDuplicates = true;
    else if (arg === '--commands') args.printOnly = true;
    else if (arg === '--doctor') args.doctor = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--exact-url') args.exactUrl = true;
    else if (arg === '--bootstrap-stdin') args.bootstrapStdin = true;
    else if (arg === '--switch') args.switchProject = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--print-only') args.printOnly = true;
    else if (arg === '--public') args.public = true;
    else if (arg === '--uninstall') args.uninstall = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--manifest') args.manifest = requireValue('--manifest', argv[++index]);
    else if (arg === MANAGED_PROXY_REGISTRATION_FLAG) args.managedProxyRegistration = true;
    else if (arg === '--url') {
      args.urlProvided = true;
      args.url = requireValue('--url', argv[++index]);
    }
    else if (arg === '--scope') {
      args.scopeProvided = true;
      args.scope = requireValue('--scope', argv[++index]);
    }
    else if (arg === '--tool-scope') {
      args.scopeProvided = true;
      args.scope = requireValue('--tool-scope', argv[++index]);
    }
    else if (arg === '--install-scope') args.installScope = requireValue('--install-scope', argv[++index]);
    else if (arg === '--project-id') args.projectId = requireValue('--project-id', argv[++index]);
    else if (arg === '--project-url') args.projectUrl = requireValue('--project-url', argv[++index]);
    else if (arg === '--bootstrap-url') args.bootstrapUrl = requireValue('--bootstrap-url', argv[++index]);
    else if (arg === '--bootstrap-claim') args.bootstrapClaim = requireValue('--bootstrap-claim', argv[++index]);
    else if (arg === '--bootstrap-request-id') args.bootstrapRequestId = requireValue('--bootstrap-request-id', argv[++index]);
    else if (arg === '--bootstrap-fd') args.bootstrapFd = Number(requireValue('--bootstrap-fd', argv[++index]));
    else if (arg === '--client') args.client = requireValue('--client', argv[++index]);
    else if (arg === '--name') args.name = requireValue('--name', argv[++index]);
    else if (arg.startsWith('--url=')) {
      args.urlProvided = true;
      args.url = requireValue('--url', arg.slice('--url='.length));
    }
    else if (arg.startsWith('--manifest=')) args.manifest = requireValue('--manifest', arg.slice('--manifest='.length));
    else if (arg.startsWith('--scope=')) {
      args.scopeProvided = true;
      args.scope = requireValue('--scope', arg.slice('--scope='.length));
    }
    else if (arg.startsWith('--tool-scope=')) {
      args.scopeProvided = true;
      args.scope = requireValue('--tool-scope', arg.slice('--tool-scope='.length));
    }
    else if (arg.startsWith('--install-scope=')) args.installScope = requireValue('--install-scope', arg.slice('--install-scope='.length));
    else if (arg.startsWith('--project-id=')) args.projectId = requireValue('--project-id', arg.slice('--project-id='.length));
    else if (arg.startsWith('--project-url=')) args.projectUrl = requireValue('--project-url', arg.slice('--project-url='.length));
    else if (arg.startsWith('--bootstrap-url=')) args.bootstrapUrl = requireValue('--bootstrap-url', arg.slice('--bootstrap-url='.length));
    else if (arg.startsWith('--bootstrap-fd=')) args.bootstrapFd = Number(requireValue('--bootstrap-fd', arg.slice('--bootstrap-fd='.length)));
    else if (arg.startsWith('--client=')) args.client = requireValue('--client', arg.slice('--client='.length));
    else if (arg.startsWith('--name=')) args.name = requireValue('--name', arg.slice('--name='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.command === 'init') {
    if (args.urlProvided || args.manifest || args.check || args.doctor || args.printOnly || args.uninstall) {
      throw new Error('spala-ai init installs the public MCP only. Use the existing flags directly for project MCPs and other actions.');
    }
    args.public = true;
  }
  if (args.command === 'status') {
    if (args.urlProvided || args.manifest || args.doctor || args.printOnly || args.uninstall) {
      throw new Error('spala-ai status checks the public MCP only. Use the existing flags directly for project MCPs and other actions.');
    }
    args.public = true;
  }
  if (args.command === 'login') {
    if (args.manifest || args.check || args.doctor || args.printOnly || args.uninstall) {
      throw new Error('spala-ai login accepts either the public MCP or an exact project MCP URL and server name.');
    }
    if (args.urlProvided) {
      args.exactUrl = true;
    } else {
      args.public = true;
    }
  }
  if (args.installScope && !INSTALL_SCOPES.includes(args.installScope)) {
    throw new Error(`--install-scope must be one of: ${INSTALL_SCOPES.join(', ')}.`);
  }
  if (args.command === 'project-prepare' || args.command === 'project-bind') {
    if (!args.urlProvided || !args.projectId || !args.projectUrl) {
      throw new Error(`${args.command.replace('-', ' ')} requires --project-id, --project-url, and --url.`);
    }
    args.exactUrl = true;
    args.installScope = args.installScope || 'workspace';
    if (args.installScope !== 'workspace') throw new Error('Project bindings must use --install-scope workspace.');
    if (args.bootstrapUrl) throw new Error('--bootstrap-url is not accepted because command arguments may be inspected. Use --bootstrap-stdin.');
  }
  if (args.command === 'project-prepare') {
    if (args.bootstrapStdin || args.bootstrapFd !== undefined || args.bootstrapClaim || args.bootstrapRequestId) {
      throw new Error('project prepare creates a new verifier and does not accept bootstrap input.');
    }
    if (!args.yes) throw new Error('project prepare requires --yes.');
  }
  if (args.command === 'project-bind') {
    if (args.bootstrapFd !== undefined && (!Number.isInteger(args.bootstrapFd) || args.bootstrapFd < 0)) throw new Error('--bootstrap-fd must be a non-negative integer.');
    if (args.bootstrapStdin && args.bootstrapFd !== undefined) throw new Error('Use only one of --bootstrap-stdin or --bootstrap-fd.');
    const protectedClaim = Boolean(args.bootstrapClaim || args.bootstrapRequestId);
    if (Boolean(args.bootstrapClaim) !== Boolean(args.bootstrapRequestId)) throw new Error('Use --bootstrap-claim and --bootstrap-request-id together.');
    if (protectedClaim && (args.bootstrapStdin || args.bootstrapFd !== undefined)) throw new Error('Use either a verifier-bound claim or stdin bootstrap, not both.');
    if ((args.bootstrapStdin || args.bootstrapFd !== undefined || protectedClaim) && !args.yes) throw new Error('Bootstrap capability input requires --yes so it is never mixed with an interactive prompt.');
  }
  if (args.command === 'proxy') {
    if (!args.projectId) throw new Error('proxy requires --project-id.');
    const unsupported = args.client !== 'all' || args.bootstrapUrl || args.bootstrapClaim || args.bootstrapRequestId || args.bootstrapStdin || args.bootstrapFd !== undefined || args.check || args.cleanupDuplicates || args.doctor || args.dryRun || args.exactUrl || args.installScope || args.json || args.manifest || args.name || args.printOnly || args.projectUrl || args.public || args.scopeProvided || args.switchProject || args.uninstall || args.urlProvided || args.yes;
    if (unsupported) throw new Error('proxy only accepts --project-id.');
  }
  if (args.managedProxyRegistration && args.command !== 'proxy') {
    throw new Error(`${MANAGED_PROXY_REGISTRATION_FLAG} is reserved for installer-managed proxy registrations.`);
  }
  if (args.command === 'project-status' || args.command === 'project-unbind') {
    if (args.urlProvided || args.manifest || args.projectId || args.projectUrl || args.bootstrapUrl || args.bootstrapClaim || args.bootstrapRequestId || args.bootstrapStdin || args.bootstrapFd !== undefined || args.public || args.scopeProvided || args.installScope) {
      throw new Error(`${args.command.replace('-', ' ')} reads the existing workspace binding and does not accept project identity flags.`);
    }
  }
  if (args.exactUrl && !args.urlProvided) {
    throw new Error('--exact-url requires --url.');
  }
  if (args.exactUrl && args.scopeProvided) {
    throw new Error('--exact-url cannot be combined with --scope.');
  }

  return args;
}

function usage() {
  return `Usage:
  spala-ai init --public --yes
  spala-ai status --json
  spala-ai login --client codex --json
  spala-ai login --client codex --url <exact-mcp-url> --name <server-name> --json
  spala-ai init --client codex --json
  spala-ai project bind --project-id <id> --project-url <url> --url <exact-mcp-url> --client <client> --yes
  spala-ai project prepare --project-id <id> --project-url <url> --url <exact-mcp-url> --client claude-code --yes --json
  spala-ai project bind --project-id <id> --project-url <url> --url <exact-mcp-url> --bootstrap-stdin --client <client> --yes
  spala-ai project status --json
  spala-ai project unbind --yes
  pnpm dlx @spala-ai/mcp-install --public --yes
  pnpm dlx @spala-ai/mcp-install project bind --project-id <id> --project-url <url> --url <exact-mcp-url> --yes
  pnpm dlx @spala-ai/mcp-install --doctor

Public MCP:
  Installs ${PUBLIC_MCP_URL} as ${PUBLIC_SERVER_NAME}.
  Use it for Spala discovery, docs, OAuth, and handoff into project-specific MCP servers.

Project MCP:
  Installs the exact project MCP URL shown by Spala for authenticated project
  build, validate, and publish workflows. Project MCP URLs may be dedicated
  hosts such as https://PROJECT.spala.ai/mcp or shared-runtime paths such as
  https://shared.spala.ai/PROJECT_SLUG/mcp.

Options:
  --check            Verify Node, config state, and MCP endpoint reachability.
  --doctor           Inspect local MCP configs and report missing or duplicate Spala entries.
  --uninstall        Remove the selected Spala MCP server entry from writable clients.
  --cleanup-duplicates
                     Remove only recognized known legacy public aliases whose URL
                     is exactly ${PUBLIC_MCP_URL}. Other entries are left untouched.
  --manifest <path>  Read MCP URL/name from a local install manifest file.
  --public           Install the public Spala MCP. Cannot be combined with --url.
  --url <url>        Project Spala MCP URL. Defaults to public MCP when omitted.
  --tool-scope <scope>
                     MCP tool permission scope to add when --url has no scope. Default: ${DEFAULT_PROJECT_SCOPE}
  --scope <scope>    Backward-compatible alias for --tool-scope.
  --install-scope <user|workspace>
                     Client configuration location. Public defaults to user; project defaults to workspace.
  --exact-url        Preserve the validated --url exactly and never add a default scope.
  --client <name>    Client to configure, comma list, or all. Default: all detected clients.
  --name <name>      MCP server name. Default: ${PUBLIC_SERVER_NAME} for public, spala-<host> for project.
  --project-id <id>  Project identity stored in .spala/project.json by project bind.
  --project-url <url>
                     Credential-free project URL stored by project bind.
  --bootstrap-stdin  Read one one-time bootstrap URL from stdin so it never appears in process arguments.
  --bootstrap-claim <url>
                     Redeem a verifier-bound one-time claim returned by project_connect.
  --bootstrap-request-id <id>
                     Match the claim to a local verifier prepared by project prepare.
  --switch           Explicitly replace a different existing workspace binding.
  --dry-run          Print planned changes without writing files.
  --json             Print machine-readable JSON.
  --commands, --print-only
                     Print command-line setup alternatives only; do not inspect or write configs.
  --yes, -y          Apply without an interactive confirmation prompt.
  --list-clients     Print supported clients.
  --help, -h         Show this help.

${formatClientList()}
`;
}

const CLIENT_RELOAD_GUIDANCE = {
  antigravity: 'Restart Antigravity to load the updated MCP configuration.',
  'antigravity-cli': 'Start a new Antigravity CLI session to load the updated MCP configuration.',
  gemini: 'Start a new Gemini CLI session to load the updated MCP configuration.',
  windsurf: 'Reload the Windsurf window to load the updated MCP configuration.',
  cline: 'Reload the VS Code window running Cline to load the updated MCP configuration.',
  roo: 'Reload the VS Code window running Roo Code to load the updated MCP configuration.',
  'claude-desktop': 'Quit and reopen Claude Desktop to load the updated MCP configuration.',
  zed: 'Reload Zed to load the updated MCP configuration.',
  codex: 'Start a new or resumed Codex session in this workspace to load the updated MCP configuration. Do not continue with app inspection, design, scaffolding, coding, testing, or QA in the pre-reload session.',
  'claude-code': 'Start a new Claude Code session in this workspace to load the updated MCP configuration.',
  cursor: 'Reload Cursor (or toggle the MCP server in Cursor settings) to load the updated MCP configuration.',
};

function commandName(args) {
  if (args.command === 'status') return 'status';
  if (args.command === 'login') return 'login';
  if (args.doctor) return 'doctor';
  if (args.check) return 'check';
  if (args.printOnly) return 'commands';
  if (args.uninstall) return 'uninstall';
  return 'init';
}

function commandPayload(serverName, mcpUrl, installScope = 'user') {
  const hints = buildCommandHints(serverName, mcpUrl, installScope);
  return {
    argv: hints.argv,
    codexAdd: hints.codexAdd,
    codexLogin: hints.codexLogin,
    claudeCode: hints.claudeCode,
    geminiCli: hints.geminiCli,
  };
}

function shellArg(value) {
  const text = String(value);
  return /^[a-z0-9,_-]+$/i.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function publicInitStep(clientSelection = 'all') {
  const client = clientSelection || 'all';
  return {
    action: 'install',
    command: `spala-ai init --client ${shellArg(client)} --yes --json`,
    argv: ['spala-ai', 'init', '--client', client, '--yes', '--json'],
  };
}

function publicReadinessStep() {
  return {
    action: 'call_tool',
    server: PUBLIC_SERVER_NAME,
    tool: 'spala_start',
    instruction: 'After the client reload, call spala_start as the protected first MCP call. This is setup-only until spala_start reaches project readiness and the project MCP is verified. Before readiness, inspect only .spala/project.json if it exists; do not web-search, inspect app files, load frontend/design skills, plan, scaffold, code, test, or QA. Do not call account_status, project_list, or any other MCP tool before spala_start. Follow exactly the one nextAction returned by spala_start, and call spala_start again only when that action explicitly requests it after a state transition. Ask account, organization, and project values in the terminal. OAuth and payment or upgrade actions are browser actions only.',
  };
}

function nextSteps(plan, clientSelection = 'all', includeReload = true, { publicReadiness = false } = {}) {
  const commands = commandPayload(plan.serverName, plan.mcpUrl, plan.installScope);
  const steps = [];
  const reloadClients = new Set();
  for (const write of plan.writes || []) {
    if (write.component === 'skill') continue;
    const instruction = write.client === 'codex' && plan.installScope === 'workspace'
      ? 'Start a new or resumed Codex session from this workspace to load .codex/config.toml.'
      : CLIENT_RELOAD_GUIDANCE[write.client];
    if (includeReload && instruction && !reloadClients.has(write.client)) {
      steps.push({ action: 'restart_required', client: write.client, dynamicReload: false, instruction });
      reloadClients.add(write.client);
    }
  }

  if (includeReload && (plan.writes || []).some(write => write.client === 'codex' && write.component === 'skill') && !reloadClients.has('codex')) {
    steps.push({ action: 'restart_required', client: 'codex', dynamicReload: false, instruction: CLIENT_RELOAD_GUIDANCE.codex });
    reloadClients.add('codex');
  }

  const commandClients = new Set((plan.skipped || []).filter(item => item.commandRequired).map(item => item.client));
  if (commandClients.has('codex')) {
    steps.push({ action: 'configure_client', client: 'codex', command: commands.codexAdd, argv: commands.argv.codexAdd });
    steps.push({ action: 'authenticate_client', client: 'codex', command: commands.codexLogin, argv: commands.argv.codexLogin });
    if (includeReload) steps.push({ action: 'restart_required', client: 'codex', dynamicReload: false, instruction: CLIENT_RELOAD_GUIDANCE.codex });
  }
  if (commandClients.has('claude-code')) {
    steps.push({ action: 'configure_client', client: 'claude-code', command: commands.claudeCode, argv: commands.argv.claudeCode });
    if (includeReload) steps.push({ action: 'restart_required', client: 'claude-code', dynamicReload: false, instruction: CLIENT_RELOAD_GUIDANCE['claude-code'] });
  }
  if (commandClients.has('gemini')) {
    steps.push({ action: 'configure_client', client: 'gemini', command: commands.geminiCli, argv: commands.argv.geminiCli });
    if (includeReload) steps.push({ action: 'restart_required', client: 'gemini', dynamicReload: false, instruction: CLIENT_RELOAD_GUIDANCE.gemini });
  }
  if (publicReadiness && includeReload && plan.mcpUrl === PUBLIC_MCP_URL && ((plan.writes || []).length > 0 || commandClients.size > 0)) {
    steps.push(publicReadinessStep());
  } else if ((plan.writes || []).length > 0) {
    const isPublic = plan.mcpUrl === PUBLIC_MCP_URL;
    steps.push(isPublic ? {
      action: 'verify',
      command: `spala-ai status --client ${shellArg(clientSelection || 'all')} --json`,
      argv: ['spala-ai', 'status', '--client', clientSelection || 'all', '--json'],
    } : {
      action: 'verify',
      command: `spala-ai --check --client ${shellArg(clientSelection || 'all')} --url ${shellArg(plan.mcpUrl)} --exact-url --json`,
      argv: ['spala-ai', '--check', '--client', clientSelection || 'all', '--url', plan.mcpUrl, '--exact-url', '--json'],
    });
  }
  return steps;
}

function nextProxySteps(plan) {
  const steps = [];
  for (const write of plan.writes || []) {
    const instruction = CLIENT_RELOAD_GUIDANCE[write.client];
    if (instruction) steps.push({ action: 'restart_required', client: write.client, dynamicReload: false, instruction });
  }
  const commands = buildProxyCommandHints(plan.serverName, plan.proxy.projectId);
  const commandClients = new Set((plan.skipped || []).filter(item => item.commandRequired).map(item => item.client));
  if (commandClients.has('claude-code')) {
    steps.push({ action: 'configure_client', client: 'claude-code', command: commands.claudeCode, argv: commands.argv.claudeCode });
    steps.push({ action: 'restart_required', client: 'claude-code', dynamicReload: false, instruction: CLIENT_RELOAD_GUIDANCE['claude-code'] });
  }
  if (commandClients.has('gemini')) {
    steps.push({ action: 'configure_client', client: 'gemini', command: commands.geminiCli, argv: commands.argv.geminiCli });
    steps.push({ action: 'restart_required', client: 'gemini', dynamicReload: false, instruction: CLIENT_RELOAD_GUIDANCE.gemini });
  }
  steps.push({ action: 'verify', instruction: 'Start or resume the selected client in this workspace and list the project MCP tools.' });
  return steps;
}

function sameClaudeRegistration(left, right) {
  return Boolean(left && right)
    && left.command === right.command
    && Array.isArray(left.args)
    && Array.isArray(right.args)
    && left.args.length === right.args.length
    && left.args.every((value, index) => value === right.args[index]);
}

async function reconcileClaudeProjectRegistration({ cwd, env, projectId, serverName, runCommand, lifecycleLock }) {
  assertProjectLifecycleLock(lifecycleLock, cwd);
  const before = inspectClaudeLocalProxyRegistration({ cwd, env, projectId, serverName });
  if (before.configured) return { changed: false, status: before };
  if (before.status !== 'missing' && !before.installerOwned) {
    throw new Error(`Claude Code already has a non-installer-owned ${serverName} registration in this workspace; refusing to replace it.`);
  }
  let previousRemoval;
  if (before.status !== 'missing') {
    previousRemoval = await removeInstallerOwnedClaudeProjectRegistration({
      cwd,
      env,
      projectId: before.registeredProjectId,
      serverName,
      lifecycleLock,
    });
  }
  const command = buildProxyCommandHints(serverName, projectId).argv.claudeCode;
  try {
    await runCommand({
      command: command[0],
      args: command.slice(1),
      cwd: before.workspaceRoot,
      timeoutMs: CLIENT_CONFIG_COMMAND_TIMEOUT_MS,
      maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
    });
    const after = inspectClaudeLocalProxyRegistration({ cwd, env, projectId, serverName });
    if (!after.configured) throw new Error('Claude Code did not persist the expected private project MCP registration.');
    return {
      changed: true,
      status: after,
      previousRegistration: before.installerRegistration || null,
      previousProjectId: before.registeredProjectId,
      previousRemoval: previousRemoval?.removal || null,
    };
  } catch (error) {
    const failures = [];
    try {
      const current = inspectClaudeLocalProxyRegistration({ cwd, env, projectId, serverName });
      if (current.installerOwned) {
        await removeInstallerOwnedClaudeProjectRegistration({
          cwd,
          env,
          projectId: current.registeredProjectId,
          serverName,
          lifecycleLock,
        });
      } else if (current.status !== 'missing') {
        throw new Error(`Claude Code ${serverName} registration changed after the failed command; refusing to overwrite it.`);
      }
      if (before.installerRegistration) {
        installPlan(createClaudeLocalProxyRestorePlan({
          cwd,
          env,
          serverName,
          registration: before.installerRegistration,
        }));
      }
    } catch (rollbackError) {
      failures.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    }
    throw new Error(failures.length
      ? `Claude Code project registration failed and rollback was incomplete: ${failures.join('; ')}`
      : (error instanceof Error ? error.message : String(error)));
  }
}

async function removeInstallerOwnedClaudeProjectRegistration({ cwd, env, projectId, serverName, lifecycleLock }) {
  assertProjectLifecycleLock(lifecycleLock, cwd);
  const before = inspectClaudeLocalProxyRegistration({ cwd, env, projectId, serverName });
  if (!before.installerOwned || before.registeredProjectId !== String(projectId)) return { changed: false, status: before };
  const plan = createClaudeLocalProxyRemovalPlan({
    cwd,
    env,
    projectId,
    serverName,
  });
  const removal = installPlan(plan);
  const after = inspectClaudeLocalProxyRegistration({ cwd, env, projectId, serverName });
  if (after.status !== 'missing') throw new Error('Claude Code did not remove the installer-owned private project MCP registration.');
  return {
    changed: true,
    status: after,
    removedRegistration: before.installerRegistration,
    removedProjectId: before.registeredProjectId,
    removal,
  };
}

async function restoreClaudeProjectRegistration({ cwd, env, projectId, serverName, registration, removal, runCommand, lifecycleLock }) {
  if (!registration) return;
  assertProjectLifecycleLock(lifecycleLock, cwd);
  if (removal) {
    const rollback = rollbackInstallPlan(removal);
    if (!rollback.ok) throw new Error(rollback.errors.join('; '));
    const restored = inspectClaudeLocalProxyRegistration({ cwd, env, projectId, serverName });
    if (!sameClaudeRegistration(restored.installerRegistration, registration)) {
      throw new Error(`Claude Code ${serverName} registration could not be restored exactly.`);
    }
    return;
  }
  const current = inspectClaudeLocalProxyRegistration({ cwd, env, projectId, serverName });
  if (sameClaudeRegistration(current.installerRegistration, registration)) return;
  if (current.status !== 'missing') {
    throw new Error(`Claude Code ${serverName} registration changed during rollback; refusing to overwrite it.`);
  }
  await runCommand({
    command: 'claude',
    args: [
      'mcp', 'add', '--transport', 'stdio', '--scope', 'local', serverName, '--',
      registration.command,
      ...registration.args,
    ],
    cwd,
    timeoutMs: CLIENT_CONFIG_COMMAND_TIMEOUT_MS,
    maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
  });
  const restored = inspectClaudeLocalProxyRegistration({ cwd, env, projectId, serverName });
  if (!sameClaudeRegistration(restored.installerRegistration, registration)) {
    throw new Error(`Claude Code did not restore the expected private ${serverName} registration.`);
  }
}

function readyStatusSteps(serverName = PUBLIC_SERVER_NAME) {
  if (serverName === PUBLIC_SERVER_NAME) return [publicReadinessStep()];
  return [{
    action: 'call_tool',
    server: serverName,
    tool: 'spala_start',
    instruction: 'Call spala_start on the selected project MCP as the protected first call, then follow its returned nextAction.',
  }];
}

function accountProbeStatus() {
  return {
    status: 'client_managed',
    verified: false,
    server: PUBLIC_SERVER_NAME,
    tool: 'account_status',
    instruction: 'Configuration checks intentionally do not read MCP-client OAuth credentials. Codex public init owns the one browser sign-in. After reload, call spala_start as the protected first MCP call; before readiness inspect only .spala/project.json if it exists and do not web-search, inspect app files, load frontend/design skills, plan, scaffold, code, test, or QA. Follow its one nextAction and repeat spala_start only when that action explicitly requests it. If authorization has expired, run exactly one installer login command that opens the browser. OAuth and payment or upgrade actions are browser actions only; do not start parallel logins, manually open an authorization URL, inspect credential stores, or hand-roll MCP HTTP calls.',
  };
}

function redactSensitiveCommandOutput(value) {
  return String(value || '')
    .replace(/(["']?)(access[_-]?token|refresh[_-]?token|client[_-]?secret)\1\s*[:=]\s*(["'])(?:\\.|(?!\3).)*\3/gi, '$1$2$1=[redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*[^\s,}]+/gi, '$1=[redacted]')
    .replace(/\bauthorization\b\s*:\s*bearer\s+[^\s]+/gi, 'authorization: Bearer [redacted]');
}

const OAUTH_AUTHORIZATION_QUERY_KEYS = new Set([
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'redirect_uri',
  'resource',
  'response_type',
  'scope',
  'state',
]);
const OAUTH_REQUIRED_QUERY_KEYS = new Set([
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'redirect_uri',
  'resource',
  'response_type',
  'state',
]);
const MAX_PERCENT_DECODE_ROUNDS = 4;
const SENSITIVE_OAUTH_CONTENT = /(?:^|[^a-z0-9])(?:token|credentials?|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization[_-]?code|auth[_-]?code|device[_-]?code|user[_-]?code)(?:\s*[:=]|[^a-z0-9]|$)|\/token(?:[/?#]|$)/i;

function expectedOAuthAuthorizationUrl(mcpUrl) {
  const parsed = new URL(normalizeMcpUrl(mcpUrl, '', true));
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = mcpUrlsMatch(mcpUrl, PUBLIC_MCP_URL)
    ? '/oauth/authorize'
    : `${parsed.pathname.replace(/\/+$/, '')}/oauth/authorize`;
  return parsed;
}

function percentDecodedLayers(value) {
  const layers = [String(value)];
  for (let round = 0; round < MAX_PERCENT_DECODE_ROUNDS; round += 1) {
    const current = layers.at(-1);
    if (!current.includes('%')) return layers;
    if (/%(?![0-9A-Fa-f]{2})/.test(current)) throw new Error('Malformed percent encoding.');
    const decoded = decodeURIComponent(current);
    layers.push(decoded);
    if (decoded === current) return layers;
  }
  if (layers.at(-1).includes('%')) throw new Error('Nested percent encoding exceeds the allowed depth.');
  return layers;
}

function containsSensitiveOAuthContent(value) {
  return percentDecodedLayers(value).some(layer => SENSITIVE_OAUTH_CONTENT.test(layer));
}

function parseCanonicalOAuthQuery(rawSearch) {
  if (!rawSearch.startsWith('?') || rawSearch.length === 1) throw new Error('Missing OAuth query.');
  const entries = [];
  for (const field of rawSearch.slice(1).split('&')) {
    const separator = field.indexOf('=');
    if (separator <= 0) throw new Error('Malformed OAuth query.');
    const rawKey = field.slice(0, separator);
    const rawValue = field.slice(separator + 1);
    const keyLayers = percentDecodedLayers(rawKey);
    if (keyLayers.length !== 1 || rawKey.includes('+')) throw new Error('Encoded OAuth query names are not allowed.');
    entries.push({
      key: rawKey,
      rawValue,
      value: decodeURIComponent(rawValue.replace(/\+/g, ' ')),
    });
  }
  return entries;
}

function safeOAuthBrowserUrl(value, mcpUrl) {
  const candidate = String(value || '').trim().replace(/[),.;]+$/, '');
  if (!candidate || candidate.length > 4096 || /[\0-\x20\x7f]/.test(candidate)) return undefined;
  try {
    percentDecodedLayers(candidate);
    const parsed = new URL(candidate);
    const expected = expectedOAuthAuthorizationUrl(mcpUrl);
    if (
      parsed.protocol !== expected.protocol
      || parsed.origin !== expected.origin
      || parsed.pathname !== expected.pathname
      || parsed.username
      || parsed.password
      || parsed.hash
      || containsSensitiveOAuthContent(parsed.pathname)
    ) {
      return undefined;
    }
    const entries = parseCanonicalOAuthQuery(parsed.search);
    const seen = new Set();
    for (const { key, rawValue, value: queryValue } of entries) {
      if (
        !OAUTH_AUTHORIZATION_QUERY_KEYS.has(key)
        || seen.has(key)
        || containsSensitiveOAuthContent(key)
      ) return undefined;
      if (key !== 'resource') {
        const decodedValueLayers = percentDecodedLayers(queryValue);
        if (decodedValueLayers.length > 1 || containsSensitiveOAuthContent(rawValue)) return undefined;
      }
      seen.add(key);
    }
    if ([...OAUTH_REQUIRED_QUERY_KEYS].some(key => !seen.has(key))) return undefined;
    if (parsed.searchParams.get('response_type') !== 'code') return undefined;
    if (!/^[A-Za-z0-9._~:-]{1,512}$/.test(parsed.searchParams.get('client_id') || '')) return undefined;
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(parsed.searchParams.get('code_challenge') || '')) return undefined;
    if (parsed.searchParams.get('code_challenge_method') !== 'S256') return undefined;
    if (!/^[A-Za-z0-9._~:-]{1,1024}$/.test(parsed.searchParams.get('state') || '')) return undefined;
    if (parsed.searchParams.has('scope') && !/^[A-Za-z0-9._~:/ -]{1,1024}$/.test(parsed.searchParams.get('scope'))) return undefined;
    const redirect = new URL(parsed.searchParams.get('redirect_uri') || '');
    const loopback = redirect.protocol === 'http:'
      && ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(redirect.hostname);
    if (
      (!loopback && redirect.protocol !== 'https:')
      || redirect.username
      || redirect.password
      || redirect.hash
      || redirect.search
      || containsSensitiveOAuthContent(redirect.href)
    ) return undefined;
    const resource = parsed.searchParams.get('resource');
    if (
      resource !== normalizeMcpUrl(mcpUrl, '', true)
      || containsSensitiveOAuthContent(resource)
    ) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function createOAuthOutputRelay(outputStream, mcpUrl) {
  let pending = '';
  let expectBrowserUrl = false;
  const emittedUrls = new Set();

  const forwardLine = line => {
    const trimmed = line.trim();
    const prompt = trimmed.match(
      /^(?:(?:if your browser did not open,\s*)?(?:open|visit|navigate to)(?: this)?(?: browser)?(?: url)?(?: in your browser)?(?: to (?:authenticate|authorize|continue))?|to authenticate,\s*open(?: this)?(?: url)?(?: in your browser)?|authorize\s+`[^`\r\n]{1,128}`\s+by opening this url in your browser)\s*:?\s*(https:\/\/\S+)?$/i,
    );
    if (prompt) {
      expectBrowserUrl = !prompt[1];
      if (prompt[1]) {
        const url = safeOAuthBrowserUrl(prompt[1], mcpUrl);
        if (url && !emittedUrls.has(url)) {
          emittedUrls.add(url);
          outputStream.write(`Open this browser URL: ${url}\n`);
        }
      }
      return;
    }
    if (expectBrowserUrl) {
      expectBrowserUrl = false;
      const url = safeOAuthBrowserUrl(trimmed, mcpUrl);
      if (url && !emittedUrls.has(url)) {
        emittedUrls.add(url);
        outputStream.write(`Open this browser URL: ${url}\n`);
      }
      return;
    }
    if (/^(?:successfully\s+)?(?:authenticated|logged in|login successful)[.!]?$/i.test(trimmed)) {
      outputStream.write('Browser authentication completed.\n');
    }
  };

  return {
    write(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) forwardLine(line);
    },
    flush() {
      if (pending) forwardLine(pending);
      pending = '';
    },
  };
}

function trustedCommandDirectory() {
  const resolved = fs.realpathSync(path.dirname(process.execPath));
  const stat = fs.lstatSync(resolved, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Installer trusted command directory must be a real directory.');
  }
  return resolved;
}

async function authenticateCodex(
  serverName,
  mcpUrl,
  isPublicInstall,
  runCommand,
  outputStream,
  commandDirectory,
  beforeSpawn,
) {
  if (beforeSpawn) beforeSpawn();
  const relay = createOAuthOutputRelay(outputStream, mcpUrl);
  try {
    await runCommand({
      command: 'codex',
      args: ['mcp', 'login', serverName, ...(isPublicInstall ? ['--scopes', 'api'] : [])],
      cwd: commandDirectory,
      timeoutMs: AUTH_COMMAND_TIMEOUT_MS,
      maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
      outputStream: relay,
    });
  } catch {
    throw new Error('Codex could not complete Spala browser authentication.');
  } finally {
    relay.flush();
  }
}

function withOutcome(payload, { command, outcome, ok, changed = false, steps = [] }) {
  return {
    schemaVersion: 1,
    command,
    outcome,
    ok,
    changed,
    intentBoundary: SPALA_BACKEND_INTENT,
    ...payload,
    nextSteps: steps,
  };
}

function responsePayload(args, payload, details) {
  return args.command ? withOutcome(payload, details) : payload;
}

function printNextSteps(steps, streams) {
  if (!steps.length) return;
  streams.stdout.write('\nNext steps:\n');
  for (const step of steps) {
    streams.stdout.write(`  - ${step.command || step.instruction}\n`);
  }
}

async function loadManifest(manifestPath, cwd) {
  if (!manifestPath) throw new Error('--manifest requires a local file path.');
  if (/^https?:\/\//i.test(manifestPath)) {
    throw new Error('--manifest only accepts local files. Remote manifests are intentionally not loaded by this installer.');
  }
  const resolved = path.resolve(cwd, manifestPath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Manifest is not a file: ${resolved}`);
  if (stat.size > 64 * 1024) throw new Error('Manifest file is too large.');
  const manifest = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Manifest must be a JSON object.');
  }
  const allowed = new Set(['schemaVersion', 'mcpUrl', 'url', 'endpoint', 'serverName', 'name', 'scope']);
  const unknown = Object.keys(manifest).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Manifest contains unsupported fields: ${unknown.join(', ')}`);
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) {
    throw new Error('Unsupported manifest schemaVersion.');
  }
  const mcpUrl = manifest?.mcpUrl || manifest?.url || manifest?.endpoint;
  if (typeof mcpUrl !== 'string' || !mcpUrl.trim()) {
    throw new Error(`Manifest ${resolved} did not include mcpUrl, url, or endpoint.`);
  }
  const serverName = manifest?.serverName || manifest?.name;
  const scope = manifest?.scope;
  return {
    mcpUrl,
    serverName: typeof serverName === 'string' ? serverName : undefined,
    scope: typeof scope === 'string' ? scope : undefined,
    manifest,
  };
}

async function endpointReachable(mcpUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(mcpUrl, {
      method: 'GET',
      headers: { accept: 'application/json, text/plain, */*' },
      signal: controller.signal,
    });
    return {
      ok: response.ok || response.status === 405,
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runBoundedCommand({
  command,
  args,
  cwd = process.cwd(),
  timeoutMs = COMMAND_TIMEOUT_MS,
  maxOutputBytes = COMMAND_MAX_OUTPUT_BYTES,
  outputStream,
}) {
  if (outputStream) {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdoutChunks = [];
      const stderrChunks = [];
      let capturedBytes = 0;
      let forwardedBytes = 0;
      let timedOut = false;

      const collect = (chunks, chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const captureRemaining = Math.max(0, maxOutputBytes - capturedBytes);
        if (captureRemaining > 0) {
          const captured = buffer.subarray(0, captureRemaining);
          chunks.push(captured);
          capturedBytes += captured.length;
        }
        const forwardRemaining = Math.max(0, maxOutputBytes - forwardedBytes);
        if (forwardRemaining > 0) {
          const forwarded = buffer.subarray(0, forwardRemaining);
          outputStream.write(forwarded);
          forwardedBytes += forwarded.length;
        }
      };

      child.stdout?.on('data', chunk => collect(stdoutChunks, chunk));
      child.stderr?.on('data', chunk => collect(stderrChunks, chunk));

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (timedOut) {
          reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
          return;
        }
        if (code !== 0) {
          const detail = redactSensitiveCommandOutput((stderr || stdout).trim());
          reject(new Error(`${command} exited with code ${String(code)}${signal ? ` (${signal})` : ''}${detail ? `: ${detail}` : ''}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  const { stdout } = await execFile(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: maxOutputBytes,
    shell: false,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { stdout: String(stdout).slice(0, maxOutputBytes) };
}

function parseCommandJson(result) {
  if (!result || typeof result.stdout !== 'string' || result.stdout.length > COMMAND_MAX_OUTPUT_BYTES) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function normalizeComparableMcpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return normalizeMcpUrl(value, '');
  } catch {
    return undefined;
  }
}

function collectMcpUrls(value, seen = new Set(), urls = []) {
  if (!value || typeof value !== 'object' || seen.has(value)) return urls;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectMcpUrls(item, seen, urls);
    return urls;
  }
  for (const [key, item] of Object.entries(value)) {
    if (CODEX_URL_FIELDS.has(key.toLowerCase()) && typeof item === 'string') {
      urls.push(item);
      continue;
    }
    collectMcpUrls(item, seen, urls);
  }
  return urls;
}

function findCodexServer(value, serverName, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findCodexServer(item, serverName, seen);
      if (match) return match;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === serverName && item && typeof item === 'object') return item;
  }
  const record = value;
  const name = record.name || record.serverName || record.server_name;
  if (name === serverName) return record;
  for (const item of Object.values(record)) {
    const match = findCodexServer(item, serverName, seen);
    if (match) return match;
  }
  return undefined;
}

function codexServerStatus(server, expectedMcpUrl) {
  const expected = normalizeComparableMcpUrl(expectedMcpUrl);
  const urls = collectMcpUrls(server);
  const normalizedUrls = urls.map(normalizeComparableMcpUrl).filter(Boolean);
  if (normalizedUrls.length === 0) return 'unknown';
  return normalizedUrls.includes(expected) ? 'configured' : 'mismatched';
}

async function probeCodexStatus(serverName, mcpUrl, runCommand, commandDirectory) {
  const getArgs = ['mcp', 'get', serverName, '--json'];
  try {
    const response = parseCommandJson(await runCommand({
      command: 'codex',
      args: getArgs,
      cwd: commandDirectory,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
    }));
    if (response !== undefined) {
      return { method: 'get', status: codexServerStatus(response, mcpUrl) };
    }
  } catch {
    // A missing server and an unavailable Codex binary both fall back to list.
  }

  try {
    const response = parseCommandJson(await runCommand({
      command: 'codex',
      args: ['mcp', 'list', '--json'],
      cwd: commandDirectory,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
    }));
    if (response === undefined) return { method: 'list', status: 'unknown' };
    const server = findCodexServer(response, serverName);
    return server
      ? { method: 'list', status: codexServerStatus(server, mcpUrl) }
      : { method: 'list', status: 'not_configured' };
  } catch {
    return { method: 'unavailable', status: 'unknown' };
  }
}

function applyCodexStatus(report, serverName, mcpUrl, probe) {
  const client = report.clients.find(item => item.client === 'codex');
  if (!client) return;
  const previousIssueCount = client.issues.length;
  client.auth = probe.status === 'unknown' ? 'unknown' : 'client_managed';
  client.source = 'codex_cli';
  client.probe = probe.method;
  client.status = probe.status;
  client.issues = [];
  client.installed = probe.status === 'configured';
  if (probe.status === 'mismatched') client.issues.push('expected_server_url_mismatch');
  if (probe.status === 'not_configured') client.issues.push('expected_server_missing');
  if (probe.status === 'unknown') client.issues.push('codex_cli_unavailable');
  report.summary.issues = Math.max(0, report.summary.issues - previousIssueCount + client.issues.length);
  if (client.installed) report.summary.installed += 1;
  report.ok = report.node.ok && report.summary.issues === 0;
}

function selectedClientNames(clientSelection) {
  if (clientSelection === 'all') return new Set([...WRITABLE_CLIENTS, ...COMMAND_ONLY_CLIENTS]);
  return new Set(String(clientSelection || '').split(',').map(value => value.trim().toLowerCase().replace(/_/g, '-')));
}

async function confirmApply(plan, streams) {
  if (plan.writes.length === 0) return false;
  if (!streams.stdin.isTTY) {
    throw new Error('Refusing to write without --yes in a non-interactive terminal.');
  }

  const rl = readline.createInterface({
    input: streams.stdin || defaultStdin,
    output: streams.stdout || defaultStdout,
  });
  try {
    const answer = await rl.question('Apply these MCP config changes? [y/N] ');
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function printPlan(plan, streams) {
  const out = streams.stdout;
  out.write(`Spala MCP server: ${plan.serverName}\n`);
  out.write(`MCP URL: ${plan.mcpUrl}\n\n`);
  out.write(`Install scope: ${plan.installScope}\n\n`);

  if (plan.writes.length > 0) {
    out.write('Config changes:\n');
    for (const write of plan.writes) {
      out.write(`  - ${CLIENT_LABELS[write.client]}: ${write.action} ${write.path}\n`);
      if (write.backupPath) out.write(`    backup: ${write.backupPath}\n`);
      if (write.removedDuplicates?.length) {
        out.write(`    cleanup: remove ${write.removedDuplicates.map(entry => entry.name).join(', ')}\n`);
      }
    }
    out.write('\n');
  } else {
    out.write('No writable client configs were detected for this selection.\n\n');
  }

  if (plan.skipped.length > 0) {
    out.write('Skipped:\n');
    for (const skipped of plan.skipped) {
      out.write(`  - ${CLIENT_LABELS[skipped.client] || skipped.client}: ${skipped.reason}\n`);
    }
    out.write('\n');
  }

  const hints = buildCommandHints(plan.serverName, plan.mcpUrl, plan.installScope);
  out.write('Terminal setup alternatives:\n');
  if (hints.codexAdd) out.write(`  Codex: ${hints.codexAdd}\n`);
  else out.write('  Codex: workspace configuration is written to .codex/config.toml\n');
  out.write(`  Claude Code: ${hints.claudeCode}\n`);
  out.write(`  Gemini CLI: ${hints.geminiCli}\n`);
  out.write('\n');
}

function summarizePlan(plan) {
  const summary = {
    cleanupDuplicates: Boolean(plan.cleanupDuplicates),
    dryRun: Boolean(plan.dryRun),
    installScope: plan.installScope,
    mcpUrl: plan.mcpUrl,
    serverName: plan.serverName,
    writes: plan.writes.map(write => ({
      client: write.client,
      path: write.path,
      action: write.action,
      backupPath: write.backupPath,
      removedDuplicates: write.removedDuplicates || [],
      removedEntries: write.removedEntries || [],
      dryRun: Boolean(write.dryRun),
    })),
    skipped: plan.skipped,
  };
  if (plan.proxy) summary.proxy = { projectId: plan.proxy.projectId, transport: 'stdio' };
  if (plan.mcpUrl && plan.skipped.some(item => item.commandRequired)) {
    summary.commands = commandPayload(plan.serverName, plan.mcpUrl, plan.installScope);
  }
  return summary;
}

function summarizeAppliedPlan(plan, result, applied = true) {
  return {
    ...summarizePlan(plan),
    applied,
    result: result.writes.map(write => ({
      client: write.client,
      path: write.path,
      action: write.action,
      backupPath: write.backupPath,
      removedDuplicates: write.removedDuplicates || [],
      removedEntries: write.removedEntries || [],
    })),
  };
}

function printCommands(serverName, mcpUrl, installScope, streams) {
  const hints = buildCommandHints(serverName, mcpUrl, installScope);
  const lines = [hints.codexAdd, hints.codexLogin, hints.claudeCode, hints.geminiCli].filter(Boolean);
  streams.stdout.write(`${lines.join('\n')}\n`);
}

function printDoctor(report, streams) {
  const out = streams.stdout;
  out.write(`Node: ${report.node.version} ${report.node.ok ? 'ok' : 'unsupported'}\n`);
  out.write(`Expected MCP: ${report.expected.serverName} -> ${report.expected.mcpUrl}\n`);
  out.write(`Summary: ${report.summary.installed} installed, ${report.summary.duplicates} duplicate(s), ${report.summary.issues} issue(s)\n\n`);
  for (const client of report.clients) {
    const status = client.issues.length ? client.issues.join(', ') : 'ok';
    out.write(`- ${client.label}: ${status}\n`);
    if (client.path) out.write(`  path: ${client.path}\n`);
    if (client.duplicates.length) {
      out.write(`  duplicates: ${client.duplicates.map(entry => entry.name).join(', ')}\n`);
    }
  }
}

function printUninstallPlan(plan, streams) {
  const out = streams.stdout;
  out.write(`Uninstall Spala MCP server: ${plan.cleanupDuplicates ? `${plan.serverName} and exact known legacy aliases` : plan.serverName}\n\n`);
  if (plan.writes.length) {
    out.write('Config changes:\n');
    for (const write of plan.writes) {
      out.write(`  - ${CLIENT_LABELS[write.client]}: remove ${write.removedEntries.map(entry => entry.name).join(', ')} from ${write.path}\n`);
      if (write.backupPath) out.write(`    backup: ${write.backupPath}\n`);
    }
    out.write('\n');
  } else {
    out.write('No matching writable client configs found.\n\n');
  }
  if (plan.skipped.length) {
    out.write('Skipped:\n');
    for (const skipped of plan.skipped) {
      out.write(`  - ${CLIENT_LABELS[skipped.client] || skipped.client}: ${skipped.reason}\n`);
    }
    out.write('\n');
  }
}

function preserveExistingCanonicalBinding(cwd, requestedBinding, { switchProject = false } = {}) {
  const requestedScopes = parseProjectScopeSet(requestedBinding.mcpUrl, 'The requested MCP URL');
  if (switchProject) return requestedBinding;
  const existing = readProjectBinding(cwd).binding;
  if (!existing) return requestedBinding;
  const sameProject = existing.schemaVersion === requestedBinding.schemaVersion
    && existing.projectId === requestedBinding.projectId
    && existing.projectUrl === requestedBinding.projectUrl
    && existing.serverName === requestedBinding.serverName;
  if (!sameProject) return requestedBinding;
  const existingScopes = parseProjectScopeSet(existing.mcpUrl, 'The existing project binding MCP URL');
  const compatibleScopes = requestedScopes
    ? Boolean(existingScopes && projectScopeSetsEqual(existingScopes, requestedScopes))
    : !existingScopes || projectScopeSetsEqual(existingScopes, DEFAULT_PROJECT_SCOPE_SET);
  return compatibleScopes && mcpEndpointsMatch(existing.mcpUrl, requestedBinding.mcpUrl)
    ? existing
    : requestedBinding;
}

export async function runCli(argv, env = process.env, cwd = process.cwd(), streams = {}, runtime = {}) {
  const io = {
    stdin: streams.stdin || defaultStdin,
    stdout: streams.stdout || defaultStdout,
    stderr: streams.stderr || process.stderr,
  };
  const args = parseArgs(argv);
  const commandDirectory = trustedCommandDirectory();

  if (args.command === 'proxy') {
    await runProxy({
      projectId: args.projectId,
      env,
      cwd,
      stdin: io.stdin,
      stdout: io.stdout,
      fetchImpl: runtime.fetch || globalThis.fetch,
    });
    return;
  }

  if (args.help) {
    io.stdout.write(usage());
    return;
  }

  if (args.listClients) {
    if (args.json) {
      io.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        command: 'list-clients',
        outcome: 'complete',
        ok: true,
        clients: clientInstallCapabilities(),
        writable: WRITABLE_CLIENTS.map(client => ({ name: client, label: CLIENT_LABELS[client] })),
        commandOnly: COMMAND_ONLY_CLIENTS.map(client => ({ name: client, label: CLIENT_LABELS[client], scope: 'user' })),
      }, null, 2)}\n`);
      return;
    }
    io.stdout.write(`${formatClientList()}\n`);
    return;
  }

  if (args.command === 'project-status') {
    const { binding, workspaceRoot } = readProjectBinding(cwd);
    const credentialConfigured = binding ? hasProjectCredential(binding.projectId, env, workspaceRoot) : false;
    const claudeRegistration = binding
      ? inspectClaudeLocalProxyRegistration({ cwd: workspaceRoot, env, projectId: binding.projectId, serverName: binding.serverName })
      : null;
    const claudeSelected = args.client !== 'all' && selectedClientNames(args.client).has('claude-code');
    const registrationMismatch = claudeRegistration?.status === 'mismatched'
      || claudeRegistration?.status === 'invalid'
      || (claudeSelected && claudeRegistration?.status !== 'configured');
    const credentialMissing = Boolean(
      binding
      && !credentialConfigured
      && (claudeSelected || claudeRegistration?.status === 'configured' || claudeRegistration?.status === 'mismatched'),
    );
    const ok = Boolean(binding && !registrationMismatch && !credentialMissing);
    const proxyHints = binding ? buildProxyCommandHints(binding.serverName, binding.projectId) : null;
    const nextSteps = (registrationMismatch || credentialMissing) && binding
      ? [{
        action: 'repair_project_binding',
        client: 'claude-code',
        command: proxyHints.claudeCode,
        argv: proxyHints.argv.claudeCode,
        instruction: 'Re-run project bind for this project so the installer replaces and verifies both the delegated credential and the private Claude Code registration.',
      }]
      : [];
    const payload = binding
      ? { schemaVersion: 1, command: 'project-status', outcome: ok ? 'bound' : 'needs_action', ok, changed: false, binding, bindingFile: '.spala/project.json', agenticCredentialConfigured: credentialConfigured, claudeRegistration, nextSteps }
      : { schemaVersion: 1, command: 'project-status', outcome: 'not_bound', ok: false, changed: false, binding: null, bindingFile: '.spala/project.json', nextSteps: [] };
    if (args.json) io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else io.stdout.write(binding ? `Bound to ${binding.projectId} (${binding.projectUrl}); agentic credential ${credentialConfigured ? 'configured' : 'not configured'}; Claude registration ${claudeRegistration.status}.\n` : 'This workspace is not bound to a Spala project.\n');
    if (!ok) process.exitCode = 1;
    return;
  }

  if (args.command === 'project-unbind') {
    const current = readProjectBinding(cwd);
    if (!current.binding) {
      const payload = { schemaVersion: 1, command: 'project-unbind', outcome: 'not_bound', ok: true, changed: false, bindingFile: '.spala/project.json', nextSteps: [] };
      if (args.json) io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else io.stdout.write('This workspace is not bound to a Spala project.\n');
      return;
    }
    if (!args.yes) {
      const confirmationPlan = { writes: [{ client: 'workspace', path: '.spala/project.json', action: 'remove' }] };
      if (!await confirmApply(confirmationPlan, io)) {
        if (args.json) io.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: 'project-unbind', outcome: 'cancelled', ok: true, changed: false, nextSteps: [] }, null, 2)}\n`);
        else io.stdout.write('No files changed.\n');
        return;
      }
    }
    let bindingDirectory;
    let lifecycleLock;
    let claudeRegistration;
    let credential;
    let result;
    try {
      bindingDirectory = openProjectBindingDirectory(current.workspaceRoot);
      lifecycleLock = await acquireProjectLifecycleLock(current.workspaceRoot);
      const asserted = assertProjectBindingRevision(
        current.workspaceRoot,
        current.binding,
        undefined,
        { directoryHandle: bindingDirectory },
      );
      claudeRegistration = await removeInstallerOwnedClaudeProjectRegistration({
        cwd: current.workspaceRoot,
        env,
        projectId: current.binding.projectId,
        serverName: current.binding.serverName,
        runCommand: runtime.runCommand || runBoundedCommand,
        lifecycleLock,
      });
      credential = (runtime.removeProjectCredential || removeProjectCredential)(
        current.binding.projectId,
        env,
        current.workspaceRoot,
      );
      result = (runtime.removeProjectBindingIfRevision || removeProjectBindingIfRevision)(
        current.workspaceRoot,
        current.binding,
        asserted.revision,
        { directoryHandle: bindingDirectory },
      );
    } catch (error) {
      const failures = [];
      if (credential?.revision) {
        try {
          const rollback = rollbackProjectCredentialIfRevision(
            credential.revision,
            env,
            current.workspaceRoot,
          );
          if (rollback.superseded) failures.push('credential rollback was superseded');
        } catch (rollbackError) {
          failures.push(`credential rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (claudeRegistration?.changed) {
        try {
          await restoreClaudeProjectRegistration({
            cwd: current.workspaceRoot,
            env,
            projectId: claudeRegistration.removedProjectId,
            serverName: current.binding.serverName,
            registration: claudeRegistration.removedRegistration,
            removal: claudeRegistration.removal,
            runCommand: runtime.runCommand || runBoundedCommand,
            lifecycleLock,
          });
        } catch (rollbackError) {
          failures.push(`Claude registration rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      throw new Error(failures.length
        ? `Project unbind failed and local rollback was incomplete: ${failures.join('; ')}`
        : (error instanceof Error ? error.message : String(error)));
    } finally {
      if (lifecycleLock) await lifecycleLock.release();
      closeProjectBindingDirectory(bindingDirectory);
    }
    const payload = {
      schemaVersion: 1,
      command: 'project-unbind',
      outcome: 'unbound',
      ok: true,
      changed: result.changed || credential.changed || claudeRegistration.changed,
      bindingFile: '.spala/project.json',
      nextSteps: [{ action: 'notice', instruction: 'The workspace binding, stored agentic credential, and installer-owned private Claude Code registration were removed. Other client configuration and client-owned manual OAuth credentials remain untouched.' }],
    };
    if (args.json) io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      io.stdout.write('Removed .spala/project.json.\n');
      printNextSteps(payload.nextSteps, io);
    }
    return;
  }

  if (args.public && args.url) {
    throw new Error('Use either --public or --url, not both.');
  }
  if (args.manifest && args.url) {
    throw new Error('Use either --manifest or --url, not both.');
  }
  if (args.manifest && args.public) {
    throw new Error('Use either --manifest or --public, not both.');
  }
  if (args.urlProvided && (!args.url || !args.url.trim())) {
    throw new Error('--url requires a non-empty MCP URL.');
  }
  const modeCount = [args.check, args.doctor, args.printOnly, args.uninstall].filter(Boolean).length;
  if (modeCount > 1) {
    throw new Error('Use only one of --check, --doctor, --commands/--print-only, or --uninstall.');
  }

  const manifest = args.manifest ? await loadManifest(args.manifest, cwd) : null;
  const requestedMcpUrl = manifest?.mcpUrl || (args.public || !args.urlProvided ? PUBLIC_MCP_URL : args.url);
  const isPublicInstall = mcpUrlsMatch(requestedMcpUrl, PUBLIC_MCP_URL);
  const installScope = args.installScope || (isPublicInstall ? 'user' : 'workspace');
  const scope = isPublicInstall || args.exactUrl ? '' : (manifest?.scope ?? args.scope);
  const mcpUrl = normalizeMcpUrl(
    requestedMcpUrl,
    scope,
    args.exactUrl,
  );
  const canonicalPublicInstall = isPublicInstall && !args.uninstall;
  if (canonicalPublicInstall && args.name && args.name !== PUBLIC_SERVER_NAME) {
    throw new Error(`The public MCP server name is fixed to ${PUBLIC_SERVER_NAME}. Remove --name or use --name ${PUBLIC_SERVER_NAME}.`);
  }
  const serverName = canonicalPublicInstall
    ? PUBLIC_SERVER_NAME
    : args.name || manifest?.serverName || (isPublicInstall ? PUBLIC_SERVER_NAME : serverNameFromUrl(mcpUrl));
  const uninstallByNameOnly = args.uninstall && Boolean(args.name) && !args.urlProvided && !args.manifest && !args.public;
  const reconcilePublicAliases = isPublicInstall && !args.uninstall;

  if (args.command === 'project-prepare') {
    const requestedBinding = {
      schemaVersion: PROJECT_BINDING_SCHEMA_VERSION,
      projectId: args.projectId,
      projectUrl: args.projectUrl,
      mcpUrl,
      serverName,
    };
    const bindingInput = preserveExistingCanonicalBinding(cwd, requestedBinding, {
      switchProject: args.switchProject,
    });
    const bindingPlan = planProjectBinding(cwd, bindingInput, { switchProject: args.switchProject });
    preflightCredentialStore(env, bindingPlan.workspaceRoot);
    const authorizationRequest = createProjectClaimRequest(bindingPlan.binding, env, bindingPlan.workspaceRoot);
    const payload = {
      schemaVersion: 1,
      command: 'project-prepare',
      outcome: 'authorization_prepared',
      ok: true,
      changed: true,
      projectId: bindingPlan.binding.projectId,
      authorizationRequest,
      nextSteps: [
        { action: 'connect_project', instruction: 'Call project_connect again with this project, client claude-code, bootstrapRequestId, and bootstrapChallenge.' },
        { action: 'bind_project', instruction: 'Run the returned verifier-bound project bind command. No browser authentication is required.' },
      ],
    };
    if (args.json) io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      io.stdout.write('Prepared a local verifier for delegated project authorization.\n');
      io.stdout.write(`Bootstrap request ID: ${authorizationRequest.requestId}\n`);
      io.stdout.write(`Bootstrap challenge: ${authorizationRequest.challenge}\n`);
      printNextSteps(payload.nextSteps, io);
    }
    return;
  }

  if (args.command === 'project-bind') {
    const protectedClaim = Boolean(args.bootstrapClaim && args.bootstrapRequestId);
    const agentic = args.bootstrapStdin || args.bootstrapFd !== undefined || protectedClaim;
    const requestedBinding = {
      schemaVersion: PROJECT_BINDING_SCHEMA_VERSION,
      projectId: args.projectId,
      projectUrl: args.projectUrl,
      mcpUrl,
      serverName,
    };
    const bindingInput = preserveExistingCanonicalBinding(cwd, requestedBinding, {
      switchProject: args.switchProject,
    });
    let bindingPlan = planProjectBinding(cwd, bindingInput, { switchProject: args.switchProject });
    const createBindingInstallPlan = currentBindingPlan => agentic
      ? createProxyInstallPlan({
        clientSelection: args.client,
        cwd: currentBindingPlan.workspaceRoot,
        dryRun: args.dryRun,
        env,
        projectId: currentBindingPlan.binding.projectId,
        serverName,
      })
      : createInstallPlan({
        clientSelection: args.client,
        cleanupDuplicates: args.cleanupDuplicates,
        cwd: currentBindingPlan.workspaceRoot,
        dryRun: args.dryRun,
        env,
        exactUrl: true,
        installScope: 'workspace',
        scope: '',
        mcpUrl: currentBindingPlan.binding.mcpUrl,
        serverName,
      });
    const validateBindingInstallPlan = currentPlan => {
      const selectedUnsupported = currentPlan.skipped.filter(item => item.unsupportedScope);
      const currentClaudeCommandRequired = agentic
        && currentPlan.skipped.some(item => item.client === 'claude-code' && item.commandRequired);
      const hasSupportedTarget = agentic
        ? currentPlan.writes.length > 0 || currentClaudeCommandRequired
        : currentPlan.writes.length > 0 || currentPlan.skipped.some(item => item.commandRequired);
      if (!hasSupportedTarget) {
        throw new Error(selectedUnsupported[0]?.reason || 'No verified workspace-scoped target is available for the selected client.');
      }
      return currentClaudeCommandRequired;
    };
    const buildBindingPayload = (currentBindingPlan, currentPlan, currentSteps) => ({
      schemaVersion: 1,
      command: 'project-bind',
      outcome: args.dryRun ? 'planned' : 'bound',
      ok: true,
      changed: false,
      binding: currentBindingPlan.binding,
      bindingFile: '.spala/project.json',
      installScope: 'workspace',
      plan: summarizePlan(currentPlan),
      nextSteps: currentSteps,
    });
    let plan = createBindingInstallPlan(bindingPlan);
    let claudeCommandRequired = validateBindingInstallPlan(plan);
    let steps = agentic ? nextProxySteps(plan) : nextSteps(plan, args.client);
    let basePayload = buildBindingPayload(bindingPlan, plan, steps);
    if (args.dryRun) {
      if (args.json) io.stdout.write(`${JSON.stringify(basePayload, null, 2)}\n`);
      else if (agentic) {
        io.stdout.write(`Planned agentic project binding for ${bindingPlan.binding.projectId}.\n`);
        io.stdout.write('The one-time bootstrap capability has not been consumed.\n');
      } else printPlan(plan, io);
      return;
    }
    if (!args.yes) {
      const confirmationPlan = plan.writes.length ? plan : { writes: [{ client: 'workspace', path: '.spala/project.json', action: 'create' }] };
      if (!await confirmApply(confirmationPlan, io)) {
        if (args.json) io.stdout.write(`${JSON.stringify({ ...basePayload, outcome: 'cancelled', changed: false }, null, 2)}\n`);
        else io.stdout.write('No files changed.\n');
        return;
      }
    }
    let installed = { writes: [] };
    let bound = { binding: bindingPlan.binding, changed: false, workspaceRoot: bindingPlan.workspaceRoot };
    let bindingDirectory;
    let lifecycleLock;
    let credentialRevision;
    let claudeRegistration;
    let previousClaudeRegistration;
    let effectiveBinding = bindingPlan.binding;
    try {
      // First bind has no .spala directory yet. Create and validate it without
      // retaining a stale descriptor while another lifecycle operation owns
      // the cross-process lock, then reopen it after this operation acquires
      // that lock.
      const preparedDirectory = openProjectBindingDirectory(bindingPlan.workspaceRoot);
      closeProjectBindingDirectory(preparedDirectory);
      lifecycleLock = await acquireProjectLifecycleLock(bindingPlan.workspaceRoot);
      const lockedBindingInput = preserveExistingCanonicalBinding(cwd, requestedBinding, {
        switchProject: args.switchProject,
      });
      bindingPlan = planProjectBinding(cwd, lockedBindingInput, { switchProject: args.switchProject });
      plan = createBindingInstallPlan(bindingPlan);
      claudeCommandRequired = validateBindingInstallPlan(plan);
      steps = agentic ? nextProxySteps(plan) : nextSteps(plan, args.client);
      basePayload = buildBindingPayload(bindingPlan, plan, steps);
      effectiveBinding = bindingPlan.binding;
      bindingDirectory = openProjectBindingDirectory(bindingPlan.workspaceRoot);
      if (claudeCommandRequired) {
        const registration = inspectClaudeLocalProxyRegistration({
          cwd: bindingPlan.workspaceRoot,
          env,
          projectId: bindingPlan.binding.projectId,
          serverName,
        });
        if (registration.status !== 'missing' && !registration.configured && !registration.installerOwned) {
          throw new Error(`Claude Code already has a non-installer-owned ${serverName} registration in this workspace; refusing to replace it.`);
        }
      }
      let bootstrapUrl;
      let codeVerifier;
      if (agentic) {
        if (protectedClaim) {
          const pending = readProjectClaimRequest(
            args.bootstrapRequestId,
            bindingPlan.binding,
            env,
            bindingPlan.workspaceRoot,
          );
          bootstrapUrl = args.bootstrapClaim;
          codeVerifier = pending.verifier;
        } else {
          bootstrapUrl = await readBootstrapCapability({ stdin: io.stdin, fd: args.bootstrapFd, stderr: io.stderr });
        }
        preflightCredentialStore(env, bindingPlan.workspaceRoot);
      }

      installed = installPlan(plan);
      bound = writeProjectBinding(bindingPlan.workspaceRoot, bindingPlan.binding, {
        switchProject: args.switchProject,
        directoryHandle: bindingDirectory,
      });

      if (agentic) {
        const exchanged = await consumeBootstrap({
          bootstrapUrl,
          projectUrl: bindingPlan.binding.projectUrl,
          mcpUrl: bindingPlan.binding.mcpUrl,
          codeVerifier,
          fetchImpl: runtime.fetch || globalThis.fetch,
          timeoutMs: runtime.bootstrapTimeoutMs || 90_000,
        });
        // The consume response is the authority on the endpoint (it may carry
        // the scope query even when the requested URL was bare). Store and
        // bind the exchanged URL so proxy credentials and the workspace
        // binding agree with the server.
        const exchangedBinding = {
          ...bindingPlan.binding,
          mcpUrl: exchanged.mcpUrl,
        };
        effectiveBinding = exchangedBinding;
        if (exchanged.mcpUrl !== bindingPlan.binding.mcpUrl) {
          bound = replaceProjectBindingIfRevision(
            bindingPlan.workspaceRoot,
            exchangedBinding,
            bound.revision,
            {
              directoryHandle: bindingDirectory,
              failureRollbackBinding: bindingPlan.existing,
              rollbackOnDirectoryChange: true,
            },
          );
        }
        assertProjectBindingRevision(
          bindingPlan.workspaceRoot,
          exchangedBinding,
          bound.revision,
          {
            directoryHandle: bindingDirectory,
            failureRollbackBinding: bindingPlan.existing,
            rollbackOnFailure: bound.changed,
          },
        );
        const previousProjectId = bindingPlan.existing?.projectId !== bindingPlan.binding.projectId
          ? bindingPlan.existing?.projectId
          : undefined;
        const credentialInput = {
          projectId: bindingPlan.binding.projectId,
          mcpUrl: exchanged.mcpUrl,
          bearerToken: exchanged.bearerToken,
          expiresAt: exchanged.expiresAt,
        };
        const persistedCredential = previousProjectId
          ? (runtime.storeProjectCredentialAndRetire || storeProjectCredentialAndRetire)(
            { ...credentialInput, previousProjectId },
            env,
            bindingPlan.workspaceRoot,
          )
          : (runtime.storeProjectCredential || storeProjectCredential)(
            credentialInput,
            env,
            bindingPlan.workspaceRoot,
          );
        credentialRevision = persistedCredential?.revision;
        assertProjectBindingRevision(
          bindingPlan.workspaceRoot,
          exchangedBinding,
          bound.revision,
          {
            directoryHandle: bindingDirectory,
            failureRollbackBinding: bindingPlan.existing,
            rollbackOnFailure: bound.changed,
          },
        );

        if (claudeCommandRequired) {
          claudeRegistration = await reconcileClaudeProjectRegistration({
            cwd: bindingPlan.workspaceRoot,
            env,
            projectId: bindingPlan.binding.projectId,
            serverName,
            runCommand: runtime.runCommand || runBoundedCommand,
            lifecycleLock,
          });
        }
      }

      if (
        !agentic
        && bindingPlan.existing
        && bindingPlan.existing.projectId !== bindingPlan.binding.projectId
      ) {
        const removedCredential = removeProjectCredential(
          bindingPlan.existing.projectId,
          env,
          bindingPlan.workspaceRoot,
        );
        credentialRevision = removedCredential.revision;
      }
      if (
        bindingPlan.existing
        && bindingPlan.existing.projectId !== bindingPlan.binding.projectId
        && (!claudeCommandRequired || bindingPlan.existing.serverName !== serverName)
      ) {
        previousClaudeRegistration = await removeInstallerOwnedClaudeProjectRegistration({
          cwd: bindingPlan.workspaceRoot,
          env,
          projectId: bindingPlan.existing.projectId,
          serverName: bindingPlan.existing.serverName,
          runCommand: runtime.runCommand || runBoundedCommand,
          lifecycleLock,
        });
      }
      assertProjectBindingRevision(
        bindingPlan.workspaceRoot,
        effectiveBinding,
        bound.revision,
        {
          directoryHandle: bindingDirectory,
          failureRollbackBinding: bindingPlan.existing,
          rollbackOnFailure: bound.changed,
        },
      );
      if (protectedClaim) {
        removeProjectClaimRequest(args.bootstrapRequestId, env, bindingPlan.workspaceRoot);
      }
      credentialRevision = undefined;
    } catch (error) {
      const failures = [];
      if (error && typeof error === 'object' && error.bindingRevisionAfterRecovery) {
        bound.revision = error.bindingRevisionAfterRecovery;
      }
      if (error && typeof error === 'object' && error.bindingRollbackCompleted) {
        bound.changed = false;
      }
      if (claudeRegistration?.changed) {
        try {
          await removeInstallerOwnedClaudeProjectRegistration({
            cwd: bindingPlan.workspaceRoot,
            env,
            projectId: bindingPlan.binding.projectId,
            serverName,
            runCommand: runtime.runCommand || runBoundedCommand,
            lifecycleLock,
          });
          await restoreClaudeProjectRegistration({
            cwd: bindingPlan.workspaceRoot,
            env,
            projectId: claudeRegistration.previousProjectId,
            serverName,
            registration: claudeRegistration.previousRegistration,
            removal: claudeRegistration.previousRemoval,
            runCommand: runtime.runCommand || runBoundedCommand,
            lifecycleLock,
          });
        } catch (rollbackError) {
          failures.push(`Claude registration rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (previousClaudeRegistration?.changed) {
        try {
          await restoreClaudeProjectRegistration({
            cwd: bindingPlan.workspaceRoot,
            env,
            projectId: previousClaudeRegistration.removedProjectId,
            serverName: bindingPlan.existing.serverName,
            registration: previousClaudeRegistration.removedRegistration,
            removal: previousClaudeRegistration.removal,
            runCommand: runtime.runCommand || runBoundedCommand,
            lifecycleLock,
          });
        } catch (rollbackError) {
          failures.push(`previous Claude registration rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (credentialRevision) {
        try {
          rollbackProjectCredentialIfRevision(
            credentialRevision,
            env,
            bindingPlan.workspaceRoot,
          );
        } catch (rollbackError) {
          failures.push(`credential rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (bound.changed) {
        try {
          rollbackProjectBinding(
            bindingPlan.workspaceRoot,
            bound.revision,
            bindingPlan.existing,
            { directoryHandle: bindingDirectory },
          );
        } catch (rollbackError) {
          failures.push(`binding rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      failures.push(...rollbackInstallPlan(installed).errors.map(rollbackError => rollbackError instanceof Error ? rollbackError.message : String(rollbackError)));
      const wrapped = new Error(failures.length
        ? `Project binding failed and local rollback was incomplete: ${failures.join('; ')}`
        : (error instanceof Error ? error.message : String(error)));
      wrapped.changed = failures.length > 0;
      throw wrapped;
    } finally {
      if (lifecycleLock) await lifecycleLock.release();
      closeProjectBindingDirectory(bindingDirectory);
    }
    const payload = {
      ...basePayload,
      outcome: 'bound',
      changed: agentic || bound.changed || installed.writes.length > 0,
      binding: bound.binding,
      agenticCredentialConfigured: agentic,
      claudeRegistrationConfigured: claudeCommandRequired ? true : undefined,
      plan: summarizeAppliedPlan(plan, installed),
      nextSteps: steps.filter(step => !(step.action === 'configure_client' && step.client === 'claude-code')),
    };
    if (args.json) io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      io.stdout.write(`Bound workspace to Spala project ${bound.binding.projectId}.\n`);
      printNextSteps(payload.nextSteps, io);
    }
    return;
  }

  if (args.command === 'login') {
    const selected = selectedClientNames(args.client);
    if (selected.size !== 1 || !selected.has('codex')) {
      throw new Error('spala-ai login currently runs native OAuth for --client codex. Other MCP clients start browser authentication when the agent calls project_list.');
    }
    const registration = codexRemoteRegistrationTarget({
      cwd,
      env,
      installScope,
      mcpUrl,
    });
    await authenticateCodex(
      serverName,
      mcpUrl,
      isPublicInstall,
      runtime.runCommand || runBoundedCommand,
      io.stderr,
      commandDirectory,
      () => {
        runtime.beforeCodexAuthenticationValidation?.({
          path: registration.path,
          serverName,
        });
        assertExactCodexRemoteRegistration(
          registration.path,
          serverName,
          mcpUrl,
          registration.safetyRoot,
        );
      },
    );
    const payload = withOutcome({
      serverName,
      mcpUrl,
      account: {
        ...accountProbeStatus(),
        status: 'authenticated',
        verified: true,
        server: serverName,
        tool: 'spala_start',
      },
    }, {
      command: 'login',
      outcome: 'authenticated',
      ok: true,
      steps: readyStatusSteps(serverName),
    });
    if (args.json) io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      io.stdout.write('Spala browser authentication completed.\n');
      printNextSteps(payload.nextSteps, io);
    }
    return;
  }

  if (args.printOnly) {
    const plan = createInstallPlan({ clientSelection: 'codex', cwd, dryRun: true, env, exactUrl: args.exactUrl, installScope, scope, mcpUrl, serverName });
    if (args.json) {
      io.stdout.write(`${JSON.stringify(responsePayload(args, { commands: commandPayload(plan.serverName, plan.mcpUrl, plan.installScope), installScope: plan.installScope, mcpUrl: plan.mcpUrl, serverName: plan.serverName }, {
        command: commandName(args), outcome: 'commands_required', ok: true, steps: nextSteps(plan, args.client, false),
      }), null, 2)}\n`);
    } else {
      printCommands(plan.serverName, plan.mcpUrl, plan.installScope, io);
    }
    return;
  }

  if (args.doctor || args.check) {
    const report = createDoctorReport({ clientSelection: args.client, cwd, env, installScope, mcpUrl, serverName: serverName || PUBLIC_SERVER_NAME });
    if (args.command === 'status' && selectedClientNames(args.client).has('codex')) {
      const probe = await probeCodexStatus(
        serverName,
        mcpUrl,
        runtime.runCommand || runBoundedCommand,
        commandDirectory,
      );
      applyCodexStatus(report, serverName, mcpUrl, probe);
    }
    if (args.check) {
      report.endpoint = await endpointReachable(mcpUrl);
      report.ok = report.ok && report.endpoint.ok;
    }
    const hasInstalledClient = report.clients.some(client => client.installed);
    const hasUnknownClient = report.clients.some(client => client.status === 'unknown');
    const hasMismatchedClient = report.clients.some(client => client.status === 'mismatched');
    const statusOk = report.ok && (!args.command || hasInstalledClient);
    const remediationPlan = createInstallPlan({ clientSelection: args.client, cwd, dryRun: true, env, installScope, scope, mcpUrl, serverName });
    const statusSteps = statusOk
      ? readyStatusSteps()
      : nextSteps(remediationPlan, args.client, false);
    if (args.command && !statusOk) statusSteps.unshift(publicInitStep(args.client));
    if (args.json) {
      const outcome = statusOk ? 'ready' : hasUnknownClient ? 'unknown' : hasMismatchedClient || hasInstalledClient ? 'needs_action' : 'not_configured';
      io.stdout.write(`${JSON.stringify(responsePayload(args, { ...report, account: accountProbeStatus() }, {
        command: commandName(args), outcome, ok: statusOk, steps: statusSteps,
      }), null, 2)}\n`);
    } else {
      printDoctor(report, io);
      if (args.check) {
        io.stdout.write(`\nEndpoint: ${report.endpoint.ok ? 'reachable' : 'not reachable'}${report.endpoint.status ? ` (${report.endpoint.status})` : ''}${report.endpoint.error ? ` - ${report.endpoint.error}` : ''}\n`);
      }
      if (args.command) printNextSteps(statusSteps, io);
    }
    if (!statusOk) process.exitCode = 1;
    return;
  }

  if (args.uninstall) {
    const plan = createUninstallPlan({
      cleanupDuplicates: args.cleanupDuplicates,
      clientSelection: args.client,
      cwd,
      dryRun: args.dryRun,
      env,
      installScope,
      mcpUrl: uninstallByNameOnly ? undefined : mcpUrl,
      serverName: serverName || PUBLIC_SERVER_NAME,
    });
    if (args.json && args.dryRun) {
      io.stdout.write(`${JSON.stringify(responsePayload(args, summarizePlan(plan), {
        command: 'uninstall', outcome: 'planned', ok: true, steps: nextSteps(plan, args.client, false),
      }), null, 2)}\n`);
    } else if (!args.json) {
      printUninstallPlan(plan, io);
    }
    if (args.dryRun) return;
    if (plan.writes.length === 0) {
      if (args.json) {
        io.stdout.write(`${JSON.stringify({ ...summarizePlan(plan), applied: false, result: [] }, null, 2)}\n`);
      } else {
        io.stdout.write('No files changed.\n');
      }
      return;
    }
    const shouldApply = args.yes || await confirmApply(plan, io);
    if (!shouldApply) {
      if (args.json) {
        io.stdout.write(`${JSON.stringify({ ...summarizePlan(plan), applied: false, result: [] }, null, 2)}\n`);
        return;
      }
      io.stdout.write('No files changed.\n');
      return;
    }
    const result = installPlan(plan);
    if (args.json) {
      io.stdout.write(`${JSON.stringify(responsePayload(args, summarizeAppliedPlan(plan, result), {
        command: 'uninstall', outcome: 'uninstalled', ok: true, changed: result.writes.length > 0, steps: nextSteps(plan, args.client),
      }), null, 2)}\n`);
      return;
    }
    for (const write of result.writes) {
      io.stdout.write(`Updated ${write.path}\n`);
    }
    io.stdout.write('Done.\n');
    if (args.command) printNextSteps(nextSteps(plan, args.client), io);
    return;
  }

  const plan = createInstallPlan({
    clientSelection: args.client,
    cleanupDuplicates: args.cleanupDuplicates || reconcilePublicAliases,
    cwd,
    dryRun: args.dryRun,
    env,
    exactUrl: args.exactUrl,
    installScope,
    scope,
    mcpUrl,
    serverName,
  });
  const explicitlyUnsupported = args.client !== 'all' && plan.writes.length === 0 && !plan.skipped.some(item => item.commandRequired);
  if (explicitlyUnsupported) {
    throw new Error(plan.skipped.find(item => item.unsupportedScope)?.reason || 'No verified installation target is available for this client and scope.');
  }

  if (args.json && args.dryRun) {
    io.stdout.write(`${JSON.stringify(responsePayload(args, summarizePlan(plan), {
      command: 'init', outcome: 'planned', ok: true, steps: isPublicInstall ? [publicInitStep(args.client)] : nextSteps(plan, args.client, false),
    }), null, 2)}\n`);
  } else if (!args.json) {
    printPlan(plan, io);
  }

  if (args.dryRun) {
    if (!args.json) io.stdout.write('Dry run complete. No files changed.\n');
    return;
  }

  if (plan.writes.length === 0) {
    if (args.json) {
      const payload = { ...summarizePlan(plan), applied: false, result: [] };
      const details = {
        command: 'init', outcome: 'commands_required', ok: true, steps: nextSteps(plan, args.client, true, { publicReadiness: isPublicInstall }),
      };
      io.stdout.write(`${JSON.stringify(args.command ? responsePayload(args, payload, details) : withOutcome(payload, { ...details, command: 'project-init' }), null, 2)}\n`);
    } else {
      io.stdout.write('No writable config files changed. Use the terminal setup command for command-only clients.\n');
    }
    return;
  }

  const shouldApply = args.yes || await confirmApply(plan, io);
  if (!shouldApply) {
    if (args.json) {
      io.stdout.write(`${JSON.stringify({ ...summarizePlan(plan), applied: false, result: [] }, null, 2)}\n`);
      return;
    }
    io.stdout.write('No files changed.\n');
    return;
  }

  const result = installPlan(plan);
  const confirmedPublicCodexSetup = isPublicInstall
    && plan.writes.some(write => (
      write.client === 'codex'
      && write.format === 'toml'
      && write.canonicalRegistrationPresent
    ));
  const canonicalCodexWrite = confirmedPublicCodexSetup
    ? plan.writes.find(write => (
      write.client === 'codex'
      && write.format === 'toml'
      && write.canonicalRegistrationPresent
    ))
    : undefined;
  let account;
  if (confirmedPublicCodexSetup) {
    try {
      await authenticateCodex(
        serverName,
        mcpUrl,
        true,
        runtime.runCommand || runBoundedCommand,
        io.stderr,
        commandDirectory,
        () => {
          runtime.beforeCodexAuthenticationValidation?.({
            path: canonicalCodexWrite.path,
            serverName,
          });
          assertExactCodexRemoteRegistration(
            canonicalCodexWrite.path,
            PUBLIC_SERVER_NAME,
            PUBLIC_MCP_URL,
            canonicalCodexWrite.safetyRoot,
          );
        },
      );
      account = { status: 'authenticated', verified: true, owner: 'installer' };
    } catch (error) {
      const configurationChanged = result.writes.length > 0;
      if (error && typeof error === 'object' && error.configurationValidation) {
        error.changed = configurationChanged;
        throw error;
      }
      const wrapped = new Error(configurationChanged
        ? 'Spala MCP configuration was changed and retained, but browser authentication did not finish.'
        : 'Spala MCP configuration was retained unchanged, but browser authentication did not finish.');
      wrapped.changed = configurationChanged;
      wrapped.retryCommand = `pnpm dlx ${INSTALLER_MAINTENANCE_SPEC} login --client codex --json`;
      throw wrapped;
    }
  }
  if (args.json) {
    const payload = { ...summarizeAppliedPlan(plan, result), ...(account ? { account } : {}) };
    const details = {
      command: 'init', outcome: 'installed', ok: true, changed: result.writes.length > 0, steps: nextSteps(plan, args.client, true, { publicReadiness: isPublicInstall }),
    };
    io.stdout.write(`${JSON.stringify(args.command ? responsePayload(args, payload, details) : withOutcome(payload, { ...details, command: 'project-init' }), null, 2)}\n`);
    return;
  }
  for (const write of result.writes) {
    io.stdout.write(`Updated ${write.path}\n`);
  }
  io.stdout.write('Done.\n');
  if (args.command) printNextSteps(nextSteps(plan, args.client, true, { publicReadiness: isPublicInstall }), io);
}
