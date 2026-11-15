
import http from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

const port = Number(process.env.PORT || 10000);
const secret = process.env.PROOF_MCP_SECRET;

if (!secret) {
  throw new Error('PROOF_MCP_SECRET is required');
}

const child = spawn(process.execPath, ['mcp.mjs'], {
  env: {
    ...process.env,
    PROOF_AGENT_ID: process.env.PROOF_AGENT_ID || 'char',
    PROOF_AGENT_TOKEN_FILE:
      process.env.PROOF_AGENT_TOKEN_FILE || 'state/char.token',
    PROOF_API_URL: 'http://127.0.0.1:8791'
  },
  stdio: ['pipe', 'pipe', 'inherit']
});

const pending = new Map();
let buffer = '';
let sequence = 0;
let alive = true;

function failPending(error) {
  alive = false;

  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  pending.clear();
}

child.on('error', error => failPending(error));

child.on('exit', code => {
  failPending(new Error(`MCP process exited: ${code}`));
});

child.stdout.setEncoding('utf8');

child.stdout.on('data', chunk => {
  buffer += chunk;
  let index;

  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);

    try {
      const message = JSON.parse(line);
      const entry = pending.get(message.id);

      if (!entry) continue;

      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    } catch {
      // Ignore non-JSON lines.
    }
  }
});

function callMcp(method, params) {
  return new Promise((resolve, reject) => {
    if (!alive || !child.stdin.writable) {
      return reject(new Error('MCP unavailable'));
    }

    const id = ++sequence;

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('MCP request timed out'));
    }, 15000);

    pending.set(id, { resolve, reject, timer });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      }) + '\n',
      error => {
        if (error && pending.has(id)) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      }
    );
  });
}

function authorized(header) {
  const supplied =
    typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice(7)
      : '';

  const a = Buffer.from(supplied);
  const b = Buffer.from(secret);

  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Mcp-Session-Id, MCP-Protocol-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.writeHead(204).end();
  }

  if (req.url === '/health' && req.method === 'GET') {
    return json(res, alive ? 200 : 503, { ok: alive });
  }

  if (req.url !== '/mcp') {
    return json(res, 404, { error: 'Not found' });
  }

  if (!authorized(req.headers.authorization)) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  try {
    let raw = '';

    for await (const chunk of req) {
      raw += chunk;

      if (raw.length > 1024 * 1024) {
        return json(res, 413, {
          error: 'Payload too large'
        });
      }
    }

    const message = JSON.parse(raw);

    if (
      Array.isArray(message) ||
      !message ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string'
    ) {
      return json(res, 400, {
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: {
          code: -32600,
          message: 'Invalid request'
        }
      });
    }

    if (message.id === undefined) {
      return res.writeHead(202).end();
    }

    const result = await callMcp(
      message.method,
      message.params
    );

    return json(res, 200, {
      ...result,
      id: message.id
    });
  } catch (error) {
    return json(res, 500, {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32603,
        message: error.message
      }
    });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Proof MCP HTTP listening on ${port}`);
});

process.on('SIGTERM', () => {
  child.kill();
  server.close();
});
