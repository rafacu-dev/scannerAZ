import crypto from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { config } from "../config.js";
import type { ExtractedInvoiceDraft } from "./extraction.js";

export type InventoryCondition =
  | "new"
  | "used_like_new"
  | "used_good"
  | "used_acceptable"
  | "unsellable";

export type InventoryMovementType =
  | "purchase"
  | "sale"
  | "amazon_sale_reversal"
  | "amazon_customer_return"
  | "retailer_return"
  | "retailer_return_rejected"
  | "adjustment";

export type InventoryReturnType = "amazon_customer" | "retailer";
export type InventoryReturnStatus =
  | "received_pending"
  | "restocked"
  | "disposed"
  | "sent"
  | "refunded"
  | "returned_to_stock";

export type InventoryInvoiceLineInput = {
  title: string;
  quantity: number;
  unitCostCents: number;
  condition: InventoryCondition;
  sku?: string;
  asin?: string;
  upc?: string;
  imageUrl?: string;
};

export type CreateInventoryInvoiceInput = {
  retailer: string;
  invoiceNumber?: string;
  purchasedAt?: string;
  currency: string;
  notes?: string;
  documentName?: string;
  sourceExtractionId?: string;
  lines: InventoryInvoiceLineInput[];
};

export type InvoiceExtractionStatus = "pending_review" | "processing" | "confirmed";

export type StoredInvoiceExtraction = {
  id: string;
  sourceFilename: string;
  mimeType: string;
  sizeBytes: number;
  documentSha256: string;
  model: string;
  status: InvoiceExtractionStatus;
  draft: ExtractedInvoiceDraft;
  createdAt: string;
  confirmedAt?: string;
  invoiceId?: string;
};

export type InventoryAsinMapping = {
  upc: string;
  asin: string;
  sku?: string;
  title?: string;
  imageUrl?: string;
  source: "saved_mapping";
};

export type InventoryProduct = {
  id: string;
  sku?: string;
  asin?: string;
  upc?: string;
  title: string;
  imageUrl?: string;
  availableQuantity: number;
  receivedQuantity: number;
  soldQuantity: number;
  customerReturnQuantity: number;
  retailerReturnQuantity: number;
  averageUnitCostCents?: number;
  inventoryValueCents: number;
  lastActivityAt?: string;
};

export type InventoryActivity = {
  id: string;
  productId: string;
  productTitle: string;
  movementType: InventoryMovementType;
  quantityDelta: number;
  condition: InventoryCondition;
  channel?: string;
  reference?: string;
  notes?: string;
  occurredAt: string;
};

export type InventoryReturnCase = {
  id: string;
  productId: string;
  productTitle: string;
  returnType: InventoryReturnType;
  status: InventoryReturnStatus;
  retailer?: string;
  quantity: number;
  condition: InventoryCondition;
  reference?: string;
  notes?: string;
  receivedAt: string;
  completedAt?: string;
};

export type InventoryOverview = {
  summary: {
    productCount: number;
    availableUnits: number;
    inventoryValueCents: number;
    soldUnits: number;
    customerReturnUnits: number;
    retailerReturnUnits: number;
    pendingReturns: number;
    unmatchedAmazonOrderLines: number;
    insufficientAmazonOrderLines: number;
    lastAmazonSalesSyncAt?: string;
  };
  products: InventoryProduct[];
  recentActivity: InventoryActivity[];
  returns: InventoryReturnCase[];
};

export type AmazonInventorySalesLine = {
  orderId: string;
  orderItemId: string;
  sellerSku?: string;
  asin?: string;
  title?: string;
  conditionType?: string;
  quantityOrdered: number;
  quantityFulfilled: number;
  fulfillmentStatus?: string;
  fulfilledBy?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
};

export type AmazonSalesSyncState = {
  connectionId: string;
  lastSyncedAt?: string;
  hasMore: boolean;
  lastError?: string;
};

export type AmazonSalesImportResult = {
  processedLines: number;
  appliedLines: number;
  appliedUnits: number;
  reversedUnits: number;
  unmatchedLines: number;
  insufficientLines: number;
  notFulfilledLines: number;
};

export type RecordInventorySaleInput = {
  productId: string;
  quantity: number;
  condition: InventoryCondition;
  channel?: string;
  reference?: string;
  notes?: string;
  occurredAt?: string;
};

export type RecordAmazonCustomerReturnInput = {
  productId: string;
  quantity: number;
  condition: InventoryCondition;
  disposition: "restock" | "hold" | "dispose";
  reference?: string;
  notes?: string;
  occurredAt?: string;
};

export type RecordRetailerReturnInput = {
  productId: string;
  retailer: string;
  quantity: number;
  condition: InventoryCondition;
  reference?: string;
  notes?: string;
  occurredAt?: string;
};

export type ResolveInventoryReturnInput = {
  returnId: string;
  disposition: "restock" | "dispose" | "refund" | "return_to_stock";
  condition?: InventoryCondition;
  notes?: string;
};

export class DuplicateInventoryInvoiceError extends Error {
  constructor() {
    super("Ya existe una factura de ese retailer con ese numero.");
  }
}

export class InventoryProductNotFoundError extends Error {
  constructor() {
    super("El producto no existe en este inventario.");
  }
}

export class InsufficientInventoryError extends Error {
  constructor() {
    super("No hay unidades disponibles suficientes para registrar esta salida.");
  }
}

export class InventoryReturnNotFoundError extends Error {
  constructor() {
    super("La devolucion no existe o ya fue cerrada.");
  }
}

export class InvalidInventoryReturnResolutionError extends Error {
  constructor() {
    super("Esta resolucion no corresponde al tipo o estado actual de la devolucion.");
  }
}

export class InventoryExtractionNotFoundError extends Error {
  constructor() {
    super("La factura extraida no existe o ya fue confirmada.");
  }
}

export class AmazonSalesSyncInProgressError extends Error {
  constructor() {
    super("Ya hay una sincronizacion de ventas de Amazon en curso.");
  }
}

type ProductRow = {
  id: string;
  sku: string | null;
  asin: string | null;
  upc: string | null;
  title: string;
  image_url: string | null;
  available_quantity: string | number | null;
  received_quantity: string | number | null;
  sold_quantity: string | number | null;
  customer_return_quantity: string | number | null;
  retailer_return_quantity: string | number | null;
  average_unit_cost_cents: string | number | null;
  last_activity_at: Date | string | null;
};

type ActivityRow = {
  id: string;
  product_id: string;
  product_title: string;
  movement_type: InventoryMovementType;
  quantity_delta: string | number;
  condition: InventoryCondition;
  channel: string | null;
  reference: string | null;
  notes: string | null;
  occurred_at: Date | string;
};

type ReturnRow = {
  id: string;
  product_id: string;
  product_title: string;
  return_type: InventoryReturnType;
  status: InventoryReturnStatus;
  retailer: string | null;
  quantity: string | number;
  condition: InventoryCondition;
  reference: string | null;
  notes: string | null;
  received_at: Date | string;
  completed_at: Date | string | null;
};

type TenantProductRow = {
  id: string;
  title: string;
};

type TenantReturnRow = {
  id: string;
  product_id: string;
  return_type: InventoryReturnType;
  status: InventoryReturnStatus;
  quantity: string | number;
  condition: InventoryCondition;
};

type InvoiceExtractionRow = {
  id: string;
  source_filename: string;
  mime_type: string;
  size_bytes: string | number;
  document_sha256: string;
  model: string;
  status: InvoiceExtractionStatus;
  draft_json: ExtractedInvoiceDraft | string;
  created_at: Date | string;
  confirmed_at: Date | string | null;
  invoice_id: string | null;
};

type AsinMappingRow = {
  upc: string;
  asin: string;
  seller_sku: string | null;
  title: string | null;
  image_url: string | null;
};

type AmazonSaleLineRow = {
  id: string;
  product_id: string | null;
  applied_quantity: string | number;
  desired_quantity: string | number;
  sync_status: AmazonSaleSyncStatus;
};

type AmazonSalesSyncRow = {
  connection_id: string;
  pagination_token: string | null;
  window_started_at: Date | string | null;
  window_after: Date | string | null;
  last_synced_at: Date | string | null;
  sync_started_at: Date | string | null;
  last_error: string | null;
};

type AmazonSalesReconciliationRow = {
  unmatched_lines: string | number | null;
  insufficient_lines: string | number | null;
  last_synced_at: Date | string | null;
};

type InventoryLotAvailabilityRow = {
  id: string;
  condition: InventoryCondition;
  available_quantity: string | number | null;
};

type InventorySourceAllocationRow = {
  lot_id: string | null;
  condition: InventoryCondition;
  applied_quantity: string | number | null;
};

type InventoryProductMatchRow = {
  id: string;
  title: string;
};

type AmazonSaleSyncStatus =
  | "applied"
  | "unmatched_product"
  | "insufficient_stock"
  | "not_fulfilled";

let pool: Pool | undefined;
let schemaPromise: Promise<void> | undefined;

export function usesManagedInventoryStore() {
  return Boolean(config.DATABASE_URL);
}

export async function initializeInventoryStore() {
  const inventoryPool = getPool();

  if (!inventoryPool || schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = inventoryPool
    .query(`
      CREATE TABLE IF NOT EXISTS scanneraz_inventory_products (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES scanneraz_tenants(id) ON DELETE CASCADE,
        product_key TEXT NOT NULL,
        sku TEXT,
        asin TEXT,
        upc TEXT,
        title TEXT NOT NULL,
        image_url TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (tenant_id, product_key)
      );

      CREATE INDEX IF NOT EXISTS scanneraz_inventory_products_tenant_updated_idx
      ON scanneraz_inventory_products (tenant_id, updated_at DESC);

      -- A retailer receipt usually has a UPC but not an Amazon ASIN. Keep the
      -- deliberate UPC-to-ASIN relation outside an individual invoice so a
      -- future receipt can be reconciled without asking the seller again.
      CREATE TABLE IF NOT EXISTS scanneraz_inventory_asin_mappings (
        tenant_id TEXT NOT NULL REFERENCES scanneraz_tenants(id) ON DELETE CASCADE,
        upc TEXT NOT NULL,
        asin TEXT NOT NULL,
        seller_sku TEXT,
        title TEXT,
        image_url TEXT,
        source TEXT NOT NULL CHECK (source IN ('invoice', 'legacy_inventory')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, upc)
      );

      CREATE INDEX IF NOT EXISTS scanneraz_inventory_asin_mappings_tenant_asin_idx
      ON scanneraz_inventory_asin_mappings (tenant_id, asin);

      -- Preserve relationships already present in inventory from before this
      -- dedicated mapping table existed. A later explicit invoice selection
      -- can still update a legacy row through the normal upsert below.
      INSERT INTO scanneraz_inventory_asin_mappings (
        tenant_id, upc, asin, seller_sku, title, image_url, source, created_at, updated_at
      )
      SELECT
        tenant_id,
        regexp_replace(COALESCE(upc, ''), '[^0-9]', '', 'g'),
        UPPER(regexp_replace(COALESCE(asin, ''), '\\s+', '', 'g')),
        sku,
        title,
        image_url,
        'legacy_inventory',
        created_at,
        updated_at
      FROM scanneraz_inventory_products
      WHERE regexp_replace(COALESCE(upc, ''), '[^0-9]', '', 'g') ~ '^[0-9]{8,14}$'
        AND UPPER(regexp_replace(COALESCE(asin, ''), '\\s+', '', 'g')) ~ '^[A-Z0-9]{10}$'
      ON CONFLICT (tenant_id, upc) DO NOTHING;

      CREATE TABLE IF NOT EXISTS scanneraz_inventory_invoices (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES scanneraz_tenants(id) ON DELETE CASCADE,
        retailer TEXT NOT NULL,
        invoice_number TEXT,
        purchased_at DATE NOT NULL,
        currency TEXT NOT NULL,
        notes TEXT,
        document_name TEXT,
        source_extraction_id TEXT,
        created_at TIMESTAMPTZ NOT NULL
      );

      ALTER TABLE scanneraz_inventory_invoices
        ADD COLUMN IF NOT EXISTS source_extraction_id TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS scanneraz_inventory_invoices_tenant_retailer_number_idx
      ON scanneraz_inventory_invoices (tenant_id, retailer, invoice_number)
      WHERE invoice_number IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS scanneraz_inventory_invoices_source_extraction_idx
      ON scanneraz_inventory_invoices (source_extraction_id)
      WHERE source_extraction_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS scanneraz_inventory_invoices_tenant_purchased_idx
      ON scanneraz_inventory_invoices (tenant_id, purchased_at DESC);

      CREATE TABLE IF NOT EXISTS scanneraz_inventory_lots (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES scanneraz_tenants(id) ON DELETE CASCADE,
        invoice_id TEXT NOT NULL REFERENCES scanneraz_inventory_invoices(id) ON DELETE RESTRICT,
        product_id TEXT NOT NULL REFERENCES scanneraz_inventory_products(id) ON DELETE RESTRICT,
        condition TEXT NOT NULL CHECK (condition IN ('new', 'used_like_new', 'used_good', 'used_acceptable', 'unsellable')),
        received_quantity INTEGER NOT NULL CHECK (received_quantity > 0),
        unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
        currency TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scanneraz_inventory_lots_tenant_product_idx
      ON scanneraz_inventory_lots (tenant_id, product_id, received_at DESC);

      CREATE TABLE IF NOT EXISTS scanneraz_inventory_movements (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES scanneraz_tenants(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES scanneraz_inventory_products(id) ON DELETE RESTRICT,
        lot_id TEXT REFERENCES scanneraz_inventory_lots(id) ON DELETE SET NULL,
        movement_type TEXT NOT NULL CHECK (movement_type IN ('purchase', 'sale', 'amazon_customer_return', 'retailer_return', 'retailer_return_rejected', 'adjustment')),
        quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
        condition TEXT NOT NULL CHECK (condition IN ('new', 'used_like_new', 'used_good', 'used_acceptable', 'unsellable')),
        channel TEXT,
        reference TEXT,
        notes TEXT,
        occurred_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scanneraz_inventory_movements_tenant_product_idx
      ON scanneraz_inventory_movements (tenant_id, product_id, occurred_at DESC);

      ALTER TABLE scanneraz_inventory_movements
        ADD COLUMN IF NOT EXISTS source_type TEXT;

      ALTER TABLE scanneraz_inventory_movements
        ADD COLUMN IF NOT EXISTS source_id TEXT;

      -- The original schema predates automatic Amazon sale reversals. Keep
      -- every inventory correction append-only so the ledger remains auditable.
      ALTER TABLE scanneraz_inventory_movements
        DROP CONSTRAINT IF EXISTS scanneraz_inventory_movements_movement_type_check;

      ALTER TABLE scanneraz_inventory_movements
        ADD CONSTRAINT scanneraz_inventory_movements_movement_type_check
        CHECK (movement_type IN (
          'purchase', 'sale', 'amazon_sale_reversal', 'amazon_customer_return',
          'retailer_return', 'retailer_return_rejected', 'adjustment'
        ));

      CREATE INDEX IF NOT EXISTS scanneraz_inventory_movements_source_idx
      ON scanneraz_inventory_movements (tenant_id, source_type, source_id)
      WHERE source_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS scanneraz_inventory_amazon_order_lines (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES scanneraz_tenants(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL,
        amazon_order_id TEXT NOT NULL,
        amazon_order_item_id TEXT NOT NULL,
        product_id TEXT REFERENCES scanneraz_inventory_products(id) ON DELETE SET NULL,
        seller_sku TEXT,
        asin TEXT,
        title TEXT,
        condition TEXT NOT NULL CHECK (condition IN ('new', 'used_like_new', 'used_good', 'used_acceptable', 'unsellable')),
        quantity_ordered INTEGER NOT NULL CHECK (quantity_ordered > 0),
        desired_quantity INTEGER NOT NULL CHECK (desired_quantity >= 0),
        applied_quantity INTEGER NOT NULL DEFAULT 0 CHECK (applied_quantity >= 0),
        fulfillment_status TEXT,
        fulfilled_by TEXT,
        order_created_at TIMESTAMPTZ,
        order_last_updated_at TIMESTAMPTZ,
        sync_status TEXT NOT NULL CHECK (sync_status IN ('applied', 'unmatched_product', 'insufficient_stock', 'not_fulfilled')),
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (tenant_id, connection_id, amazon_order_id, amazon_order_item_id)
      );

      CREATE INDEX IF NOT EXISTS scanneraz_inventory_amazon_order_lines_tenant_status_idx
      ON scanneraz_inventory_amazon_order_lines (tenant_id, sync_status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS scanneraz_inventory_amazon_sale_syncs (
        tenant_id TEXT NOT NULL REFERENCES scanneraz_tenants(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL,
        pagination_token TEXT,
        window_started_at TIMESTAMPTZ,
        window_after TIMESTAMPTZ,
        last_synced_at TIMESTAMPTZ,
        sync_started_at TIMESTAMPTZ,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, connection_id)
      );

      CREATE TABLE IF NOT EXISTS scanneraz_inventory_returns (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES scanneraz_tenants(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES scanneraz_inventory_products(id) ON DELETE RESTRICT,
        return_type TEXT NOT NULL CHECK (return_type IN ('amazon_customer', 'retailer')),
        status TEXT NOT NULL CHECK (status IN ('received_pending', 'restocked', 'disposed', 'sent', 'refunded', 'returned_to_stock')),
        retailer TEXT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        condition TEXT NOT NULL CHECK (condition IN ('new', 'used_like_new', 'used_good', 'used_acceptable', 'unsellable')),
        reference TEXT,
        notes TEXT,
        received_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scanneraz_inventory_returns_tenant_status_idx
      ON scanneraz_inventory_returns (tenant_id, status, received_at DESC);

      CREATE TABLE IF NOT EXISTS scanneraz_inventory_invoice_extractions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES scanneraz_tenants(id) ON DELETE CASCADE,
        source_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        document_sha256 TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending_review', 'processing', 'confirmed')),
        draft_json JSONB NOT NULL,
        invoice_id TEXT REFERENCES scanneraz_inventory_invoices(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        confirmed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS scanneraz_inventory_invoice_extractions_tenant_created_idx
      ON scanneraz_inventory_invoice_extractions (tenant_id, created_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS scanneraz_inventory_invoice_extractions_tenant_document_idx
      ON scanneraz_inventory_invoice_extractions (tenant_id, document_sha256);
    `)
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaPromise = undefined;
      throw error;
    });

  return schemaPromise;
}

export async function createInventoryInvoice(
  tenantId: string,
  input: CreateInventoryInvoiceInput
) {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const invoiceId = crypto.randomUUID();
  const createdAt = new Date();
  const purchasedAt = input.purchasedAt ? new Date(input.purchasedAt) : createdAt;
  const retailer = normalizeRequiredText(input.retailer, "retailer");
  const invoiceNumber = normalizeOptionalText(input.invoiceNumber);
  const currency = normalizeCurrency(input.currency);
  const client = await inventoryPool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO scanneraz_inventory_invoices (
          id, tenant_id, retailer, invoice_number, purchased_at, currency, notes, document_name, source_extraction_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        invoiceId,
        tenantId,
        retailer,
        invoiceNumber,
        purchasedAt.toISOString().slice(0, 10),
        currency,
        normalizeOptionalText(input.notes),
        normalizeOptionalText(input.documentName),
        normalizeOptionalText(input.sourceExtractionId),
        createdAt
      ]
    );

    const lines = await resolveInvoiceLinesFromMappings(client, tenantId, input.lines);

    for (const line of lines) {
      const product = await upsertProduct(client, tenantId, line, createdAt);
      await upsertInventoryAsinMapping(client, tenantId, line, createdAt);
      const lotId = crypto.randomUUID();
      const quantity = positiveInteger(line.quantity, "quantity");
      const unitCostCents = nonNegativeInteger(line.unitCostCents, "unitCostCents");

      await client.query(
        `
          INSERT INTO scanneraz_inventory_lots (
            id, tenant_id, invoice_id, product_id, condition, received_quantity, unit_cost_cents, currency, received_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          lotId,
          tenantId,
          invoiceId,
          product.id,
          line.condition,
          quantity,
          unitCostCents,
          currency,
          purchasedAt,
          createdAt
        ]
      );

      await insertMovement(client, {
        tenantId,
        productId: product.id,
        lotId,
        movementType: "purchase",
        quantityDelta: quantity,
        condition: line.condition,
        channel: retailer,
        reference: invoiceNumber,
        notes: normalizeOptionalText(input.notes),
        occurredAt: purchasedAt,
        createdAt
      });
    }

    await client.query("COMMIT");
    return { id: invoiceId, purchasedAt: purchasedAt.toISOString(), lineCount: lines.length };
  } catch (error) {
    await client.query("ROLLBACK");

    if (isUniqueViolation(error)) {
      throw new DuplicateInventoryInvoiceError();
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function resolveInventoryAsinMappings(tenantId: string, upcs: string[]) {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  return Array.from((await findInventoryAsinMappings(inventoryPool, tenantId, upcs)).values());
}

export async function saveInvoiceExtraction(
  tenantId: string,
  input: {
    sourceFilename: string;
    mimeType: string;
    sizeBytes: number;
    documentSha256: string;
    model: string;
    draft: ExtractedInvoiceDraft;
  }
): Promise<StoredInvoiceExtraction> {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const result = await inventoryPool.query<InvoiceExtractionRow>(
    `
      INSERT INTO scanneraz_inventory_invoice_extractions (
        id, tenant_id, source_filename, mime_type, size_bytes, document_sha256, model, status, draft_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_review', $8::jsonb, $9)
      ON CONFLICT (tenant_id, document_sha256) DO UPDATE
      SET source_filename = scanneraz_inventory_invoice_extractions.source_filename
      RETURNING
        id, source_filename, mime_type, size_bytes, document_sha256, model, status, draft_json,
        created_at, confirmed_at, invoice_id
    `,
    [
      id,
      tenantId,
      normalizeRequiredText(input.sourceFilename, "sourceFilename"),
      normalizeRequiredText(input.mimeType, "mimeType"),
      positiveInteger(input.sizeBytes, "sizeBytes"),
      normalizeRequiredText(input.documentSha256, "documentSha256"),
      normalizeRequiredText(input.model, "model"),
      JSON.stringify(input.draft),
      createdAt
    ]
  );

  return toStoredInvoiceExtraction(result.rows[0]!);
}

export async function findInvoiceExtractionByDocumentHash(
  tenantId: string,
  documentSha256: string
): Promise<StoredInvoiceExtraction | undefined> {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const result = await inventoryPool.query<InvoiceExtractionRow>(
    `
      SELECT
        id, source_filename, mime_type, size_bytes, document_sha256, model, status, draft_json,
        created_at, confirmed_at, invoice_id
      FROM scanneraz_inventory_invoice_extractions
      WHERE tenant_id = $1 AND document_sha256 = $2
      LIMIT 1
    `,
    [tenantId, normalizeRequiredText(documentSha256, "documentSha256")]
  );

  return result.rows[0] ? toStoredInvoiceExtraction(result.rows[0]) : undefined;
}

export async function confirmInvoiceExtraction(
  tenantId: string,
  input: { extractionId: string; invoice: CreateInventoryInvoiceInput }
) {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const claimed = await inventoryPool.query<{ id: string; source_filename: string }>(
    `
      UPDATE scanneraz_inventory_invoice_extractions
      SET status = 'processing'
      WHERE id = $1 AND tenant_id = $2 AND status = 'pending_review'
      RETURNING id, source_filename
    `,
    [input.extractionId, tenantId]
  );

  if (!claimed.rows[0]) {
    throw new InventoryExtractionNotFoundError();
  }

  try {
    const invoice = await createInventoryInvoice(tenantId, {
      ...input.invoice,
      documentName: input.invoice.documentName ?? claimed.rows[0].source_filename,
      sourceExtractionId: input.extractionId
    });
    const confirmedAt = new Date();
    const updated = await inventoryPool.query<InvoiceExtractionRow>(
      `
        UPDATE scanneraz_inventory_invoice_extractions
        SET status = 'confirmed', invoice_id = $3, confirmed_at = $4
        WHERE id = $1 AND tenant_id = $2 AND status = 'processing'
        RETURNING
          id, source_filename, mime_type, size_bytes, document_sha256, model, status, draft_json,
          created_at, confirmed_at, invoice_id
      `,
      [input.extractionId, tenantId, invoice.id, confirmedAt]
    );

    if (!updated.rows[0]) {
      throw new InventoryExtractionNotFoundError();
    }

    return { invoice, extraction: toStoredInvoiceExtraction(updated.rows[0]) };
  } catch (error) {
    await inventoryPool.query(
      `
        UPDATE scanneraz_inventory_invoice_extractions
        SET status = 'pending_review'
        WHERE id = $1 AND tenant_id = $2 AND status = 'processing'
      `,
      [input.extractionId, tenantId]
    );
    throw error;
  }
}

export async function recordInventorySale(tenantId: string, input: RecordInventorySaleInput) {
  return recordOutboundMovement(tenantId, {
    productId: input.productId,
    quantity: input.quantity,
    condition: input.condition,
    movementType: "sale",
    channel: normalizeOptionalText(input.channel) ?? "Amazon",
    reference: normalizeOptionalText(input.reference),
    notes: normalizeOptionalText(input.notes),
    occurredAt: parseOccurredAt(input.occurredAt)
  });
}

export async function recordAmazonCustomerReturn(
  tenantId: string,
  input: RecordAmazonCustomerReturnInput
) {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const quantity = positiveInteger(input.quantity, "quantity");
  const occurredAt = parseOccurredAt(input.occurredAt);
  const returnId = crypto.randomUUID();
  const createdAt = new Date();
  const isRestocked = input.disposition === "restock";
  const status: InventoryReturnStatus = input.disposition === "restock"
    ? "restocked"
    : input.disposition === "dispose"
      ? "disposed"
      : "received_pending";
  const client = await inventoryPool.connect();

  try {
    await client.query("BEGIN");
    await requireTenantProduct(client, tenantId, input.productId);
    await client.query(
      `
        INSERT INTO scanneraz_inventory_returns (
          id, tenant_id, product_id, return_type, status, retailer, quantity, condition, reference, notes,
          received_at, completed_at, created_at
        ) VALUES ($1, $2, $3, 'amazon_customer', $4, NULL, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        returnId,
        tenantId,
        input.productId,
        status,
        quantity,
        input.condition,
        normalizeOptionalText(input.reference),
        normalizeOptionalText(input.notes),
        occurredAt,
        status === "received_pending" ? null : createdAt,
        createdAt
      ]
    );

    if (isRestocked) {
      await insertMovement(client, {
        tenantId,
        productId: input.productId,
        movementType: "amazon_customer_return",
        quantityDelta: quantity,
        condition: input.condition,
        channel: "Amazon",
        reference: normalizeOptionalText(input.reference),
        notes: normalizeOptionalText(input.notes),
        occurredAt,
        createdAt
      });
    }

    await client.query("COMMIT");
    return { id: returnId, status };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordRetailerReturn(tenantId: string, input: RecordRetailerReturnInput) {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const quantity = positiveInteger(input.quantity, "quantity");
  const occurredAt = parseOccurredAt(input.occurredAt);
  const retailer = normalizeRequiredText(input.retailer, "retailer");
  const returnId = crypto.randomUUID();
  const createdAt = new Date();
  const client = await inventoryPool.connect();

  try {
    await client.query("BEGIN");
    await requireAvailableQuantity(client, tenantId, input.productId, quantity);
    await client.query(
      `
        INSERT INTO scanneraz_inventory_returns (
          id, tenant_id, product_id, return_type, status, retailer, quantity, condition, reference, notes,
          received_at, completed_at, created_at
        ) VALUES ($1, $2, $3, 'retailer', 'sent', $4, $5, $6, $7, $8, $9, NULL, $10)
      `,
      [
        returnId,
        tenantId,
        input.productId,
        retailer,
        quantity,
        input.condition,
        normalizeOptionalText(input.reference),
        normalizeOptionalText(input.notes),
        occurredAt,
        createdAt
      ]
    );
    await insertMovement(client, {
      tenantId,
      productId: input.productId,
      movementType: "retailer_return",
      quantityDelta: -quantity,
      condition: input.condition,
      channel: retailer,
      reference: normalizeOptionalText(input.reference),
      notes: normalizeOptionalText(input.notes),
      occurredAt,
      createdAt
    });
    await client.query("COMMIT");
    return { id: returnId, status: "sent" as const };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveInventoryReturn(tenantId: string, input: ResolveInventoryReturnInput) {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const client = await inventoryPool.connect();
  const createdAt = new Date();

  try {
    await client.query("BEGIN");
    const returnCase = await getOpenReturnCase(client, tenantId, input.returnId);

    if (!returnCase) {
      throw new InventoryReturnNotFoundError();
    }

    if (returnCase.return_type === "amazon_customer") {
      if (returnCase.status !== "received_pending" || !["restock", "dispose"].includes(input.disposition)) {
        throw new InvalidInventoryReturnResolutionError();
      }

      const nextStatus: InventoryReturnStatus = input.disposition === "restock" ? "restocked" : "disposed";
      const nextCondition = input.condition ?? returnCase.condition;

      if (input.disposition === "restock") {
        await insertMovement(client, {
          tenantId,
          productId: returnCase.product_id,
          movementType: "amazon_customer_return",
          quantityDelta: numberValue(returnCase.quantity),
          condition: nextCondition,
          channel: "Amazon",
          reference: undefined,
          notes: normalizeOptionalText(input.notes),
          occurredAt: createdAt,
          createdAt
        });
      }

      await client.query(
        `
          UPDATE scanneraz_inventory_returns
          SET status = $3, condition = $4, notes = COALESCE($5, notes), completed_at = $6
          WHERE id = $1 AND tenant_id = $2
        `,
        [input.returnId, tenantId, nextStatus, nextCondition, normalizeOptionalText(input.notes), createdAt]
      );
    } else {
      if (returnCase.status !== "sent" || !["refund", "return_to_stock"].includes(input.disposition)) {
        throw new InvalidInventoryReturnResolutionError();
      }

      const nextStatus: InventoryReturnStatus = input.disposition === "refund" ? "refunded" : "returned_to_stock";
      const nextCondition = input.condition ?? returnCase.condition;

      if (input.disposition === "return_to_stock") {
        await insertMovement(client, {
          tenantId,
          productId: returnCase.product_id,
          movementType: "retailer_return_rejected",
          quantityDelta: numberValue(returnCase.quantity),
          condition: nextCondition,
          channel: "Retailer",
          reference: undefined,
          notes: normalizeOptionalText(input.notes),
          occurredAt: createdAt,
          createdAt
        });
      }

      await client.query(
        `
          UPDATE scanneraz_inventory_returns
          SET status = $3, condition = $4, notes = COALESCE($5, notes), completed_at = $6
          WHERE id = $1 AND tenant_id = $2
        `,
        [input.returnId, tenantId, nextStatus, nextCondition, normalizeOptionalText(input.notes), createdAt]
      );
    }

    await client.query("COMMIT");
    return { id: input.returnId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type AmazonSalesSyncWork = {
  connectionId: string;
  paginationToken?: string;
  lastUpdatedAfter: string;
  startedAt: string;
};

/**
 * Claim a single tenant connection for an Amazon sales sync. A continuing page
 * uses Amazon's short-lived pagination token; a fresh run overlaps the prior
 * high-water mark by five minutes so late status changes are re-read safely.
 */
export async function beginAmazonSalesSync(
  tenantId: string,
  connectionId: string,
  initialLastUpdatedAfter: string
): Promise<AmazonSalesSyncWork> {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const client = await inventoryPool.connect();
  const now = new Date();
  const requestedAfter = parseOccurredAt(initialLastUpdatedAfter);

  try {
    await client.query("BEGIN");
    // Ensure the row exists before locking it. This closes the race where two
    // first-time sync requests both observed an absent state row.
    await client.query(
      `
        INSERT INTO scanneraz_inventory_amazon_sale_syncs (tenant_id, connection_id, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, connection_id) DO NOTHING
      `,
      [tenantId, connectionId, now]
    );
    const currentResult = await client.query<AmazonSalesSyncRow>(
      `
        SELECT connection_id, pagination_token, window_started_at, window_after, last_synced_at, sync_started_at, last_error
        FROM scanneraz_inventory_amazon_sale_syncs
        WHERE tenant_id = $1 AND connection_id = $2
        FOR UPDATE
      `,
      [tenantId, connectionId]
    );
    const current = currentResult.rows[0];
    const activeAt = current?.sync_started_at;

    if (activeAt && new Date(activeAt).getTime() > now.getTime() - 10 * 60 * 1000) {
      throw new AmazonSalesSyncInProgressError();
    }

    const pendingToken = current?.pagination_token ?? undefined;
    const pendingStartedAt = current?.window_started_at ? new Date(current.window_started_at) : undefined;
    const pendingAfter = current?.window_after ? new Date(current.window_after) : undefined;
    const canContinue = Boolean(
      pendingToken &&
      pendingStartedAt &&
      pendingAfter &&
      pendingStartedAt.getTime() > now.getTime() - 23 * 60 * 60 * 1000
    );
    const priorSyncedAt = current?.last_synced_at ? new Date(current.last_synced_at) : undefined;
    const lastUpdatedAfter = canContinue
      ? pendingAfter!
      : new Date(Math.max(
        requestedAfter.getTime(),
        (priorSyncedAt ? priorSyncedAt.getTime() - 5 * 60 * 1000 : requestedAfter.getTime())
      ));
    const startedAt = canContinue ? pendingStartedAt! : now;

    await client.query(
      `
        INSERT INTO scanneraz_inventory_amazon_sale_syncs (
          tenant_id, connection_id, pagination_token, window_started_at, window_after, sync_started_at, last_error, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $6)
        ON CONFLICT (tenant_id, connection_id) DO UPDATE SET
          pagination_token = EXCLUDED.pagination_token,
          window_started_at = EXCLUDED.window_started_at,
          window_after = EXCLUDED.window_after,
          sync_started_at = EXCLUDED.sync_started_at,
          last_error = NULL,
          updated_at = EXCLUDED.updated_at
      `,
      [
        tenantId,
        connectionId,
        canContinue ? pendingToken ?? null : null,
        startedAt,
        lastUpdatedAfter,
        now
      ]
    );
    await client.query("COMMIT");

    return {
      connectionId,
      paginationToken: canContinue ? pendingToken : undefined,
      lastUpdatedAfter: lastUpdatedAfter.toISOString(),
      startedAt: startedAt.toISOString()
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeAmazonSalesSync(
  tenantId: string,
  work: AmazonSalesSyncWork,
  nextPageToken?: string
) {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const completed = !nextPageToken;
  const now = new Date();

  await inventoryPool.query(
    `
      UPDATE scanneraz_inventory_amazon_sale_syncs
      SET
        pagination_token = $3,
        last_synced_at = CASE WHEN $4 THEN $5 ELSE last_synced_at END,
        window_started_at = CASE WHEN $4 THEN NULL ELSE window_started_at END,
        window_after = CASE WHEN $4 THEN NULL ELSE window_after END,
        sync_started_at = NULL,
        last_error = NULL,
        updated_at = $6
      WHERE tenant_id = $1 AND connection_id = $2
    `,
    [tenantId, work.connectionId, nextPageToken ?? null, completed, now, now]
  );

  return {
    connectionId: work.connectionId,
    lastSyncedAt: completed ? now.toISOString() : undefined,
    hasMore: !completed
  } satisfies AmazonSalesSyncState;
}

export async function failAmazonSalesSync(tenantId: string, connectionId: string) {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  await inventoryPool.query(
    `
      UPDATE scanneraz_inventory_amazon_sale_syncs
      SET sync_started_at = NULL, last_error = 'La sincronizacion de Amazon no termino. Intenta de nuevo.', updated_at = $3
      WHERE tenant_id = $1 AND connection_id = $2
    `,
    [tenantId, connectionId, new Date()]
  );
}

export async function getAmazonSalesSyncState(
  tenantId: string,
  connectionId: string
): Promise<AmazonSalesSyncState> {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const result = await inventoryPool.query<AmazonSalesSyncRow>(
    `
      SELECT connection_id, pagination_token, window_started_at, window_after, last_synced_at, last_error
      FROM scanneraz_inventory_amazon_sale_syncs
      WHERE tenant_id = $1 AND connection_id = $2
      LIMIT 1
    `,
    [tenantId, connectionId]
  );
  const row = result.rows[0];

  return {
    connectionId,
    lastSyncedAt: row?.last_synced_at ? new Date(row.last_synced_at).toISOString() : undefined,
    hasMore: Boolean(row?.pagination_token),
    lastError: row?.last_error ?? undefined
  };
}

/**
 * Reconcile an already-normalized Orders API page against invoice-backed stock.
 * Only operational seller data is persisted. An unmatched SKU/ASIN or a stock
 * shortfall is retained as a reconciliation item rather than generating a
 * hidden negative balance.
 */
export async function importAmazonSalesLines(
  tenantId: string,
  connectionId: string,
  lines: AmazonInventorySalesLine[]
): Promise<AmazonSalesImportResult> {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const client = await inventoryPool.connect();
  const result: AmazonSalesImportResult = {
    processedLines: 0,
    appliedLines: 0,
    appliedUnits: 0,
    reversedUnits: 0,
    unmatchedLines: 0,
    insufficientLines: 0,
    notFulfilledLines: 0
  };

  try {
    await client.query("BEGIN");

    for (const line of lines) {
      const outcome = await reconcileAmazonSalesLine(client, tenantId, connectionId, line);
      result.processedLines += 1;
      result.appliedUnits += outcome.appliedUnits;
      result.reversedUnits += outcome.reversedUnits;

      if (outcome.status === "applied") {
        result.appliedLines += 1;
      } else if (outcome.status === "unmatched_product") {
        result.unmatchedLines += 1;
      } else if (outcome.status === "insufficient_stock") {
        result.insufficientLines += 1;
      } else {
        result.notFulfilledLines += 1;
      }
    }

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function reconcileAmazonSalesLine(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  connectionId: string,
  rawLine: AmazonInventorySalesLine
) {
  const line = normalizeAmazonSalesLine(rawLine);
  const now = new Date();
  const occurredAt = new Date(line.lastUpdatedAt ?? line.createdAt ?? now);
  const source = await upsertAmazonSalesLine(client, tenantId, connectionId, line, now);
  const desiredQuantity = line.quantityFulfilled;
  const matchedProduct = desiredQuantity > 0
    ? await findInventoryProductForAmazonLine(client, tenantId, line)
    : undefined;
  let appliedQuantity = numberValue(source.applied_quantity);
  let reversedUnits = 0;

  // A SKU may have been corrected in Seller Central since a prior import. Undo
  // its old allocation before applying the line to a different inventory item.
  if (source.product_id && source.product_id !== matchedProduct?.id && appliedQuantity > 0) {
    reversedUnits += await reverseAmazonSalesAllocations(client, {
      tenantId,
      productId: source.product_id,
      sourceId: source.id,
      quantity: appliedQuantity,
      reference: line.orderId,
      occurredAt,
      createdAt: now
    });
    appliedQuantity = 0;
  }

  if (desiredQuantity === 0) {
    if (source.product_id && source.product_id === matchedProduct?.id && appliedQuantity > 0) {
      reversedUnits += await reverseAmazonSalesAllocations(client, {
        tenantId,
        productId: source.product_id,
        sourceId: source.id,
        quantity: appliedQuantity,
        reference: line.orderId,
        occurredAt: line.lastUpdatedAt ?? line.createdAt ?? now,
        createdAt: now
      });
      appliedQuantity = 0;
    }

    await updateAmazonSalesLine(client, {
      id: source.id,
      tenantId,
      productId: matchedProduct?.id,
      appliedQuantity,
      status: "not_fulfilled"
    });

    return { status: "not_fulfilled" as const, appliedUnits: 0, reversedUnits };
  }

  if (!matchedProduct) {
    await updateAmazonSalesLine(client, {
      id: source.id,
      tenantId,
      productId: undefined,
      appliedQuantity: 0,
      status: "unmatched_product",
      lastError: "No existe una factura con SKU o ASIN coincidente para esta venta de Amazon."
    });

    return { status: "unmatched_product" as const, appliedUnits: 0, reversedUnits };
  }

  if (source.product_id === matchedProduct.id && appliedQuantity > desiredQuantity) {
    const quantityToReverse = appliedQuantity - desiredQuantity;
    const reversed = await reverseAmazonSalesAllocations(client, {
      tenantId,
      productId: matchedProduct.id,
      sourceId: source.id,
      quantity: quantityToReverse,
      reference: line.orderId,
      occurredAt: line.lastUpdatedAt ?? line.createdAt ?? now,
      createdAt: now
    });
    reversedUnits += reversed;
    appliedQuantity -= reversed;
  }

  const quantityToApply = Math.max(0, desiredQuantity - appliedQuantity);
  const availableQuantity = quantityToApply > 0
    ? await availableInventoryQuantity(client, tenantId, matchedProduct.id)
    : 0;
  const allocationQuantity = Math.min(quantityToApply, Math.max(0, availableQuantity));

  if (allocationQuantity > 0) {
    await allocateOutboundMovements(client, {
      tenantId,
      productId: matchedProduct.id,
      movementType: "sale",
      quantity: allocationQuantity,
      condition: line.condition,
      channel: line.fulfilledBy === "AMAZON" ? "Amazon FBA" : "Amazon FBM",
      reference: line.orderId,
      notes: "Sincronizado desde Amazon Orders API",
      sourceType: "amazon_order_item",
      sourceId: source.id,
      occurredAt,
      createdAt: now
    });
    appliedQuantity += allocationQuantity;
  }

  const status: AmazonSaleSyncStatus = appliedQuantity >= desiredQuantity
    ? "applied"
    : "insufficient_stock";
  await updateAmazonSalesLine(client, {
    id: source.id,
    tenantId,
    productId: matchedProduct.id,
    appliedQuantity,
    status,
    lastError: status === "insufficient_stock"
      ? "La factura registrada no cubre todas las unidades vendidas."
      : undefined
  });

  return { status, appliedUnits: allocationQuantity, reversedUnits };
}

function normalizeAmazonSalesLine(input: AmazonInventorySalesLine) {
  const orderId = normalizeRequiredText(input.orderId, "amazon order id").slice(0, 200);
  const orderItemId = normalizeRequiredText(input.orderItemId, "amazon order item id").slice(0, 200);
  const quantityOrdered = positiveInteger(Math.floor(input.quantityOrdered), "quantityOrdered");
  const quantityFulfilled = Math.min(
    quantityOrdered,
    Math.max(0, Number.isFinite(input.quantityFulfilled) ? Math.floor(input.quantityFulfilled) : 0)
  );
  const createdAt = safeAmazonDate(input.createdAt);
  const lastUpdatedAt = safeAmazonDate(input.lastUpdatedAt);

  return {
    orderId,
    orderItemId,
    sellerSku: normalizeCode(input.sellerSku)?.slice(0, 200),
    asin: normalizeCode(input.asin)?.slice(0, 40),
    title: normalizeOptionalText(input.title)?.slice(0, 500),
    condition: inventoryConditionFromAmazon(input.conditionType),
    quantityOrdered,
    quantityFulfilled,
    fulfillmentStatus: normalizeOptionalText(input.fulfillmentStatus)?.toUpperCase().slice(0, 80),
    fulfilledBy: normalizeOptionalText(input.fulfilledBy)?.toUpperCase().slice(0, 40),
    createdAt,
    lastUpdatedAt
  };
}

async function upsertAmazonSalesLine(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  connectionId: string,
  line: ReturnType<typeof normalizeAmazonSalesLine>,
  now: Date
) {
  const result = await client.query<AmazonSaleLineRow>(
    `
      INSERT INTO scanneraz_inventory_amazon_order_lines (
        id, tenant_id, connection_id, amazon_order_id, amazon_order_item_id, seller_sku, asin, title,
        condition, quantity_ordered, desired_quantity, fulfillment_status, fulfilled_by,
        order_created_at, order_last_updated_at, sync_status, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17
      )
      ON CONFLICT (tenant_id, connection_id, amazon_order_id, amazon_order_item_id) DO UPDATE SET
        seller_sku = EXCLUDED.seller_sku,
        asin = EXCLUDED.asin,
        title = EXCLUDED.title,
        condition = EXCLUDED.condition,
        quantity_ordered = EXCLUDED.quantity_ordered,
        desired_quantity = EXCLUDED.desired_quantity,
        fulfillment_status = EXCLUDED.fulfillment_status,
        fulfilled_by = EXCLUDED.fulfilled_by,
        order_created_at = EXCLUDED.order_created_at,
        order_last_updated_at = EXCLUDED.order_last_updated_at,
        updated_at = EXCLUDED.updated_at
      RETURNING id, product_id, applied_quantity, desired_quantity, sync_status
    `,
    [
      crypto.randomUUID(),
      tenantId,
      connectionId,
      line.orderId,
      line.orderItemId,
      line.sellerSku ?? null,
      line.asin ?? null,
      line.title ?? null,
      line.condition,
      line.quantityOrdered,
      line.quantityFulfilled,
      line.fulfillmentStatus ?? null,
      line.fulfilledBy ?? null,
      line.createdAt ?? null,
      line.lastUpdatedAt ?? null,
      line.quantityFulfilled === 0 ? "not_fulfilled" : "unmatched_product",
      now
    ]
  );

  return result.rows[0]!;
}

async function updateAmazonSalesLine(
  client: Pick<PoolClient, "query">,
  input: {
    id: string;
    tenantId: string;
    productId?: string;
    appliedQuantity: number;
    status: AmazonSaleSyncStatus;
    lastError?: string;
  }
) {
  await client.query(
    `
      UPDATE scanneraz_inventory_amazon_order_lines
      SET product_id = $3, applied_quantity = $4, sync_status = $5, last_error = $6, updated_at = $7
      WHERE id = $1 AND tenant_id = $2
    `,
    [
      input.id,
      input.tenantId,
      input.productId ?? null,
      input.appliedQuantity,
      input.status,
      input.lastError ?? null,
      new Date()
    ]
  );
}

async function findInventoryProductForAmazonLine(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  line: ReturnType<typeof normalizeAmazonSalesLine>
) {
  if (!line.sellerSku && !line.asin) {
    return undefined;
  }

  const result = await client.query<InventoryProductMatchRow>(
    `
      SELECT id, title
      FROM scanneraz_inventory_products
      WHERE tenant_id = $1 AND (
        ($2::text IS NOT NULL AND UPPER(REPLACE(COALESCE(sku, ''), ' ', '')) = $2)
        OR ($3::text IS NOT NULL AND UPPER(REPLACE(COALESCE(asin, ''), ' ', '')) = $3)
      )
      ORDER BY
        CASE WHEN $2::text IS NOT NULL AND UPPER(REPLACE(COALESCE(sku, ''), ' ', '')) = $2 THEN 0 ELSE 1 END,
        CASE WHEN $3::text IS NOT NULL AND UPPER(REPLACE(COALESCE(asin, ''), ' ', '')) = $3 THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [tenantId, line.sellerSku ?? null, line.asin ?? null]
  );

  return result.rows[0];
}

async function reverseAmazonSalesAllocations(
  client: Pick<PoolClient, "query">,
  input: {
    tenantId: string;
    productId: string;
    sourceId: string;
    quantity: number;
    reference: string;
    occurredAt: string | Date;
    createdAt: Date;
  }
) {
  const result = await client.query<InventorySourceAllocationRow>(
    `
      SELECT lot_id, MIN(condition) AS condition, -SUM(quantity_delta) AS applied_quantity
      FROM scanneraz_inventory_movements
      WHERE tenant_id = $1 AND product_id = $2 AND source_type = 'amazon_order_item' AND source_id = $3
      GROUP BY lot_id
      HAVING SUM(quantity_delta) < 0
      ORDER BY lot_id NULLS LAST
    `,
    [input.tenantId, input.productId, input.sourceId]
  );
  let remaining = input.quantity;
  let reversed = 0;

  for (const allocation of result.rows) {
    const quantity = Math.min(remaining, numberValue(allocation.applied_quantity));

    if (quantity <= 0) {
      continue;
    }

    await insertMovement(client, {
      tenantId: input.tenantId,
      productId: input.productId,
      lotId: allocation.lot_id ?? undefined,
      movementType: "amazon_sale_reversal",
      quantityDelta: quantity,
      condition: allocation.condition,
      channel: "Amazon",
      reference: input.reference,
      notes: "Correccion de estado desde Amazon Orders API",
      sourceType: "amazon_order_item",
      sourceId: input.sourceId,
      occurredAt: input.occurredAt instanceof Date ? input.occurredAt : new Date(input.occurredAt),
      createdAt: input.createdAt
    });
    remaining -= quantity;
    reversed += quantity;
  }

  if (remaining > 0) {
    throw new Error("Amazon sale ledger allocation is inconsistent.");
  }

  return reversed;
}

function inventoryConditionFromAmazon(value?: string): InventoryCondition {
  const condition = value?.trim().toUpperCase() ?? "";

  if (condition.includes("ACCEPTABLE")) {
    return "used_acceptable";
  }

  if (condition.includes("GOOD")) {
    return "used_good";
  }

  if (condition.includes("USED") || condition.includes("LIKE_NEW") || condition.includes("REFURBISHED")) {
    return "used_like_new";
  }

  return "new";
}

function safeAmazonDate(value?: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export async function getInventoryOverview(tenantId: string): Promise<InventoryOverview> {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const [productResult, activityResult, returnResult, reconciliationResult] = await Promise.all([
    inventoryPool.query<ProductRow>(
      `
        WITH movement_summary AS (
          SELECT
            product_id,
            SUM(quantity_delta) AS available_quantity,
            SUM(CASE WHEN movement_type = 'purchase' THEN quantity_delta ELSE 0 END) AS received_quantity,
            SUM(CASE WHEN movement_type IN ('sale', 'amazon_sale_reversal') THEN -quantity_delta ELSE 0 END) AS sold_quantity,
            SUM(CASE WHEN movement_type = 'amazon_customer_return' THEN quantity_delta ELSE 0 END) AS customer_return_quantity,
            SUM(CASE WHEN movement_type = 'retailer_return' THEN -quantity_delta ELSE 0 END) AS retailer_return_quantity,
            MAX(occurred_at) AS last_activity_at
          FROM scanneraz_inventory_movements
          WHERE tenant_id = $1
          GROUP BY product_id
        ),
        lot_cost AS (
          SELECT
            product_id,
            ROUND(SUM(received_quantity * unit_cost_cents)::numeric / NULLIF(SUM(received_quantity), 0))::integer
              AS average_unit_cost_cents
          FROM scanneraz_inventory_lots
          WHERE tenant_id = $1
          GROUP BY product_id
        )
        SELECT
          products.id,
          products.sku,
          products.asin,
          products.upc,
          products.title,
          products.image_url,
          movement_summary.available_quantity,
          movement_summary.received_quantity,
          movement_summary.sold_quantity,
          movement_summary.customer_return_quantity,
          movement_summary.retailer_return_quantity,
          lot_cost.average_unit_cost_cents,
          movement_summary.last_activity_at
        FROM scanneraz_inventory_products AS products
        LEFT JOIN movement_summary ON movement_summary.product_id = products.id
        LEFT JOIN lot_cost ON lot_cost.product_id = products.id
        WHERE products.tenant_id = $1
        ORDER BY movement_summary.last_activity_at DESC NULLS LAST, products.updated_at DESC
        LIMIT 200
      `,
      [tenantId]
    ),
    inventoryPool.query<ActivityRow>(
      `
        SELECT
          movements.id,
          movements.product_id,
          products.title AS product_title,
          movements.movement_type,
          movements.quantity_delta,
          movements.condition,
          movements.channel,
          movements.reference,
          movements.notes,
          movements.occurred_at
        FROM scanneraz_inventory_movements AS movements
        JOIN scanneraz_inventory_products AS products ON products.id = movements.product_id
        WHERE movements.tenant_id = $1
        ORDER BY movements.occurred_at DESC, movements.created_at DESC
        LIMIT 20
      `,
      [tenantId]
    ),
    inventoryPool.query<ReturnRow>(
      `
        SELECT
          returns.id,
          returns.product_id,
          products.title AS product_title,
          returns.return_type,
          returns.status,
          returns.retailer,
          returns.quantity,
          returns.condition,
          returns.reference,
          returns.notes,
          returns.received_at,
          returns.completed_at
        FROM scanneraz_inventory_returns AS returns
        JOIN scanneraz_inventory_products AS products ON products.id = returns.product_id
        WHERE returns.tenant_id = $1
        ORDER BY returns.completed_at NULLS FIRST, returns.received_at DESC
        LIMIT 40
      `,
      [tenantId]
    ),
    inventoryPool.query<AmazonSalesReconciliationRow>(
      `
        SELECT
          COUNT(lines.id) FILTER (WHERE lines.sync_status = 'unmatched_product') AS unmatched_lines,
          COUNT(lines.id) FILTER (WHERE lines.sync_status = 'insufficient_stock') AS insufficient_lines,
          MAX(syncs.last_synced_at) AS last_synced_at
        FROM scanneraz_inventory_amazon_sale_syncs AS syncs
        LEFT JOIN scanneraz_inventory_amazon_order_lines AS lines
          ON lines.tenant_id = syncs.tenant_id AND lines.connection_id = syncs.connection_id
        WHERE syncs.tenant_id = $1
      `,
      [tenantId]
    )
  ]);

  const products = productResult.rows.map((row) => {
    const availableQuantity = numberValue(row.available_quantity);
    const averageUnitCostCents = nullableNumberValue(row.average_unit_cost_cents);

    return {
      id: row.id,
      sku: row.sku ?? undefined,
      asin: row.asin ?? undefined,
      upc: row.upc ?? undefined,
      title: row.title,
      imageUrl: row.image_url ?? undefined,
      availableQuantity,
      receivedQuantity: numberValue(row.received_quantity),
      soldQuantity: numberValue(row.sold_quantity),
      customerReturnQuantity: numberValue(row.customer_return_quantity),
      retailerReturnQuantity: numberValue(row.retailer_return_quantity),
      averageUnitCostCents,
      inventoryValueCents: averageUnitCostCents === undefined ? 0 : Math.max(availableQuantity, 0) * averageUnitCostCents,
      lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : undefined
    } satisfies InventoryProduct;
  });
  const returns = returnResult.rows.map(toInventoryReturnCase);
  const reconciliation = reconciliationResult.rows[0];

  return {
    summary: {
      productCount: products.length,
      availableUnits: products.reduce((total, product) => total + product.availableQuantity, 0),
      inventoryValueCents: products.reduce((total, product) => total + product.inventoryValueCents, 0),
      soldUnits: products.reduce((total, product) => total + product.soldQuantity, 0),
      customerReturnUnits: products.reduce((total, product) => total + product.customerReturnQuantity, 0),
      retailerReturnUnits: products.reduce((total, product) => total + product.retailerReturnQuantity, 0),
      pendingReturns: returns.filter((returnCase) =>
        returnCase.status === "received_pending" || returnCase.status === "sent"
      ).length,
      unmatchedAmazonOrderLines: numberValue(reconciliation?.unmatched_lines),
      insufficientAmazonOrderLines: numberValue(reconciliation?.insufficient_lines),
      lastAmazonSalesSyncAt: reconciliation?.last_synced_at
        ? new Date(reconciliation.last_synced_at).toISOString()
        : undefined
    },
    products,
    recentActivity: activityResult.rows.map(toInventoryActivity),
    returns
  };
}

export function inventoryProductKey(input: Pick<InventoryInvoiceLineInput, "title" | "sku" | "asin" | "upc">) {
  const sku = normalizeCode(input.sku);
  const asin = normalizeCode(input.asin);
  const upc = normalizeInventoryUpc(input.upc) ?? normalizeCode(input.upc);

  if (sku) {
    return `sku:${sku}`;
  }

  if (asin) {
    return `asin:${asin}`;
  }

  if (upc) {
    return `upc:${upc}`;
  }

  return `title:${normalizeRequiredText(input.title, "title").toLowerCase().replace(/\s+/g, " ")}`;
}

async function recordOutboundMovement(
  tenantId: string,
  input: {
    productId: string;
    quantity: number;
    condition: InventoryCondition;
    movementType: "sale";
    channel?: string;
    reference?: string;
    notes?: string;
    sourceType?: string;
    sourceId?: string;
    occurredAt: Date;
  }
) {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const quantity = positiveInteger(input.quantity, "quantity");
  const client = await inventoryPool.connect();
  const createdAt = new Date();

  try {
    await client.query("BEGIN");
    await requireAvailableQuantity(client, tenantId, input.productId, quantity);
    const activities = await allocateOutboundMovements(client, {
      tenantId,
      productId: input.productId,
      movementType: input.movementType,
      quantity,
      condition: input.condition,
      channel: input.channel,
      reference: input.reference,
      notes: input.notes,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      occurredAt: input.occurredAt,
      createdAt
    });
    await client.query("COMMIT");
    return activities[0] ?? { id: crypto.randomUUID() };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resolveInvoiceLinesFromMappings(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  lines: InventoryInvoiceLineInput[]
) {
  const mappings = await findInventoryAsinMappings(
    client,
    tenantId,
    lines.map((line) => line.upc ?? "")
  );

  return lines.map((line) => {
    if (normalizeAmazonAsin(line.asin)) {
      return line;
    }

    const upc = normalizeInventoryUpc(line.upc);
    const mapping = upc ? mappings.get(upc) : undefined;

    if (!mapping) {
      return line;
    }

    return {
      ...line,
      asin: mapping.asin,
      imageUrl: line.imageUrl ?? mapping.imageUrl
    };
  });
}

async function findInventoryAsinMappings(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  values: string[]
) {
  const upcs = Array.from(new Set(values
    .map((value) => normalizeInventoryUpc(value))
    .filter((value): value is string => Boolean(value))));

  if (!upcs.length) {
    return new Map<string, InventoryAsinMapping>();
  }

  const result = await client.query<AsinMappingRow>(
    `
      SELECT upc, asin, seller_sku, title, image_url
      FROM scanneraz_inventory_asin_mappings
      WHERE tenant_id = $1 AND upc = ANY($2::text[])
    `,
    [tenantId, upcs]
  );

  return new Map(result.rows.map((row) => [
    row.upc,
    {
      upc: row.upc,
      asin: row.asin,
      sku: row.seller_sku ?? undefined,
      title: row.title ?? undefined,
      imageUrl: row.image_url ?? undefined,
      source: "saved_mapping" as const
    }
  ]));
}

async function upsertInventoryAsinMapping(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  line: InventoryInvoiceLineInput,
  now: Date
) {
  const upc = normalizeInventoryUpc(line.upc);
  const asin = normalizeAmazonAsin(line.asin);

  if (!upc || !asin) {
    return;
  }

  await client.query(
    `
      INSERT INTO scanneraz_inventory_asin_mappings (
        tenant_id, upc, asin, seller_sku, title, image_url, source, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'invoice', $7, $7)
      ON CONFLICT (tenant_id, upc) DO UPDATE SET
        asin = EXCLUDED.asin,
        seller_sku = COALESCE(EXCLUDED.seller_sku, scanneraz_inventory_asin_mappings.seller_sku),
        title = EXCLUDED.title,
        image_url = COALESCE(EXCLUDED.image_url, scanneraz_inventory_asin_mappings.image_url),
        source = 'invoice',
        updated_at = EXCLUDED.updated_at
    `,
    [
      tenantId,
      upc,
      asin,
      normalizeCode(line.sku),
      normalizeOptionalText(line.title),
      normalizeOptionalText(line.imageUrl),
      now
    ]
  );
}

async function upsertProduct(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  line: InventoryInvoiceLineInput,
  now: Date
) {
  const title = normalizeRequiredText(line.title, "title");
  const productKey = inventoryProductKey(line);
  const sku = normalizeCode(line.sku);
  const asin = normalizeAmazonAsin(line.asin) ?? normalizeCode(line.asin);
  const upc = normalizeInventoryUpc(line.upc) ?? normalizeCode(line.upc);
  const existing = await client.query<TenantProductRow>(
    `
      SELECT id, title
      FROM scanneraz_inventory_products
      WHERE tenant_id = $1 AND (
        product_key = $2
        OR ($3::text IS NOT NULL AND UPPER(REPLACE(COALESCE(sku, ''), ' ', '')) = $3)
        OR ($4::text IS NOT NULL AND UPPER(REPLACE(COALESCE(asin, ''), ' ', '')) = $4)
        OR ($5::text IS NOT NULL AND regexp_replace(COALESCE(upc, ''), '[^0-9]', '', 'g') = $5)
      )
      ORDER BY
        CASE WHEN product_key = $2 THEN 0 ELSE 1 END,
        CASE WHEN $4::text IS NOT NULL AND UPPER(REPLACE(COALESCE(asin, ''), ' ', '')) = $4 THEN 0 ELSE 1 END,
        CASE WHEN $5::text IS NOT NULL AND regexp_replace(COALESCE(upc, ''), '[^0-9]', '', 'g') = $5 THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [tenantId, productKey, sku ?? null, asin ?? null, upc ?? null]
  );

  if (existing.rows[0]) {
    const updated = await client.query<TenantProductRow>(
      `
        UPDATE scanneraz_inventory_products
        SET
          sku = COALESCE($2, sku),
          asin = COALESCE($3, asin),
          upc = COALESCE($4, upc),
          title = $5,
          image_url = COALESCE($6, image_url),
          updated_at = $7
        WHERE id = $1 AND tenant_id = $8
        RETURNING id, title
      `,
      [
        existing.rows[0].id,
        sku ?? null,
        asin ?? null,
        upc ?? null,
        title,
        normalizeOptionalText(line.imageUrl),
        now,
        tenantId
      ]
    );
    return updated.rows[0]!;
  }

  const result = await client.query<TenantProductRow>(
    `
      INSERT INTO scanneraz_inventory_products (
        id, tenant_id, product_key, sku, asin, upc, title, image_url, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
      ON CONFLICT (tenant_id, product_key) DO UPDATE SET
        sku = COALESCE(EXCLUDED.sku, scanneraz_inventory_products.sku),
        asin = COALESCE(EXCLUDED.asin, scanneraz_inventory_products.asin),
        upc = COALESCE(EXCLUDED.upc, scanneraz_inventory_products.upc),
        title = EXCLUDED.title,
        image_url = COALESCE(EXCLUDED.image_url, scanneraz_inventory_products.image_url),
        updated_at = EXCLUDED.updated_at
      RETURNING id, title
    `,
    [
      crypto.randomUUID(),
      tenantId,
      productKey,
      sku,
      asin,
      upc,
      title,
      normalizeOptionalText(line.imageUrl),
      now
    ]
  );

  return result.rows[0]!;
}

async function requireTenantProduct(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  productId: string
) {
  const result = await client.query<TenantProductRow>(
    `
      SELECT id, title
      FROM scanneraz_inventory_products
      WHERE id = $1 AND tenant_id = $2
      FOR UPDATE
    `,
    [productId, tenantId]
  );
  const product = result.rows[0];

  if (!product) {
    throw new InventoryProductNotFoundError();
  }

  return product;
}

async function requireAvailableQuantity(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  productId: string,
  requestedQuantity: number
) {
  await requireTenantProduct(client, tenantId, productId);
  const result = await client.query<{ available_quantity: string | number | null }>(
    `
      SELECT COALESCE(SUM(quantity_delta), 0) AS available_quantity
      FROM scanneraz_inventory_movements
      WHERE tenant_id = $1 AND product_id = $2
    `,
    [tenantId, productId]
  );

  if (numberValue(result.rows[0]?.available_quantity) < requestedQuantity) {
    throw new InsufficientInventoryError();
  }
}

async function availableInventoryQuantity(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  productId: string
) {
  const result = await client.query<{ available_quantity: string | number | null }>(
    `
      SELECT COALESCE(SUM(quantity_delta), 0) AS available_quantity
      FROM scanneraz_inventory_movements
      WHERE tenant_id = $1 AND product_id = $2
    `,
    [tenantId, productId]
  );

  return numberValue(result.rows[0]?.available_quantity);
}

/**
 * Split every outbound movement across purchase lots, oldest first. Older
 * manual movements did not have a lot ID, so their net quantity is consumed
 * from the same FIFO sequence before allocating a new sale. This keeps total
 * stock exact while progressively improving lot-level traceability.
 */
async function allocateOutboundMovements(
  client: Pick<PoolClient, "query">,
  input: {
    tenantId: string;
    productId: string;
    movementType: "sale";
    quantity: number;
    condition: InventoryCondition;
    channel?: string;
    reference?: string;
    notes?: string;
    sourceType?: string;
    sourceId?: string;
    occurredAt: Date;
    createdAt: Date;
  }
) {
  const [lotResult, unallocatedResult] = await Promise.all([
    client.query<InventoryLotAvailabilityRow>(
      `
        SELECT
          lots.id,
          lots.condition,
          COALESCE(SUM(movements.quantity_delta), 0) AS available_quantity
        FROM scanneraz_inventory_lots AS lots
        LEFT JOIN scanneraz_inventory_movements AS movements ON movements.lot_id = lots.id
        WHERE lots.tenant_id = $1 AND lots.product_id = $2
        GROUP BY lots.id, lots.condition, lots.received_at, lots.created_at
        ORDER BY lots.received_at ASC, lots.created_at ASC, lots.id ASC
      `,
      [input.tenantId, input.productId]
    ),
    client.query<{ unallocated_quantity: string | number | null }>(
      `
        SELECT COALESCE(SUM(quantity_delta), 0) AS unallocated_quantity
        FROM scanneraz_inventory_movements
        WHERE tenant_id = $1 AND product_id = $2 AND lot_id IS NULL
      `,
      [input.tenantId, input.productId]
    )
  ]);
  let remaining = input.quantity;
  let legacyUnallocatedOutbound = Math.max(0, -numberValue(unallocatedResult.rows[0]?.unallocated_quantity));
  const activities: Array<{ id: string }> = [];

  for (const lot of lotResult.rows) {
    const available = Math.max(0, numberValue(lot.available_quantity));
    const consumedByLegacyMovement = Math.min(available, legacyUnallocatedOutbound);
    legacyUnallocatedOutbound -= consumedByLegacyMovement;
    const allocatable = available - consumedByLegacyMovement;
    const allocation = Math.min(remaining, allocatable);

    if (allocation <= 0) {
      continue;
    }

    activities.push(await insertMovement(client, {
      tenantId: input.tenantId,
      productId: input.productId,
      lotId: lot.id,
      movementType: input.movementType,
      quantityDelta: -allocation,
      condition: input.condition,
      channel: input.channel,
      reference: input.reference,
      notes: input.notes,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      occurredAt: input.occurredAt,
      createdAt: input.createdAt
    }));
    remaining -= allocation;
  }

  // Positive unallocated movements can come from a return that was put back
  // into stock before a source lot was known. Preserve the ledger rather than
  // attaching that unit to an arbitrary invoice lot.
  const unallocatedInventory = Math.max(0, numberValue(unallocatedResult.rows[0]?.unallocated_quantity));
  const unallocatedAllocation = Math.min(remaining, unallocatedInventory);

  if (unallocatedAllocation > 0) {
    activities.push(await insertMovement(client, {
      tenantId: input.tenantId,
      productId: input.productId,
      movementType: input.movementType,
      quantityDelta: -unallocatedAllocation,
      condition: input.condition,
      channel: input.channel,
      reference: input.reference,
      notes: input.notes,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      occurredAt: input.occurredAt,
      createdAt: input.createdAt
    }));
    remaining -= unallocatedAllocation;
  }

  if (remaining > 0) {
    throw new InsufficientInventoryError();
  }

  return activities;
}

async function getOpenReturnCase(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  returnId: string
) {
  const result = await client.query<TenantReturnRow>(
    `
      SELECT id, product_id, return_type, status, quantity, condition
      FROM scanneraz_inventory_returns
      WHERE id = $1 AND tenant_id = $2 AND completed_at IS NULL
      FOR UPDATE
    `,
    [returnId, tenantId]
  );

  return result.rows[0];
}

async function insertMovement(
  client: Pick<PoolClient, "query">,
  input: {
    tenantId: string;
    productId: string;
    lotId?: string;
    movementType: InventoryMovementType;
    quantityDelta: number;
    condition: InventoryCondition;
    channel?: string;
    reference?: string;
    notes?: string;
    sourceType?: string;
    sourceId?: string;
    occurredAt: Date;
    createdAt: Date;
  }
) {
  const id = crypto.randomUUID();
  await client.query(
    `
      INSERT INTO scanneraz_inventory_movements (
        id, tenant_id, product_id, lot_id, movement_type, quantity_delta, condition, channel, reference, notes,
        source_type, source_id, occurred_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `,
    [
      id,
      input.tenantId,
      input.productId,
      input.lotId ?? null,
      input.movementType,
      input.quantityDelta,
      input.condition,
      input.channel ?? null,
      input.reference ?? null,
      input.notes ?? null,
      input.sourceType ?? null,
      input.sourceId ?? null,
      input.occurredAt,
      input.createdAt
    ]
  );

  return { id };
}

function toInventoryActivity(row: ActivityRow): InventoryActivity {
  return {
    id: row.id,
    productId: row.product_id,
    productTitle: row.product_title,
    movementType: row.movement_type,
    quantityDelta: numberValue(row.quantity_delta),
    condition: row.condition,
    channel: row.channel ?? undefined,
    reference: row.reference ?? undefined,
    notes: row.notes ?? undefined,
    occurredAt: new Date(row.occurred_at).toISOString()
  };
}

function toInventoryReturnCase(row: ReturnRow): InventoryReturnCase {
  return {
    id: row.id,
    productId: row.product_id,
    productTitle: row.product_title,
    returnType: row.return_type,
    status: row.status,
    retailer: row.retailer ?? undefined,
    quantity: numberValue(row.quantity),
    condition: row.condition,
    reference: row.reference ?? undefined,
    notes: row.notes ?? undefined,
    receivedAt: new Date(row.received_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined
  };
}

function toStoredInvoiceExtraction(row: InvoiceExtractionRow): StoredInvoiceExtraction {
  const draft = typeof row.draft_json === "string"
    ? JSON.parse(row.draft_json) as ExtractedInvoiceDraft
    : row.draft_json;

  return {
    id: row.id,
    sourceFilename: row.source_filename,
    mimeType: row.mime_type,
    sizeBytes: numberValue(row.size_bytes),
    documentSha256: row.document_sha256,
    model: row.model,
    status: row.status,
    draft,
    createdAt: new Date(row.created_at).toISOString(),
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : undefined,
    invoiceId: row.invoice_id ?? undefined
  };
}

function getPool() {
  if (!config.DATABASE_URL) {
    return undefined;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : undefined
    });
  }

  return pool;
}

function requirePool() {
  const inventoryPool = getPool();

  if (!inventoryPool) {
    throw new Error("ScannerAz inventory requires DATABASE_URL");
  }

  return inventoryPool;
}

function normalizeRequiredText(value: string, field: string) {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${field} is required`);
  }

  return normalized;
}

function normalizeOptionalText(value?: string) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeCode(value?: string) {
  const normalized = normalizeOptionalText(value)?.toUpperCase().replace(/\s+/g, "");
  return normalized || undefined;
}

function normalizeInventoryUpc(value?: string) {
  const digits = normalizeOptionalText(value)?.replace(/[^0-9]/g, "");
  return digits && /^\d{8,14}$/.test(digits) ? digits : undefined;
}

function normalizeAmazonAsin(value?: string) {
  const asin = normalizeCode(value);
  return asin && /^[A-Z0-9]{10}$/.test(asin) ? asin : undefined;
}

function normalizeCurrency(value: string) {
  const normalized = normalizeRequiredText(value, "currency").toUpperCase();

  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error("currency is invalid");
  }

  return normalized;
}

function positiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }

  return value;
}

function nonNegativeInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }

  return value;
}

function parseOccurredAt(value?: string) {
  const occurredAt = value ? new Date(value) : new Date();

  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error("occurredAt is invalid");
  }

  return occurredAt;
}

function numberValue(value: string | number | null | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumberValue(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return undefined;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}
