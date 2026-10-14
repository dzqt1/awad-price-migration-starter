# Zero-downtime migration: `price` to `price_vnd`

## Mục tiêu

Chuyển giá lưu trong `menu_items` từ:

- `price REAL`: đơn vị nghìn VND.
- `price_vnd INTEGER`: đơn vị VND.

Công thức chuyển đổi duy nhất:

```sql
CAST(round(price * 1000) AS INTEGER)
```

Chiều ngược lại (SQLite) **phải chia float**, vì `INTEGER / INTEGER` trong SQLite là chia nguyên:

```sql
price_vnd / 1000.0      -- đúng
price_vnd / 1000        -- SAI: cắt phần thập phân
```

Migration phải chạy được trong lúc hệ thống vẫn phục vụ request và có thể có nhiều version ứng dụng cùng truy cập database trong rolling deploy.

Phạm vi chỉ gồm `menu_items`. Cột `order_items.unit_price` tiếp tục là `REAL` theo đơn vị cũ để không thay đổi snapshot giá của order đã tạo. Khi tạo order, snapshot được tính `unit_price = price_vnd / 1000.0`.

## Giả định hạ tầng

- Mọi instance truy cập cùng một file SQLite trên cùng host hoặc volume có file locking đúng (không phải NFS).
- Mọi connection đặt `PRAGMA journal_mode=WAL` và `PRAGMA busy_timeout` (đề xuất 5000 ms).
- Không còn writer nào ngoài danh sách đã kiểm kê ở pre-flight (web app, seed script, cron, import, admin tool).
- "Zero-downtime" chỉ được khẳng định sau khi đo thời gian giữ write lock của Step 7 trên bản sao production.

## Quy ước version code

- **`v1`**: code hiện tại, chỉ biết và đọc/ghi `price`.
- **`v2`**: code compatibility. Ghi cả hai cột trong cùng transaction, đọc `price`, log mismatch với `price_vnd`; hỗ trợ cả API `price` và `priceVnd`.
- **`v3`**: code contract. Ghi cả hai cột, đọc `price_vnd`, dựng field HTTP `price` cho client cũ, trả thêm `priceVnd`.
- **`v4`**: code cuối. Chỉ đọc/ghi `price_vnd`; không có SQL nào nhắc tới cột `price`. Field HTTP `price` vẫn được tạo ở boundary API.

Quy tắc ghi của `v2` và `v3`:

- Input `price`: `price_vnd = CAST(round(price * 1000) AS INTEGER)`.
- Input `priceVnd`: `price = priceVnd / 1000.0`.

## Quy tắc nguồn dữ liệu chuẩn (authoritative)

| Giai đoạn | Nguồn chuẩn | Khi hai cột lệch nhau |
|---|---|---|
| Step 1 đến hết gate của Step 3 | `price` | Trigger hoặc backfill sửa `price_vnd` từ `price`; ghi log. |
| Sau gate Step 3 đến trước Step 7 | Hai cột phải luôn khớp | **Mismatch là bug**: phát alert, không tự sửa im lặng. Điều tra rồi mới sửa tay có ghi log. |
| Sau Step 7 | `price_vnd` | Không còn cột `price`. |

## Pre-flight (trước Step 1)

- Đã có backup khôi phục được.
- Query kiểm tra dữ liệu nguồn (mục "Kiểm tra dữ liệu nguồn") trả **0 row**, hoặc mọi row bất thường đã được quyết định cách xử lý và sửa.
- Đã kiểm kê toàn bộ writer vào `menu_items`.
- Test suite `v1` đã pass trên schema đã expand (chạy trên bản sao).
- Đã diễn tập toàn bộ migration, gồm Step 7, trên bản sao production.

## Các bước thực hiện

"Code on every instance" là version chạy trên toàn bộ instance sau khi rollout của step đó hoàn tất; trong lúc rolling deploy, hai version liền kề chạy song song và phải tương thích với nhau.

| Step | Schema | Code on every instance | Undo with |
|---:|---|---|---|
| 1 | `price`, `price_vnd` (NULL) + trigger đồng bộ | `v1` | `migrate:down 002` (drop trigger, drop `price_vnd`) |
| 2 | same | `v2` — writes both, reads `price` | redeploy `v1` |
| 3 | `price`, `price_vnd` (backfilled, matched) | `v2` | stop script; recompute `price_vnd` from `price` |
| 4 | same | `v2` + `NEW_CLIENTS` tăng dần 0 → 100% | `NEW_CLIENTS=0` |
| 5 | same | `v3` — writes both, reads `price_vnd` | redeploy `v2` |
| 6 | same (`price` không còn được ghi nên cũ dần) | `v4` — reads/writes `price_vnd` only | resync `price` from `price_vnd`, then redeploy `v3` |
| 7 | `price_vnd` `NOT NULL CHECK (price_vnd > 0)`; không còn `price` và trigger | `v4` | `migrate:down 003` (re-add `price`, resync) rồi redeploy `v3`; hoặc restore backup |
| 8 | same | `v4` — bỏ flag `NEW_CLIENTS` và code fallback | redeploy build `v4` trước đó |

**Point of no return:** Bước 7, vì ở bước này bảng price sẽ bị drop và dữ liệu gốc không còn tồn tại. Việc undo ở bước này chỉ là tạo lại bảng price từ dữ liệu của bảng price_vnd, không phải khôi phục lại dữ liệu ban đầu. 

## Điều kiện chuyển bước

| Chuyển sang | Điều kiện |
|---|---|
| Step 2 | `002` chạy thành công: `price` còn nguyên, `price_vnd` nullable, hai trigger tồn tại. Thử `v1` ghi `price` và xác nhận `price_vnd` được đồng bộ. Test `v1` pass trên schema mới. |
| Step 3 | Toàn bộ instance là `v2`. Test API cũ, API mới và traffic với `NEW_CLIENTS=0` không có `error`/`contract`/`stale`/`unavailable`. Mỗi instance báo version qua log hoặc metric. Backfill chạy bằng script vận hành riêng, **không** chạy trong transaction `BEGIN IMMEDIATE` của `scripts/migrate.js`. |
| Step 4 | Gate của Step 3: `npm run check` và bốn query verify (mục "Kiểm tra sau backfill") đều trả 0; metric xác nhận không còn instance `v1` và mọi writer đã kiểm kê đều ≥ `v2`. Sau điểm này, hai cột phải luôn khớp. |
| Step 5 | `NEW_CLIENTS` tăng theo nấc 1% → 10% → 50% → 100%. Mỗi nấc soak tối thiểu 30 phút có traffic (đề xuất, chỉnh theo lưu lượng thực) với `error=0`, `contract=0`, `stale=0`, `unavailable=0`, order total không đổi. Người duyệt mỗi nấc: owner của migration. |
| Step 6 | Toàn bộ instance là `v3`; mismatch alert = 0; test API và order flow pass. |
| Step 7 | Toàn bộ instance là `v4`; không còn SQL runtime nào nhắc tới `menu_items.price`; backup mới đã được xác nhận; `PRAGMA foreign_key_check` rỗng và thời gian lock đã đo trên bản sao production. |
| Step 8 | Quan sát tối thiểu 7 ngày (đề xuất); test/check cuối pass; migration history (`002`, `003`) và tài liệu đã cập nhật. |

## Trigger đồng bộ (Step 1)

Trigger giúp DB tự giữ đồng bộ khi còn `v1` hoặc có writer bị bỏ sót, thay vì chỉ dựa vào kỷ luật của code. Trigger chỉ đồng bộ theo chiều `price` → `price_vnd`; vì vậy từ `v2` trở đi code phải ghi cả hai cột như đã nêu.

```sql
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
```

Trigger update chỉ chạy khi hai cột lệch nhau nên không xung đột với `v2`/`v3` đã ghi đúng cả hai cột. Cả hai trigger bị xóa cùng bảng ở Step 7.

## Kiểm tra dữ liệu nguồn (pre-flight)

"Price hợp lệ" trong backfill được định nghĩa bằng việc query này trả 0 row:

```sql
SELECT id, price FROM menu_items
WHERE price IS NULL
   OR price <= 0
   OR abs(price * 1000 - round(price * 1000)) > 1e-6;
```

Row bất thường (giá NULL, bằng 0, hoặc có phần lẻ dưới 1 VND như `12.3456`) phải được xử lý bằng quyết định rõ ràng (sửa dữ liệu, hoặc xác nhận cho phép làm tròn) trước khi backfill, vì Step 7 yêu cầu `NOT NULL` và `CHECK (price_vnd > 0)`. Nếu nghiệp vụ cho phép món giá 0, đổi `CHECK` thành `>= 0` và sửa query tương ứng.

## Chi tiết backfill (Step 3)

Backfill chạy ngoài migration DDL, theo batch nhỏ, mỗi batch một transaction riêng để giảm thời gian giữ write lock của SQLite:

```sql
UPDATE menu_items
SET price_vnd = CAST(round(price * 1000) AS INTEGER)
WHERE id IN (
  SELECT id FROM menu_items
  WHERE price_vnd IS NULL AND price IS NOT NULL
  LIMIT 500
);
```

Lặp lại cho đến khi `changes() = 0`. Script phải idempotent, đặt `busy_timeout`, retry khi `SQLITE_BUSY`, và nghỉ ngắn giữa các batch.

> Không chạy một backfill lớn bên trong `scripts/migrate.js`, vì runner dùng `BEGIN IMMEDIATE` cho toàn bộ migration.

## Kiểm tra sau backfill (gate của Step 3)

Cả bốn query phải trả 0:

```sql
-- thiếu price_vnd
SELECT count(*) FROM menu_items WHERE price IS NOT NULL AND price_vnd IS NULL;

-- mismatch giữa hai cột
SELECT count(*) FROM menu_items
WHERE price_vnd IS NOT CAST(round(price * 1000) AS INTEGER);

-- price_vnd không phải integer
SELECT count(*) FROM menu_items
WHERE price_vnd IS NOT NULL AND typeof(price_vnd) <> 'integer';

-- giá không dương
SELECT count(*) FROM menu_items WHERE price_vnd <= 0;
```

## Resync khi rollback `v4` → `v3` (Step 6)

Idempotent, chạy trước khi redeploy `v3`:

```sql
UPDATE menu_items
SET price = price_vnd / 1000.0
WHERE price IS NOT price_vnd / 1000.0;
```

## Table rebuild (Step 7)

Gộp việc bỏ cột và siết ràng buộc trong một lần rebuild theo quy trình chuẩn của SQLite. Cách này tránh các giới hạn của `DROP COLUMN` (không drop được cột nằm trong index, trigger, view hoặc `CHECK`) và thêm được `NOT NULL`, vốn không thể `ALTER` trực tiếp.

```sql
PRAGMA foreign_keys = OFF;          -- phải đặt ngoài transaction
BEGIN IMMEDIATE;

CREATE TABLE menu_items_new (
  -- giữ nguyên toàn bộ cột và ràng buộc hiện có của menu_items, trừ `price`
  -- ...
  price_vnd INTEGER NOT NULL CHECK (price_vnd > 0)
);

INSERT INTO menu_items_new (/* các cột hiện có */, price_vnd)
SELECT /* các cột hiện có */, price_vnd FROM menu_items;

DROP TABLE menu_items;              -- xóa luôn trigger đồng bộ
ALTER TABLE menu_items_new RENAME TO menu_items;
-- tạo lại mọi index và trigger khác của menu_items

PRAGMA foreign_key_check;           -- phải trả về rỗng, nếu không thì ROLLBACK
COMMIT;
PRAGMA foreign_keys = ON;
```

Lưu ý:

- Nếu `order_items` tham chiếu `menu_items`, bắt buộc theo đúng thứ tự `foreign_keys = OFF` → rebuild → `foreign_key_check` → `foreign_keys = ON`.
- Bảng bị khóa ghi trong lúc rebuild. Phải đo thời gian trên bản sao production và chốt cửa sổ chấp nhận được trước khi chạy thật.
- Các connection khác sẽ tự prepare lại statement sau khi schema đổi; điều này an toàn vì `v4` không nhắc tới `price`.
- Đánh số riêng: `002_expand_price_vnd` (Step 1) và `003_contract_price_vnd` (Step 7), mỗi file `down` ghi rõ phạm vi. `003` down gồm `ALTER TABLE menu_items ADD COLUMN price REAL` rồi `UPDATE menu_items SET price = price_vnd / 1000.0`. `001_init.down.sql` không phục vụ migration này.

## Kiểm tra bắt buộc

1. Trước migration: query dữ liệu nguồn trả 0 row; test suite `v1` pass trên schema đã expand; toàn bộ migration đã được diễn tập trên bản sao production.
2. Sau Step 1: `price` còn tồn tại, `price_vnd` là nullable integer, hai trigger tồn tại; thử `v1` ghi `price` và xác nhận `price_vnd` được đồng bộ.
3. Chạy `npm run check` sau mỗi đợt backfill; tiếp tục đến khi bốn query verify đều trả 0.
4. Test POST/PATCH bằng cả `{ price }` và `{ priceVnd }`; xác nhận hai cột được cập nhật atomically và `priceVnd` lẻ (ví dụ `12500`) cho ra `price = 12.5`.
5. Test list/get trả cả `price` và `priceVnd`; client cũ vẫn đọc được `price`.
6. Chạy order flow và xác nhận `order_items.unit_price` cùng order total không đổi so với trước migration (test tự động so sánh trước/sau).
7. Chạy traffic với client cũ và mới theo các nấc ở Step 4; chỉ đi tiếp khi `error`, `contract`, `stale`, `unavailable` đều bằng 0.
8. Trước Step 7: xác nhận không còn SQL runtime nào nhắc tới `menu_items.price`, `PRAGMA foreign_key_check` rỗng trên bản sao, thời gian lock đã đo.
9. Sau Step 7 và Step 8: kiểm tra schema cuối và chạy lại toàn bộ test/check.

## Rollback policy

- Các Step 1 đến 6 có thể dừng và tiếp tục lại mà không cần downtime.
- Không rollback binary về `v1` sau gate của Step 3, và không bật `NEW_CLIENTS` khi còn instance `v1`.
- Rollback `v4` → `v3` luôn phải chạy resync `price` từ `price_vnd` trước.
- Dữ liệu sai sau backfill: tính lại `price_vnd` từ `price` (chỉ đúng khi `price` còn là nguồn chuẩn, tức trước hết gate của Step 3). Sau đó, mismatch là bug cần điều tra, không tự động ghi đè.
- `001_init.down.sql` chỉ rollback toàn bộ schema baseline, không phải rollback an toàn cho migration này.
- Step 7 cần backup và quy trình rebuild đã được diễn tập trên bản sao database production; migration down không được xem là đủ nếu chưa kiểm chứng. Sau Step 7, `v1` và `v2` không còn được hỗ trợ vì `price_vnd` là `NOT NULL` và không còn trigger.
