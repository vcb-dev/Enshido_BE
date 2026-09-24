-- Nhập kho: Ngày nhập lưu cả giờ lúc nhập xong.
ALTER TABLE "stock_inbounds"
    ALTER COLUMN "received_at" TYPE TIMESTAMP(3)
    USING "received_at"::timestamp;
