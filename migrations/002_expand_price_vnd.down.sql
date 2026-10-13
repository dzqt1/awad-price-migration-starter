DROP TRIGGER IF EXISTS menu_items_sync_vnd_upd;
DROP TRIGGER IF EXISTS menu_items_sync_vnd_ins;
ALTER TABLE menu_items DROP COLUMN price_vnd;