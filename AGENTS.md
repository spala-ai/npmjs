# Repository Scope

This repository owns the public npm package `@spala-ai/mcp-install`.

It configures supported MCP clients and delegates authentication to those
clients. It does not implement the public Spala MCP service, the Spala platform,
or project MCP tools. Do not copy those implementations into this repository.

Before committing, run:

```bash
pnpm install --frozen-lockfile
pnpm run ci
```

Claude Code registry identity is the main checkout’s physical path, while
Spala binding/recovery identity stays in the worktree. Keep those paths separate
and cover registration changes with real Git worktree tests.
