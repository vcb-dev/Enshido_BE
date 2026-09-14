UPDATE "warehouses"
SET "name" = 'Kho BTP',
    "short_name" = 'Kho BTP',
    "description" = 'Nhập, xuất và tồn bán thành phẩm. Xuất từ kho khác có thể chuyển sang đây.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "code" = 'btp-cho-vao-da';
