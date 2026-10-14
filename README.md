# IA#2 starter — change a column under live traffic

CSC13114 · Advanced Web Application Development · HK1 2026–2027

The menu service of `smart-restaurant`, cut down to what IA#2 needs. Node 22.5+,
no dependencies — the database is SQLite through the built-in `node:sqlite`.

## The change you have to make

Prices are stored the way last year's team stored them: **thousands of dong, as a
float** — `menu_items.price = 45.5` means 45,500 đ. Floats and money do not mix,
and every new client has to remember to multiply by 1000.

Move to **`menu_items.price_vnd INTEGER`, in dong**, and remove `price` at the
end — **without a single failed request**, while two instances keep serving
traffic, and with a way back at every step until the one you name as the point
of no return.

The HTTP contract does not break: old clients keep sending and reading `price`
(thousands) for the whole semester. New clients may send and read `priceVnd`
(dong) once your API offers it. Both see the same price.

Out of scope: `order_items.unit_price` keeps its old unit.

## Run it

```bash
npm run migrate          # creates data/app.db
npm run seed             # 20,000 menu items, so a backfill takes real time
PORT=3001 npm start      # terminal 1
PORT=3002 npm start      # terminal 2 — two instances, one database
npm run traffic          # terminal 3 — leave it running
npm test
```

| Command | What it does |
|---|---|
| `npm run migrate` | applies every pending `migrations/NNN_name.up.sql`, each in one transaction |
| `npm run migrate:down` | reverts the **last** applied step with its `.down.sql` |
| `npm run migrate:status` | lists what is applied |
| `npm run traffic` | old-client traffic against both instances; writes `traffic-log.txt` |
| `npm run check` | is the data consistent right now? (`price` vs `price_vnd`) |

## Two versions at once: one worktree per version

During a rolling deploy, instance A runs the new code while instance B still runs
the old code — against the same database. Reproduce that with `git worktree`,
one directory per tagged version, all pointing at one database file:

```bash
git tag v1                                   # the starter, as you received it
# ... commit your next version, then:
git tag v2
git worktree add ../v2 v2

export DB_PATH="$PWD/data/app.db"            # absolute: every version uses this file
kill <pid of :3001>                          # the server finishes in-flight requests first
(cd ../v2 && PORT=3001 npm start)            # A runs v2, B still runs v1
```

Restart **one instance at a time**. While one is down the traffic script sends
everything to the other and counts it as `rerouted` — that is a rolling restart,
not a failure. If both are down at once, it counts `unavailable`, and that is
downtime.

## What `npm run traffic` counts as a failure

- `error` — any 5xx
- `contract` — a response without a numeric `price`, or a wrong status
- `stale` — a read that does not show the last acknowledged write. This is
  what catches a version that writes one column while another version reads
  the other one
- `unavailable` — a moment when no instance answered

Traffic uses the final client contract and sends `priceVnd`, expecting it back
alongside the legacy `price` response field.

The traffic log shows whether a request failed; it does **not** show a row that
is wrong but has not been read yet. Run `npm run check` after every step as well.

## What to hand in

See the IA#2 rubric on Classroom.
