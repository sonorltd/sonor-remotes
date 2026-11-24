'use strict';
// Small network helpers shared by the remote drivers. Node built-ins only (the Android app shims the same modules).
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const crypto = require('crypto');

// Open a TCP socket, optionally wait for a greeting, write each payload and collect the reply until `until` matches
// or the timeout passes. Returns the reply text (latin1). Used by Denon, Onkyo, PJLink, JVC, Global Caché.
function tcpTalk(host, port, { send = [], until = null, greet = false, timeout = 2500, settle = 450, binary = false, onData = null } = {}) {
  // until = null: write every payload (60 ms apart), then collect replies for `settle` ms.
  // until = /re/: write one payload at a time and wait for a reply matching it before the next.
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    let buf = Buffer.alloc(0); let done = false; let step = 0; let mark = 0; const list = Array.isArray(send) ? send : [send];
    const finish = (err) => { if (done) return; done = true; clearTimeout(t); s.destroy(); err ? reject(err) : resolve(binary ? buf : buf.toString('latin1')); };
    const t = setTimeout(() => (buf.length || !until ? finish() : finish(new Error(`No answer from ${host}:${port}`))), timeout);
    const write = (p) => { try { s.write(typeof p === 'function' ? p(buf) : p); } catch (e) { finish(e); } };
    const start = () => {
      if (until) { if (list.length) { mark = buf.length; write(list[step++]); } return; }
      list.forEach((p, i) => setTimeout(() => { if (!done) write(p); }, i * 60));
      setTimeout(() => finish(), list.length * 60 + settle);
    };
    s.on('connect', () => { if (!greet) start(); });
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (onData) { const r = onData(buf, s); if (r === 'done') return finish(); if (r === 'wait') return; }
      if (greet && step === 0 && !s._started) { s._started = true; return start(); }
      if (until && until.test(buf.slice(mark).toString('latin1'))) { if (step < list.length) { mark = buf.length; write(list[step++]); } else finish(); }
    });
    s.on('error', (e) => finish(e.code === 'ECONNREFUSED' ? new Error(`${host}:${port} refused the connection`) : e));
  });
}

function portOpen(host, port, timeout = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port }); const t = setTimeout(() => { s.destroy(); resolve(false); }, timeout);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

// HTTP(S) request. LAN devices use self-signed certificates, so certificates are not checked (LAN only).
function request(method, url, { body = null, headers = {}, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const mod = u.protocol === 'https:' ? https : http;
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = mod.request(u, { method, timeout, rejectUnauthorized: false, headers: { ...(data ? { 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; if (b.length > 2e6) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: b, json: () => { try { return JSON.parse(b); } catch { return null; } } }));
    });
    req.on('timeout', () => req.destroy(new Error(`${u.host} did not answer`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Minimal WebSocket client (RFC 6455): text frames, client masking, ping/pong. Enough for LG webOS and Samsung Tizen.
function websocket(url, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const secure = u.protocol === 'wss:'; const port = Number(u.port || (secure ? 443 : 80));
    const key = crypto.randomBytes(16).toString('base64');
    const sock = secure ? tls.connect({ host: u.hostname, port, rejectUnauthorized: false, servername: '' }) : net.connect({ host: u.hostname, port });
    let buf = Buffer.alloc(0); let open = false; const handlers = { message: [], close: [] };
    const t = setTimeout(() => { sock.destroy(); reject(new Error(`${u.host} did not open a WebSocket`)); }, timeout);
    sock.on(secure ? 'secureConnect' : 'connect', () => {
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    const api = {
      send(text) { const p = Buffer.from(text); const mask = crypto.randomBytes(4); let h;
        if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
        else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
        else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
        const m = Buffer.from(p); for (let i = 0; i < m.length; i++) m[i] ^= mask[i % 4];
        sock.write(Buffer.concat([h, mask, m])); },
      on(ev, f) { (handlers[ev] = handlers[ev] || []).push(f); return api; },
      close() { try { sock.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0])); } catch {} sock.end(); setTimeout(() => sock.destroy(), 200); },
      // Send and wait for the first message that `match` accepts.
      ask(text, match, ms = 5000) { return new Promise((res, rej) => { const tt = setTimeout(() => rej(new Error('No reply')), ms); const f = (m) => { let j; try { j = JSON.parse(m); } catch { return; } if (match(j)) { clearTimeout(tt); handlers.message = handlers.message.filter((x) => x !== f); res(j); } }; handlers.message.push(f); if (text != null) api.send(text); }); },
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n'); if (end < 0) return;
        const head = buf.slice(0, end).toString();
        if (!/^HTTP\/1\.1 101/.test(head)) { clearTimeout(t); sock.destroy(); return reject(new Error('WebSocket refused: ' + head.split('\r\n')[0])); }
        open = true; buf = buf.slice(end + 4); clearTimeout(t); resolve(api);
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f; let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf[1] & 0x80) off += 4; // servers don't mask, but be safe
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len); buf = buf.slice(off + len);
        if (op === 0x1 || op === 0x2) handlers.message.forEach((f) => f(payload.toString()));
        else if (op === 0x9) { const p = Buffer.from([0x8a, 0x80, 0, 0, 0, 0]); sock.write(p); }
        else if (op === 0x8) { sock.end(); }
      }
    });
    sock.on('close', () => handlers.close.forEach((f) => f()));
    sock.on('error', (e) => { clearTimeout(t); if (!open) reject(e); });
  });
}

// Wake-on-LAN: TVs that are off (LG, Samsung, Sony) only wake this way.
function wol(mac, broadcasts = ['255.255.255.255']) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, ''); if (hex.length !== 12) return Promise.reject(new Error('No MAC address for this device, so it cannot be woken over the network'));
  const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(hex, 'hex'))]);
  return new Promise((resolve) => { const s = dgram.createSocket('udp4'); s.bind(() => { s.setBroadcast(true); let n = 0; for (const b of broadcasts) for (const p of [9, 7]) s.send(pkt, p, b, () => { if (++n === broadcasts.length * 2) { s.close(); resolve(true); } }); }); });
}

// MAC address of a host we have just talked to, from the OS neighbour (ARP) table. '' when unknown (other subnet, tablet without access).
async function macOf(ip) {
  const norm = (m) => (m && !/^0{1,2}([:-]0{1,2}){5}$/.test(m) ? m.split(/[:-]/).map((x) => x.padStart(2, '0')).join(':').toUpperCase() : '');
  try { const t = require('fs').readFileSync('/proc/net/arp', 'utf8'); const row = t.split('\n').find((l) => l.split(/\s+/)[0] === ip); if (row) return norm(row.split(/\s+/)[3]); } catch {}
  try { const cp = require('child_process'); const out = await new Promise((r) => cp.execFile('arp', process.platform === 'win32' ? ['-a', ip] : ['-n', ip], { timeout: 1500 }, (e, o) => r(e ? '' : String(o))));
    const m = out.match(/([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}/i); return m ? norm(m[0]) : ''; } catch { return ''; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { tcpTalk, portOpen, request, websocket, wol, sleep, macOf };
