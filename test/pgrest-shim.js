'use strict';
// Tiny PostgREST stand-in for tests: runs requests as role "anon" through psql so grants/RLS are real.
// Supports the calls Sky Remote makes: POST /rest/v1/rpc/<fn>, GET /rest/v1/<view|table>?col=eq.x&select=a,b&order=..,
// POST /rest/v1/sky_commands (return=representation).
const http = require('http');
const { execFileSync } = require('child_process');
const PG = process.env.PGSHIM || '-h /tmp/pgsky -p 5499 -U postgres';
const lit = (v) => v === null || v === undefined ? 'null' : "'" + String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/'/g, "''") + "'";
function q(sql) {
  const out = execFileSync('psql', [...PG.split(' '), '-At', '-v', 'ON_ERROR_STOP=1', '-c', `set role anon; ${sql}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.trim().split('\n').filter((l) => l && l !== 'SET').pop() || 'null';
}
const ARGS = {
  sky_bridge_register: { p_name: 'text', p_version: 'text' },
  sky_bridge_heartbeat: { p_id: 'uuid', p_token: 'text', p_name: 'text', p_version: 'text', p_state: 'jsonb' },
  sky_bridge_claim: { p_id: 'uuid', p_token: 'text' },
  sky_bridge_finish: { p_id: 'uuid', p_token: 'text', p_cmd: 'bigint', p_code: 'int', p_result: 'jsonb' },
};
http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => b += d); req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', '*');
    if (req.method === 'OPTIONS') return res.end();
    const u = new URL(req.url, 'http://x'); const body = b ? JSON.parse(b) : {};
    try {
      let out;
      const m = u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
      if (m) {
        const sig = ARGS[m[1]]; const args = Object.entries(sig).map(([k, t]) => `${k} => ${lit(body[k])}::${t}`).join(', ');
        out = m[1] === 'sky_bridge_heartbeat' || m[1] === 'sky_bridge_finish'
          ? (q(`select public.${m[1]}(${args});`), 'null')
          : q(`select coalesce(json_agg(t), '[]') from public.${m[1]}(${args}) t;`);
      } else {
        const tbl = u.pathname.split('/').pop();
        if (req.method === 'POST') {
          const cols = Object.keys(body);
          out = q(`with i as (insert into public.${tbl} (${cols.join(',')}) values (${cols.map((c) => lit(body[c])).join(',')}) returning *) select json_agg(i) from i;`);
        } else {
          const where = []; let sel = '*'; let order = '';
          for (const [k, v] of u.searchParams) {
            if (k === 'select') sel = v; else if (k === 'order') order = ' order by ' + v.split(',').map((o) => o.replace('.desc', ' desc').replace('.nullslast', ' nulls last').replace('.asc', '')).join(',');
            else where.push(`${k} = ${lit(v.replace(/^eq\./, ''))}`);
          }
          out = q(`select coalesce(json_agg(t), '[]') from (select ${sel} from public.${tbl}${where.length ? ' where ' + where.join(' and ') : ''}${order}) t;`);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out);
    } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: String(e.stderr || e.message).trim() })); }
  });
}).listen(Number(process.env.SHIM_PORT || 5490), () => console.log('shim up'));
