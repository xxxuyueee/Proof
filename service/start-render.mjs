
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const env = {
  ...process.env,
  PROOF_HOST: '127.0.0.1',
  PROOF_PORT: '8791',
  PROOF_AGENT_ID: process.env.PROOF_AGENT_ID || 'char',
  PROOF_AGENT_TOKEN_FILE: process.env.PROOF_AGENT_TOKEN_FILE || 'state/char.token'
};

if (!env.PROOF_MCP_SECRET) {
  console.error('Missing PROOF_MCP_SECRET');
  process.exit(1);
}

const service = spawn(process.execPath, ['server.mjs'], {
  env,
  stdio: 'inherit'
});

let bridge;
let shuttingDown = false;

function shutdown(code = 1) {
  if (shuttingDown) return;
  shuttingDown = true;
  bridge?.kill();
  service.kill();
  process.exitCode = code;
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

service.on('exit', code => {
  console.error('Proof Service stopped:', code);
  shutdown(1);
});

async function main() {
  let ready = false;

  for (let i = 0; i < 90; i++) {
    if (service.exitCode !== null || shuttingDown) return;

    try {
      await fetch('http://127.0.0.1:8791/', {
        signal: AbortSignal.timeout(1000)
      });

      if (existsSync(env.PROOF_AGENT_TOKEN_FILE)) {
        ready = true;
        break;
      }
    } catch {
      // Service is still starting.
    }

    await sleep(1000);
  }

  if (!ready) {
    throw new Error(
      `Proof service/token not ready: ${env.PROOF_AGENT_TOKEN_FILE}`
    );
  }

  bridge = spawn(process.execPath, ['mcp-http.mjs'], {
    env,
    stdio: 'inherit'
  });

  bridge.on('exit', code => {
    console.error('MCP bridge stopped:', code);
    shutdown(1);
  });
}

main().catch(error => {
  console.error(error);
  shutdown(1);
});
