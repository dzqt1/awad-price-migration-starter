// Steady traffic from OLD clients (and optionally new ones) against every running
// instance, like a load balancer would send it. Leave it running for the whole
// migration; its log is your evidence for IA#2.
//
//   TARGETS=http://localhost:3001,http://localhost:3002  (default)
//   DURATION=0        seconds, 0 = until Ctrl+C
//   IDS=2000          menu ids 1..IDS are used; 1..50 are never re-priced
//   LOG=traffic-log.txt
//
// Counted as failures: any 5xx, a response that breaks the contract, a read that
// does not show the last acknowledged write ("stale"), and any moment when NO
// instance answers ("unavailable"). One instance being down while another
// answers is a rolling restart, not a failure — it is counted as "rerouted".
import { appendFileSync } from 'node:fs';

const TARGETS = (process.env.TARGETS ?? 'http://localhost:3001,http://localhost:3002').split(',');
const DURATION = Number(process.env.DURATION ?? 0);
const IDS = Number(process.env.IDS ?? 2000);
const LOG = process.env.LOG ?? 'traffic-log.txt';
const WORKERS = 8;
const FIXED = 50; // ids 1..FIXED keep their price: orders are checked against them

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const log = (line) => { console.log(line); appendFileSync(LOG, line + '\n'); };

const n = { ok: 0, error: 0, contract: 0, stale: 0, rerouted: 0, unavailable: 0 };
const firstOf = {};
const fail = (kind, detail) => {
  n[kind]++;
  if ((firstOf[kind] = (firstOf[kind] ?? 0) + 1) <= 5) log(`${ts()} ${kind.toUpperCase()} ${detail}`);
};

const down = new Map(); // target -> retry-after timestamp
let rr = 0;
async function send(method, path, body) {
  for (let tries = 0; tries < TARGETS.length * 3; tries++) {
    const live = TARGETS.filter((t) => (down.get(t) ?? 0) <= Date.now());
    if (!live.length) { await new Promise((r) => setTimeout(r, 50)); continue; }
    const target = live[rr++ % live.length];
    try {
      const res = await fetch(target + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(3000),
      });
      if (down.has(target)) { down.delete(target); log(`${ts()} ${target} back`); }
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, target };
    } catch (e) {
      const code = e.cause?.code ?? e.name;
      if (!['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'TimeoutError'].includes(code)) throw e;
      if (!down.has(target)) log(`${ts()} ${target} down (${code})`);
      down.set(target, Date.now() + 300);
      n.rerouted++;
    }
  }
  return null;
}

const expected = new Map(); // id -> last acknowledged price, in thousands
const inflight = new Set();
const created = [];         // ids of items this run created, read back later
const pick = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
function checkItem(r, client, where) {
  const d = r.data;
  if (typeof d !== 'object' || typeof d.price !== 'number' || !(d.price > 0))
    return fail('contract', `${where} via ${r.target}: no numeric price — ${JSON.stringify(d).slice(0, 120)}`), false;
  if (client === 'new' && (!Number.isInteger(d.priceVnd) || d.priceVnd !== Math.round(d.price * 1000)))
    return fail('contract', `${where} via ${r.target}: priceVnd missing or disagrees with price — ${JSON.stringify(d).slice(0, 120)}`), false;
  return true;
}

async function once() {
  const roll = Math.random();
  const client = 'new';

  if (roll < 0.6) {                                     // read one item
    const id = created.length && Math.random() < 0.15 ? created[pick(0, created.length - 1)] : pick(1, IDS);
    const watching = !inflight.has(id) && expected.has(id);
    const want = expected.get(id);
    const r = await send('GET', `/menu/${id}`);
    if (!r) return fail('unavailable', `GET /menu/${id}`);
    if (r.status >= 500) return fail('error', `GET /menu/${id} -> ${r.status} via ${r.target}`);
    if (r.status !== 200) return fail('contract', `GET /menu/${id} -> ${r.status} via ${r.target}`);
    if (!checkItem(r, client, `GET /menu/${id}`)) return;
    if (watching && !inflight.has(id) && expected.get(id) === want && Math.abs(r.data.price - want) > 1e-9)
      return fail('stale', `GET /menu/${id} via ${r.target}: price ${r.data.price}, last write was ${want}`);
    return n.ok++;
  }

  if (roll < 0.8) {                                     // re-price one item
    const id = pick(FIXED + 1, IDS);
    if (inflight.has(id)) return;
    inflight.add(id);
    try {
      const price = pick(30, 500) / 2;
      const body = client === 'new' ? { priceVnd: Math.round(price * 1000) } : { price };
      const r = await send('PATCH', `/menu/${id}`, body);
      if (!r) return fail('unavailable', `PATCH /menu/${id}`);
      if (r.status >= 500) return fail('error', `PATCH /menu/${id} -> ${r.status} via ${r.target}`);
      if (r.status !== 200) return fail('contract', `PATCH /menu/${id} ${JSON.stringify(body)} -> ${r.status} via ${r.target}`);
      expected.set(id, price);
      if (!checkItem(r, client, `PATCH /menu/${id}`)) return;
      if (Math.abs(r.data.price - price) > 1e-9)
        return fail('stale', `PATCH /menu/${id} via ${r.target}: sent ${price}, response says ${r.data.price}`);
      return n.ok++;
    } finally { inflight.delete(id); }
  }

  if (roll < 0.95) {                                    // place an order
    const items = [{ menuItemId: pick(1, FIXED), qty: pick(1, 3) }, { menuItemId: pick(1, FIXED), qty: 1 }];
    const r = await send('POST', '/orders', { items });
    if (!r) return fail('unavailable', 'POST /orders');
    if (r.status >= 500) return fail('error', `POST /orders -> ${r.status} via ${r.target}`);
    if (r.status !== 201 || typeof r.data.total !== 'number')
      return fail('contract', `POST /orders -> ${r.status} via ${r.target}: ${JSON.stringify(r.data).slice(0, 120)}`);
    const want = items.reduce((s, i) => s + expected.get(i.menuItemId) * i.qty, 0);
    if (Math.abs(r.data.total - want) > 1e-6)
      return fail('stale', `POST /orders via ${r.target}: total ${r.data.total}, expected ${want}`);
    return n.ok++;
  }

  if (roll < 0.97) {                                    // add a dish
    const price = pick(30, 500) / 2;
    const body = client === 'new' ? { name: 'Món mới', priceVnd: Math.round(price * 1000) } : { name: 'Món mới', price };
    const r = await send('POST', '/menu', body);
    if (!r) return fail('unavailable', 'POST /menu');
    if (r.status >= 500) return fail('error', `POST /menu -> ${r.status} via ${r.target}`);
    if (r.status !== 201) return fail('contract', `POST /menu ${JSON.stringify(body)} -> ${r.status} via ${r.target}`);
    if (!checkItem(r, client, 'POST /menu')) return;
    if (Math.abs(r.data.price - price) > 1e-9)
      return fail('stale', `POST /menu via ${r.target}: sent ${price}, response says ${r.data.price}`);
    expected.set(r.data.id, price);
    created.push(r.data.id);
    return n.ok++;
  }

  const r = await send('GET', `/menu?limit=20&offset=${pick(0, IDS - 20)}`);  // list a page
  if (!r) return fail('unavailable', 'GET /menu');
  if (r.status >= 500) return fail('error', `GET /menu -> ${r.status} via ${r.target}`);
  if (r.status !== 200 || !Array.isArray(r.data) || r.data.some((x) => typeof x.price !== 'number'))
    return fail('contract', `GET /menu via ${r.target}: bad page`);
  n.ok++;
}

// Learn the fixed prices once, before the run starts.
for (let id = 1; id <= FIXED; id++) {
  const r = await send('GET', `/menu/${id}`);
  if (!r || r.status !== 200) { console.error(`cannot read /menu/${id} — is the service up and seeded?`); process.exit(2); }
  expected.set(id, r.data.price);
}

log(`\n=== traffic start ${new Date().toISOString()} · targets ${TARGETS.join(' ')}`);
let stop = false;
process.on('SIGINT', () => { stop = true; });
if (DURATION) setTimeout(() => { stop = true; }, DURATION * 1000);

const bad = () => n.error + n.contract + n.stale + n.unavailable;
const tick = setInterval(() =>
  log(`${ts()} ok=${n.ok} error=${n.error} contract=${n.contract} stale=${n.stale} unavailable=${n.unavailable} rerouted=${n.rerouted}`), 5000);

await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (!stop) {
    try { await once(); } catch (e) { fail('error', `client crash: ${e.message}`); }
  }
}));
clearInterval(tick);
log(`${ts()} FINAL ok=${n.ok} error=${n.error} contract=${n.contract} stale=${n.stale} unavailable=${n.unavailable} rerouted=${n.rerouted}`);
log(bad() === 0 ? 'RESULT: zero failed requests' : `RESULT: ${bad()} failed requests`);
process.exit(bad() === 0 ? 0 : 1);
