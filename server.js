#!/usr/bin/env node
'use strict';
// Sonor Sky Remote bridge: finds Sky boxes on the LAN and controls them over IP.
// Serves the remote page locally, and (optionally) relays commands from the hosted
// page on apps.sonor.co.uk through Supabase (see lib/relay.js).
// Run: node server.js            then open http://localhost:8049 (or the LAN URL on a phone)
//      node server.js --relay "Test rig Pi"   also link this bridge to apps.sonor.co.uk

const http = require('http');
const fs = require('fs');
const path = require('path');
const sky = require('./lib/sky');

const VERSION = '1.3.0';
const PORT = Number(process.env.PORT || 8049);
const DATA = path.join(__dirname, 'boxes.json');
const PUBLIC = path.join(__dirname, 'public');

function load() { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return { boxes: [] }; } }
function save(db) { fs.writeFileSync(DATA, JSON.stringify(db, null, 2)); }
let db = load();

function upsert(box) {
  const i = db.boxes.findIndex((b) => b.ip === box.ip);
  if (i >= 0) db.boxes[i] = { ...db.boxes[i], ...box, name: db.boxes[i].name || box.name };
  else db.boxes.push(box);
  save(db);
}

let scan = { running: false, done: 0, total: 0, lastResult: null, error: null };
const listeners = new Set(); // called when boxes/scan state change (relay pushes a heartbeat)
const changed = () => listeners.forEach((f) => { try { f(); } catch {} });

async function runScan(nets) {
  scan = { running: true, done: 0, total: 254 * Math.max(nets.length || sky.localSubnets().length, 1), lastResult: null, error: null };
  changed();
  let n = 0;
  try {
    const r = await sky.discover({ subnets: nets, onProgress: () => { scan.done = ++n; } });
    r.boxes.forEach(upsert);
    scan.lastResult = { found: r.boxes.length, subnets: r.subnets, at: new Date().toISOString() };
  } catch (e) { scan.error = e.message; }
  scan.running = false;
  changed();
}

// Actions: shared by the local HTTP API and the relay. Each returns [status, body].
const actions = {
  boxes: async () => [200, { boxes: db.boxes, scan, subnets: sky.localSubnets(), version: VERSION }],

  scan: async ({ subnets } = {}) => {
    if (scan.running) return [409, { error: 'scan already running' }];
    const nets = (subnets || []).map((s) => String(s).trim().split('.').slice(0, 3).join('.')).filter((s) => /^\d+\.\d+\.\d+$/.test(s));
    runScan(nets);
    return [202, { started: true }];
  },

  add: async ({ ip, name } = {}) => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip || '')) return [400, { error: 'enter an IPv4 address' }];
    const box = await sky.probe(ip, { name });
    if (!box) return [404, { error: `No Sky box answered at ${ip} (tried ports 49160, 5900 and 9006).` }];
    if (name) box.name = name;
    upsert(box); changed();
    return [200, { box }];
  },

  rename: async ({ ip, name } = {}) => {
    const b = db.boxes.find((x) => x.ip === ip);
    if (!b) return [404, { error: 'unknown box' }];
    b.name = String(name || '').slice(0, 40); save(db); changed();
    return [200, { box: b }];
  },

  remove: async ({ ip } = {}) => {
    db.boxes = db.boxes.filter((x) => x.ip !== ip); save(db); changed();
    return [200, { ok: true }];
  },

  status: async ({ ip } = {}) => {
    const b = db.boxes.find((x) => x.ip === ip);
    if (!b) return [404, { error: 'unknown box' }];
    const fresh = await sky.probe(ip);
    if (!fresh) b.power = 'offline'; else upsert({ ...fresh, name: b.name });
    save(db); changed();
    return [200, { box: db.boxes.find((x) => x.ip === ip) }];
  },

  key: async ({ ip, keys } = {}) => {
    const b = db.boxes.find((x) => x.ip === ip);
    if (!b) return [404, { error: 'unknown box' }];
    const list = Array.isArray(keys) ? keys : [keys];
    const ports = b.port ? [b.port, b.port === sky.PORT_SKYQ ? sky.PORT_LEGACY : sky.PORT_SKYQ] : [sky.PORT_SKYQ, sky.PORT_LEGACY];
    let lastErr;
    for (const p of ports) {
      try {
        await sky.sendKeys(ip, p, list);
        if (b.port !== p) { b.port = p; b.controllable = true; save(db); }
        return [200, { ok: true, port: p }];
      } catch (e) { lastErr = e; if (/unknown key/.test(e.message)) break; }
    }
    return [502, { error: lastErr ? lastErr.message : 'failed' }];
  },
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/(\w+)$/);
  if (m && actions[m[1]] && (req.method === 'POST' || m[1] === 'boxes')) {
    try { const [code, obj] = await actions[m[1]](req.method === 'POST' ? await readBody(req) : {}); json(res, code, obj); }
    catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); }
    return;
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nSonor Sky Remote bridge v${VERSION} running.`);
    console.log(`  On this computer:  http://localhost:${PORT}`);
    for (const s of sky.localSubnets()) console.log(`  On a phone (${s.ifname}): http://${s.address}:${PORT}`);
    console.log('');
  });
  const i = process.argv.indexOf('--relay');
  if (i > 0 || process.env.SKY_RELAY) {
    const name = (i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[i + 1] : (process.env.SKY_RELAY_NAME || require('os').hostname());
    require('./lib/relay').start({ name, actions, onChange: (f) => listeners.add(f), version: VERSION, dir: __dirname });
  }
}

module.exports = { server, actions, onChange: (f) => listeners.add(f), VERSION };
