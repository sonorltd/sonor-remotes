'use strict';
// Sky box IP control and discovery. No dependencies (Node 18+).
//
// Remote keys: Sky Q (main + Mini) and Sky+HD accept an RFB/VNC-style key
// protocol on TCP 49160 (Sky Q firmware 060+) or 5900 (Sky+HD, old Sky Q).
// The box greets with a 12-byte banner ("SKY 000.001\n"). The client echoes it,
// echoes the first byte of each short reply, then sends KeyEvent frames:
//   [4, down, 0, 0, 0, 0, 0xE0 + (code >> 4), code & 0x0F]  (down=1 press, 0 release)
// Status: Sky Q exposes JSON on http://<ip>:9006/as/system/information.
// Sky Stream / Sky Glass have no local IP control (IR, Bluetooth or CEC only).

const net = require('net');
const dgram = require('dgram');
const http = require('http');
const os = require('os');

const PORT_SKYQ = 49160;
const PORT_LEGACY = 5900;
const PORT_REST = 9006;

const KEYS = {
  power: 0, select: 1, backup: 2, dismiss: 2, channelup: 6, channeldown: 7,
  interactive: 8, sidebar: 8, help: 9, services: 10, search: 10,
  tvguide: 11, home: 11, i: 14, text: 15,
  up: 16, down: 17, left: 18, right: 19,
  red: 32, green: 33, yellow: 34, blue: 35,
  0: 48, 1: 49, 2: 50, 3: 51, 4: 52, 5: 53, 6: 54, 7: 55, 8: 56, 9: 57,
  play: 64, pause: 65, stop: 66, record: 67, fastforward: 69, rewind: 71,
  boxoffice: 240, sky: 241,
};

function keyFrame(code, down) {
  return Buffer.from([4, down ? 1 : 0, 0, 0, 0, 0, 224 + Math.floor(code / 16), code % 16]);
}

// Open a connection, do the handshake, call onReady(socket) once the box will take keys.
function handshake(host, port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let stage = 0; // 0 = waiting for banner, 1 = short replies, 2 = ready
    let banner = '';
    const fail = (err) => { sock.destroy(); reject(err); };
    const timer = setTimeout(() => fail(new Error(`timeout talking to ${host}:${port}`)), timeoutMs);
    sock.on('error', (e) => { clearTimeout(timer); fail(e); });
    sock.on('data', (chunk) => {
      if (stage === 0) {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 12) return;
        banner = buf.slice(0, 12).toString('latin1');
        if (!banner.startsWith('SKY')) {
          clearTimeout(timer);
          return fail(new Error(`${host}:${port} is not a Sky box (banner ${JSON.stringify(banner.trim())})`));
        }
        sock.write(buf.slice(0, 12));
        stage = 1;
        chunk = buf.slice(12);
        if (!chunk.length) return;
      }
      if (stage === 1) {
        if (chunk.length < 24) { sock.write(chunk.slice(0, 1)); return; }
        stage = 2;
        clearTimeout(timer);
        sock.removeAllListeners('data');
        resolve({ sock, banner: banner.trim() });
      }
    });
  });
}

function writeAsync(sock, b) {
  return new Promise((res, rej) => sock.write(b, (e) => (e ? rej(e) : res())));
}

async function sendKey(host, port, key) {
  const code = typeof key === 'number' ? key : KEYS[String(key).toLowerCase()];
  if (code === undefined) throw new Error(`unknown key "${key}"`);
  const { sock } = await handshake(host, port);
  try {
    await writeAsync(sock, keyFrame(code, true));
    await writeAsync(sock, keyFrame(code, false));
  } finally {
    sock.end();
    setTimeout(() => sock.destroy(), 200);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendKeys(host, port, keys, gapMs = 350) {
  for (let i = 0; i < keys.length; i++) {
    await sendKey(host, port, keys[i]);
    if (i < keys.length - 1) await sleep(gapMs);
  }
}

// Is a TCP port open? Resolves true/false.
function portOpen(host, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

// Read just the banner, to confirm a port really is a Sky box (5900 is also VNC).
function readBanner(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(null));
    s.on('error', () => done(null));
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= 12) done(buf.slice(0, 12).toString('latin1').trim());
    });
  });
}

function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 200000) req.destroy(); });
      res.on('end', () => resolve(res.statusCode === 200 ? body : null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Sky Q only: model, serial, standby state.
async function skyQInfo(host) {
  const body = await httpGet(`http://${host}:${PORT_REST}/as/system/information`);
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

function describeSkyQ(info) {
  const t = String(info.deviceType || '').toUpperCase();
  let model = 'Sky Q';
  if (t === 'GATEWAYSTB') model = 'Sky Q (main box)';
  else if (t === 'IPSETTOPBOX') model = 'Sky Q Mini';
  else if (t === 'TV') model = 'Sky Q (TV app)';
  return {
    model,
    hardware: [info.hardwareName, info.hardwareModel, info.modelNumber].filter(Boolean).join(' / '),
    serial: info.serialNumber || info.ESN || '',
    power: info.activeStandby === true ? 'standby' : 'on',
    deviceType: info.deviceType || '',
  };
}

// Work out what a given IP is and which port to use for keys.
async function probe(host, hint = {}) {
  const [q, legacy, rest] = await Promise.all([
    portOpen(host, PORT_SKYQ), portOpen(host, PORT_LEGACY), portOpen(host, PORT_REST),
  ]);
  if (!q && !legacy && !rest) return null;
  const box = { ip: host, name: hint.name || '', model: '', hardware: '', serial: '', power: 'unknown', port: null, controllable: false, notes: [] };
  if (rest) {
    const info = await skyQInfo(host);
    if (info) Object.assign(box, describeSkyQ(info));
  }
  for (const p of [q && PORT_SKYQ, legacy && PORT_LEGACY].filter(Boolean)) {
    const banner = await readBanner(host, p);
    if (banner && banner.startsWith('SKY')) { box.port = p; box.controllable = true; break; }
  }
  if (!box.model) {
    if (box.controllable && box.port === PORT_LEGACY) box.model = 'Sky+HD (or Sky Q on old firmware)';
    else if (box.controllable) box.model = 'Sky box';
    else return null; // a port was open but it isn't a Sky box (e.g. a Mac with screen sharing on 5900)
  }
  if (!box.controllable) box.notes.push('Status works but the remote port did not answer. Check the box is not in deep standby.');
  if (hint.ssdpModel && !box.hardware) box.hardware = hint.ssdpModel;
  return box;
}

function localSubnets() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ ifname, address: a.address, prefix: a.address.split('.').slice(0, 3).join('.') });
    }
  }
  return out;
}

// SSDP: Sky boxes announce NDS UPnP devices (SkyServe / SkyControl / SkyBrowse).
function ssdpSearch(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return resolve(found); }
    const targets = ['ssdp:all', 'urn:schemas-nds-com:device:SkyServe:2', 'urn:schemas-nds-com:device:SkyControl:2'];
    sock.on('error', () => { try { sock.close(); } catch {} resolve(found); });
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const get = (h) => (text.match(new RegExp(`^${h}:\\s*(.*)$`, 'im')) || [])[1] || '';
      const st = get('ST') + ' ' + get('USN') + ' ' + get('SERVER');
      if (!/nds-com|sky/i.test(st)) return;
      const e = found.get(rinfo.address) || { ip: rinfo.address, location: get('LOCATION'), ssdp: [] };
      e.ssdp.push(get('ST'));
      found.set(rinfo.address, e);
    });
    sock.bind(0, () => {
      for (const st of targets) {
        const m = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        sock.send(m, 1900, '239.255.255.250', () => {});
      }
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve(found); }, timeoutMs);
  });
}

// mDNS: Sky Stream pucks and Sky Glass advertise _rdk-rics._tcp (port 8091). We list them so the
// installer can see them; their control needs Sky's app certificate, which this tool doesn't have.
function mdnsStream(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return resolve(found); }
    const name = '_rdk-rics._tcp.local';
    const labels = Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
    // header: id 0, flags 0, 1 question; question: PTR (12), class IN with unicast-response bit
    const q = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), labels, Buffer.from([0, 12, 0x80, 1])]);
    sock.on('error', () => { try { sock.close(); } catch {} resolve(found); });
    sock.on('message', (msg, rinfo) => {
      if (!msg.includes('_rdk-rics')) return;
      const text = msg.toString('latin1');
      const mac = (text.match(/device_id=([0-9A-Fa-f:]{12,17})/) || [])[1] || '';
      found.set(rinfo.address, { ip: rinfo.address, mac });
    });
    sock.bind(0, () => { sock.send(q, 5353, '224.0.0.251', () => {}); });
    setTimeout(() => { try { sock.close(); } catch {} resolve(found); }, timeoutMs);
  });
}

function streamBox(ip, mac) {
  return { ip, name: '', model: 'Sky Stream / Sky Glass', hardware: mac ? `MAC ${mac}` : '', serial: '', power: 'on',
    port: 8091, controllable: false, notes: ['Found on the network. Control over IP is not supported in this tool yet (needs Sky app certificate). Use IR or the Chowmain driver.'] };
}

async function ssdpModel(location) {
  if (!location) return '';
  const xml = await httpGet(location, 1500);
  if (!xml) return '';
  const tag = (t) => (xml.match(new RegExp(`<${t}>([^<]*)</${t}>`, 'i')) || [])[1] || '';
  return [tag('friendlyName'), tag('modelName'), tag('modelNumber')].filter(Boolean).join(' / ');
}

// Sweep a /24 for open Sky ports. Limited concurrency so we don't flood the LAN.
async function sweep(prefix, onProgress) {
  const hosts = [];
  for (let i = 1; i < 255; i++) hosts.push(`${prefix}.${i}`);
  const hits = new Set();
  let done = 0;
  const worker = async () => {
    while (hosts.length) {
      const h = hosts.shift();
      const [a, b, c] = await Promise.all([portOpen(h, PORT_SKYQ, 500), portOpen(h, PORT_LEGACY, 500), portOpen(h, PORT_REST, 500)]);
      if (a || b || c) hits.add(h);
      done++;
      if (onProgress) onProgress(done, 254);
    }
  };
  await Promise.all(Array.from({ length: 48 }, worker));
  return [...hits];
}

// Full discovery: SSDP + subnet sweep, then probe every candidate.
async function discover({ subnets, onProgress } = {}) {
  const nets = subnets && subnets.length ? subnets : [...new Set(localSubnets().map((s) => s.prefix))];
  const [ssdp, streams, ...swept] = await Promise.all([ssdpSearch(), mdnsStream(), ...nets.map((p) => sweep(p, onProgress))]);
  const candidates = new Set([...ssdp.keys(), ...swept.flat()]);
  const boxes = [];
  await Promise.all([...candidates].map(async (ip) => {
    const s = ssdp.get(ip);
    const hint = s ? { ssdpModel: await ssdpModel(s.location) } : {};
    const box = await probe(ip, hint);
    if (box) { box.foundBy = [s && 'SSDP', swept.flat().includes(ip) && 'scan'].filter(Boolean).join(' + '); boxes.push(box); }
  }));
  for (const [ip, s] of streams) if (!boxes.find((b) => b.ip === ip)) boxes.push({ ...streamBox(ip, s.mac), foundBy: 'mDNS' });
  const ipNum = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
  boxes.sort((a, b) => ipNum(a.ip) - ipNum(b.ip));
  return { boxes, subnets: nets };
}

module.exports = { mdnsStream, streamBox, KEYS, PORT_SKYQ, PORT_LEGACY, PORT_REST, keyFrame, handshake, sendKey, sendKeys, probe, discover, localSubnets, skyQInfo, describeSkyQ, readBanner };
