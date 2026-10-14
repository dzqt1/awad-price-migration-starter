// Backfill price_vnd outside the DDL migration, one small write transaction at a time.
import { open, DB_PATH } from '../src/db.js';

const BATCH_SIZE = 500;
const MAX_RETRIES = 10;
const PAUSE_MS = 25;
const db = open();

const updateBatch = db.prepare(`
  UPDATE menu_items
  SET price_vnd = CAST(round(price * 1000) AS INTEGER)
  WHERE id IN (
    SELECT id FROM menu_items
    WHERE price_vnd IS NULL AND price IS NOT NULL
    LIMIT ?
  )
`);
const changes = db => db.prepare('SELECT changes() AS count').get().count;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isBusy = error => error?.code === 'SQLITE_BUSY' || error?.errcode === 5 || error?.message?.includes('database is locked');

async function runBatch(db) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let started = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      started = true;
      updateBatch.run(BATCH_SIZE);
      const count = changes(db);
      db.exec('COMMIT');
      return count;
    } catch (error) {
      if (started) db.exec('ROLLBACK');
      if (!isBusy(error) || attempt === MAX_RETRIES) throw error;
      await sleep(Math.min(PAUSE_MS * 2 ** attempt, 1000));
    }
  }
}

let total = 0;
let batches = 0;
try {
  while (true) {
    const count = await runBatch(db);
    if (count === 0) break;
    total += count;
    batches++;
    console.log(`backfilled ${count} rows (total ${total})`);
    await sleep(PAUSE_MS);
  }
  console.log(`backfill complete: ${total} rows in ${batches} batches (${DB_PATH})`);
} finally {
  db.close();
}