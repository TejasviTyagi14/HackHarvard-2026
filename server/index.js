import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { RetellClient, normalizePhone } from './retell.js';
import { PhoneSession } from './phone-session.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
export function configuration(env) {
  const missing = ['PHOTON_PHONE_NUMBER', 'RETELL_API_KEY', 'RETELL_AGENT_ID', 'PHONE_BRIDGE_SECRET'].filter(key => !env[key]?.trim());
  if (env.PHOTON_PHONE_NUMBER) {
    try { normalizePhone(env.PHOTON_PHONE_NUMBER); } catch { missing.push('PHOTON_PHONE_NUMBER (include + and country code)'); }
  }
  if (env.PHONE_BRIDGE_SECRET && !/^[a-zA-Z0-9_-]{32,}$/.test(env.PHONE_BRIDGE_SECRET)) missing.push('PHONE_BRIDGE_SECRET (at least 32 URL-safe characters)');
  return { enabled: !missing.length, missing, number: missing.length ? null : normalizePhone(env.PHOTON_PHONE_NUMBER) };
}
function equalSecret(a, b) {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
export function allowedRequest(req) {
  // Loopback binding + Host/Origin validation prevent websites from dialing through this server.
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers['x-forwarded-for'] || req.headers['forwarded'] || req.headers['x-forwarded-host']) return false;
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return false;
  return true;
}

export function createApp({ env = process.env, api } = {}) {
  const config = configuration(env), token = randomBytes(32).toString('hex');
  api ||= new RetellClient({ apiKey: env.RETELL_API_KEY, agentId: env.RETELL_AGENT_ID, number: config.number });
  let active = null;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!allowedRequest(req)) { res.writeHead(403).end('Forbidden'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/api/phone/config') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...config, token })); return;
      }
      const name = pathname === '/' ? '/index.html' : pathname;
      // Explicit public-file allowlist: never serve .env, .git, server code, or dependencies.
      if (!/^\/(index\.html|map\.html|(?:js|css)\/[\w./-]+\.(?:js|css))$/.test(name) || name.includes('..')) {
        res.writeHead(404).end('Not found'); return;
      }
      const body = await readFile(path.join(root, name));
      res.setHeader('Content-Type', `${mime[path.extname(name)]}; charset=utf-8`);
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404).end('Not found'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const providers = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    const reject = () => { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); };
    const match = /^\/api\/retell\/llm\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]{1,150})$/.exec(req.url || '');
    if (match) {
      if (!config.enabled || !equalSecret(match[1], env.PHONE_BRIDGE_SECRET)) return reject();
      try {
        const call = await api.getCall(match[2]);
        if (call.call_id !== match[2] || !api.matches(call) || socket.destroyed) return reject();
        providers.handleUpgrade(req, socket, head, ws => {
          ws.on('error', () => {});
          if (!active?.attach(ws, call)) {
            ws.send(JSON.stringify({ response_type: 'response', response_id: 0, content: 'No camera session is available. Open Stereo Distance, select Connect incoming call, then call again.', content_complete: true, end_call: true }));
            const timer = setTimeout(() => ws.close(), 10000); timer.unref(); ws.once('close', () => clearTimeout(timer));
          }
        });
      } catch { if (!socket.destroyed) reject(); }
      return;
    }
    if (!allowedRequest(req) || req.headers.origin !== `http://${req.headers.host}` || req.url !== '/api/phone') return reject();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    let authenticated = false, call = null, lastDial = 0;
    const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    const send = (message) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { call?.end('Browser disconnected.'); });
    ws.on('close', () => { clearTimeout(authTimer); call?.end('Browser disconnected.'); });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { ws.close(1008, 'Invalid message'); return; }
      if (!msg || typeof msg !== 'object') return;
      if (!authenticated) {
        if (msg.type !== 'auth' || !equalSecret(typeof msg.token === 'string' ? msg.token : '', token)) {
          ws.close(1008, 'Unauthorized'); return;
        }
        authenticated = true; clearTimeout(authTimer); send({ type: 'ready' }); return;
      }
      if (msg.type === 'dial' || msg.type === 'listen') {
        if (!config.enabled) { send({ type: 'error', message: 'Phone calling needs setup. See Phone setup in the README.' }); return; }
        if (active) { send({ type: 'error', message: 'Another camera page is using phone mode. End that session first.' }); return; }
        if (Date.now() - lastDial < 5000) { send({ type: 'error', message: 'Wait a few seconds before connecting again.' }); return; }
        let number;
        if (msg.type === 'dial') {
          try { number = normalizePhone(msg.number); } catch (error) { send({ type: 'error', message: error.message }); return; }
        }
        lastDial = Date.now();
        const session = new PhoneSession({ api, send, onClosed: () => { if (active === session) active = null; } });
        call = active = session;
        session.start(number);
      } else if (msg.type === 'hangup') call?.end();
      else if (msg.type === 'answer') call?.answer(msg);
      else if (msg.type === 'speak') call?.speak(msg);
      else if (msg.type === 'interrupt') call?.interrupt();
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 15000);
  heartbeat.unref();
  async function close() {
    clearInterval(heartbeat);
    await active?.end('Server stopped.');
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    for (const ws of providers.clients) ws.terminate();
    providers.close();
    await new Promise((resolve) => server.close(resolve));
  }
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  const port = Number(process.env.PORT || 8766);
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Stereo Distance: http://localhost:${port}`);
    const config = configuration(process.env);
    console.log(config.enabled ? 'Photon 2.0 + Retell phone calling is configured.' : `Phone setup needed: ${config.missing.join(', ')}. See .env.example.`);
  });
  app.server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set PORT in .env to an unused port.` : 'Could not start the local server.'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit()));
}
