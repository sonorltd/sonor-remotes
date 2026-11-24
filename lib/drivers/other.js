'use strict';
// Projectors (PJLink, JVC), Sonos, Sky.
const crypto = require('crypto');
const { tcpTalk, request } = require('../conn');
const sky = require('../sky');

// ── PJLink class 1 (TCP 4352): Epson, Sony, Panasonic, NEC, BenQ, Optoma, Christie… ──
// Greeting "PJLINK 0" = no password, "PJLINK 1 <rand>" = prefix every command with md5(rand + password).
async function pjlink(dev, cmds) {
  let prefix = '';
  const raw = await tcpTalk(dev.ip, 4352, { greet: true, until: /\r/, timeout: 3000, send: cmds.map((c) => (buf) => {
    if (!prefix) { const g = buf.toString('latin1').match(/PJLINK ([01])(?: (\S+))?/); if (g && g[1] === '1') { if (!(dev.auth || {}).password) throw new Error('This projector has a PJLink password: press Pair and enter it'); prefix = crypto.createHash('md5').update(g[2] + dev.auth.password).digest('hex'); } else prefix = ' '; }
    return prefix.trim() + '%1' + c + '\r'; }) });
  if (/ERRA/.test(raw)) throw new Error('PJLink password not accepted');
  const lines = raw.split('\r').map((x) => x.trim()).filter((x) => x.startsWith('%1'));
  const err = lines.find((l) => /=ERR[1-4]/.test(l)); if (err) throw new Error({ ERR1: 'Command not supported', ERR2: 'Value not supported', ERR3: 'Projector is busy (warming up / cooling down)', ERR4: 'Projector fault' }[err.split('=')[1]] || err);
  return Object.fromEntries(lines.map((l) => { const [k, v] = l.slice(2).split('='); return [k, v]; }));
}
const PJ_TYPE = { 1: 'RGB', 2: 'Video', 3: 'HDMI', 4: 'USB', 5: 'Network' };
const pjlinkDriver = {
  id: 'pjlink', make: 'Projector (PJLink)', kind: 'Projector', ports: [4352],
  async detect(ip, open) {
    if (!open.has(4352)) return null;
    const g = await tcpTalk(ip, 4352, { timeout: 1500 }).catch(() => ''); if (!/PJLINK [01]/.test(g)) return null;
    const out = { model: 'Projector', locked: /PJLINK 1/.test(g), needsPair: /PJLINK 1/.test(g) };
    if (!out.locked) { const r = await pjlink({ ip }, ['NAME ?', 'INF1 ?', 'INF2 ?', 'INST ?']).catch(() => ({})); Object.assign(out, { name: r.NAME || '', make: r.INF1 || 'Projector', model: r.INF2 || 'Projector', inputs: pjInputs(r.INST) }); }
    return out;
  },
  caps(dev) { return { keys: ['power', 'poweron', 'poweroff', 'mute'], inputs: dev.inputs && dev.inputs.length ? dev.inputs : [['31', 'HDMI 1'], ['32', 'HDMI 2']], pairable: !!dev.locked, pairField: 'PJLink password', paired: !dev.locked || !!(dev.auth || {}).password, note: 'PJLink covers power, input and picture mute. Menus need the maker\'s own protocol or IR.' }; },
  async pair(dev, { password } = {}) { dev.auth = { ...(dev.auth || {}), password: String(password || '') }; const r = await pjlink(dev, ['NAME ?', 'INF1 ?', 'INF2 ?', 'INST ?']); Object.assign(dev, { name: dev.name || r.NAME || '', make: r.INF1 || dev.make, model: r.INF2 || dev.model, inputs: pjInputs(r.INST) }); return dev; },
  async status(dev) { const r = await pjlink(dev, ['POWR ?', 'INPT ?', 'AVMT ?', 'LAMP ?']); return { power: { 0: 'standby', 1: 'on', 2: 'cooling', 3: 'warming' }[r.POWR] || 'unknown', input: r.INPT || '', mute: r.AVMT === '31', lamp: r.LAMP ? r.LAMP.split(' ')[0] + ' h' : '' }; },
  async send(dev, key) {
    if (key === 'power') { const s = await this.status(dev); key = s.power === 'on' || s.power === 'warming' ? 'poweroff' : 'poweron'; }
    if (key === 'mute') { const s = await this.status(dev); return pjlink(dev, [s.mute ? 'AVMT 30' : 'AVMT 31']); }
    const c = { poweron: 'POWR 1', poweroff: 'POWR 0' }[key] || (key.startsWith('input:') ? 'INPT ' + key.slice(6) : null);
    if (!c) throw new Error('Not available over PJLink: ' + key);
    return pjlink(dev, [c]);
  },
};
function pjInputs(inst) { const n = {}; return String(inst || '').split(' ').filter(Boolean).map((c) => { const t = PJ_TYPE[c[0]] || 'Input'; n[t] = (n[t] || 0) + 1; return [c, `${t} ${c.slice(1)}`]; }); }

// ── JVC D-ILA (TCP 20554): "PJ_OK" → "PJREQ" → "PJACK", then binary commands. Newer models need the network password. ──
const jvcCmd = (ascii) => Buffer.concat([Buffer.from([0x21, 0x89, 0x01]), Buffer.from(ascii), Buffer.from([0x0a])]);
async function jvc(dev, ascii) {
  const pw = (dev.auth || {}).password;
  const r = await tcpTalk(dev.ip, 20554, { greet: true, until: /PJACK|PJNAK|\x06\x89\x01/, timeout: 4000, send: [Buffer.from(pw ? 'PJREQ_' + pw : 'PJREQ'), jvcCmd(ascii)] });
  if (/PJNAK/.test(r)) throw new Error('The projector refused the connection: set the network password under Pair');
  return r;
}
const jvcDriver = {
  id: 'jvc', make: 'JVC', kind: 'Projector', ports: [20554],
  async detect(ip, open) { if (!open.has(20554)) return null; const g = await tcpTalk(ip, 20554, { timeout: 1500 }).catch(() => ''); return /PJ_OK/.test(g) ? { model: 'D-ILA projector' } : null; },
  caps() { return { keys: ['poweron', 'poweroff'], inputs: [['IP6', 'HDMI 1'], ['IP7', 'HDMI 2']], pairable: true, pairField: 'Network password (newer models only)', paired: true, note: 'Power and input over IP. Menus need IR. The projector ignores power on while cooling down.' }; },
  async pair(dev, { password } = {}) { dev.auth = { ...(dev.auth || {}), password: String(password || '') }; return dev; },
  async status() { return {}; },
  async send(dev, key) { const c = { poweron: 'PW1', poweroff: 'PW0' }[key] || (key.startsWith('input:') ? key.slice(6) : null); if (!c) throw new Error('Not available on JVC over IP: ' + key); return jvc(dev, c); },
};

// ── Sonos (UPnP SOAP, port 1400) ────────────────────────────
async function upnp(dev, svc, action, args = {}) {
  const ctl = { AVTransport: '/MediaRenderer/AVTransport/Control', RenderingControl: '/MediaRenderer/RenderingControl/Control' }[svc];
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${svc}:1">${Object.entries({ InstanceID: 0, ...args }).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const r = await request('POST', `http://${dev.ip}:1400${ctl}`, { body, headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"urn:schemas-upnp-org:service:${svc}:1#${action}"` } });
  if (r.status >= 400) throw new Error(r.status === 500 && action === 'Play' ? 'Nothing queued to play on this Sonos' : `Sonos said ${r.status}`);
  return r.text;
}
const tagVal = (x, t) => ((x.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || '');
const sonos = {
  id: 'sonos', make: 'Sonos', kind: 'Speaker', ports: [1400],
  async detect(ip, open) {
    if (!open.has(1400)) return null;
    const r = await request('GET', `http://${ip}:1400/xml/device_description.xml`, { timeout: 2000 }).catch(() => null); if (!r || !/Sonos/i.test(r.text)) return null;
    return { model: tagVal(r.text, 'modelName') || 'Sonos', name: tagVal(r.text, 'roomName'), firmware: tagVal(r.text, 'displayVersion'), serial: tagVal(r.text, 'serialNum'), mac: tagVal(r.text, 'MACAddress').toUpperCase() };
  },
  caps() { return { keys: ['play', 'pause', 'prev', 'next', 'volup', 'voldown', 'mute'], volume: { min: 0, max: 100 }, inputs: [], note: 'Grouped players: send play / pause / next to the group coordinator. Volume is per room.' }; },
  async status(dev) { const v = await upnp(dev, 'RenderingControl', 'GetVolume', { Channel: 'Master' }); const m = await upnp(dev, 'RenderingControl', 'GetMute', { Channel: 'Master' }); const t = await upnp(dev, 'AVTransport', 'GetTransportInfo'); return { power: 'on', volume: Number(tagVal(v, 'CurrentVolume')), mute: tagVal(m, 'CurrentMute') === '1', playing: tagVal(t, 'CurrentTransportState') }; },
  async send(dev, key) {
    if (key === 'play') return upnp(dev, 'AVTransport', 'Play', { Speed: 1 });
    if (key === 'pause') return upnp(dev, 'AVTransport', 'Pause');
    if (key === 'next') return upnp(dev, 'AVTransport', 'Next');
    if (key === 'prev') return upnp(dev, 'AVTransport', 'Previous');
    if (key === 'mute') { const s = await this.status(dev); return upnp(dev, 'RenderingControl', 'SetMute', { Channel: 'Master', DesiredMute: s.mute ? 0 : 1 }); }
    if (key === 'volup' || key === 'voldown' || key.startsWith('vol:')) {
      let v = key.startsWith('vol:') ? Number(key.slice(4)) : Number(tagVal(await upnp(dev, 'RenderingControl', 'GetVolume', { Channel: 'Master' }), 'CurrentVolume')) + (key === 'volup' ? 2 : -2);
      return upnp(dev, 'RenderingControl', 'SetVolume', { Channel: 'Master', DesiredVolume: Math.max(0, Math.min(100, Math.round(v))) });
    }
    throw new Error('Not available on Sonos: ' + key);
  },
};

// ── Sky Q / Q Mini / Sky+HD (the original Sky Remote protocol, lib/sky.js) ──
const SKY_MAP = { power: 'power', select: 'select', back: 'backup', home: 'home', guide: 'tvguide', info: 'i', menu: 'services', chup: 'channelup', chdown: 'channeldown', play: 'play', pause: 'pause', stop: 'stop', rew: 'rewind', ff: 'fastforward', rec: 'record', search: 'search', text: 'text', sky: 'sky', boxoffice: 'boxoffice', up: 'up', down: 'down', left: 'left', right: 'right', red: 'red', green: 'green', yellow: 'yellow', blue: 'blue' };
const skyDriver = {
  id: 'sky', make: 'Sky', kind: 'Satellite', ports: [sky.PORT_SKYQ, sky.PORT_LEGACY, sky.PORT_REST],
  async detect(ip, open) { if (![sky.PORT_SKYQ, sky.PORT_LEGACY, sky.PORT_REST].some((p) => open.has(p))) return null; const b = await sky.probe(ip).catch(() => null); return b ? { model: b.model, hardware: b.hardware, serial: b.serial, power: b.power, port: b.port, controllable: b.controllable, notes: b.notes } : null; },
  caps(dev) { return { keys: dev.controllable === false ? [] : ['power', 'up', 'down', 'left', 'right', 'select', 'back', 'home', 'guide', 'info', 'menu', 'chup', 'chdown', 'play', 'pause', 'stop', 'rew', 'ff', 'rec', 'search', 'text', 'sky', 'boxoffice', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'red', 'green', 'yellow', 'blue'], inputs: [], note: (dev.notes || []).join(' ') || 'Volume is on the TV or receiver: Sky boxes have no volume over IP.' }; },
  async status(dev) { const b = await sky.probe(dev.ip); return b ? { power: b.power } : { power: 'off' }; },
  async send(dev, key) {
    const k = /^\d$/.test(key) ? key : SKY_MAP[key]; if (k === undefined) throw new Error('Not available on Sky: ' + key);
    const ports = dev.port ? [dev.port, dev.port === sky.PORT_SKYQ ? sky.PORT_LEGACY : sky.PORT_SKYQ] : [sky.PORT_SKYQ, sky.PORT_LEGACY];
    let last; for (const p of ports) { try { await sky.sendKeys(dev.ip, p, [k]); dev.port = p; return; } catch (e) { last = e; } } throw last;
  },
};

module.exports = { pjlink: pjlinkDriver, jvc: jvcDriver, sonos, sky: skyDriver };
