import { createServer } from 'node:http';

// v4 contract code: price_vnd is the only persisted price column.

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
    list: db.prepare('SELECT id, name, price_vnd FROM menu_items ORDER BY id LIMIT ? OFFSET ?'),
    get: db.prepare('SELECT id, name, price_vnd FROM menu_items WHERE id = ?'),
    insert: db.prepare('INSERT INTO menu_items (name, price_vnd) VALUES (?, ?)'),
    setPrice: db.prepare('UPDATE menu_items SET price_vnd = ? WHERE id = ?'),
    insertOrder: db.prepare("INSERT INTO orders (created_at) VALUES (datetime('now'))"),
    insertLine: db.prepare('INSERT INTO order_items (order_id, menu_item_id, qty, unit_price) VALUES (?, ?, ?, ?)'),
  };

  const resolvePrice = (row) => {
    const priceVnd = row.price_vnd;
    return { price: priceVnd / 1000.0, priceVnd };
  };

  const view = (row) => ({ id: row.id, name: row.name, ...resolvePrice(row) });

  const pricesFromBody = (body) => {
    if (isPrice(body.price) && body.priceVnd === undefined)
      return { priceVnd: Math.round(body.price * 1000) };
    if (isPriceVnd(body.priceVnd)) return { price: body.priceVnd / 1000.0, priceVnd: body.priceVnd };
    return null;
  };

  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
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
        const prices = body && pricesFromBody(body);
        if (!body || typeof body.name !== 'string' || !body.name || !prices)
          return error(res, 400, 'invalid_body', 'name (string) and price or priceVnd are required');
        const row = transaction(() => {
          const { lastInsertRowid } = q.insert.run(body.name, prices.priceVnd);
          return q.get.get(lastInsertRowid);
        });
        return json(res, 201, view(row));
      }
    }

    if (parts[0] === 'menu' && parts.length === 2) {
      const id = Number(parts[1]);
      const row = Number.isInteger(id) ? q.get.get(id) : undefined;
      if (!row) return error(res, 404, 'not_found', `menu item ${parts[1]} not found`);
      if (req.method === 'GET') return json(res, 200, view(row));
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const prices = body && pricesFromBody(body);
        if (!prices)
          return error(res, 400, 'invalid_body', 'price or priceVnd is required');
        const updated = transaction(() => {
          q.setPrice.run(prices.priceVnd, id);
          return q.get.get(id);
        });
        return json(res, 200, view(updated));
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
          const resolved = resolvePrice(item);
          q.insertLine.run(orderId, item.id, qty, resolved.price);
          total += resolved.price * qty;
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
