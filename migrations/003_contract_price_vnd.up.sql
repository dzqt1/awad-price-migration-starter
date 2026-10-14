PRAGMA foreign_keys = OFF;

CREATE TABLE menu_items_new (
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL,
  price_vnd INTEGER NOT NULL CHECK (price_vnd > 0)
);

INSERT INTO menu_items_new (id, name, price_vnd)
SELECT id, name, price_vnd FROM menu_items;

DROP TABLE menu_items;
ALTER TABLE menu_items_new RENAME TO menu_items;

PRAGMA foreign_key_check;
PRAGMA foreign_keys = ON;