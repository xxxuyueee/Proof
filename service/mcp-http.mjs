
import http from 'node:http';
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 10000);
const agentId = process.env.PROOF_AGENT_ID || 'char';
const tokenFile = process.env.PROOF_AGENT_TOKEN_FILE || 'state/char.token';

const child = spawn(process.execPath, ['mcp.mjs'], {
  env: {
    ...process.env,
    PROOF_AGENT_ID: agentId,
    PROOF_AGENT_TOKEN_FILE: tokenFile,
    PROOF_API_URL: 'http://127.0.0.1:8791'
  },
  stdio: ['pipe', 'pipe', 'inherit']
});

let buffer = '';
let sequence = 0;
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    try {
      const message = JSON.parse(line);
      const callback = pending.get(message.id);
      if (callback) {
        pending.delete(message.id);
        callback(message);
      }
    } catch {}
  }
});

function request(method, params) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      return reject(new Error('MCP process unavailable'));
    }
    const id = ++sequence;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id, method, params
    }) + '\n');
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version'
  );

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const expectedKey = process.env.PROOF_MCP_SECRET;

  if (!expectedKey) {
    res.writeHead(503);
    return res.end('MCP authentication not configured');
  }

  if (req.headers.authorization !== `Bearer ${expectedKey}`) {
    res.writeHead(401);
    return res.end('Unauthorized');
  }

  if (req.url !== '/mcp' || req.method !== 'POST') {
    res.writeHead(404);
    return res.end();
  }

  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);

    if (message.method === 'notifications/initialized') {
      res.writeHead(202);
      return res.end();
    }

    if (message.id == null) {
      res.writeHead(202);
      return res.end();
    }

    const result = await request(message.method, message.params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...result, id: message.id }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: String(error.message) },
      id: null
    }));
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Proof MCP HTTP listening on ${port}`);
});
