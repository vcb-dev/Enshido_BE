-- AlterTable
ALTER TABLE "users" ADD COLUMN     "worker_stages" "ProductionStage"[] DEFAULT ARRAY[]::"ProductionStage"[];

-- Thợ đang có trước khi có cột này vẫn nhận được mọi khâu như cũ; admin sửa lại theo đúng
-- khâu từng người ở màn Nhân sự.
UPDATE "users"
SET "worker_stages" = ARRAY['FILING', 'STONE_SETTING', 'ENGRAVING', 'POLISHING', 'PLATING']::"ProductionStage"[]
WHERE "role_code" = 'WORKER' OR 'WORKER' = ANY("extra_roles");
