import { createInstallPlan, installPlan, PUBLIC_MCP_URL, PUBLIC_SERVER_NAME } from '../src/installer.js';

const [home, crashPoint] = process.argv.slice(2);
const [crashStage, rawOccurrence = '1'] = String(crashPoint || '').split(':');
const crashOccurrence = Number(rawOccurrence);
if (!home || !crashStage) process.exit(2);
if (!Number.isSafeInteger(crashOccurrence) || crashOccurrence < 1) process.exit(2);

const plan = createInstallPlan({
  clientSelection: 'gemini',
  env: { SPALA_MCP_INSTALL_HOME: home },
  mcpUrl: PUBLIC_MCP_URL,
  scope: '',
  serverName: PUBLIC_SERVER_NAME,
});

installPlan(plan, {
  fileOperationHook: (() => {
    let occurrence = 0;
    return stage => {
      if (stage !== crashStage) return;
      occurrence += 1;
      if (occurrence === crashOccurrence) process.exit(86);
    };
  })(),
});

process.exit(3);
