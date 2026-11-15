
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const env = {
  ...process.env,
  PROOF_HOST: '127.0.0.1',
  PROOF_PORT: '8791',
  PROOF_AGENT_ID: process.env.PROOF_AGENT_ID || 'char',
  PROOF_AGENT_TOKEN_FILE: 'state/char.token'
};

const service = spawn(process.execPath, ['server.mjs'], {
  env,
  stdio: 'inherit'
});

async function main() {
  for (let i = 0; i < 60; i++) {
    if (service.exitCode !== null) {
      throw new Error('Proof Service exited');
    }

    try {
      const response = await fetch('http://127.0.0.1:8791/agent/home');
      if (response.status !== 404) break;
    } catch {}

    await sleep(1000);
  }

  if (!existsSync(env.PROOF_AGENT_TOKEN_FILE)) {
    throw new Error('Agent token not found');
  }

  const bridge = spawn(process.execPath, ['mcp-http.mjs'], {
    env,
    stdio: 'inherit'
  });

  bridge.on('exit', code => {
    console.error('MCP bridge exited:', code);
    service.kill();
    process.exit(1);
  });
}

main().catch(error => {
  console.error(error);
  service.kill();
  process.exit(1);
});
