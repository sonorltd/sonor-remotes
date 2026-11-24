'use strict';
// Simulated Sky boxes on loopback aliases (Linux: all of 127.0.0.0/8 is local).
//   127.0.0.5  Sky Q main box: remote on 49160, REST on 9006
//   127.0.0.7  Sky+HD: remote on 5900, no REST
//   127.0.0.6  a Mac with screen sharing: VNC on 5900 (must NOT be listed)
// Run: node test/test.js
const net = require('net');
const http = require('http');
const assert = require('assert');
const sky = require('../lib/sky');

const received = {};

function fakeSkyRemote(host, port) {
  return new Promise((res) => {
    const srv = net.createServer((c) => {
      let stage = 0; let buf = Buffer.alloc(0);
      c.write('SKY 000.001\n');
      c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (stage === 0 && buf.length >= 12) { assert.strictEqual(buf.slice(0, 12).toString(), 'SKY 000.001\n'); buf = buf.slice(12); stage = 1; c.write(Buffer.from([1, 1])); }
        if (stage === 1 && buf.length >= 1) { buf = buf.slice(1); stage = 2; c.write(Buffer.from([0, 0, 0, 0])); }
        if (stage === 2 && buf.length >= 1) { buf = buf.slice(1); stage = 3; const init = Buffer.alloc(28); init.write('SKY', 24); c.write(init); }
        while (stage === 3 && buf.length >= 8) {
          const f = buf.slice(0, 8); buf = buf.slice(8);
          (received[host] = received[host] || []).push([...f]);
        }
      });
      c.on('error', () => {});
    });
    srv.listen(port, host, () => res(srv));
  });
}

function fakeVnc(host) {
  return new Promise((res) => { const s = net.createServer((c) => { c.write('RFB 003.008\n'); c.on('error', () => {}); }); s.listen(5900, host, () => res(s)); });
}

function fakeRest(host, info) {
  return new Promise((res) => {
    const s = http.createServer((req, r) => {
      if (req.url === '/as/system/information') { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(info)); }
      else { r.writeHead(404); r.end(); }
    });
    s.listen(9006, host, () => res(s));
  });
}

(async () => {
  const servers = await Promise.all([
    fakeSkyRemote('127.0.0.5', 49160),
    fakeRest('127.0.0.5', { deviceType: 'GATEWAYSTB', hardwareName: 'Falcon', hardwareModel: 'ES240', modelNumber: 'Q112.000.21.00L', serialNumber: '0123456789', activeStandby: false }),
    fakeSkyRemote('127.0.0.7', 5900),
    fakeVnc('127.0.0.6'),
  ]);

  // Frame encoding
  assert.deepStrictEqual([...sky.keyFrame(0, true)], [4, 1, 0, 0, 0, 0, 224, 0]);
  assert.deepStrictEqual([...sky.keyFrame(241, false)], [4, 0, 0, 0, 0, 0, 239, 1]);
  assert.deepStrictEqual([...sky.keyFrame(sky.KEYS.up, true)], [4, 1, 0, 0, 0, 0, 225, 0]);
  console.log('ok  key frames');

  // Discovery over the loopback "subnet"
  const t0 = Date.now();
  const { boxes } = await sky.discover({ subnets: ['127.0.0'] });
  console.log(`    discovery took ${Date.now() - t0} ms, found:`, boxes.map((b) => `${b.ip} ${b.model} port ${b.port}`));
  assert.strictEqual(boxes.length, 2, 'should find exactly the two Sky boxes, not the VNC host');
  const q = boxes.find((b) => b.ip === '127.0.0.5');
  assert.strictEqual(q.model, 'Sky Q (main box)'); assert.strictEqual(q.port, 49160); assert.strictEqual(q.power, 'on');
  assert.ok(q.hardware.includes('ES240'));
  const hd = boxes.find((b) => b.ip === '127.0.0.7');
  assert.ok(hd.model.startsWith('Sky+HD')); assert.strictEqual(hd.port, 5900);
  console.log('ok  discovery (Sky Q on 49160, Sky+HD on 5900, VNC ignored)');

  // Key sending: press + release per key
  await sky.sendKeys('127.0.0.5', 49160, ['power', '1', '0', '1']);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(received['127.0.0.5'], [
    [4, 1, 0, 0, 0, 0, 224, 0], [4, 0, 0, 0, 0, 0, 224, 0],
    [4, 1, 0, 0, 0, 0, 227, 1], [4, 0, 0, 0, 0, 0, 227, 1],
    [4, 1, 0, 0, 0, 0, 227, 0], [4, 0, 0, 0, 0, 0, 227, 0],
    [4, 1, 0, 0, 0, 0, 227, 1], [4, 0, 0, 0, 0, 0, 227, 1],
  ]);
  await sky.sendKey('127.0.0.7', 5900, 'sky');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(received['127.0.0.7'], [[4, 1, 0, 0, 0, 0, 239, 1], [4, 0, 0, 0, 0, 0, 239, 1]]);
  console.log('ok  key sending (Sky Q channel 101, Sky+HD sky key)');

  // Refuses to send keys to a VNC server
  await assert.rejects(sky.sendKey('127.0.0.6', 5900, 'power'), /not a Sky box/);
  await assert.rejects(sky.sendKey('127.0.0.5', 49160, 'nonsense'), /unknown key/);
  console.log('ok  rejects VNC hosts and unknown keys');

  servers.forEach((s) => s.close());
  console.log('\nAll tests passed.');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
