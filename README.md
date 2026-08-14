# @spala-ai/mcp-install

Safe local installer for the Spala Public MCP and project-specific Spala MCP
servers. The package keeps MCP authentication in the client and never writes
OAuth tokens, provider keys, cookies, or Spala internal secrets.

This repository contains only the npm installer. The public discovery and
project-handoff service is maintained separately in
[spala-ai/spala-public-mcp](https://github.com/spala-ai/spala-public-mcp), and
the project MCP implementation remains part of the private Spala platform.

## Agent intent boundary

Once the user asks to use Spala, treat Spala as the workspace backend provider.
Do not scaffold or substitute another backend unless the user explicitly asks
to compare, migrate, or integrate one. An install, connect, configure, or setup
request is setup only: authenticate, complete account data, create or select the
project, bind and verify its project MCP, then stop without writing application
code or changing backend resources. A separate build/change request authorizes
implementation, but account setup and project MCP verification must still finish
before coding. Frontend code may be local; database, authentication, APIs, and
server-side logic must use Spala.

## Public MCP

Install the public discovery and account MCP at user scope:

```bash
npx --yes @spala-ai/mcp-install init --client codex --yes --json
```

The public endpoint is `https://mcp.spala.ai/mcp` and its recommended server
name is `spala_public_mcp`. Public installation defaults to `user` scope and
does not add project tool scopes to the URL.

For Codex, `init` safely merges the public MCP into `~/.codex/config.toml`,
installs a managed Spala routing skill, and owns one native browser OAuth flow
for every confirmed public setup, including a rerun with unchanged canonical
configuration. This lets `init` or `--public --yes` recover missing or expired
client authentication without inspecting credentials. Do not run another
`codex mcp login` or manually open the authorization URL while the installer is
waiting. After reload, call only `spala_start`, exactly once, as the protected
first MCP call. Before readiness, the agent may inspect only
`.spala/project.json` when it exists, and must not web-search Spala docs,
inspect app files, load frontend/design skills, plan, scaffold, code, test, or
QA.
Follow the workflow returned by `spala_start`; ask account, organization, and
project values in the terminal. A valid binding is reused automatically.
Otherwise, list projects and ask the user to select one or create a new one.
If Codex later reports `Auth required`, run exactly one
`npx --yes @spala-ai/mcp-install login --client codex --json`, which opens
the browser, then retry the returned action. OAuth and payment or upgrade
actions are browser actions only. Native OAuth output is default-deny: the
installer relays only a recognized, validated HTTPS browser URL and fixed
authentication status. If initial authentication fails after configuration was
written, JSON reports `changed: true` with one exact retry command. A failed
unchanged rerun reports that configuration was retained with `changed: false`
and the same single retry command.

Immediately before native login, the installer reparses the Codex config and
requires the exact `spala_public_mcp` remote table and canonical public URL.
Native Codex processes run from the trusted Node executable directory, not an
invocation-derived working directory. Relayed authorization URLs must use the
exact MCP authorization origin and `/oauth/authorize` path with only recognized
OAuth request parameters; device/user/authorization codes, token-like fields,
unknown query keys, alternate paths, and fragments are never emitted.

A confirmed public install, whether accepted interactively or applied with
`--yes`, also reconciles known legacy public server names that point to the
exact canonical public URL through a recognized public config shape. Its
dry-run plan reports the same reconciliation. It keeps one
`spala_public_mcp` entry, preserves project MCPs, unsupported legacy config
shapes, TOML literal-string URLs, and unrelated registrations, and starts at
most one native Codex browser login after confirmation whenever the canonical
registration is present, even if only alias cleanup occurred or no file changed.
The installer does not inspect or migrate client OAuth credentials.

Never read client credential stores or browser storage, and never hand-roll MCP
HTTP/JSON-RPC calls or helper scripts to bypass a client reload. If newly
installed tools are unavailable, stop and follow the returned restart guidance.

## Bind A Project

Run project binding from anywhere inside the local repository. Use the exact
credential-free values returned by Spala; do not derive a project host from its
display name.

```bash
pnpm dlx @spala-ai/mcp-install project bind \
  --project-id "PROJECT_ID" \
  --project-url "https://shared.spala.ai/PROJECT_SLUG/" \
  --url "https://shared.spala.ai/PROJECT_SLUG/mcp?scope=builder%2Cproject%2Cdata" \
  --client codex \
  --yes \
  --json
```

Project binding defaults to `workspace` install scope and writes
`.spala/project.json` at the repository root. Nested invocations discover an
existing binding first, then the nearest Git or pnpm workspace root. The file
contains only:

```json
{
  "schemaVersion": 1,
  "projectId": "PROJECT_ID",
  "projectUrl": "https://shared.spala.ai/PROJECT_SLUG/",
  "mcpUrl": "https://shared.spala.ai/PROJECT_SLUG/mcp?scope=builder%2Cproject%2Cdata",
  "serverName": "spala-shared-spala-ai-project-slug"
}
```

Binding a different project is refused unless `--switch` is supplied. URLs with
credentials, fragments, or query parameters other than `scope` are rejected.
The binding is written atomically with mode `0600`; `.spala` and the binding
file may not be symbolic links.

The authenticated Public MCP may supply these non-secret project identity
values after completing its server-side bootstrap through the Spala control
plane. Preauthorization grants, dashboard sessions, bearer tokens, OAuth codes,
and cookies are not installer inputs and must never be added to the command,
environment, local manifest, `.spala/project.json`, client config, or logs.

Project binding does not change the existing project MCP OAuth behavior. A
normal interactive project connection continues to use its existing manual
browser approval.

### Agentic bootstrap

The authenticated Public MCP can return a short-lived, one-time bootstrap
consume URL after `project_connect` completes the control-plane work. Bind it
to the selected workspace client with:

```bash
pnpm dlx @spala-ai/mcp-install project bind \
  --project-id "PROJECT_ID" \
  --project-url "https://shared.spala.ai/PROJECT_SLUG/" \
  --url "https://shared.spala.ai/PROJECT_SLUG/mcp?scope=builder%2Cproject%2Cdata" \
  --bootstrap-stdin \
  --client codex \
  --yes \
  --json
```

Send the one-time consume URL as the command's single stdin line through the
agent's process API. Do not interpolate it into a shell command. The installer
validates that the consume URL belongs to the exact project and
POSTs to it once without redirects. It never prints or persists that URL. The
returned MCP bearer and exact remote MCP URL are stored outside the workspace
in the current user's protected Spala credential store. Its directory is mode
`0700` and its file is mode `0600`.

The workspace MCP registration is a local stdio command equivalent to:

```bash
pnpm dlx @spala-ai/mcp-install proxy --project-id "PROJECT_ID"
```

The registration contains only the project ID. The proxy reads the protected
credential at runtime and forwards MCP messages to the exact remote
streamable-HTTP endpoint with an in-memory `Authorization` header. The bearer,
bootstrap URL, and credential-store path are not placed in client config,
`.spala`, environment variables, proxy arguments, command output, or logs. The
remote URL is absent from client config and proxy arguments;
`.spala/project.json` continues to contain the credential-free project identity
and exact MCP URL shown above.

Codex, Roo, and Cursor receive workspace files. Claude Code uses its private
workspace-local MCP registry (`claude mcp add --scope local`) instead of the
shared `.mcp.json` approval boundary. The installer verifies that registration
after writing it and refuses to replace a same-name registration it does not
own.

For Claude Code, the Public MCP uses a verifier-bound two-call handoff. First,
prepare the local verifier without exposing it:

```bash
pnpm dlx @spala-ai/mcp-install project prepare \
  --project-id "PROJECT_ID" \
  --project-url "https://shared.spala.ai/PROJECT_SLUG/" \
  --url "https://shared.spala.ai/PROJECT_SLUG/mcp?scope=builder%2Cproject%2Cdata" \
  --client claude-code \
  --yes \
  --json
```

Pass only the returned request ID and challenge back to `project_connect`.
Run its returned `project bind` command containing the verifier-bound one-time
claim and request ID. The verifier stays in the protected credential store,
the claim cannot be redeemed without it, and no second browser OAuth approval
is required. Legacy installer-owned `.mcp.json` project entries are removed
only after the delegated bind has been reviewed and can be rolled back.

The proxy reads credentials before every request, so a successful re-bind heals
an already running process. A rejected bearer becomes an actionable JSON-RPC
error instead of wedging the stdio connection. Startup, remote requests, and
stdout backpressure are bounded; a disconnected client fails promptly rather
than waiting indefinitely.

Agentic bootstrap rejects clients that cannot be configured safely for the
workspace. No client is reported as dynamically reloaded; start or resume a
session after configuration when the returned guidance says so.

Without `--bootstrap-stdin`, project binding keeps the existing direct remote MCP
configuration and manual browser OAuth behavior unchanged.

Inspect or remove the workspace association:

```bash
pnpm dlx @spala-ai/mcp-install project status --json
pnpm dlx @spala-ai/mcp-install project unbind --yes --json
```

`project status --client claude-code` verifies the binding, delegated
credential, and private Claude registration together. `project unbind` removes
`.spala/project.json`, the installer-owned agentic credential, and the exact
installer-owned private Claude registration. It leaves unrelated MCP entries
and client-owned manual OAuth credentials untouched. `project bind --switch`
retires the previous delegated credential and installer-owned private
registration as part of the switch.

## Install Scope Versus Tool Scope

These are separate concepts:

- `--install-scope user|workspace` selects where the client registration lives.
- `--tool-scope <scope>` controls the project MCP permission query when the URL
  does not already include one. The backward-compatible `--scope` alias remains
  available.
- Public MCP defaults to user install scope and no project tool scope.
- Project MCP defaults to workspace install scope and
  `builder,project,data` tool scope unless an exact handoff URL is supplied.
- `--exact-url` validates and preserves the handoff URL without changing it.

## Client Support

The installer fails closed when a selected client has no verified target for
the requested install scope.

| Client | User-scoped public MCP | Workspace-scoped project MCP |
|---|---|---|
| Codex CLI | Merges `~/.codex/config.toml` and installs a managed routing skill | Merges `.codex/config.toml` under `[mcp_servers.<name>]` |
| Claude Code | `claude mcp add --scope user` | Private `claude mcp add --scope local` registration verified by the installer |
| Gemini CLI | Merges `~/.gemini/settings.json` | `gemini mcp add --scope project` |
| Roo Code | Not verified; fails closed | Merges `.roo/mcp.json` |
| Cursor | Merges `~/.cursor/mcp.json` | Merges `.cursor/mcp.json` |
| Antigravity IDE | User JSON config | Not verified; fails closed |
| Antigravity CLI | User JSON config | Not verified; fails closed |
| Windsurf | User JSON config | Not verified; fails closed |
| Cline | User JSON config | Not verified; fails closed |
| Claude Desktop | User application config through pinned `pnpm dlx mcp-remote` | Not verified; fails closed |
| Zed | User JSON config | Not verified; fails closed |

Codex TOML updates preserve unrelated text and tables. The installer refuses to
replace a same-name MCP table with a different URL or modify TOML it cannot
safely understand.

## Reload Behavior

The package does not claim dynamic MCP reload for any client. JSON output marks
reload guidance as `dynamicReload: false`. After changing configuration, follow
the returned `restart_required` instruction: start a new CLI session, reload the
editor window, or reopen the desktop application as appropriate.

## Other Commands

```bash
pnpm dlx @spala-ai/mcp-install --doctor --client gemini --json
pnpm dlx @spala-ai/mcp-install --check --public --client gemini --json
pnpm dlx @spala-ai/mcp-install --uninstall --public --client gemini --yes --json
pnpm dlx @spala-ai/mcp-install --list-clients --json
```

Useful options:

- `--dry-run`: report planned changes without writing.
- `--manifest <path>`: load a local install manifest. Remote manifests are not
  accepted.
- `--cleanup-duplicates`: remove only recognized known legacy public aliases
  whose URL is byte-for-byte `https://mcp.spala.ai/mcp`.
- `--name <name>`: override a generated project MCP server name. Public installs
  always use `spala_public_mcp`.
- `--commands` / `--print-only`: print client commands without changing config.
- `--yes`: apply without an interactive prompt.

Existing JSON files are parsed with a lossless structural reader and changed
only at installer-owned endpoint fields, preserving unknown client fields,
unrelated values, large integers, and source bytes. Blank JSON files are treated
as empty configs while their exact original whitespace remains rollback data.
Symbolic links and hard-linked file targets are rejected.

Public endpoint variants, including trailing slashes, explicit public scopes,
and `--exact-url`, are stored as exactly `https://mcp.spala.ai/mcp` under
`spala_public_mcp` at user scope.

Writes use a fully written and fsynced same-directory temporary followed by an
atomic rename over the target. They never publish through hard links or
truncate the target in place. Existing bytes are copied to a timestamped
`0600` backup while the original remains available, and a fsynced lock,
journal, and backup metadata sidecar record hashes and restoration metadata.
A later operation performs one bounded recovery of recognized records left by
a dead installer, preserves a committed target or an untouched original, and
refuses unknown, conflicting, live, or externally changed state. Rollback uses
another atomic rename and restores mode, ownership, and atime/mtime where the
platform supports those operations. POSIX ctime cannot be restored, and
platform-specific ACLs, flags, birth time, and timestamp precision are not
portable; rollback never silently accepts a mode mismatch. Machine-readable
output omits merged config bodies and client credential data.

## Release

Prefer trusted publishing in CI. For a manual package release:

```bash
pnpm publish --access public --provenance
```
