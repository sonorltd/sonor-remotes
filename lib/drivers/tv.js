'use strict';
// TVs and streamers: LG webOS, Samsung Tizen, Sony Bravia, Roku. TVs that are off wake with Wake-on-LAN (needs the MAC).
const { request, websocket, wol, portOpen, sleep } = require('../conn');

const NAV = ['up', 'down', 'left', 'right', 'select', 'back', 'home', 'menu', 'info'];
const TRANSPORT = ['play', 'pause', 'stop', 'rew', 'ff'];
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const COLOURS = ['red', 'green', 'yellow', 'blue'];

// ── LG webOS (SSAP over WebSocket 3000 / 3001) ───────────────
// The TV asks once to accept "LG Remote App"; the client key it returns is kept on the device record.
const LG_PAIRING = require('./lg-pairing.json'); // MIT, from the lgtv2 package (see lg-pairing.LICENSE.txt)
async function lgOpen(dev, { pairing = false } = {}) {
  const urls = dev.wsUrl ? [dev.wsUrl] : [`wss://${dev.ip}:3001/`, `ws://${dev.ip}:3000/`];
  let ws, used, lastErr;
  for (const u of urls) { try { ws = await websocket(u, { timeout: 3500 }); used = u; break; } catch (e) { lastErr = e; } }
  if (!ws) throw lastErr || new Error('The TV did not answer');
  dev.wsUrl = used;
  const key = (dev.auth || {}).clientKey;
  if (!key && !pairing) { ws.close(); throw Object.assign(new Error('Pair with this TV first: press Pair, then accept the prompt on the TV'), { needsPair: true }); }
  const reg = { type: 'register', id: 'reg0', payload: { ...LG_PAIRING, 'client-key': key || undefined } };
  const r = await ws.ask(JSON.stringify(reg), (j) => j.id === 'reg0' && (j.type === 'registered' || j.type === 'error'), pairing ? 60000 : 6000);
  if (r.type === 'error') { ws.close(); throw new Error('TV refused: ' + (r.error || 'not paired')); }
  if (r.payload && r.payload['client-key']) dev.auth = { ...(dev.auth || {}), clientKey: r.payload['client-key'] };
  let n = 0; ws.req = (uri, payload) => { const id = 'r' + (++n); return ws.ask(JSON.stringify({ type: 'request', id, uri, payload }), (j) => j.id === id, 5000).then((j) => { if (j.type === 'error') throw new Error(j.error); return j.payload || {}; }); };
  return ws;
}
async function lgButton(ws, name) {
  const { socketPath } = await ws.req('ssap://com.webos.service.networkinput/getPointerInputSocket');
  const p = await websocket(socketPath.replace(/^wss?:\/\/[^/]+/, (m) => m), { timeout: 3000 });
  p.send(`type:button\nname:${name}\n\n`); await sleep(120); p.close();
}
const LG_BUTTON = { up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', select: 'ENTER', back: 'BACK', home: 'HOME', menu: 'MENU', info: 'INFO', guide: 'GUIDE', red: 'RED', green: 'GREEN', yellow: 'YELLOW', blue: 'BLUE', exit: 'EXIT', ...Object.fromEntries(DIGITS.map((d) => [d, d])) };
const LG_SSAP = { volup: 'ssap://audio/volumeUp', voldown: 'ssap://audio/volumeDown', chup: 'ssap://tv/channelUp', chdown: 'ssap://tv/channelDown', poweroff: 'ssap://system/turnOff', play: 'ssap://media.controls/play', pause: 'ssap://media.controls/pause', stop: 'ssap://media.controls/stop', rew: 'ssap://media.controls/rewind', ff: 'ssap://media.controls/fastForward' };
const lg = {
  id: 'lg', make: 'LG', kind: 'TV', ports: [3000, 3001],
  async detect(ip, open, hint = {}) {
    if (!open.has(3001) && !open.has(3000)) return null;
    // Opening the socket is harmless (no prompt until we register). Port 3000 alone is too common to trust without LG in the hint.
    if (!open.has(3001) && !/lg/i.test(hint.make || '')) return null;
    for (const u of [`wss://${ip}:3001/`, `ws://${ip}:3000/`]) { try { const w = await websocket(u, { timeout: 2500 }); w.close(); return { model: 'webOS TV', wsUrl: u, needsPair: true }; } catch {} }
    return null;
  },
  caps(dev) { return { keys: ['power', 'poweron', 'poweroff', ...NAV, 'guide', 'exit', 'volup', 'voldown', 'mute', 'chup', 'chdown', ...TRANSPORT, ...DIGITS, ...COLOURS], inputs: dev.inputs && dev.inputs.length ? dev.inputs : [['HDMI_1', 'HDMI 1'], ['HDMI_2', 'HDMI 2'], ['HDMI_3', 'HDMI 3'], ['HDMI_4', 'HDMI 4']], pairable: true, paired: !!(dev.auth || {}).clientKey, wake: !!dev.mac, note: 'Turning on needs Wake-on-LAN: on the TV set "Turn on via Wi-Fi / Mobile TV On" and make sure the MAC is known.' }; },
  async pair(dev) {
    const ws = await lgOpen(dev, { pairing: true });
    try {
      const info = await ws.req('ssap://system/getSystemInfo').catch(() => ({}));
      const sw = await ws.req('ssap://com.webos.service.update/getCurrentSWInformation').catch(() => ({}));
      const ins = await ws.req('ssap://tv/getExternalInputList').catch(() => ({}));
      Object.assign(dev, { model: info.modelName || dev.model, firmware: sw.product_name ? `${sw.product_name} ${sw.major_ver || ''}.${sw.minor_ver || ''}` : dev.firmware, mac: dev.mac || (sw.device_id || '').toUpperCase(),
        inputs: (ins.devices || []).map((d) => [d.id, d.label || d.id]) });
    } finally { ws.close(); }
    return dev;
  },
  async status(dev) { const ws = await lgOpen(dev); try { const a = await ws.req('ssap://audio/getStatus').catch(() => ({})); const fg = await ws.req('ssap://com.webos.applicationManager/getForegroundAppInfo').catch(() => ({})); return { power: 'on', volume: a.volume ?? (a.volumeStatus || {}).volume ?? null, mute: !!(a.mute ?? (a.volumeStatus || {}).muteStatus), input: fg.appId || '' }; } finally { ws.close(); } },
  async send(dev, key) {
    if (key === 'poweron') return wol(dev.mac);
    let ws; try { ws = await lgOpen(dev); } catch (e) { if (key === 'power' && !e.needsPair) return wol(dev.mac); throw e; }
    try {
      if (key === 'power') key = 'poweroff';
      if (key === 'mute') { const a = await ws.req('ssap://audio/getStatus'); return await ws.req('ssap://audio/setMute', { mute: !(a.mute ?? (a.volumeStatus || {}).muteStatus) }); }
      if (key.startsWith('vol:')) return await ws.req('ssap://audio/setVolume', { volume: Math.round(Number(key.slice(4))) });
      if (key.startsWith('input:')) return await ws.req('ssap://tv/switchInput', { inputId: key.slice(6) });
      if (LG_SSAP[key]) return await ws.req(LG_SSAP[key]);
      if (LG_BUTTON[key]) return await lgButton(ws, LG_BUTTON[key]);
      throw new Error('Not available on this TV: ' + key);
    } finally { ws.close(); }
  },
};

// ── Samsung Tizen (2016+) ──────────────────────────────────
const SAMSUNG_KEY = { power: 'KEY_POWER', up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT', select: 'KEY_ENTER', back: 'KEY_RETURN', home: 'KEY_HOME', menu: 'KEY_MENU', info: 'KEY_INFO', guide: 'KEY_GUIDE', exit: 'KEY_EXIT',
  volup: 'KEY_VOLUP', voldown: 'KEY_VOLDOWN', mute: 'KEY_MUTE', chup: 'KEY_CHUP', chdown: 'KEY_CHDOWN', play: 'KEY_PLAY', pause: 'KEY_PAUSE', stop: 'KEY_STOP', rew: 'KEY_REWIND', ff: 'KEY_FF',
  red: 'KEY_RED', green: 'KEY_GREEN', yellow: 'KEY_YELLOW', blue: 'KEY_CYAN', source: 'KEY_SOURCE', ...Object.fromEntries(DIGITS.map((d) => [d, 'KEY_' + d])) };
const APP_NAME = Buffer.from('Sonor Remotes').toString('base64');
async function samsungOpen(dev, pairing) {
  const tok = (dev.auth || {}).token;
  const url = dev.tokenAuth === false ? `ws://${dev.ip}:8001/api/v2/channels/samsung.remote.control?name=${APP_NAME}` : `wss://${dev.ip}:8002/api/v2/channels/samsung.remote.control?name=${APP_NAME}${tok ? '&token=' + tok : ''}`;
  const ws = await websocket(url, { timeout: 4000 });
  const r = await ws.ask(null, (j) => j.event === 'ms.channel.connect' || j.event === 'ms.channel.unauthorized' || j.event === 'ms.channel.timeOut', pairing ? 60000 : 8000);
  if (r.event !== 'ms.channel.connect') { ws.close(); throw new Error(r.event === 'ms.channel.unauthorized' ? 'The TV refused. Press Pair and choose Allow on the TV.' : 'Nobody accepted the prompt on the TV in time'); }
  if (r.data && r.data.token) dev.auth = { ...(dev.auth || {}), token: r.data.token };
  return ws;
}
const samsung = {
  id: 'samsung', make: 'Samsung', kind: 'TV', ports: [8001, 8002],
  async detect(ip, open) {
    if (!open.has(8001)) return null;
    const r = await request('GET', `http://${ip}:8001/api/v2/`, { timeout: 2000 }).catch(() => null); const j = r && r.json(); const d = j && j.device; if (!d) return null;
    return { model: d.modelName || d.model || 'Tizen TV', name: d.name || j.name || '', mac: (d.wifiMac || '').toUpperCase(), firmware: d.firmwareVersion && d.firmwareVersion !== 'Unknown' ? d.firmwareVersion : '', tokenAuth: d.TokenAuthSupport === 'true' || d.TokenAuthSupport === true, needsPair: true };
  },
  caps(dev) { return { keys: ['power', 'poweron', ...NAV, 'guide', 'exit', 'volup', 'voldown', 'mute', 'chup', 'chdown', ...TRANSPORT, ...DIGITS, ...COLOURS, 'source'], inputs: [['KEY_HDMI1', 'HDMI 1'], ['KEY_HDMI2', 'HDMI 2'], ['KEY_HDMI3', 'HDMI 3'], ['KEY_HDMI4', 'HDMI 4']], pairable: true, paired: dev.tokenAuth === false || !!(dev.auth || {}).token, wake: !!dev.mac, note: 'First use: press Pair and choose Allow on the TV. Turning on uses Wake-on-LAN ("Power On with Mobile" in the TV network settings). Direct HDMI keys work on most, not all, models; Source always works.' }; },
  async pair(dev) { const ws = await samsungOpen(dev, true); ws.close(); return dev; },
  async status(dev) { const r = await request('GET', `http://${dev.ip}:8001/api/v2/`, { timeout: 2000 }).catch(() => null); const j = r && r.json(); return { power: j ? ((j.device || {}).PowerState || 'on') : 'off' }; },
  async send(dev, key) {
    if (key === 'poweron') return wol(dev.mac);
    if (key === 'power' && !(await portOpen(dev.ip, 8001, 800))) return wol(dev.mac);
    const code = key.startsWith('input:') ? key.slice(6) : SAMSUNG_KEY[key]; if (!code) throw new Error('Not available on this TV: ' + key);
    const ws = await samsungOpen(dev, false);
    try { ws.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: code, Option: 'false', TypeOfRemote: 'SendRemoteKey' } })); await sleep(250); } finally { ws.close(); }
  },
};

// ── Sony Bravia (REST + IRCC, Pre-Shared Key) ───────────────
const sonyApi = async (dev, svc, method, params = [], version = '1.0') => {
  const r = await request('POST', `http://${dev.ip}/sony/${svc}`, { body: { method, id: 1, params, version }, headers: { 'Content-Type': 'application/json', ...((dev.auth || {}).psk ? { 'X-Auth-PSK': dev.auth.psk } : {}) } });
  const j = r.json() || {}; if (j.error) { const [code, msg] = j.error; throw new Error(code === 403 || code === 401 ? 'The TV wants the Pre-Shared Key: set it under Network > IP control on the TV and press Pair here' : `TV error ${code}: ${msg}`); }
  return j.result || [];
};
const SONY_NAME = { power: 'TvPower', up: 'Up', down: 'Down', left: 'Left', right: 'Right', select: 'Confirm', back: 'Return', home: 'Home', menu: 'Options', info: 'Display', guide: 'GGuide', exit: 'Exit',
  volup: 'VolumeUp', voldown: 'VolumeDown', mute: 'Mute', chup: 'ChannelUp', chdown: 'ChannelDown', play: 'Play', pause: 'Pause', stop: 'Stop', rew: 'Rewind', ff: 'Forward', red: 'Red', green: 'Green', yellow: 'Yellow', blue: 'Blue', source: 'Input', ...Object.fromEntries(DIGITS.map((d) => [d, 'Num' + d])) };
const sony = {
  id: 'sony', make: 'Sony', kind: 'TV', ports: [80],
  async detect(ip, open) {
    if (!open.has(80)) return null;
    const res = await sonyApi({ ip }, 'system', 'getInterfaceInformation').catch(() => null); const i = res && res[0]; if (!i || !/TV|BRAVIA/i.test(`${i.productCategory} ${i.productName}`)) return null;
    const rc = await sonyApi({ ip }, 'system', 'getRemoteControllerInfo').catch(() => null);
    return { model: i.modelName || 'Bravia', name: i.productName || '', firmware: i.serverName || '', ircc: rc && rc[1] ? Object.fromEntries(rc[1].map((x) => [x.name, x.value])) : null, needsPair: true };
  },
  caps(dev) { return { keys: ['power', 'poweron', 'poweroff', ...NAV, 'guide', 'exit', 'volup', 'voldown', 'mute', 'chup', 'chdown', ...TRANSPORT, ...DIGITS, ...COLOURS, 'source'], volume: { min: 0, max: 100 }, inputs: dev.inputs && dev.inputs.length ? dev.inputs : [], pairable: true, pairField: 'Pre-Shared Key (TV: Network > IP control)', paired: !!(dev.auth || {}).psk, wake: true }; },
  async pair(dev, { psk } = {}) {
    if (!psk) throw new Error('Enter the Pre-Shared Key set on the TV');
    dev.auth = { ...(dev.auth || {}), psk: String(psk) };
    const ins = await sonyApi(dev, 'avContent', 'getCurrentExternalInputsStatus').catch((e) => { if (/Pre-Shared/.test(e.message)) throw new Error('That key was not accepted'); return []; });
    dev.inputs = (ins[0] || []).map((x) => [x.uri, x.label || x.title]);
    if (!dev.ircc) { const rc = await sonyApi(dev, 'system', 'getRemoteControllerInfo').catch(() => null); if (rc && rc[1]) dev.ircc = Object.fromEntries(rc[1].map((x) => [x.name, x.value])); }
    return dev;
  },
  async status(dev) { const p = await sonyApi(dev, 'system', 'getPowerStatus').catch(() => [{}]); const v = await sonyApi(dev, 'audio', 'getVolumeInformation').catch(() => [[]]); const sp = (v[0] || []).find((x) => x.target === 'speaker') || {}; return { power: (p[0] || {}).status === 'active' ? 'on' : 'standby', volume: sp.volume ?? null, mute: !!sp.mute }; },
  async send(dev, key) {
    if (key === 'poweron') return sonyApi(dev, 'system', 'setPowerStatus', [{ status: true }]).catch(() => wol(dev.mac));
    if (key === 'poweroff') return sonyApi(dev, 'system', 'setPowerStatus', [{ status: false }]);
    if (key.startsWith('vol:')) return sonyApi(dev, 'audio', 'setAudioVolume', [{ target: 'speaker', volume: String(Math.round(Number(key.slice(4)))) }]);
    if (key.startsWith('input:')) return sonyApi(dev, 'avContent', 'setPlayContent', [{ uri: key.slice(6) }]);
    const code = dev.ircc && dev.ircc[SONY_NAME[key]]; if (!code) throw new Error('Not available on this TV: ' + key);
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>${code}</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>`;
    const r = await request('POST', `http://${dev.ip}/sony/IRCC`, { body, headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPACTION: '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"', ...((dev.auth || {}).psk ? { 'X-Auth-PSK': dev.auth.psk } : {}) } });
    if (r.status >= 400) throw new Error(r.status === 403 ? 'The TV wants the Pre-Shared Key: press Pair' : 'TV said ' + r.status);
  },
};

// ── Roku (ECP, HTTP 8060) ──────────────────────────────────
const ROKU_KEY = { power: 'Power', poweron: 'PowerOn', poweroff: 'PowerOff', up: 'Up', down: 'Down', left: 'Left', right: 'Right', select: 'Select', back: 'Back', home: 'Home', info: 'Info', play: 'Play', pause: 'Play', rew: 'Rev', ff: 'Fwd', replay: 'InstantReplay', volup: 'VolumeUp', voldown: 'VolumeDown', mute: 'VolumeMute', chup: 'ChannelUp', chdown: 'ChannelDown', search: 'Search' };
const xmlTag = (x, t) => ((x.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || '').trim();
const roku = {
  id: 'roku', make: 'Roku', kind: 'Streamer', ports: [8060],
  async detect(ip, open) {
    if (!open.has(8060)) return null;
    const r = await request('GET', `http://${ip}:8060/query/device-info`, { timeout: 2000 }).catch(() => null); if (!r || r.status !== 200 || !/<device-info>/.test(r.text)) return null;
    const x = r.text; const tv = xmlTag(x, 'is-tv') === 'true';
    return { model: `${xmlTag(x, 'model-name')} ${xmlTag(x, 'model-number')}`.trim(), name: xmlTag(x, 'user-device-name') || xmlTag(x, 'friendly-device-name'), serial: xmlTag(x, 'serial-number'), firmware: xmlTag(x, 'software-version'), mac: (xmlTag(x, 'wifi-mac') || xmlTag(x, 'ethernet-mac')).toUpperCase(), kind: tv ? 'TV' : 'Streamer', isTv: tv };
  },
  caps(dev) { return { keys: ['power', 'poweron', 'poweroff', 'up', 'down', 'left', 'right', 'select', 'back', 'home', 'info', 'play', 'rew', 'ff', 'replay', 'search', ...(dev.isTv ? ['volup', 'voldown', 'mute', 'chup', 'chdown'] : [])], inputs: dev.isTv ? [['InputHDMI1', 'HDMI 1'], ['InputHDMI2', 'HDMI 2'], ['InputHDMI3', 'HDMI 3'], ['InputTuner', 'Aerial']] : [], apps: dev.apps || [], note: 'If keys are ignored, on the Roku set Settings > System > Advanced > Control by mobile apps to Enabled.' }; },
  async status(dev) { const r = await request('GET', `http://${dev.ip}:8060/query/device-info`).catch(() => null); return { power: r ? (xmlTag(r.text, 'power-mode') === 'PowerOn' ? 'on' : 'standby') : 'off' }; },
  async send(dev, key) {
    if (key.startsWith('app:')) return request('POST', `http://${dev.ip}:8060/launch/${encodeURIComponent(key.slice(4))}`);
    const k = key.startsWith('input:') ? key.slice(6) : /^\d$/.test(key) ? 'Lit_' + key : ROKU_KEY[key]; if (!k) throw new Error('Not available on Roku: ' + key);
    const r = await request('POST', `http://${dev.ip}:8060/keypress/${k}`); if (r.status >= 400) throw new Error(r.status === 403 ? 'Roku refused: enable "Control by mobile apps"' : 'Roku said ' + r.status);
  },
};

module.exports = { lg, samsung, sony, roku };
