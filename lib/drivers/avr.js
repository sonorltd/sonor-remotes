'use strict';
// AV receivers: Denon / Marantz (Telnet 23), Yamaha MusicCast (YXC over HTTP), Onkyo / Pioneer / Integra (eISCP 60128).
const { tcpTalk, request } = require('../conn');

// ── Denon / Marantz ─────────────────────────────────────────
// One Telnet session at a time is allowed by the receiver, so each command opens, sends and closes.
const DENON_INPUTS = [['BD', 'Blu-ray'], ['SAT/CBL', 'Sky / CBL'], ['GAME', 'Game'], ['MPLAY', 'Media player'], ['TV', 'TV audio'], ['DVD', 'DVD'], ['AUX1', 'AUX 1'], ['NET', 'HEOS / Network'], ['TUNER', 'Tuner'], ['BT', 'Bluetooth'], ['PHONO', 'Phono'], ['CD', 'CD']];
const DENON_MODES = [['AUTO', 'Auto'], ['STEREO', 'Stereo'], ['DIRECT', 'Direct'], ['PURE DIRECT', 'Pure Direct'], ['MOVIE', 'Movie'], ['MUSIC', 'Music'], ['GAME', 'Game'], ['MCH STEREO', 'All-ch stereo']];
const denonSend = (ip, cmds, until) => tcpTalk(ip, 23, { send: cmds.map((c) => c + '\r'), until, timeout: 1800 });
async function denonStatus(dev) {
  const r = await denonSend(dev.ip, ['PW?', 'MV?', 'MU?', 'SI?', 'MS?'], null).catch(() => '');
  const g = (re) => (r.match(re) || [])[1];
  const mv = g(/\rMV(\d{2,3})\r/) || g(/^MV(\d{2,3})/m);
  return { power: g(/PW(ON|STANDBY)/) === 'ON' ? 'on' : g(/PW(ON|STANDBY)/) ? 'standby' : 'unknown', volume: mv ? Number(mv.length === 3 ? mv / 10 : mv) : null, mute: g(/MU(ON|OFF)/) === 'ON', input: g(/SI([^\r]+)/) || '', mode: g(/MS([^\r]+)/) || '' };
}
const DENON_KEYS = { poweron: 'PWON', poweroff: 'PWSTANDBY', volup: 'MVUP', voldown: 'MVDOWN', up: 'MNCUP', down: 'MNCDN', left: 'MNCLT', right: 'MNCRT', select: 'MNENT', back: 'MNRTN', menu: 'MNMEN ON', info: 'MNINF', zone2on: 'Z2ON', zone2off: 'Z2OFF' };
const denon = {
  id: 'denon', make: 'Denon / Marantz', kind: 'AV receiver', ports: [23],
  async detect(ip, open) {
    if (!open.has(23)) return null;
    const r = await denonSend(ip, ['PW?'], /PW(ON|STANDBY)/).catch(() => '');
    if (!/PW(ON|STANDBY)/.test(r)) return null;
    let model = '';
    for (const u of [`http://${ip}:8080/goform/Deviceinfo.xml`, `http://${ip}/goform/Deviceinfo.xml`]) {
      const x = await request('GET', u, { timeout: 1500 }).catch(() => null);
      const m = x && x.status === 200 && x.text.match(/<ModelName>([^<]+)<\/ModelName>/i); if (m) { model = m[1].trim(); break; }
    }
    return { model: model || 'AV receiver', make: /marantz/i.test(model) ? 'Marantz' : model ? 'Denon' : 'Denon / Marantz' };
  },
  caps() { return { keys: ['power', 'poweron', 'poweroff', 'volup', 'voldown', 'mute', 'up', 'down', 'left', 'right', 'select', 'back', 'menu', 'info', 'zone2on', 'zone2off'], volume: { min: 0, max: 98 }, inputs: DENON_INPUTS, modes: DENON_MODES, note: 'Only one Telnet control can be connected at a time. Close the Control4 / Crestron Telnet session if commands are ignored.' }; },
  status: denonStatus,
  async send(dev, key) {
    if (key === 'power') { const s = await denonStatus(dev); key = s.power === 'on' ? 'poweroff' : 'poweron'; }
    if (key === 'mute') { const s = await denonStatus(dev); return denonSend(dev.ip, [s.mute ? 'MUOFF' : 'MUON']); }
    let cmd = DENON_KEYS[key];
    if (!cmd && key.startsWith('input:')) cmd = 'SI' + key.slice(6);
    if (!cmd && key.startsWith('mode:')) cmd = 'MS' + key.slice(5);
    if (!cmd && key.startsWith('vol:')) cmd = 'MV' + String(Math.max(0, Math.min(98, Math.round(Number(key.slice(4)))))).padStart(2, '0');
    if (!cmd) throw new Error('Not available on this receiver: ' + key);
    return denonSend(dev.ip, [cmd]);
  },
};

// ── Yamaha MusicCast (YXC) ──────────────────────────────────
const yxc = async (ip, path) => { const r = await request('GET', `http://${ip}/YamahaExtendedControl/v1/${path}`, { timeout: 2500 }); const j = r.json(); if (!j || j.response_code !== 0) throw new Error(`Receiver said no (code ${j ? j.response_code : r.status})`); return j; };
const yamaha = {
  id: 'yamaha', make: 'Yamaha', kind: 'AV receiver', ports: [80],
  async detect(ip, open) {
    if (!open.has(80)) return null;
    const j = await yxc(ip, 'system/getDeviceInfo').catch(() => null); if (!j || !j.model_name) return null;
    const f = await yxc(ip, 'system/getFeatures').catch(() => null); const z = f && (f.zone || []).find((x) => x.id === 'main');
    const n = await yxc(ip, 'system/getNameText').catch(() => null);
    return { model: j.model_name, firmware: String(j.system_version || ''), serial: j.serial_number || '', name: ((n && n.zone_list || []).find((x) => x.id === 'main') || {}).text || '',
      inputs: z ? (z.input_list || []).map((i) => [i, i.toUpperCase().replace(/(\D)(\d)/, '$1 $2')]) : [], modes: z ? (z.sound_program_list || []).map((p) => [p, p.replace(/_/g, ' ')]) : [] };
  },
  caps(dev) { return { keys: ['power', 'poweron', 'poweroff', 'volup', 'voldown', 'mute', 'up', 'down', 'left', 'right', 'select', 'back', 'menu', 'play', 'pause', 'stop', 'prev', 'next'], volume: { min: 0, max: 161 }, inputs: dev.inputs && dev.inputs.length ? dev.inputs : [['hdmi1', 'HDMI 1'], ['hdmi2', 'HDMI 2'], ['hdmi3', 'HDMI 3'], ['av1', 'AV 1'], ['net_radio', 'Net radio'], ['bluetooth', 'Bluetooth']], modes: dev.modes || [] }; },
  async status(dev) { const s = await yxc(dev.ip, 'main/getStatus'); return { power: s.power === 'on' ? 'on' : 'standby', volume: s.volume, mute: !!s.mute, input: s.input, mode: s.sound_program || '' }; },
  async send(dev, key) {
    const K = { power: 'main/setPower?power=toggle', poweron: 'main/setPower?power=on', poweroff: 'main/setPower?power=standby', volup: 'main/setVolume?volume=up&step=2', voldown: 'main/setVolume?volume=down&step=2',
      up: 'main/controlCursor?cursor=up', down: 'main/controlCursor?cursor=down', left: 'main/controlCursor?cursor=left', right: 'main/controlCursor?cursor=right', select: 'main/controlCursor?cursor=select', back: 'main/controlCursor?cursor=return', menu: 'main/controlMenu?menu=on_screen',
      play: 'netusb/setPlayback?playback=play', pause: 'netusb/setPlayback?playback=pause', stop: 'netusb/setPlayback?playback=stop', prev: 'netusb/setPlayback?playback=previous', next: 'netusb/setPlayback?playback=next' };
    if (key === 'mute') { const s = await this.status(dev); return yxc(dev.ip, `main/setMute?enable=${!s.mute}`); }
    if (key.startsWith('input:')) return yxc(dev.ip, 'main/setInput?input=' + encodeURIComponent(key.slice(6)));
    if (key.startsWith('mode:')) return yxc(dev.ip, 'main/setSoundProgram?program=' + encodeURIComponent(key.slice(5)));
    if (key.startsWith('vol:')) return yxc(dev.ip, 'main/setVolume?volume=' + Math.round(Number(key.slice(4))));
    if (!K[key]) throw new Error('Not available on this receiver: ' + key);
    return yxc(dev.ip, K[key]);
  },
};

// ── Onkyo / Pioneer / Integra (eISCP, TCP 60128) ────────────
function iscp(cmd) { const data = Buffer.from('!1' + cmd + '\r'); const h = Buffer.alloc(16); h.write('ISCP', 0); h.writeUInt32BE(16, 4); h.writeUInt32BE(data.length, 8); h[12] = 1; return Buffer.concat([h, data]); }
const iscpRead = (buf) => { const out = []; let o = 0; while (o + 16 <= buf.length && buf.toString('latin1', o, o + 4) === 'ISCP') { const hl = buf.readUInt32BE(o + 4); const dl = buf.readUInt32BE(o + 8); out.push(buf.toString('latin1', o + hl, o + hl + dl).replace(/[\r\n\x1a]+$/, '').replace(/^!1/, '')); o += hl + dl; } return out; };
const onkyoTalk = (ip, cmds, until) => tcpTalk(ip, 60128, { send: cmds.map(iscp), until, timeout: 1800, binary: true }).then(iscpRead);
const ONKYO_INPUTS = [['10', 'BD / DVD'], ['01', 'Sky / CBL / SAT'], ['02', 'Game'], ['05', 'PC'], ['12', 'TV'], ['2B', 'Network'], ['2E', 'Bluetooth'], ['24', 'Tuner FM'], ['23', 'CD'], ['03', 'AUX']];
const onkyo = {
  id: 'onkyo', make: 'Onkyo / Pioneer / Integra', kind: 'AV receiver', ports: [60128],
  async detect(ip, open) {
    if (!open.has(60128)) return null;
    const r = await onkyoTalk(ip, ['PWRQSTN'], /PWR/).catch(() => []);
    return r.some((x) => /^PWR/.test(x)) ? { model: 'AV receiver' } : null;
  },
  caps() { return { keys: ['power', 'poweron', 'poweroff', 'volup', 'voldown', 'mute', 'up', 'down', 'left', 'right', 'select', 'back', 'menu', 'home'], volume: { min: 0, max: 80 }, inputs: ONKYO_INPUTS, modes: [['MOVIE', 'Movie'], ['MUSIC', 'Music'], ['GAME', 'Game'], ['00', 'Stereo'], ['01', 'Direct']] }; },
  async status(dev) {
    const r = await onkyoTalk(dev.ip, ['PWRQSTN', 'MVLQSTN', 'AMTQSTN', 'SLIQSTN'], null).catch(() => []);
    const g = (p) => (r.find((x) => x.startsWith(p)) || '').slice(3);
    return { power: g('PWR') === '01' ? 'on' : g('PWR') ? 'standby' : 'unknown', volume: g('MVL') ? parseInt(g('MVL'), 16) : null, mute: g('AMT') === '01', input: g('SLI') };
  },
  async send(dev, key) {
    const K = { poweron: 'PWR01', poweroff: 'PWR00', volup: 'MVLUP', voldown: 'MVLDOWN', mute: 'AMTTG', up: 'OSDUP', down: 'OSDDOWN', left: 'OSDLEFT', right: 'OSDRIGHT', select: 'OSDENTER', back: 'OSDEXIT', menu: 'OSDMENU', home: 'OSDHOME' };
    if (key === 'power') { const s = await this.status(dev); key = s.power === 'on' ? 'poweroff' : 'poweron'; }
    let c = K[key];
    if (!c && key.startsWith('input:')) c = 'SLI' + key.slice(6);
    if (!c && key.startsWith('mode:')) c = /^\d/.test(key.slice(5)) ? 'LMD' + key.slice(5) : 'LMD' + key.slice(5);
    if (!c && key.startsWith('vol:')) c = 'MVL' + Math.max(0, Math.min(80, Math.round(Number(key.slice(4))))).toString(16).toUpperCase().padStart(2, '0');
    if (!c) throw new Error('Not available on this receiver: ' + key);
    return onkyoTalk(dev.ip, [c]);
  },
};

module.exports = { denon, yamaha, onkyo, iscp, iscpRead };
