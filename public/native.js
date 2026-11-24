'use strict';
// NATIVE transport: used when the page runs inside the Sonor Sky Remote phone app (Capacitor).
// The app's SkyTcp plugin opens TCP sockets directly, so the phone talks to the Sky boxes itself:
// no Pi, no bridge. Same actions as server.js, same box records, stored on the phone.
(function () {
  const Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
  const Tcp = Cap.Plugins.SkyTcp;
  if (!Tcp) return;

  const PORT_SKYQ = 49160, PORT_LEGACY = 5900, PORT_REST = 9006;
  const KEYS = { power: 0, select: 1, backup: 2, dismiss: 2, channelup: 6, channeldown: 7, interactive: 8, sidebar: 8, help: 9, services: 10, search: 10, tvguide: 11, home: 11, i: 14, text: 15, up: 16, down: 17, left: 18, right: 19, red: 32, green: 33, yellow: 34, blue: 35, 0: 48, 1: 49, 2: 50, 3: 51, 4: 52, 5: 53, 6: 54, 7: 55, 8: 56, 9: 57, play: 64, pause: 65, stop: 66, record: 67, fastforward: 69, rewind: 71, boxoffice: 240, sky: 241 };

  const STORE = 'skyBoxesNative';
  let db = { boxes: [] };
  try { db = JSON.parse(localStorage.getItem(STORE)) || db; } catch {}
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(db)); } catch {} };
  const upsert = (box) => {
    const i = db.boxes.findIndex((b) => b.ip === box.ip);
    if (i >= 0) db.boxes[i] = { ...db.boxes[i], ...box, name: db.boxes[i].name || box.name }; else db.boxes.push(box);
    save();
  };
  let scan = { running: false, done: 0, total: 0, lastResult: null, error: null };
  let subnets = [];

  const probePort = (host, port, timeout = 600) => Tcp.probe({ host, port, timeout }).then((r) => r).catch(() => ({ open: false }));

  async function skyQInfo(host) {
    try {
      const r = await fetch(`http://${host}:${PORT_REST}/as/system/information`, { signal: AbortSignal.timeout(2000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  function describe(info) {
    const t = String(info.deviceType || '').toUpperCase();
    return {
      model: t === 'GATEWAYSTB' ? 'Sky Q (main box)' : t === 'IPSETTOPBOX' ? 'Sky Q Mini' : 'Sky Q',
      hardware: [info.hardwareName, info.hardwareModel, info.modelNumber].filter(Boolean).join(' / '),
      serial: info.serialNumber || '', power: info.activeStandby === true ? 'standby' : 'on', deviceType: info.deviceType || '',
    };
  }

  async function probe(host) {
    const [q, legacy, rest] = await Promise.all([probePort(host, PORT_SKYQ), probePort(host, PORT_LEGACY), probePort(host, PORT_REST)]);
    if (!q.open && !legacy.open && !rest.open) return null;
    const box = { ip: host, name: '', model: '', hardware: '', serial: '', power: 'unknown', port: null, controllable: false, notes: [] };
    if (rest.open) { const info = await skyQInfo(host); if (info) Object.assign(box, describe(info)); }
    if (q.open && (q.banner || '').startsWith('SKY')) { box.port = PORT_SKYQ; box.controllable = true; }
    else if (legacy.open && (legacy.banner || '').startsWith('SKY')) { box.port = PORT_LEGACY; box.controllable = true; }
    if (!box.model) {
      if (box.controllable) box.model = box.port === PORT_LEGACY ? 'Sky+HD (or Sky Q on old firmware)' : 'Sky box';
      else return null;
    }
    return box;
  }

  async function discover(nets) {
    if (!nets.length) {
      const r = await Tcp.localAddresses().catch(() => ({ addresses: [] }));
      nets = [...new Set((r.addresses || []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a) && !a.startsWith('127.') && !a.startsWith('169.254.')).map((a) => a.split('.').slice(0, 3).join('.')))];
    }
    subnets = nets;
    const hosts = nets.flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`));
    scan.total = hosts.length;
    const hits = [];
    const worker = async () => {
      while (hosts.length) {
        const h = hosts.shift();
        const rs = await Promise.all([probePort(h, PORT_SKYQ, 500), probePort(h, PORT_LEGACY, 500), probePort(h, PORT_REST, 500)]);
        if (rs.some((r) => r.open)) hits.push(h);
        scan.done++;
      }
    };
    await Promise.all(Array.from({ length: 32 }, worker));
    const boxes = (await Promise.all(hits.map(probe))).filter(Boolean);
    boxes.forEach((b) => { b.foundBy = 'scan'; upsert(b); });
    return { boxes, subnets: nets };
  }

  const actions = {
    boxes: async () => [200, { boxes: db.boxes, scan, subnets: subnets.map((p) => ({ ifname: 'wifi', prefix: p })) }],
    scan: async ({ subnets: s } = {}) => {
      if (scan.running) return [409, { error: 'scan already running' }];
      const nets = (s || []).map((x) => String(x).trim().split('.').slice(0, 3).join('.')).filter((x) => /^\d+\.\d+\.\d+$/.test(x));
      scan = { running: true, done: 0, total: 254, lastResult: null, error: null };
      discover(nets).then((r) => { scan.lastResult = { found: r.boxes.length, subnets: r.subnets, at: new Date().toISOString() }; })
        .catch((e) => { scan.error = e.message; }).finally(() => { scan.running = false; });
      return [202, { started: true }];
    },
    add: async ({ ip, name } = {}) => {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip || '')) return [400, { error: 'enter an IPv4 address' }];
      const box = await probe(ip);
      if (!box) return [404, { error: `No Sky box answered at ${ip} (tried ports 49160, 5900 and 9006).` }];
      if (name) box.name = name;
      upsert(box); return [200, { box }];
    },
    rename: async ({ ip, name } = {}) => {
      const b = db.boxes.find((x) => x.ip === ip); if (!b) return [404, { error: 'unknown box' }];
      b.name = String(name || '').slice(0, 40); save(); return [200, { box: b }];
    },
    remove: async ({ ip } = {}) => { db.boxes = db.boxes.filter((x) => x.ip !== ip); save(); return [200, { ok: true }]; },
    status: async ({ ip } = {}) => {
      const b = db.boxes.find((x) => x.ip === ip); if (!b) return [404, { error: 'unknown box' }];
      const fresh = await probe(ip);
      if (!fresh) b.power = 'offline'; else upsert({ ...fresh, name: b.name });
      save(); return [200, { box: db.boxes.find((x) => x.ip === ip) }];
    },
    key: async ({ ip, keys } = {}) => {
      const b = db.boxes.find((x) => x.ip === ip); if (!b) return [404, { error: 'unknown box' }];
      const list = (Array.isArray(keys) ? keys : [keys]).map((k) => KEYS[String(k).toLowerCase()]);
      if (list.some((c) => c === undefined)) return [400, { error: 'unknown key' }];
      const ports = b.port ? [b.port, b.port === PORT_SKYQ ? PORT_LEGACY : PORT_SKYQ] : [PORT_SKYQ, PORT_LEGACY];
      let err;
      for (const port of ports) {
        try {
          await Tcp.sendKeys({ host: ip, port, codes: list, gapMs: 350 });
          if (b.port !== port) { b.port = port; b.controllable = true; save(); }
          return [200, { ok: true, port }];
        } catch (e) { err = e; }
      }
      return [502, { error: err ? err.message : 'failed' }];
    },
  };

  window.SkyNative = {
    async call(action, payload) {
      const fn = actions[action];
      if (!fn) throw new Error('unknown action ' + action);
      const [code, body] = await fn(payload || {});
      if (code >= 400) throw new Error(body.error || 'failed');
      return body;
    },
  };
})();
