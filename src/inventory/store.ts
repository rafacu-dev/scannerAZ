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
  };
  products: InventoryProduct[];
  recentActivity: InventoryActivity[];
  returns: InventoryReturnCase[];
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

    for (const line of input.lines) {
      const product = await upsertProduct(client, tenantId, line, createdAt);
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
    return { id: invoiceId, purchasedAt: purchasedAt.toISOString(), lineCount: input.lines.length };
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

export async function getInventoryOverview(tenantId: string): Promise<InventoryOverview> {
  const inventoryPool = requirePool();
  await initializeInventoryStore();
  const [productResult, activityResult, returnResult] = await Promise.all([
    inventoryPool.query<ProductRow>(
      `
        WITH movement_summary AS (
          SELECT
            product_id,
            SUM(quantity_delta) AS available_quantity,
            SUM(CASE WHEN movement_type = 'purchase' THEN quantity_delta ELSE 0 END) AS received_quantity,
            SUM(CASE WHEN movement_type = 'sale' THEN -quantity_delta ELSE 0 END) AS sold_quantity,
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
      ).length
    },
    products,
    recentActivity: activityResult.rows.map(toInventoryActivity),
    returns
  };
}

export function inventoryProductKey(input: Pick<InventoryInvoiceLineInput, "title" | "sku" | "asin" | "upc">) {
  const sku = normalizeCode(input.sku);
  const asin = normalizeCode(input.asin);
  const upc = normalizeCode(input.upc);

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
    const activity = await insertMovement(client, {
      tenantId,
      productId: input.productId,
      movementType: input.movementType,
      quantityDelta: -quantity,
      condition: input.condition,
      channel: input.channel,
      reference: input.reference,
      notes: input.notes,
      occurredAt: input.occurredAt,
      createdAt
    });
    await client.query("COMMIT");
    return activity;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function upsertProduct(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  line: InventoryInvoiceLineInput,
  now: Date
) {
  const title = normalizeRequiredText(line.title, "title");
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
      inventoryProductKey(line),
      normalizeCode(line.sku),
      normalizeCode(line.asin),
      normalizeCode(line.upc),
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
    occurredAt: Date;
    createdAt: Date;
  }
) {
  const id = crypto.randomUUID();
  await client.query(
    `
      INSERT INTO scanneraz_inventory_movements (
        id, tenant_id, product_id, lot_id, movement_type, quantity_delta, condition, channel, reference, notes,
        occurred_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
