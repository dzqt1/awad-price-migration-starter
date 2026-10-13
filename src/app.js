import { createServer } from 'node:http';

// v2 keeps the old HTTP price field while introducing priceVnd and dual-write
// compatibility for rolling deploys.

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const error = (res, status, code, message) => json(res, status, { error: code, message });

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

const isPrice = (p) => typeof p === 'number' && Number.isFinite(p) && p > 0 && p <= 100000;
const isPriceVnd = (p) => Number.isInteger(p) && p > 0 && p <= 100000000;

export function createApp(db) {
  const q = {
    list: db.prepare('SELECT id, name, price, price_vnd FROM menu_items ORDER BY id LIMIT ? OFFSET ?'),
    get: db.prepare('SELECT id, name, price, price_vnd FROM menu_items WHERE id = ?'),
    insertFromPrice: db.prepare('INSERT INTO menu_items (name, price, price_vnd) VALUES (?, ?, CAST(round(? * 1000) AS INTEGER))'),
    insertFromPriceVnd: db.prepare('INSERT INTO menu_items (name, price, price_vnd) VALUES (?, ? / 1000.0, ?)'),
    setFromPrice: db.prepare('UPDATE menu_items SET price = ?, price_vnd = CAST(round(? * 1000) AS INTEGER) WHERE id = ?'),
    setFromPriceVnd: db.prepare('UPDATE menu_items SET price = ? / 1000.0, price_vnd = ? WHERE id = ?'),
    insertOrder: db.prepare("INSERT INTO orders (created_at) VALUES (datetime('now'))"),
    insertLine: db.prepare('INSERT INTO order_items (order_id, menu_item_id, qty, unit_price) VALUES (?, ?, ?, ?)'),
  };

  const effectivePriceVnd = (row) => {
    const expected = Number.isFinite(row.price) && row.price > 0
      ? Math.round(row.price * 1000)
      : undefined;
    if (Number.isInteger(row.price_vnd) && row.price_vnd > 0 && row.price_vnd === expected)
      return row.price_vnd;
    if (expected !== undefined) {
      if (row.price_vnd !== expected)
        console.error(`price mismatch for menu item ${row.id}: price=${row.price}, price_vnd=${row.price_vnd}`);
      return expected;
    }
    return row.price_vnd;
  };

  const view = (row) => {
    const priceVnd = effectivePriceVnd(row);
    return { id: row.id, name: row.name, price: priceVnd / 1000.0, priceVnd };
  };

  const inputPrice = (body) => {
    if (isPrice(body.price) && body.priceVnd === undefined)
      return { kind: 'price', value: body.price };
    if (isPriceVnd(body.priceVnd) && body.price === undefined)
      return { kind: 'priceVnd', value: body.priceVnd };
    return undefined;
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

    if (parts[0] === 'menu' && parts.length === 1) {
      if (req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return json(res, 200, q.list.all(limit, offset).map(view));
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const price = body && inputPrice(body);
        if (!body || typeof body.name !== 'string' || !body.name || !price)
          return error(res, 400, 'invalid_body', 'name (string) and either price or priceVnd are required');
        const { lastInsertRowid } = price.kind === 'price'
          ? q.insertFromPrice.run(body.name, price.value, price.value)
          : q.insertFromPriceVnd.run(body.name, price.value, price.value);
        return json(res, 201, view(q.get.get(lastInsertRowid)));
      }
    }

    if (parts[0] === 'menu' && parts.length === 2) {
      const id = Number(parts[1]);
      const row = Number.isInteger(id) ? q.get.get(id) : undefined;
      if (!row) return error(res, 404, 'not_found', `menu item ${parts[1]} not found`);
      if (req.method === 'GET') return json(res, 200, view(row));
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const price = body && inputPrice(body);
        if (!price)
          return error(res, 400, 'invalid_body', 'either price or priceVnd is required');
        if (price.kind === 'price') q.setFromPrice.run(price.value, price.value, id);
        else q.setFromPriceVnd.run(price.value, price.value, id);
        return json(res, 200, view(q.get.get(id)));
      }
    }

    if (req.method === 'POST' && url.pathname === '/orders') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.items) || body.items.length === 0)
        return error(res, 400, 'invalid_body', 'items: [{menuItemId, qty}] is required');
      db.exec('BEGIN IMMEDIATE');
      try {
        const { lastInsertRowid: orderId } = q.insertOrder.run();
        let total = 0;
        for (const { menuItemId, qty } of body.items) {
          const item = q.get.get(menuItemId);
          if (!item || !Number.isInteger(qty) || qty < 1) throw Object.assign(new Error(), { status: 400 });
          const price = view(item).price;
          q.insertLine.run(orderId, item.id, qty, price);
          total += price * qty;
        }
        db.exec('COMMIT');
        return json(res, 201, { id: Number(orderId), total: Math.round(total * 1000) / 1000 });
      } catch (e) {
        db.exec('ROLLBACK');
        if (e.status === 400) return error(res, 400, 'invalid_item', 'unknown menuItemId or bad qty');
        throw e;
      }
    }

    return error(res, 404, 'not_found', 'no such route');
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) error(res, 500, 'internal', e.message);
    });
  });
}
