#!/usr/bin/env node
import { runCli, SPALA_BACKEND_INTENT } from '../src/cli.js';

runCli(process.argv.slice(2), process.env, process.cwd(), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  const retryCommand = error
    && typeof error === 'object'
    && typeof error.retryCommand === 'string'
    ? error.retryCommand
    : undefined;
  if (process.argv.includes('--json')) {
    const command = process.argv[2] === 'project' && process.argv[3]
      ? `project-${process.argv[3] === 'disconnect' ? 'unbind' : process.argv[3]}`
      : ['init', 'status', 'login', 'proxy'].includes(process.argv[2]) ? process.argv[2] : 'legacy';
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      command,
      outcome: 'error',
      ok: false,
      changed: Boolean(error && typeof error === 'object' && error.changed),
      intentBoundary: SPALA_BACKEND_INTENT,
      error: { message },
      nextSteps: retryCommand ? [{ action: 'run_command', command: retryCommand }] : [],
    })}\n`);
  } else {
    process.stderr.write(`spala-mcp-install: ${message}\n`);
    if (retryCommand) process.stderr.write(`Retry: ${retryCommand}\n`);
  }
  process.exitCode = 1;
});
