#!/usr/bin/env node
'use strict';
// Sonor Remotes bridge: finds controllable AV kit on the LAN (Sky, Denon / Marantz, Yamaha, Onkyo / Pioneer, LG, Samsung,
// Sony, Roku, Sonos, PJLink and JVC projectors) and drives it over IP.
// Serves the remote page locally, and (optionally) relays commands from the hosted
// page on apps.sonor.co.uk through Supabase (see lib/relay.js).
// Run: node server.js            then open http://localhost:8049 (or the LAN URL on a phone)
//      node server.js --relay "Test rig Pi"   also link this bridge to apps.sonor.co.uk

const http = require('http');
const fs = require('fs');
const path = require('path');

const drivers = require('./lib/drivers');

const VERSION = '2.3.0';
const PORT = Number(process.env.PORT || 8049);
const DATA = path.join(__dirname, 'remote.json');
const LEGACY = path.join(__dirname, 'boxes.json');
const PUBLIC = path.join(__dirname, 'public');

// remote.json = every device found or added, with its driver and pairing (client keys, PSK, passwords). Stays on this machine.
function load() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
  try { const old = JSON.parse(fs.readFileSync(LEGACY, 'utf8')); return { devices: (old.boxes || []).map((b) => ({ ...b, driver: 'sky', make: 'Sky', kind: 'Satellite' })) }; } catch {}
  return { devices: [] };
}
function save(db) { fs.writeFileSync(DATA, JSON.stringify(db, null, 2)); }
let db = load();
const find = (ip) => db.devices.find((d) => d.ip === ip);
const pub = (d) => { const { auth, ...rest } = d; return { ...rest, paired: !!(auth && Object.keys(auth).length), caps: drivers.caps(d) }; };

function upsert(dev) {
  const i = db.devices.findIndex((b) => b.ip === dev.ip);
  if (i >= 0) { const o = db.devices[i]; db.devices[i] = { ...o, ...dev, name: o.name || dev.name, auth: o.driver === dev.driver ? o.auth : dev.auth }; }
  else db.devices.push(dev);
  save(db);
}

let scan = { running: false, done: 0, total: 0, phase: '', lastResult: null, error: null };
const listeners = new Set(); // called when devices/scan state change (relay pushes a heartbeat)
const changed = () => listeners.forEach((f) => { try { f(); } catch {} });

async function runScan(nets) {
  scan = { running: true, done: 0, total: 254 * Math.max(nets.length || drivers.localSubnets().length, 1), phase: 'sweep', lastResult: null, error: null };
  changed();
  try {
    const r = await drivers.discover({ subnets: nets, onProgress: (d, t, ph) => { scan.done = d; scan.total = t; scan.phase = ph; } });
    r.devices.forEach(upsert);
    scan.lastResult = { found: r.devices.length, subnets: r.subnets, answered: r.answered, at: new Date().toISOString() };
  } catch (e) { scan.error = e.message; }
  scan.running = false;
  changed();
}
const drv = (d) => drivers.BY_ID[d.driver];

// Actions: shared by the local HTTP API, the relay and the Android app. Each returns [status, body].
const actions = {
  devices: async () => [200, { devices: db.devices.map(pub), scan, subnets: drivers.localSubnets(), drivers: drivers.DRIVERS.map((d) => ({ id: d.id, make: d.make, kind: d.kind })), version: VERSION }],

  scan: async ({ subnets } = {}) => {
    if (scan.running) return [409, { error: 'A scan is already running' }];
    const nets = (subnets || []).map((s) => String(s).trim().split('.').slice(0, 3).join('.')).filter((s) => /^\d+\.\d+\.\d+$/.test(s));
    runScan(nets);
    return [202, { started: true }];
  },

  add: async ({ ip, name, driver } = {}) => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip || '')) return [400, { error: 'Enter an IPv4 address' }];
    const dev = await drivers.identify(ip, { only: driver || null });
    if (!dev) return [404, { error: `Nothing controllable answered at ${ip}${driver ? ' as ' + drivers.BY_ID[driver].make : ''}. Checked ports ${drivers.PORTS.join(', ')}.` }];
    if (name) dev.name = name;
    upsert(dev); changed();
    return [200, { device: pub(find(ip)) }];
  },

  rename: async ({ ip, name } = {}) => { const d = find(ip); if (!d) return [404, { error: 'Unknown device' }]; d.name = String(name || '').slice(0, 40); save(db); changed(); return [200, { device: pub(d) }]; },
  remove: async ({ ip } = {}) => { db.devices = db.devices.filter((x) => x.ip !== ip); save(db); changed(); return [200, { ok: true }]; },
  setmac: async ({ ip, mac } = {}) => { const d = find(ip); if (!d) return [404, { error: 'Unknown device' }]; d.mac = String(mac || '').toUpperCase(); save(db); return [200, { device: pub(d) }]; },

  status: async ({ ip } = {}) => {
    const d = find(ip); if (!d) return [404, { error: 'Unknown device' }];
    try { d.state = { ...(await drv(d).status(d)), at: new Date().toISOString() }; } catch (e) { d.state = { power: 'unknown', error: e.message, at: new Date().toISOString() }; }
    save(db); changed(); return [200, { device: pub(d) }];
  },

  pair: async ({ ip, ...data } = {}) => {
    const d = find(ip); if (!d) return [404, { error: 'Unknown device' }];
    if (!drv(d).pair) return [400, { error: 'This device does not need pairing' }];
    try { await drv(d).pair(d, data); d.needsPair = false; save(db); changed(); return [200, { device: pub(d) }]; }
    catch (e) { save(db); return [502, { error: e.message }]; }
  },

  key: async ({ ip, keys } = {}) => {
    const d = find(ip); if (!d) return [404, { error: 'Unknown device' }];
    const list = Array.isArray(keys) ? keys : [keys];
    try { for (const k of list) { await drv(d).send(d, String(k)); if (list.length > 1) await new Promise((r) => setTimeout(r, 300)); } save(db); return [200, { ok: true }]; }
    catch (e) { save(db); return [e.needsPair ? 409 : 502, { error: e.message, needsPair: !!e.needsPair }]; }
  },
};
actions.boxes = actions.devices; // the relay and older pages ask for "boxes"

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
  if (m && actions[m[1]] && (req.method === 'POST' || m[1] === 'boxes' || m[1] === 'devices')) {
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
    console.log(`\nSonor Remotes bridge v${VERSION} running.`);
    console.log(`  On this computer:  http://localhost:${PORT}`);
    for (const s of drivers.localSubnets()) console.log(`  On a phone (${s.ifname}): http://${s.address}:${PORT}`);
    console.log('');
  });
  const i = process.argv.indexOf('--relay');
  if (i > 0 || process.env.SKY_RELAY) {
    const name = (i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[i + 1] : (process.env.SKY_RELAY_NAME || require('os').hostname());
    require('./lib/relay').start({ name, actions, onChange: (f) => listeners.add(f), version: VERSION, dir: __dirname });
  }
}

module.exports = { server, actions, onChange: (f) => listeners.add(f), VERSION };
