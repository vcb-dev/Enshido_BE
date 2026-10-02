-- Phiếu làm lại thiếu thợ: lấy lại từ phiếu cha gốc.
UPDATE casting_slips AS child
SET
  started_by_user_id = root.started_by_user_id,
  started_by_name = root.started_by_name
FROM casting_slips AS root
WHERE child.redo_of_slip_id = root.id
  AND child.started_by_user_id IS NULL
  AND root.started_by_user_id IS NOT NULL;
