'use strict';
// Sonor Remote drivers against simulated devices on loopback aliases (Linux: all of 127/8 is local; low ports need root or
// net.ipv4.ip_unprivileged_port_start=0). Each fake speaks just enough of the real protocol to check what we send.
//   .21 Denon (Telnet 23)   .22 Yamaha (YXC 80)   .23 Onkyo (eISCP 60128)   .24 Roku (8060)   .25 Sonos (1400)
//   .26 PJLink (4352, password)   .27 JVC (20554)   .28 Samsung (8001 + wss 8002)   .29 LG (wss 3001)   .30 Sony (80)
// Run: node test/remote.test.js
const http = require('http'); const https = require('https'); const net = require('net'); const crypto = require('crypto'); const fs = require('fs'); const path = require('path');
const assert = require('assert');
const drivers = require('../lib/drivers');
const { iscp, iscpRead } = require('../lib/drivers/avr');
const got = []; // everything the fakes received
const TLS = { key: fs.readFileSync(path.join(__dirname, 'fixtures/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'fixtures/cert.pem')) };

const listen = (srv, host, port) => new Promise((r) => srv.listen(port, host, () => r(srv)));
const tcp = (host, port, onConn) => listen(net.createServer((c) => { c.on('error', () => {}); onConn(c); }), host, port);
const web = (host, port, fn, secure) => listen(secure ? https.createServer(TLS, fn) : http.createServer(fn), host, port);
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => b += d); req.on('end', () => r(b)); });

// Tiny WebSocket server side (handshake + unmasking) for the LG and Samsung fakes.
function wsAttach(server, onSocket) {
  server.on('upgrade', (req, sock) => {
    const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    let buf = Buffer.alloc(0); const send = (t) => { const p = Buffer.from(t); sock.write(Buffer.concat([Buffer.from(p.length < 126 ? [0x81, p.length] : [0x81, 126, p.length >> 8, p.length & 255]), p])); };
    const api = { send, url: req.url, onMsg: () => {} };
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); while (buf.length > 6) { let len = buf[1] & 0x7f, o = 2; if (len === 126) { len = buf.readUInt16BE(2); o = 4; } if (buf.length < o + 4 + len) return; const m = buf.slice(o, o + 4); const p = Buffer.from(buf.slice(o + 4, o + 4 + len)); for (let i = 0; i < p.length; i++) p[i] ^= m[i % 4]; const op = buf[0] & 15; buf = buf.slice(o + 4 + len); if (op === 8) return sock.end(); api.onMsg(p.toString()); } });
    sock.on('error', () => {});
    onSocket(api);
  });
  return server;
}

(async () => {
  const S = [];
  // Denon: one command per line, answers PW / MV / MU / SI
  let dn = { PW: 'STANDBY', MV: '45', MU: 'OFF', SI: 'BD' };
  S.push(await tcp('127.0.0.21', 23, (c) => c.on('data', (d) => d.toString().split('\r').filter(Boolean).forEach((cmd) => {
    got.push('denon ' + cmd);
    if (cmd === 'PW?') c.write(`PW${dn.PW}\r`); else if (cmd === 'MV?') c.write(`MV${dn.MV}\rMVMAX 98\r`); else if (cmd === 'MU?') c.write(`MU${dn.MU}\r`); else if (cmd === 'SI?') c.write(`SI${dn.SI}\r`); else if (cmd === 'MS?') c.write('MSSTEREO\r');
    else if (cmd === 'PWON') { dn.PW = 'ON'; c.write('PWON\r'); } else if (cmd.startsWith('SI')) { dn.SI = cmd.slice(2); c.write(cmd + '\r'); } else if (cmd === 'MUON') { dn.MU = 'ON'; c.write('MUON\r'); }
  }))));
  S.push(await web('127.0.0.21', 8080, (q, r) => { if (q.url === '/goform/Deviceinfo.xml') { r.end('<Device_Info><ModelName>AVC-X6800H</ModelName></Device_Info>'); } else { r.writeHead(404); r.end(); } }));
  // Yamaha YXC
  S.push(await web('127.0.0.22', 80, (q, r) => { got.push('yamaha ' + q.url); const u = q.url.replace('/YamahaExtendedControl/v1/', ''); const J = (o) => { r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify({ response_code: 0, ...o })); };
    if (u === 'system/getDeviceInfo') return J({ model_name: 'RX-A8A', system_version: 3.71, serial_number: 'Y1' }); if (u === 'system/getFeatures') return J({ zone: [{ id: 'main', input_list: ['hdmi1', 'hdmi2', 'net_radio'], sound_program_list: ['straight', 'surr_decoder'] }] });
    if (u === 'system/getNameText') return J({ zone_list: [{ id: 'main', text: 'Cinema' }] }); if (u === 'main/getStatus') return J({ power: 'on', volume: 80, mute: false, input: 'hdmi1' }); if (u.startsWith('main/') || u.startsWith('netusb/')) return J({}); r.writeHead(404); r.end(); }));
  // Onkyo eISCP
  S.push(await tcp('127.0.0.23', 60128, (c) => c.on('data', (d) => iscpRead(d).forEach((cmd) => { got.push('onkyo ' + cmd); if (cmd === 'PWRQSTN') c.write(iscp('PWR01')); else if (cmd === 'MVLQSTN') c.write(iscp('MVL28')); else c.write(iscp(cmd)); }))));
  // Roku
  S.push(await web('127.0.0.24', 8060, async (q, r) => { got.push('roku ' + q.method + ' ' + q.url); if (q.url === '/query/device-info') return r.end('<device-info><model-name>Roku Ultra</model-name><model-number>4850X</model-number><user-device-name>Lounge Roku</user-device-name><serial-number>X00</serial-number><software-version>12.5</software-version><is-tv>false</is-tv><power-mode>PowerOn</power-mode></device-info>'); r.end(); }));
  // Sonos
  let snVol = 20;
  S.push(await web('127.0.0.25', 1400, async (q, r) => { const b = await body(q); got.push('sonos ' + (q.headers.soapaction || q.url));
    if (q.url === '/xml/device_description.xml') return r.end('<root><device><roomName>Kitchen</roomName><modelName>Sonos Era 100</modelName><displayVersion>16.4</displayVersion><serialNum>48-A6</serialNum><MACAddress>48:A6:B8:11:22:33</MACAddress></device></root>');
    if (/#GetVolume/.test(q.headers.soapaction)) return r.end(`<CurrentVolume>${snVol}</CurrentVolume>`); if (/#SetVolume/.test(q.headers.soapaction)) { snVol = Number(b.match(/<DesiredVolume>(\d+)/)[1]); } r.end('<ok/>'); }));
  // PJLink with password "sonor"
  S.push(await tcp('127.0.0.26', 4352, (c) => { const rnd = '498e4a67'; c.write(`PJLINK 1 ${rnd}\r`); c.on('data', (d) => d.toString().split('\r').filter(Boolean).forEach((line) => {
    const want = crypto.createHash('md5').update(rnd + 'sonor').digest('hex'); const cmd = line.startsWith(want) ? line.slice(32) : line.startsWith('%1') ? (c.authed ? line : null) : null;
    if (!cmd) return c.write('PJLINK ERRA\r'); c.authed = true; got.push('pjlink ' + cmd);
    const [k, v] = cmd.slice(2).split(' '); const A = { NAME: 'Cinema PJ', INF1: 'EPSON', INF2: 'EH-LS12000B', INST: '31 32 52', POWR: v === '?' ? '0' : 'OK', INPT: v === '?' ? '31' : 'OK', AVMT: v === '?' ? '30' : 'OK', LAMP: '1234 0' };
    c.write(`%1${k}=${A[k] || 'ERR1'}\r`); })); }));
  // JVC
  S.push(await tcp('127.0.0.27', 20554, (c) => { c.write('PJ_OK'); c.on('data', (d) => { const t = d.toString('latin1'); if (t.startsWith('PJREQ')) { got.push('jvc ' + t); c.write('PJACK'); } else { got.push('jvc cmd ' + d.slice(3, -1).toString()); c.write(Buffer.from([0x06, 0x89, 0x01, 0x50, 0x57, 0x0a])); } }); }));
  // Samsung: REST 8001 + wss 8002 that issues a token
  S.push(await web('127.0.0.28', 8001, (q, r) => { r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify({ device: { modelName: 'QE65S95CATXXU', name: 'Samsung S95C', wifiMac: '64:1c:ae:00:11:22', TokenAuthSupport: 'true', PowerState: 'on' } })); }));
  S.push(wsAttach(await web('127.0.0.28', 8002, (q, r) => { r.writeHead(404); r.end(); }, true), (ws) => { got.push('samsung ws ' + ws.url.split('?')[1]); ws.send(JSON.stringify({ event: 'ms.channel.connect', data: { token: '12345678' } })); ws.onMsg = (m) => got.push('samsung ' + JSON.parse(m).params.DataOfCmd); }));
  // LG: wss 3001 with SSAP register + requests + pointer socket on the same server
  const lgSrv = await web('127.0.0.29', 3001, (q, r) => { r.writeHead(404); r.end(); }, true);
  wsAttach(lgSrv, (ws) => {
    if (ws.url.startsWith('/pointer')) { ws.onMsg = (m) => got.push('lg pointer ' + m.split('\n')[1]); return; }
    ws.onMsg = (m) => { const j = JSON.parse(m); got.push('lg ' + (j.uri || j.type));
      if (j.type === 'register') return ws.send(JSON.stringify({ type: 'registered', id: j.id, payload: { 'client-key': 'abc123' } }));
      const P = { 'ssap://system/getSystemInfo': { modelName: 'OLED65C3' }, 'ssap://tv/getExternalInputList': { devices: [{ id: 'HDMI_1', label: 'Sky Q' }, { id: 'HDMI_2', label: 'Apple TV' }] }, 'ssap://com.webos.service.networkinput/getPointerInputSocket': { socketPath: 'wss://127.0.0.29:3001/pointer/1' }, 'ssap://audio/getStatus': { volume: 12, mute: false } };
      ws.send(JSON.stringify({ type: 'response', id: j.id, payload: { returnValue: true, ...(P[j.uri] || {}) } })); };
  });
  S.push(lgSrv);
  // Sony: REST + IRCC with PSK 0000
  S.push(await web('127.0.0.30', 80, async (q, r) => { const b = await body(q); r.setHeader('Content-Type', 'application/json');
    if (q.url === '/sony/IRCC') { got.push('sony ircc ' + b.match(/<IRCCCode>([^<]+)/)[1] + ' psk=' + q.headers['x-auth-psk']); return r.end(); }
    const j = JSON.parse(b || '{}'); got.push('sony ' + j.method);
    const R = { getInterfaceInformation: [{ productCategory: 'tv', productName: 'BRAVIA', modelName: 'XR-65A95L', serverName: '' }], getRemoteControllerInfo: [{}, [{ name: 'VolumeUp', value: 'AAAAAQAAAAEAAAASAw==' }, { name: 'Confirm', value: 'AAAAAQAAAAEAAABlAw==' }]],
      getCurrentExternalInputsStatus: [[{ uri: 'extInput:hdmi?port=1', title: 'HDMI 1', label: 'Sky Q' }]], getPowerStatus: [{ status: 'active' }] };
    if (j.method === 'getCurrentExternalInputsStatus' && q.headers['x-auth-psk'] !== '0000') return r.end(JSON.stringify({ error: [403, 'Forbidden'] }));
    r.end(JSON.stringify({ result: R[j.method] || [] })); }));

  // ── discovery ──
  const ips = Array.from({ length: 12 }, (_, i) => `127.0.0.${20 + i}`);
  const t0 = Date.now(); const r = await drivers.discover({ targets: ips }); const by = Object.fromEntries(r.devices.map((d) => [d.ip, d]));
  for (const d of r.devices) console.log(d.ip.padEnd(12), d.driver.padEnd(8), `${d.make} ${d.model}`.padEnd(36), d.name || '');
  const want = { '127.0.0.21': 'denon', '127.0.0.22': 'yamaha', '127.0.0.23': 'onkyo', '127.0.0.24': 'roku', '127.0.0.25': 'sonos', '127.0.0.26': 'pjlink', '127.0.0.27': 'jvc', '127.0.0.28': 'samsung', '127.0.0.29': 'lg', '127.0.0.30': 'sony' };
  for (const [ip, id] of Object.entries(want)) assert.strictEqual((by[ip] || {}).driver, id, `${ip} should be ${id}`);
  assert.strictEqual(by['127.0.0.21'].model, 'AVC-X6800H'); assert.strictEqual(by['127.0.0.22'].name, 'Cinema'); assert.strictEqual(by['127.0.0.25'].name, 'Kitchen'); assert.ok(by['127.0.0.26'].locked);
  console.log(`discovery ok (${Date.now() - t0} ms)`);

  // ── control ──
  const D = (ip) => by[ip]; const send = (ip, k) => drivers.BY_ID[D(ip).driver].send(D(ip), k);
  await send('127.0.0.21', 'power'); await send('127.0.0.21', 'input:SAT/CBL'); await send('127.0.0.21', 'vol:52'); await send('127.0.0.21', 'mute');
  assert.ok(got.includes('denon PWON') && got.includes('denon SISAT/CBL') && got.includes('denon MV52') && got.includes('denon MUON'), 'denon commands');
  assert.deepStrictEqual(await drivers.BY_ID.denon.status(D('127.0.0.21')), { power: 'on', volume: 45, mute: true, input: 'SAT/CBL', mode: 'STEREO' });
  await send('127.0.0.22', 'input:hdmi2'); await send('127.0.0.22', 'volup'); assert.ok(got.includes('yamaha /YamahaExtendedControl/v1/main/setInput?input=hdmi2'));
  await send('127.0.0.23', 'vol:40'); await send('127.0.0.23', 'input:01'); assert.ok(got.includes('onkyo MVL28') && got.includes('onkyo SLI01'));
  await send('127.0.0.24', 'home'); await send('127.0.0.24', '5'); assert.ok(got.includes('roku POST /keypress/Home') && got.includes('roku POST /keypress/Lit_5'));
  await send('127.0.0.25', 'volup'); assert.strictEqual(snVol, 22);
  await assert.rejects(send('127.0.0.26', 'poweron'), /password/);
  await drivers.BY_ID.pjlink.pair(D('127.0.0.26'), { password: 'sonor' }); assert.strictEqual(D('127.0.0.26').model, 'EH-LS12000B'); assert.strictEqual(D('127.0.0.26').inputs[0][1], 'HDMI 1');
  await send('127.0.0.26', 'poweron'); await send('127.0.0.26', 'input:32'); assert.ok(got.includes('pjlink %1POWR 1') && got.includes('pjlink %1INPT 32'));
  await send('127.0.0.27', 'poweron'); assert.ok(got.includes('jvc cmd PW1'));
  await drivers.BY_ID.samsung.pair(D('127.0.0.28')); assert.strictEqual(D('127.0.0.28').auth.token, '12345678');
  await send('127.0.0.28', 'volup'); assert.ok(got.includes('samsung KEY_VOLUP') && got.some((g) => /token=12345678/.test(g)));
  await assert.rejects(send('127.0.0.29', 'volup'), /Pair/);
  await drivers.BY_ID.lg.pair(D('127.0.0.29')); assert.strictEqual(D('127.0.0.29').auth.clientKey, 'abc123'); assert.strictEqual(D('127.0.0.29').model, 'OLED65C3'); assert.strictEqual(D('127.0.0.29').inputs[1][1], 'Apple TV');
  await send('127.0.0.29', 'volup'); await send('127.0.0.29', 'up'); await send('127.0.0.29', 'input:HDMI_2');
  assert.ok(got.includes('lg ssap://audio/volumeUp') && got.includes('lg pointer name:UP') && got.includes('lg ssap://tv/switchInput'));
  await assert.rejects(drivers.BY_ID.sony.pair(D('127.0.0.30'), { psk: '9999' }), /not accepted/);
  await drivers.BY_ID.sony.pair(D('127.0.0.30'), { psk: '0000' }); assert.strictEqual(D('127.0.0.30').inputs[0][1], 'Sky Q');
  await send('127.0.0.30', 'volup'); assert.ok(got.includes('sony ircc AAAAAQAAAAEAAAASAw== psk=0000'));
  console.log('control ok:', got.length, 'messages checked');
  S.forEach((s) => s.close()); process.exit(0);
})().catch((e) => { console.error(e); console.error(got.slice(-15).join('\n')); process.exit(1); });
