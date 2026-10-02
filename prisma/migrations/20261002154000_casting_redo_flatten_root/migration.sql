-- Mọi phiếu làm lại trỏ thẳng phiếu gốc (cùng level dưới cha khi xổ bảng).
WITH RECURSIVE ancestry AS (
  SELECT id, id AS root_id FROM casting_slips WHERE redo_of_slip_id IS NULL
  UNION ALL
  SELECT c.id, a.root_id
  FROM casting_slips c
  INNER JOIN ancestry a ON c.redo_of_slip_id = a.id
)
UPDATE casting_slips c
SET redo_of_slip_id = a.root_id
FROM ancestry a
WHERE c.id = a.id AND c.redo_of_slip_id IS NOT NULL AND c.redo_of_slip_id <> a.root_id;
