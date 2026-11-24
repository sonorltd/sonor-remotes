'use strict';
// Driver registry + discovery. Every driver: { id, make, kind, ports, detect(ip, openPorts, hint), caps(dev), status(dev), send(dev, key), pair?(dev, data) }.
// Key words are shared across drivers so the page can draw one remote: power poweron poweroff up down left right select back home menu info guide exit
// volup voldown mute chup chdown play pause stop rew ff prev next rec 0-9 red green yellow blue source, plus input:<id> mode:<id> vol:<n> app:<id>.
const os = require('os');
const { portOpen } = require('../conn');
const { denon, yamaha, onkyo } = require('./avr');
const { lg, samsung, sony, roku } = require('./tv');
const { pjlink, jvc, sonos, sky } = require('./other');

// Order matters: the first driver whose detect() answers wins for an IP (Sky before generic web, Sony before Yamaha on port 80…).
const DRIVERS = [sky, denon, onkyo, samsung, lg, roku, sonos, sony, yamaha, pjlink, jvc];
const BY_ID = Object.fromEntries(DRIVERS.map((d) => [d.id, d]));
const PORTS = [...new Set(DRIVERS.flatMap((d) => d.ports))].sort((a, b) => a - b);

function localSubnets() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) for (const a of addrs || []) {
    if (a.family !== 'IPv4' && a.family !== 4) continue; if (a.internal || a.address.startsWith('169.254.')) continue;
    out.push({ ifname, address: a.address, prefix: a.address.split('.').slice(0, 3).join('.') });
  }
  return out;
}

async function openPorts(ip, ports = PORTS, timeout = 450) { const res = await Promise.all(ports.map((p) => portOpen(ip, p, timeout).then((o) => o && p))); return new Set(res.filter(Boolean)); }

// Identify one IP. `only` limits to one driver (when the engineer picks the type by hand).
async function identify(ip, { only = null, hint = {}, open = null } = {}) {
  const o = open || await openPorts(ip);
  const found = [];
  for (const d of only ? [BY_ID[only]].filter(Boolean) : DRIVERS) {
    if (!d.ports.some((p) => o.has(p))) continue;
    const r = await d.detect(ip, o, hint).catch(() => null);
    if (r) { found.push({ ip, driver: d.id, make: r.make || d.make, kind: r.kind || d.kind, model: '', name: '', firmware: '', serial: '', mac: '', ...r }); if (!only) break; }
  }
  return found[0] || null;
}

// Sweep the subnets for control ports, then identify each host that has one open.
async function discover({ subnets = [], targets = [], onProgress } = {}) {
  const nets = subnets.length ? subnets : [...new Set(localSubnets().map((s) => s.prefix))];
  const ips = targets.length ? targets : nets.flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`));
  const self = new Set(localSubnets().map((s) => s.address));
  const hits = []; let done = 0; let i = 0;
  const worker = async () => { while (i < ips.length) { const ip = ips[i++]; if (!self.has(ip)) { const o = await openPorts(ip); if (o.size) hits.push([ip, o]); } done++; if (onProgress) onProgress(done, ips.length, 'sweep'); } };
  await Promise.all(Array.from({ length: 24 }, worker));
  const devices = []; let k = 0;
  await Promise.all(hits.map(async ([ip, o]) => { const d = await identify(ip, { open: o }); if (d) devices.push(d); if (onProgress) onProgress(++k, hits.length, 'identify'); }));
  const num = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
  devices.sort((a, b) => num(a.ip) - num(b.ip));
  return { devices, subnets: nets, checked: ips.length, answered: hits.length };
}

function caps(dev) { const d = BY_ID[dev.driver]; return d ? { make: d.make, kind: d.kind, ...d.caps(dev) } : { keys: [], inputs: [] }; }

module.exports = { DRIVERS, BY_ID, PORTS, discover, identify, caps, localSubnets, openPorts };
