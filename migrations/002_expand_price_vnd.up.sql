ALTER TABLE menu_items ADD COLUMN price_vnd INTEGER;

CREATE TRIGGER menu_items_sync_vnd_ins
AFTER INSERT ON menu_items
WHEN NEW.price IS NOT NULL AND NEW.price_vnd IS NULL
BEGIN
  UPDATE menu_items
  SET price_vnd = CAST(round(NEW.price * 1000) AS INTEGER)
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER menu_items_sync_vnd_upd
AFTER UPDATE OF price ON menu_items
WHEN NEW.price IS NOT NULL
 AND NEW.price_vnd IS NOT CAST(round(NEW.price * 1000) AS INTEGER)
BEGIN
  UPDATE menu_items
  SET price_vnd = CAST(round(NEW.price * 1000) AS INTEGER)
  WHERE rowid = NEW.rowid;
END;