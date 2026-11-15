
import { spawn } from 'node:child_process';

const env = {
  ...process.env,
  PROOF_HOST: '127.0.0.1',
  PROOF_PORT: '8791'
};

const service = spawn(process.execPath, ['server.mjs'], {
  env,
  stdio: 'inherit'
});

const bridge = spawn(process.execPath, ['mcp-http.mjs'], {
  env,
  stdio: 'inherit'
});

for (const child of [service, bridge]) {
  child.on('exit', (code) => {
    console.error(`Proof process exited: ${code}`);
    service.kill();
    bridge.kill();
    process.exit(code || 1);
  });
}
