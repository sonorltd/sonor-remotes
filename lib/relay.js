'use strict';
// Relay: links this bridge to the hosted page on apps.sonor.co.uk via Supabase.
// The bridge only makes OUTBOUND HTTPS calls (no port forwarding on site):
//   - registers once (sky_bridge_register) and keeps its id + token in relay.json
//   - every few seconds posts its box list / scan state (sky_bridge_heartbeat)
//   - polls for commands (sky_bridge_claim), runs them, posts results (sky_bridge_finish)
// The hosted page inserts rows into sky_commands and reads the result back.

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SKY_SUPABASE_URL || 'https://ysmvklstkzodlocttspy.supabase.co';
// Public anon key (the same one every Sonor app page ships). Bridge rights come from its own token.
const SUPABASE_ANON = process.env.SKY_SUPABASE_ANON || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzbXZrbHN0a3pvZGxvY3R0c3B5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3Njc0OTMsImV4cCI6MjA4OTM0MzQ5M30.08kRS_dtbwz0rSYezNGMJHnOU_st8GKZseQPefcMEMc';

const POLL_MS = 600;       // command poll when idle
const HEARTBEAT_MS = 10000;

async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function start({ name, actions, onChange, version, dir }) {
  const cfgPath = path.join(dir, 'relay.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  let online = false;
  let dirty = true;
  onChange(() => { dirty = true; });

  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[relay]', ...a);

  async function ensureRegistered() {
    if (cfg && cfg.id && cfg.token) return;
    const rows = await rpc('sky_bridge_register', { p_name: name, p_version: version });
    const row = Array.isArray(rows) ? rows[0] : rows;
    cfg = { id: row.id, token: row.token, name };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    log(`registered as "${name}" (${cfg.id})`);
  }

  async function heartbeat() {
    const [, state] = await actions.boxes();
    await rpc('sky_bridge_heartbeat', { p_id: cfg.id, p_token: cfg.token, p_name: name, p_version: version, p_state: state });
    dirty = false;
    scanning = !!(state.scan && state.scan.running);
  }

  async function runCommand(c) {
    let code = 500, result;
    try {
      const fn = actions[c.action];
      if (!fn) [code, result] = [400, { error: `unknown action ${c.action}` }];
      else [code, result] = await fn(c.payload || {});
    } catch (e) { result = { error: e.message }; }
    // publish the new box list BEFORE reporting done, so the page's next read already shows it
    if (c.action !== 'key') { try { await heartbeat(); } catch {} }
    await rpc('sky_bridge_finish', { p_id: cfg.id, p_token: cfg.token, p_cmd: c.id, p_code: code, p_result: result });
    dirty = true;
  }

  let lastBeat = 0;
  let scanning = false;
  async function loop() {
    try {
      await ensureRegistered();
      if (dirty || Date.now() - lastBeat > (scanning ? 1500 : HEARTBEAT_MS)) { await heartbeat(); lastBeat = Date.now(); }
      const cmds = await rpc('sky_bridge_claim', { p_id: cfg.id, p_token: cfg.token }) || [];
      for (const c of cmds) await runCommand(c);
      if (!online) { online = true; log('linked to apps.sonor.co.uk'); }
      if (cmds.length) dirty = true;
    } catch (e) {
      if (/invalid bridge/i.test(e.message)) { log('bridge token rejected, registering again'); cfg = null; try { fs.unlinkSync(cfgPath); } catch {} }
      if (online || !loop.warned) { log('offline:', e.message); loop.warned = true; }
      online = false;
      return setTimeout(loop, 5000);
    }
    setTimeout(loop, POLL_MS);
  }
  loop();
}

module.exports = { start };
