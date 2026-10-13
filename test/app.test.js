import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { open } from '../src/db.js';
import { createApp } from '../src/app.js';

let db, server, base;
before(async () => {
  db = open(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.up.sql')).sort())
    db.exec(readFileSync(new URL(f, dir), 'utf8'));          // every migration, in order
  db.exec("INSERT INTO menu_items (name, price) VALUES ('Phở bò', 45.5), ('Trà đá', 5)");
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('GET /menu/:id returns price in thousands of dong', async () => {
  assert.deepEqual(await call('GET', '/menu/1'), { status: 200, body: { id: 1, name: 'Phở bò', price: 45.5, priceVnd: 45500 } });
});

test('PATCH /menu/:id changes the price', async () => {
  const r = await call('PATCH', '/menu/2', { price: 6 });
  assert.equal(r.status, 200);
  assert.equal(r.body.price, 6);
  assert.equal(r.body.priceVnd, 6000);
});

test('priceVnd clients can create and update items', async () => {
  const created = await call('POST', '/menu', { name: 'Bánh mì', priceVnd: 12500 });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { id: 3, name: 'Bánh mì', price: 12.5, priceVnd: 12500 });

  const updated = await call('PATCH', '/menu/3', { priceVnd: 13000 });
  assert.deepEqual(updated.body, { id: 3, name: 'Bánh mì', price: 13, priceVnd: 13000 });
  const stored = db.prepare('SELECT price, price_vnd FROM menu_items WHERE id = 3').get();
  assert.equal(stored.price, 13);
  assert.equal(stored.price_vnd, 13000);
});

test('reads fall back to price while priceVnd is missing or mismatched', async () => {
  db.prepare('UPDATE menu_items SET price_vnd = NULL WHERE id = 1').run();
  assert.deepEqual((await call('GET', '/menu/1')).body, { id: 1, name: 'Phở bò', price: 45.5, priceVnd: 45500 });

  db.prepare('UPDATE menu_items SET price_vnd = 1 WHERE id = 1').run();
  assert.deepEqual((await call('GET', '/menu/1')).body, { id: 1, name: 'Phở bò', price: 45.5, priceVnd: 45500 });
});

test('POST /orders totals at the current price', async () => {
  const r = await call('POST', '/orders', { items: [{ menuItemId: 1, qty: 2 }, { menuItemId: 2, qty: 1 }] });
  assert.deepEqual(r, { status: 201, body: { id: 1, total: 97 } });
});

test('errors have one shape', async () => {
  assert.deepEqual((await call('GET', '/menu/999')).body.error, 'not_found');
  assert.equal((await call('PATCH', '/menu/1', { price: -1 })).status, 400);
});
