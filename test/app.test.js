import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { open } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base;
before(async () => {
  const db = open(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.up.sql')).sort())
    db.exec(readFileSync(new URL(f, dir), 'utf8'));          // every migration, in order
  db.exec("INSERT INTO menu_items (name, price_vnd) VALUES ('Phở bò', 45500), ('Trà đá', 5000)");
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

test('POST and PATCH accept priceVnd and expose the legacy price field', async () => {
  const created = await call('POST', '/menu', { name: 'Bánh mì', priceVnd: 12500 });
  assert.equal(created.status, 201);
  assert.equal(created.body.price, 12.5);
  assert.equal(created.body.priceVnd, 12500);

  const updated = await call('PATCH', `/menu/${created.body.id}`, { priceVnd: 13750 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.price, 13.75);
  assert.equal(updated.body.priceVnd, 13750);
});

test('POST /orders totals at the current price', async () => {
  const r = await call('POST', '/orders', { items: [{ menuItemId: 1, qty: 2 }, { menuItemId: 2, qty: 1 }] });
  assert.deepEqual(r, { status: 201, body: { id: 1, total: 97 } });
});

test('errors have one shape', async () => {
  assert.deepEqual((await call('GET', '/menu/999')).body.error, 'not_found');
  assert.equal((await call('PATCH', '/menu/1', { price: -1 })).status, 400);
});
