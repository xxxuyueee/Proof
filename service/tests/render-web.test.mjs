import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebHandler } from '../web-http.mjs';

test('web boundary: private writes, public capabilities, path and origin restrictions', async t => {
  const seen = [];
  const backend = http.createServer(async (req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const env = { PROOF_WEB_USER: 'owner', PROOF_WEB_PASSWORD: 'test-only-long-password-123', PROOF_PUBLIC_DRINK_URL: 'https://proof.example/proof/drink/' };
  const handler = createWebHandler({ env, api: `http://127.0.0.1:${backend.address().port}` });
  const front = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  front.listen(0, '127.0.0.1'); await once(front, 'listening');
  t.after(() => { front.closeAllConnections(); front.close(); backend.closeAllConnections(); backend.close(); });
  const base = `http://127.0.0.1:${front.address().port}`;
  const authorization = 'Basic ' + Buffer.from(`${env.PROOF_WEB_USER}:${env.PROOF_WEB_PASSWORD}`).toString('base64');
  for (const [path, method] of [['/', 'GET'], ['/proof-engine.js', 'GET'], ['/proof-api/human/menu', 'GET'], ['/proof-api/human/offers', 'POST'], ['/proof-api/human/menu', 'POST'], ['/proof-api/human/admin/password', 'POST']]) {
    assert.equal((await fetch(base + path, { method })).status, 401, path);
  }
  assert.equal(seen.length, 0);
  assert.equal((await fetch(base + '/', { headers: { authorization: 'Bearer mcp-test-secret' } })).status, 401);
  assert.equal((await fetch(base + '/', { headers: { cookie: 'proof_web=forged.invalid' } })).status, 401);
  const page = await fetch(base + '/', { headers: { authorization } });
  assert.equal(page.status, 200); assert.match(await page.text(), /proof-engine.js/);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  assert.match(page.headers.get('set-cookie'), /Secure/);
  assert.equal((await fetch(base + '/proof-engine.js?v=1', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(base + '/proof/drink/')).status, 200);
  assert.equal((await fetch(base + '/proof-api/human/offers', { method: 'POST', headers: { cookie, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/proof-api/human/offers', { method: 'POST', headers: { cookie, origin: 'https://proof.example' }, body: '{}' })).status, 200);
  assert.equal((await fetch(base + '/proof-api/human/session', { method: 'POST', headers: { cookie, authorization: 'Bearer admin-test' } })).status, 200);
  assert.equal(seen.at(-1).headers.authorization, 'Bearer admin-test');
  for (const path of ['/proof-api/agent/state', '/proof-api/v1/chat/completions', '/proof-api/human/unknown', '/proof-api/human/menu%2f..%2fagent', '/state/char.token', '/server.mjs']) {
    assert.equal((await fetch(base + path, { headers: { authorization } })).status, 404, path);
  }
  assert.equal((await fetch(base + '/proof-api/capability/offer', { method: 'POST', headers: { authorization: 'Bearer cup-test', cookie }, body: '{}' })).status, 200);
  assert.equal(seen.at(-1).headers.authorization, 'Bearer cup-test');
  assert.equal(seen.at(-1).headers.cookie, undefined);
});

test('actual Render launcher: MCP authentication and drink link lifecycle', async t => {
  const state = await mkdtemp(join(tmpdir(), 'proof-render-'));
  const reserve = http.createServer(); reserve.listen(0); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, ['start-render.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), PROOF_DATA_DIR: state, PROOF_AGENT_TOKEN_FILE: join(state, 'char.token'), PROOF_MCP_SECRET: 'mcp-test-secret', PROOF_WEB_USER: 'owner', PROOF_WEB_PASSWORD: 'test-only-long-password-123', RENDER_EXTERNAL_URL: 'https://proof.example', PROOF_TEST_FIXED_CUP_IDS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = ''; child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  t.after(async () => { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; await rm(state, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, logs);
  assert.equal((await fetch(base + '/mcp', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/mcp', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(base + '/mcp', { headers: { authorization: 'Bearer mcp-test-secret' } })).status, 405);
  const rpc = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer mcp-test-secret' }, body: JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'tools/list', params: {} }) });
  const data = await rpc.json(); assert.equal(rpc.status, 200); assert.equal(data.id, 17); assert.ok(data.result.tools.length);
  assert.equal((await fetch(base + '/mcp', { method: 'OPTIONS' })).status, 204);
  assert.equal((await fetch(base + '/proof-api/human/offers', { method: 'POST', body: '{}' })).status, 401);
  const authorization = 'Basic ' + Buffer.from('owner:test-only-long-password-123').toString('base64');
  const made = await fetch(base + '/proof-api/human/offers', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Test', parts: [{ id: '柠檬汁', volume: 60 }] }) });
  const offer = await made.json(); assert.equal(made.status, 201, JSON.stringify(offer));
  assert.ok(offer.link.startsWith('https://proof.example/proof/drink/#'));
  const token = new URL(offer.link).hash.slice(1);
  assert.equal((await fetch(base + '/proof-api/capability/offer')).status, 401);
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  assert.equal((await fetch(base + '/proof-api/capability/offer', { headers })).status, 200);
  assert.equal((await fetch(base + '/proof-api/capability/offer', { method: 'POST', headers, body: JSON.stringify({ action: 'drink' }) })).status, 200);
  assert.equal((await fetch(base + '/health')).status, 200);
});

 test('missing web credentials fail closed without hiding public drink page', async t => {
  const handler = createWebHandler({ env: {} });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/')).status, 503);
  assert.equal((await fetch(base + '/proof-api/human/menu')).status, 503);
  assert.equal((await fetch(base + '/proof/drink/')).status, 200);
});
