-- Phiếu đúc dịch vụ: gửi ngoài xưởng, không giao thợ đúc trong hệ thống.
ALTER TABLE "casting_slips" ADD COLUMN "is_service_cast" BOOLEAN NOT NULL DEFAULT false;
