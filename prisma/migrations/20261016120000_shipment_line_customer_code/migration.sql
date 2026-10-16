-- Mã của khách trên dòng phiếu xuất: người lập nhập / sửa; trống thì lấy mã trên đơn.
ALTER TABLE "shipment_lines" ADD COLUMN "customer_code" TEXT;
