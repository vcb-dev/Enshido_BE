-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RoleCode" AS ENUM ('ADMIN', 'USER', 'WORKER');

-- CreateEnum
CREATE TYPE "MetalKind" AS ENUM ('SILVER', 'GOLD', 'STONE', 'ALLOY', 'COPPER');

-- CreateEnum
CREATE TYPE "MaterialClass" AS ENUM ('RAW_MATERIAL', 'CONSUMABLE', 'SEMI_FINISHED');

-- CreateEnum
CREATE TYPE "OtherClassKind" AS ENUM ('CATALOG', 'OTHER');

-- CreateEnum
CREATE TYPE "ProductionStatus" AS ENUM ('NEW', 'REDO_3D', 'CASTING', 'FILING', 'STONE_SETTING', 'ENGRAVING', 'POLISHING', 'PLATING', 'DEFECT', 'FINISHING', 'DELIVERED');

-- CreateEnum
CREATE TYPE "ProductionRequestType" AS ENUM ('SAMPLE', 'RETAIL', 'BULK');

-- CreateEnum
CREATE TYPE "ProductionSource" AS ENUM ('NVL', 'BTP');

-- CreateEnum
CREATE TYPE "ProductionImageKind" AS ENUM ('DETAIL', 'PRODUCT');

-- CreateEnum
CREATE TYPE "ProductionStage" AS ENUM ('FILING', 'STONE_SETTING', 'ENGRAVING', 'POLISHING', 'PLATING');

-- CreateEnum
CREATE TYPE "SubTicketOutcome" AS ENUM ('DEFECT', 'FINISH');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role_code" "RoleCode" NOT NULL,
    "extra_roles" "RoleCode"[] DEFAULT ARRAY[]::"RoleCode"[],
    "allowed_screens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "department" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "description" TEXT,
    "parent_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_locations" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "zone" TEXT NOT NULL,
    "aisle" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metal_kind" "MetalKind",
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "material_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "other_classes" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "OtherClassKind" NOT NULL DEFAULT 'CATALOG',
    "parent_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "other_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shapes" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shapes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "colors" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku_letter" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "colors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "materials" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "location_code" TEXT,
    "unit_id" UUID NOT NULL,
    "material_type_id" UUID,
    "other_class_id" UUID,
    "body_metal_id" UUID,
    "product_kind_id" UUID,
    "plating_color_id" UUID,
    "shape_id" UUID,
    "color_id" UUID,
    "size_label" TEXT,
    "quality" TEXT,
    "note" TEXT,
    "classification" "MaterialClass" NOT NULL DEFAULT 'RAW_MATERIAL',
    "metal_kind" "MetalKind",
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "reorder_point" DECIMAL(18,4) NOT NULL DEFAULT 5,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_images" (
    "id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "opening_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "opening_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "stock_unit_price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "in_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "in_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "out_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "out_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "counted_qty" DECIMAL(18,4),
    "counted_at" DATE,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_inbounds" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "material_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "received_at" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "unit_id" UUID,
    "unit_name" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "stock_unit_price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "entered_by" TEXT,
    "supplier_sku" TEXT,
    "supplier_id" UUID,
    "supplier_name" TEXT,
    "apply_to_stock" BOOLEAN NOT NULL DEFAULT false,
    "source_warehouse_id" UUID,
    "source_outbound_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_inbounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_outbounds" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "material_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "issued_at" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "unit_id" UUID,
    "unit_name" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "stock_unit_price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "inbound_unit_price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "issued_by" TEXT,
    "received_by" TEXT,
    "received_by_user_id" UUID,
    "apply_to_stock" BOOLEAN NOT NULL DEFAULT false,
    "production_order_id" UUID,
    "auto_issued" BOOLEAN NOT NULL DEFAULT false,
    "dest_warehouse_id" UUID,
    "dest_inbound_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_outbounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "btp_waiting_items" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "received_at" DATE NOT NULL,
    "craftsman_user_id" UUID,
    "craftsman_name" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit_id" UUID,
    "unit_name" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "weight" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "note" TEXT,
    "entered_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "btp_waiting_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_orders" (
    "id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ProductionStatus" NOT NULL DEFAULT 'NEW',
    "source" "ProductionSource" NOT NULL DEFAULT 'NVL',
    "btp_material_id" UUID,
    "nvl_material_id" UUID,
    "source_order_code" TEXT,
    "request_type" "ProductionRequestType" NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "qty_unit" TEXT,
    "finished_product_qty" INTEGER,
    "returned_qty" INTEGER NOT NULL DEFAULT 0,
    "model_3d_code" TEXT,
    "model_3d_url" TEXT,
    "lead_time" TEXT,
    "tracking_code" TEXT,
    "closed_by" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "stone_color" TEXT,
    "stone_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "size" TEXT,
    "size_label" TEXT,
    "stone_count" INTEGER,
    "stone_weight" DECIMAL(18,4),
    "laser_engraving" TEXT,
    "other_requirements" TEXT,
    "main_material" TEXT,
    "plating_color" TEXT,
    "btp_category" TEXT,
    "product_kind" TEXT,
    "asked_user_id" UUID,
    "asked_user_name" TEXT,
    "received_date" DATE NOT NULL,
    "due_date" DATE,
    "casting_sent_date" DATE,
    "casting_returned_date" DATE,
    "debt_status" TEXT,
    "silver_weight" DECIMAL(18,4),
    "parent_id" UUID,
    "last_printed_at" TIMESTAMP(3),
    "data_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "created_by_user_id" UUID,
    "sub_ticket_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_order_images" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" "ProductionImageKind" NOT NULL,
    "url" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_order_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_stage_entries" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sub_ticket_id" UUID,
    "stage" "ProductionStage" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "handed_by_user_id" UUID,
    "handed_by_name" TEXT NOT NULL,
    "handed_at" TIMESTAMP(3) NOT NULL,
    "handed_qty" INTEGER,
    "handed_silver_weight" DECIMAL(18,4),
    "craftsman_user_id" UUID,
    "craftsman_name" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "submitted_by_user_id" UUID,
    "submitted_by_name" TEXT,
    "returned_by_user_id" UUID,
    "returned_by_name" TEXT,
    "returned_at" TIMESTAMP(3),
    "returned_qty" INTEGER,
    "returned_silver_weight" DECIMAL(18,4),
    "btp_recovered_weight" DECIMAL(18,4),
    "silver_recovered_weight" DECIMAL(18,4),
    "labor_cost" DECIMAL(18,2),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_stage_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_sub_tickets" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "no" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "silver_weight" DECIMAL(18,4) NOT NULL,
    "note" TEXT,
    "pending_stage" "ProductionStage",
    "pending_at" TIMESTAMP(3),
    "pending_by_name" TEXT,
    "claimed_by_user_id" UUID,
    "claimed_by_name" TEXT,
    "claimed_at" TIMESTAMP(3),
    "outcome" "SubTicketOutcome",
    "outcome_at" TIMESTAMP(3),
    "outcome_by_user_id" UUID,
    "outcome_by_name" TEXT,
    "outcome_stage" "ProductionStage",
    "outcome_qty" INTEGER,
    "outcome_note" TEXT,
    "last_printed_at" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_sub_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_sub_ticket_top_ups" (
    "id" UUID NOT NULL,
    "sub_ticket_id" UUID NOT NULL,
    "stage_entry_id" UUID,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "silver_weight" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "created_by_user_id" UUID,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_sub_ticket_top_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_status_logs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "ProductionStatus",
    "to_status" "ProductionStatus" NOT NULL,
    "note" TEXT,
    "changed_by" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_order_costs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_order_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_receipts" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "received_by_user_id" UUID,
    "received_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finished_goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "shipped_at" DATE NOT NULL,
    "customer_name" TEXT NOT NULL,
    "payment_method" TEXT,
    "note" TEXT,
    "created_by_user_id" UUID,
    "created_by_name" TEXT NOT NULL,
    "last_printed_at" TIMESTAMP(3),
    "data_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "auto_issued" BOOLEAN NOT NULL DEFAULT false,
    "created_by_order_id" UUID,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_lines" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "unit_cost" DECIMAL(18,2) NOT NULL,
    "cost_amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shipment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_code_is_active_idx" ON "users"("role_code", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");

-- CreateIndex
CREATE INDEX "warehouses_parent_id_sort_order_idx" ON "warehouses"("parent_id", "sort_order");

-- CreateIndex
CREATE INDEX "warehouse_locations_warehouse_id_is_active_sort_order_idx" ON "warehouse_locations"("warehouse_id", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "warehouse_locations_wh_slot_idx" ON "warehouse_locations"("warehouse_id", "zone", "aisle", "level", "position");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_locations_warehouse_id_code_key" ON "warehouse_locations"("warehouse_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "units_code_key" ON "units"("code");

-- CreateIndex
CREATE UNIQUE INDEX "material_types_code_key" ON "material_types"("code");

-- CreateIndex
CREATE INDEX "material_types_metal_kind_sort_order_idx" ON "material_types"("metal_kind", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "other_classes_code_key" ON "other_classes"("code");

-- CreateIndex
CREATE INDEX "other_classes_kind_sort_order_idx" ON "other_classes"("kind", "sort_order");

-- CreateIndex
CREATE INDEX "other_classes_parent_id_idx" ON "other_classes"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "shapes_code_key" ON "shapes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "colors_code_key" ON "colors"("code");

-- CreateIndex
CREATE INDEX "materials_warehouse_id_is_active_sort_order_idx" ON "materials"("warehouse_id", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "materials_warehouse_id_location_code_idx" ON "materials"("warehouse_id", "location_code");

-- CreateIndex
CREATE INDEX "materials_material_type_id_idx" ON "materials"("material_type_id");

-- CreateIndex
CREATE INDEX "materials_body_metal_id_idx" ON "materials"("body_metal_id");

-- CreateIndex
CREATE INDEX "materials_product_kind_id_idx" ON "materials"("product_kind_id");

-- CreateIndex
CREATE INDEX "materials_plating_color_id_idx" ON "materials"("plating_color_id");

-- CreateIndex
CREATE UNIQUE INDEX "materials_warehouse_id_sku_key" ON "materials"("warehouse_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "materials_sku_key" ON "materials"("sku");

-- CreateIndex
CREATE INDEX "material_images_material_id_sort_order_idx" ON "material_images"("material_id", "sort_order");

-- CreateIndex
CREATE INDEX "material_images_public_id_idx" ON "material_images"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_material_id_key" ON "stock_balances"("material_id");

-- CreateIndex
CREATE INDEX "stock_balances_warehouse_id_idx" ON "stock_balances"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_warehouse_id_material_id_key" ON "stock_balances"("warehouse_id", "material_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_code_key" ON "suppliers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "stock_inbounds_source_outbound_id_key" ON "stock_inbounds"("source_outbound_id");

-- CreateIndex
CREATE INDEX "stock_inbounds_warehouse_id_received_at_idx" ON "stock_inbounds"("warehouse_id", "received_at");

-- CreateIndex
CREATE INDEX "stock_inbounds_warehouse_id_sort_order_idx" ON "stock_inbounds"("warehouse_id", "sort_order");

-- CreateIndex
CREATE INDEX "stock_inbounds_wh_mat_apply_idx" ON "stock_inbounds"("warehouse_id", "material_id", "apply_to_stock");

-- CreateIndex
CREATE INDEX "stock_inbounds_material_id_idx" ON "stock_inbounds"("material_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_inbounds_warehouse_id_sort_order_key" ON "stock_inbounds"("warehouse_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "stock_outbounds_dest_inbound_id_key" ON "stock_outbounds"("dest_inbound_id");

-- CreateIndex
CREATE INDEX "stock_outbounds_warehouse_id_issued_at_idx" ON "stock_outbounds"("warehouse_id", "issued_at");

-- CreateIndex
CREATE INDEX "stock_outbounds_warehouse_id_sort_order_idx" ON "stock_outbounds"("warehouse_id", "sort_order");

-- CreateIndex
CREATE INDEX "stock_outbounds_wh_mat_apply_idx" ON "stock_outbounds"("warehouse_id", "material_id", "apply_to_stock");

-- CreateIndex
CREATE INDEX "stock_outbounds_material_id_idx" ON "stock_outbounds"("material_id");

-- CreateIndex
CREATE INDEX "stock_outbounds_production_order_id_idx" ON "stock_outbounds"("production_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_outbounds_warehouse_id_sort_order_key" ON "stock_outbounds"("warehouse_id", "sort_order");

-- CreateIndex
CREATE INDEX "btp_waiting_items_warehouse_id_received_at_idx" ON "btp_waiting_items"("warehouse_id", "received_at");

-- CreateIndex
CREATE INDEX "btp_waiting_items_warehouse_id_sort_order_idx" ON "btp_waiting_items"("warehouse_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "btp_waiting_items_warehouse_id_sort_order_key" ON "btp_waiting_items"("warehouse_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_seq_key" ON "production_orders"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_code_key" ON "production_orders"("code");

-- CreateIndex
CREATE INDEX "production_orders_status_created_at_idx" ON "production_orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "production_orders_request_type_idx" ON "production_orders"("request_type");

-- CreateIndex
CREATE INDEX "production_orders_parent_id_idx" ON "production_orders"("parent_id");

-- CreateIndex
CREATE INDEX "production_orders_btp_material_id_idx" ON "production_orders"("btp_material_id");

-- CreateIndex
CREATE INDEX "production_orders_nvl_material_id_idx" ON "production_orders"("nvl_material_id");

-- CreateIndex
CREATE INDEX "production_order_images_order_id_kind_sort_order_idx" ON "production_order_images"("order_id", "kind", "sort_order");

-- CreateIndex
CREATE INDEX "production_stage_entries_order_id_created_at_idx" ON "production_stage_entries"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "production_stage_entries_sub_ticket_id_idx" ON "production_stage_entries"("sub_ticket_id");

-- CreateIndex
CREATE INDEX "production_stage_entries_craftsman_user_id_returned_at_idx" ON "production_stage_entries"("craftsman_user_id", "returned_at");

-- CreateIndex
-- NULLS NOT DISTINCT (PostgreSQL 15+) phải viết tay: Prisma 6 chưa khai báo được nó trong
-- schema.prisma, nên nếu sinh lại file này bằng prisma migrate diff thì phải thêm lại.
-- Thiếu nó thì khâu cấp đơn (sub_ticket_id null) lặp được khâu + lần, vì NULL != NULL.
CREATE UNIQUE INDEX "production_stage_entries_order_ticket_stage_attempt_key" ON "production_stage_entries"("order_id", "sub_ticket_id", "stage", "attempt") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "production_sub_tickets_pending_stage_claimed_by_user_id_idx" ON "production_sub_tickets"("pending_stage", "claimed_by_user_id");

-- CreateIndex
CREATE INDEX "production_sub_tickets_claimed_by_user_id_idx" ON "production_sub_tickets"("claimed_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_sub_tickets_order_id_no_key" ON "production_sub_tickets"("order_id", "no");

-- CreateIndex
CREATE INDEX "production_sub_ticket_top_ups_sub_ticket_id_idx" ON "production_sub_ticket_top_ups"("sub_ticket_id");

-- CreateIndex
CREATE INDEX "production_sub_ticket_top_ups_stage_entry_id_idx" ON "production_sub_ticket_top_ups"("stage_entry_id");

-- CreateIndex
CREATE INDEX "production_status_logs_order_id_changed_at_idx" ON "production_status_logs"("order_id", "changed_at");

-- CreateIndex
CREATE INDEX "production_order_costs_order_id_created_at_idx" ON "production_order_costs"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_receipts_order_id_key" ON "finished_goods_receipts"("order_id");

-- CreateIndex
CREATE INDEX "finished_goods_receipts_received_at_idx" ON "finished_goods_receipts"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_seq_key" ON "shipments"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_code_key" ON "shipments"("code");

-- CreateIndex
CREATE INDEX "shipments_shipped_at_idx" ON "shipments"("shipped_at");

-- CreateIndex
CREATE INDEX "shipments_created_by_order_id_idx" ON "shipments"("created_by_order_id");

-- CreateIndex
CREATE INDEX "shipment_lines_shipment_id_sort_order_idx" ON "shipment_lines"("shipment_id", "sort_order");

-- CreateIndex
CREATE INDEX "shipment_lines_order_id_idx" ON "shipment_lines"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_classes" ADD CONSTRAINT "other_classes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "other_classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_material_type_id_fkey" FOREIGN KEY ("material_type_id") REFERENCES "material_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_other_class_id_fkey" FOREIGN KEY ("other_class_id") REFERENCES "other_classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_body_metal_id_fkey" FOREIGN KEY ("body_metal_id") REFERENCES "other_classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_product_kind_id_fkey" FOREIGN KEY ("product_kind_id") REFERENCES "other_classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_plating_color_id_fkey" FOREIGN KEY ("plating_color_id") REFERENCES "other_classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_shape_id_fkey" FOREIGN KEY ("shape_id") REFERENCES "shapes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_color_id_fkey" FOREIGN KEY ("color_id") REFERENCES "colors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_images" ADD CONSTRAINT "material_images_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_inbounds" ADD CONSTRAINT "stock_inbounds_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_inbounds" ADD CONSTRAINT "stock_inbounds_source_warehouse_id_fkey" FOREIGN KEY ("source_warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_inbounds" ADD CONSTRAINT "stock_inbounds_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_inbounds" ADD CONSTRAINT "stock_inbounds_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_inbounds" ADD CONSTRAINT "stock_inbounds_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_outbounds" ADD CONSTRAINT "stock_outbounds_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_outbounds" ADD CONSTRAINT "stock_outbounds_dest_warehouse_id_fkey" FOREIGN KEY ("dest_warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_outbounds" ADD CONSTRAINT "stock_outbounds_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_outbounds" ADD CONSTRAINT "stock_outbounds_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_outbounds" ADD CONSTRAINT "stock_outbounds_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "btp_waiting_items" ADD CONSTRAINT "btp_waiting_items_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "btp_waiting_items" ADD CONSTRAINT "btp_waiting_items_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_btp_material_id_fkey" FOREIGN KEY ("btp_material_id") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_nvl_material_id_fkey" FOREIGN KEY ("nvl_material_id") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_images" ADD CONSTRAINT "production_order_images_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage_entries" ADD CONSTRAINT "production_stage_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage_entries" ADD CONSTRAINT "production_stage_entries_sub_ticket_id_fkey" FOREIGN KEY ("sub_ticket_id") REFERENCES "production_sub_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_sub_tickets" ADD CONSTRAINT "production_sub_tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_sub_ticket_top_ups" ADD CONSTRAINT "production_sub_ticket_top_ups_sub_ticket_id_fkey" FOREIGN KEY ("sub_ticket_id") REFERENCES "production_sub_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_sub_ticket_top_ups" ADD CONSTRAINT "production_sub_ticket_top_ups_stage_entry_id_fkey" FOREIGN KEY ("stage_entry_id") REFERENCES "production_stage_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_status_logs" ADD CONSTRAINT "production_status_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_costs" ADD CONSTRAINT "production_order_costs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_receipts" ADD CONSTRAINT "finished_goods_receipts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_order_id_fkey" FOREIGN KEY ("created_by_order_id") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

