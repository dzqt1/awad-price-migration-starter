PRAGMA foreign_keys = OFF;

CREATE TABLE menu_items_old (
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL,
  price     REAL    CHECK (price > 0),
  price_vnd INTEGER
);

INSERT INTO menu_items_old (id, name, price, price_vnd)
SELECT id, name, price_vnd / 1000.0, price_vnd FROM menu_items;

DROP TABLE menu_items;
ALTER TABLE menu_items_old RENAME TO menu_items;

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

PRAGMA foreign_key_check;
PRAGMA foreign_keys = ON;