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
- Không còn writer nào ngoài danh sách đã kiểm kê ở bước 1 (web app, seed script, cron, import, admin tool).
- "Zero-downtime" chỉ được khẳng định sau khi đo thời gian giữ write lock của bước 9 trên bản sao production.

## Quy ước version code

- **`v1`**: code hiện tại, chỉ biết và đọc/ghi `price`.
- **`v2`**: code compatibility, dual-read và dual-write; hỗ trợ cả API `price` và `priceVnd`.
- **`v3`**: code contract. Đọc từ `price_vnd`, dựng field HTTP `price` cho client cũ, trả thêm `priceVnd`. **Vẫn ghi cả hai cột** (dual-write) để còn rollback được về `v2`.
- **`v4`**: code cuối. Chỉ đọc/ghi `price_vnd`; không có SQL nào nhắc tới cột `price`. Field HTTP `price` vẫn được tạo ở boundary API.

## Quy tắc nguồn dữ liệu chuẩn (authoritative)

| Giai đoạn | Nguồn chuẩn | Khi hai cột lệch nhau |
|---|---|---|
| Từ bước 2 đến hết bước 5 (còn có thể có `v1`) | `price` | Trigger hoặc backfill sửa `price_vnd` từ `price`; ghi log. |
| Từ bước 6 đến trước bước 9 (chỉ còn `v2`/`v3`) | `price_vnd` đã verify | **Mismatch là bug**: phát alert, không tự sửa im lặng. Điều tra rồi mới sửa tay có ghi log. |
| Sau bước 9 | `price_vnd` | Không còn cột `price`. |

## Các bước thực hiện

| # | Bước | Schema sau bước | Version được phép chạy | Cách undo / rollback | Điều kiện chuyển bước |
|---:|---|---|---|---|---|
| 1 | Baseline và pre-flight | `menu_items.price REAL`; chưa có `price_vnd`. | `v1`. | Không thay đổi gì. | (a) Đã có backup khôi phục được. (b) Query kiểm tra dữ liệu nguồn (mục "Kiểm tra dữ liệu nguồn") trả **0 row**, hoặc mọi row bất thường đã được quyết định cách xử lý và sửa. (c) Đã kiểm kê toàn bộ writer vào `menu_items`. (d) Test suite `v1` đã pass trên schema đã expand (chạy trên bản sao). (e) Đã diễn tập toàn bộ migration, gồm bước 9, trên bản sao production. |
| 2 | Expand schema (`002_expand_price_vnd`) | Thêm `price_vnd INTEGER NULL`; giữ `price`. Thêm trigger `AFTER INSERT` và `AFTER UPDATE OF price` để DB tự đồng bộ `price_vnd` từ `price` (xem mục "Trigger đồng bộ"). Không thêm `NOT NULL`, không xóa cột cũ. | `v1` chạy bình thường (không phụ thuộc `price_vnd`, và mọi lần `v1` ghi `price` đều được trigger đồng bộ). `v2` được phép deploy sau bước này. | Drop trigger, rồi drop `price_vnd` chỉ khi chưa có code nào ghi vào cột này. Nếu SQLite production không hỗ trợ `DROP COLUMN`, dùng table rebuild hoặc restore backup. | DDL thành công; `price` còn nguyên; `price_vnd` nullable; trigger tồn tại; test `v1` pass trên schema mới. |
| 3 | Deploy `v2` và verify rolling compatibility | Hai cột cùng tồn tại; `price_vnd` có thể còn NULL ở row cũ. | `v1` và `v2` song song trong rolling deploy. `v1` không được coi là trạng thái ổn định lâu dài. | Dừng rollout, quay binary về `v1`, giữ nguyên schema expand và trigger. Không xóa schema expand khi còn instance `v2`. | `v2` đọc `price_vnd` nếu hợp lệ, fallback sang `price` khi NULL/mismatch (và ghi log mismatch); trả cả `price` và `priceVnd`; ghi hai cột trong cùng transaction (`price` input: `price_vnd = CAST(round(price * 1000) AS INTEGER)`; `priceVnd` input: `price = priceVnd / 1000.0`). Test API cũ, API mới và traffic với `NEW_CLIENTS=0` không có error/contract/stale/unavailable. Mỗi instance báo version qua log hoặc metric. |
| 4 | Backfill theo batch | Mọi row có `price` hợp lệ được bổ sung `price_vnd` bằng công thức chuẩn. | `v1`, `v2`. Writer `v1` vẫn an toàn nhờ trigger. | Dừng batch; chạy lại được vì idempotent. Nếu dữ liệu sai, tính lại từ `price` (đúng vì `price` còn là nguồn chuẩn ở giai đoạn này). | Trigger đã tồn tại và `v2` đã deploy xong. Backfill chạy bằng script vận hành riêng, mỗi batch một transaction nhỏ, **không** chạy trong transaction `BEGIN IMMEDIATE` của `scripts/migrate.js`. |
| 5 | Verify dữ liệu sau backfill | Không còn row có `price IS NOT NULL` mà `price_vnd IS NULL`; không mismatch; `price_vnd` đều là integer và dương. | `v1`, `v2`. | Dừng rollout hoặc backfill lại; không cần xóa `price_vnd`. | Chạy `npm run check` và các query verify (mục "Kiểm tra sau backfill") đều trả 0 row. **Chốt hết `v1`**: metric version xác nhận không còn instance `v1` nào và mọi writer đã kiểm kê đều là `v2`. Sau điểm này, `price_vnd` trở thành nguồn chuẩn. |
| 6 | Bật client mới theo từng đợt | Hai cột đồng bộ; API giữ cả `price` và `priceVnd`. | `v2` (và `v3` khi đã sẵn sàng). Không còn `v1`. | Đưa `NEW_CLIENTS` về `0`, tiếp tục compatibility mode và điều tra. | Bắt đầu từ `NEW_CLIENTS=0`, tăng theo nấc 1% → 10% → 50% → 100%. Mỗi nấc soak tối thiểu 30 phút có traffic (đề xuất, chỉnh theo lưu lượng thực) với `error=0`, `contract=0`, `stale=0`, `unavailable=0`, và order total không đổi. Người duyệt mỗi nấc: owner của migration. |
| 7 | Deploy `v3` (contract code, còn dual-write) | `price_vnd` là nguồn chuẩn trong code; `price` còn trong schema và vẫn được ghi. | `v2`, `v3`. | Rollback về `v2`, giữ nguyên hai cột. An toàn vì `v3` vẫn ghi `price` nên `price` không bị cũ. | Toàn bộ instance là `v3`; mismatch alert = 0; test API và order flow pass. |
| 8 | Deploy `v4` (final code, không đụng `price`) | Hai cột vẫn tồn tại nhưng `price` không còn được ghi nên bắt đầu cũ dần. | `v3`, `v4`. | Rollback về `v3` được, **nhưng phải chạy resync trước**: `UPDATE menu_items SET price = price_vnd / 1000.0 WHERE price IS NOT price_vnd / 1000.0;` (idempotent). Trigger vẫn còn và không xung đột với resync. | Toàn bộ instance là `v4`; `grep`/test xác nhận không còn SQL runtime nào nhắc tới `menu_items.price`; backup mới đã được xác nhận. |
| 9 | **Table rebuild: bỏ `price`, siết ràng buộc (point of no return)** | `menu_items` được rebuild với `price_vnd INTEGER NOT NULL CHECK (price_vnd > 0)`; không còn `price` và không còn trigger. Index và foreign key được dựng lại. | Chỉ `v4`. Binary cũ sẽ lỗi. | Đây là điểm không quay lại đối với binary cũ. Forward-fix: `ALTER TABLE menu_items ADD COLUMN price REAL`, backfill `price = price_vnd / 1000.0`, deploy lại `v3`. Hoặc restore backup (mất ghi mới kể từ backup). `v1` không còn được hỗ trợ vì `price_vnd` là `NOT NULL`. | Backfill/check đạt; toàn bộ instance là `v4`; không còn dependency vào `price`; backup khôi phục được; bước diễn tập ở bước 1 đã cho thời gian lock chấp nhận được. |
| 10 | Cleanup sau thời gian quan sát | Schema cuối: `menu_items.price_vnd INTEGER NOT NULL CHECK (price_vnd > 0)`. | `v4`. | Deploy lại code phù hợp schema cuối; không khôi phục cột bằng code-only. | Quan sát tối thiểu 7 ngày (đề xuất); test/check cuối pass; migration history (`002`, `003`) và tài liệu đã cập nhật; xóa `NEW_CLIENTS` và code fallback không còn dùng. |

## Trigger đồng bộ (bước 2)

Trigger giúp DB tự giữ đồng bộ khi còn `v1` hoặc có writer bị bỏ sót, thay vì chỉ dựa vào kỷ luật của code. Trigger chỉ đồng bộ theo chiều `price` → `price_vnd`; vì vậy từ `v3` trở đi code phải dual-write `price` như đã nêu.

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

Trigger update chỉ chạy khi hai cột lệch nhau nên không xung đột với `v2`/`v3` đã ghi đúng cả hai cột. Cả hai trigger bị xóa cùng bảng ở bước 9.

## Kiểm tra dữ liệu nguồn (bước 1)

"Price hợp lệ" trong backfill được định nghĩa bằng việc query này trả 0 row:

```sql
SELECT id, price FROM menu_items
WHERE price IS NULL
   OR price <= 0
   OR abs(price * 1000 - round(price * 1000)) > 1e-6;
```

Row bất thường (giá NULL, bằng 0, hoặc có phần lẻ dưới 1 VND như `12.3456`) phải được xử lý bằng quyết định rõ ràng (sửa dữ liệu, hoặc xác nhận cho phép làm tròn) trước khi backfill, vì bước 9 yêu cầu `NOT NULL` và `CHECK (price_vnd > 0)`. Nếu nghiệp vụ cho phép món giá 0, đổi `CHECK` thành `>= 0` và sửa query tương ứng.

## Chi tiết backfill (bước 4)

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

## Kiểm tra sau backfill (bước 5)

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

## Table rebuild (bước 9)

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
- Đánh số riêng: `002_expand_price_vnd` (bước 2) và `003_contract_price_vnd` (bước 9), mỗi file `down` ghi rõ phạm vi. `001_init.down.sql` không phục vụ migration này.

## Kiểm tra bắt buộc

1. Trước migration: query dữ liệu nguồn trả 0 row; test suite `v1` pass trên schema đã expand; toàn bộ migration đã được diễn tập trên bản sao production.
2. Sau bước expand: `price` còn tồn tại, `price_vnd` là nullable integer, hai trigger tồn tại; thử `v1` ghi `price` và xác nhận `price_vnd` được đồng bộ.
3. Chạy `npm run check` sau mỗi đợt backfill; tiếp tục đến khi bốn query verify đều trả 0.
4. Test POST/PATCH bằng cả `{ price }` và `{ priceVnd }`; xác nhận hai cột được cập nhật atomically và `priceVnd` lẻ (ví dụ `12500`) cho ra `price = 12.5`.
5. Test list/get trả cả `price` và `priceVnd`; client cũ vẫn đọc được `price`.
6. Chạy order flow và xác nhận `order_items.unit_price` cùng order total không đổi so với trước migration (test tự động so sánh trước/sau).
7. Chạy traffic với client cũ và mới theo các nấc ở bước 6; chỉ đi tiếp khi `error`, `contract`, `stale`, `unavailable` đều bằng 0.
8. Trước bước 9: xác nhận không còn SQL runtime nào nhắc tới `menu_items.price`, `PRAGMA foreign_key_check` rỗng trên bản sao, thời gian lock đã đo.
9. Sau bước 9 và sau cleanup: kiểm tra schema cuối và chạy lại toàn bộ test/check.

## Rollback policy

- Các bước 2 đến 8 có thể dừng và tiếp tục lại mà không cần downtime.
- Không chuyển sang bước 6 khi còn bất kỳ instance `v1` nào, và không rollback binary về `v1` sau bước 5.
- Rollback `v4` → `v3` luôn phải chạy resync `price` từ `price_vnd` trước (bước 8).
- Dữ liệu sai sau backfill: tính lại `price_vnd` từ `price` (chỉ đúng khi `price` còn là nguồn chuẩn, tức trước hết bước 5). Sau đó, mismatch là bug cần điều tra, không tự động ghi đè.
- `001_init.down.sql` chỉ rollback toàn bộ schema baseline, không phải rollback an toàn cho migration này.
- Bước 9 cần backup và quy trình rebuild đã được diễn tập trên bản sao database production; migration down không được xem là đủ nếu chưa kiểm chứng.
