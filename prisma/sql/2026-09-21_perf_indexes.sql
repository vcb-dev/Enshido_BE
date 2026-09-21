-- Chỉ mục cho sổ tồn thành phẩm / giá vốn / phiếu của thợ.
CREATE INDEX IF NOT EXISTS stock_outbounds_production_order_id_idx
  ON stock_outbounds (production_order_id);

CREATE INDEX IF NOT EXISTS finished_goods_receipts_received_at_idx
  ON finished_goods_receipts (received_at DESC);

CREATE INDEX IF NOT EXISTS production_stage_entries_craftsman_returned_idx
  ON production_stage_entries (craftsman_user_id, returned_at);
