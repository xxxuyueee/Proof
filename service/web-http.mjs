import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { signSession, verifySession } from './lib/adminAuth.mjs';

const assets = new Map([
  ['/', ['../ui/index.html', 'text/html; charset=utf-8', false]],
  ['/index.html', ['../ui/index.html', 'text/html; charset=utf-8', false]],
  ['/proof-engine.js', ['../ui/proof-engine.js', 'text/javascript; charset=utf-8', false]],
  ['/drink-visuals.js', ['../ui/drink-visuals.js', 'text/javascript; charset=utf-8', false]],
  ['/proof/drink/', ['../ui/drink/index.html', 'text/html; charset=utf-8', true]]
]);
const routes = [
  ['GET', /^\/human\/(agents|menu|offers|auth-status)$/],
  ['POST', /^\/human\/(offers|menu|session|admin\/password)$/],
  ['POST', /^\/human\/offers\/[\w-]+\/link$/],
  ['PATCH', /^\/human\/(menu|visibility)\/[\w-]+$/],
  ['DELETE', /^\/human\/menu\/[\w-]+$/],
  ['POST', /^\/human\/menu\/[\w-]+\/proposals$/],
  ['POST', /^\/human\/agents\/[\w-]+\/(reset|injection)$/]
];
const digest = value => createHash('sha256').update(value).digest();

// This boundary protects even upstream human writes that do not require an admin.
// Missing configuration closes only the web bar; MCP remains independent.
export function createWebHandler({ env = process.env, api = 'http://127.0.0.1:8791' } = {}) {
  const user = env.PROOF_WEB_USER;
  const password = env.PROOF_WEB_PASSWORD;
  let publicOrigin = null;
  try {
    const url = new URL(env.PROOF_PUBLIC_DRINK_URL);
    if (url.protocol === 'https:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) && url.pathname === '/proof/drink/' && !url.search && !url.hash && !url.username && !url.password) publicOrigin = url.origin;
  } catch { /* Invalid web configuration must not interrupt MCP. */ }
  const configured = !!user && !!password && password.length >= 20 && !!publicOrigin;
  const key = configured ? digest(`proof-web:${user}:${password}`).toString('hex') : '';
  return async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: body }));
    };
    try {
      const url = new URL(req.url, 'http://local');
      const path = url.pathname;
      const asset = assets.get(path);
      const isApi = path.startsWith('/proof-api/');
      if (!asset && !isApi && path !== '/proof/drink') return false;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      if (path === '/proof/drink') {
        res.writeHead(308, { Location: '/proof/drink/' }); res.end(); return true;
      }
      const upstreamPath = path.slice('/proof-api'.length);
      const publicApi = isApi && upstreamPath === '/capability/offer' && ['GET', 'POST'].includes(req.method);
      if (isApi && !publicApi && !routes.some(([method, pattern]) => method === req.method && pattern.test(upstreamPath))) {
        reply(404, 'Not found'); return true;
      }
      if (!asset?.[2] && !publicApi) {
        if (!configured) { reply(503, 'Web bar is not configured'); return true; }
        const basic = req.headers.authorization || '';
        const expected = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
        const basicOK = timingSafeEqual(digest(basic), digest(expected));
        const cookie = /(?:^|;\s*)proof_web=([^;]+)/.exec(req.headers.cookie || '')?.[1];
        if (!basicOK && !verifySession(key, cookie)) {
          res.setHeader('WWW-Authenticate', 'Basic realm="Proof bar", charset="UTF-8"');
          reply(401, 'Unauthorized'); return true;
        }
        if (basicOK) {
          const token = signSession(key, { exp: Date.now() + 8 * 3600000 });
          res.setHeader('Set-Cookie', `proof_web=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
        }
        if (isApi && !['GET', 'HEAD'].includes(req.method)) {
          const origin = req.headers.origin;
          const allowedOrigin = publicOrigin;
          if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== allowedOrigin)) {
            reply(403, 'Origin rejected'); return true;
          }
        }
      }
      if (asset) {
        if (!['GET', 'HEAD'].includes(req.method)) { reply(405, 'Method not allowed'); return true; }
        const bytes = await readFile(new URL(asset[0], import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1] });
        res.end(req.method === 'HEAD' ? undefined : bytes); return true;
      }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { reply(413, 'Payload too large'); return true; }
        chunks.push(chunk);
      }
      const headers = {};
      for (const name of ['content-type', 'authorization', 'idempotency-key']) {
        if (req.headers[name] && !(name === 'authorization' && req.headers[name].startsWith('Basic '))) headers[name] = req.headers[name];
      }
      if (!publicApi && req.headers.cookie) headers.cookie = req.headers.cookie;
      const upstream = await fetch(`${api}${upstreamPath}${url.search}`, {
        method: req.method, headers, redirect: 'error', signal: AbortSignal.timeout(15000),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
      });
      const responseHeaders = { 'Content-Type': upstream.headers.get('content-type') || 'application/json' };
      const cookie = upstream.headers.get('set-cookie');
      if (!publicApi && cookie) responseHeaders['Set-Cookie'] = cookie + '; Secure';
      res.writeHead(upstream.status, responseHeaders);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      if (!res.headersSent) reply(502, 'Web upstream unavailable');
      else res.end();
    }
    return true;
  };
}
