// Is the data consistent right now? Run it between steps and after a rollback.
// Knows about the two column names IA#2 fixes: `price` (thousands, REAL) and
// `price_vnd` (dong, INTEGER). Works whichever of them exists.
import { open } from '../src/db.js';

const db = open();
const cols = new Set(db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name));
const count = (sql) => db.prepare(sql).get().n;
const out = { columns: [...cols].join(', '), rows: count('SELECT count(*) n FROM menu_items') };
let ok = true;

if (cols.has('price_vnd')) {
  out.price_vnd_null = count('SELECT count(*) n FROM menu_items WHERE price_vnd IS NULL');
  out.price_vnd_not_integer = count("SELECT count(*) n FROM menu_items WHERE price_vnd IS NOT NULL AND typeof(price_vnd) <> 'integer'");
  out.price_vnd_non_positive = count('SELECT count(*) n FROM menu_items WHERE price_vnd <= 0');
  ok &&= out.price_vnd_not_integer === 0;
  ok &&= out.price_vnd_non_positive === 0;
}
if (cols.has('price') && cols.has('price_vnd')) {
  out.disagree = count('SELECT count(*) n FROM menu_items WHERE price_vnd IS NOT NULL AND price_vnd <> CAST(round(price * 1000) AS INTEGER)');
  ok &&= out.disagree === 0;
}
if (cols.has('price_vnd') && !cols.has('price') && out.price_vnd_null > 0) {
  out.problem = 'price is gone and some rows have no price_vnd';
  ok = false;
}
if (!cols.has('price') && !cols.has('price_vnd')) { out.problem = 'no price column at all'; ok = false; }

for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(22)} ${v}`);
if (!ok) console.log('INCONSISTENT');
else if (out.price_vnd_null > 0) console.log(`CONSISTENT, but ${out.price_vnd_null} rows have no price_vnd yet — nothing may read price_vnd until they do`);
else console.log('CONSISTENT');
process.exit(ok ? 0 : 1);
