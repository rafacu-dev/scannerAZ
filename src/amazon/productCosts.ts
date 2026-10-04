import { config } from "../config.js";
import { getAutomationPool } from "./repricing.js";

/**
 * Seller-entered calculator inputs per SKU and store. The cost price feeds
 * profit and ROI for the product.
 */
export type ProductCost = {
  connectionId: string;
  sku: string;
  asin?: string;
  costPrice?: number;
  salePrice?: number;
  fulfillment: "FBA" | "FBM";
  fbmCost: number;
  quantity: number;
  updatedAt: string;
};

type ProductCostRow = {
  tenant_id: string;
  connection_id: string;
  sku: string;
  asin: string | null;
  cost_price: string | number | null;
  sale_price: string | number | null;
  fulfillment: "FBA" | "FBM";
  fbm_cost: string | number;
  quantity: number;
  updated_at: Date | string;
};

const localCosts = new Map<string, ProductCost & { tenantId: string }>();
let schemaPromise: Promise<void> | undefined;

export async function initializeProductCostStore() {
  const pool = getAutomationPool();

  if (!pool || schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = pool
    .query(`
      CREATE TABLE IF NOT EXISTS scanneraz_product_costs (
        tenant_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        asin TEXT,
        cost_price NUMERIC(12, 2),
        sale_price NUMERIC(12, 2),
        fulfillment TEXT NOT NULL DEFAULT 'FBM',
        fbm_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (connection_id, sku)
      );
    `)
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaPromise = undefined;
      throw error;
    });

  return schemaPromise;
}

function optionalNumber(value: string | number | null) {
  return value === null ? undefined : Number(value);
}

function fromRow(row: ProductCostRow): ProductCost {
  return {
    connectionId: row.connection_id,
    sku: row.sku,
    asin: row.asin ?? undefined,
    costPrice: optionalNumber(row.cost_price),
    salePrice: optionalNumber(row.sale_price),
    fulfillment: row.fulfillment,
    fbmCost: Number(row.fbm_cost),
    quantity: row.quantity,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function assertLocalStoreAllowed() {
  if (config.NODE_ENV === "production") {
    throw new Error("Product costs require DATABASE_URL in production.");
  }
}

export async function listProductCosts(tenantId: string, connectionId: string) {
  const pool = getAutomationPool();

  if (pool) {
    await initializeProductCostStore();
    const result = await pool.query<ProductCostRow>(
      `SELECT * FROM scanneraz_product_costs WHERE tenant_id = $1 AND connection_id = $2 ORDER BY sku`,
      [tenantId, connectionId]
    );
    return result.rows.map(fromRow);
  }

  assertLocalStoreAllowed();
  return [...localCosts.values()]
    .filter((cost) => cost.tenantId === tenantId && cost.connectionId === connectionId)
    .map(({ tenantId: _tenantId, ...cost }) => cost);
}

export async function saveProductCost(input: Omit<ProductCost, "updatedAt"> & { tenantId: string }) {
  const updatedAt = new Date().toISOString();
  const pool = getAutomationPool();

  if (pool) {
    await initializeProductCostStore();
    const result = await pool.query<ProductCostRow>(
      `
        INSERT INTO scanneraz_product_costs
          (tenant_id, connection_id, sku, asin, cost_price, sale_price, fulfillment, fbm_cost, quantity, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (connection_id, sku) DO UPDATE SET
          asin = EXCLUDED.asin,
          cost_price = EXCLUDED.cost_price,
          sale_price = EXCLUDED.sale_price,
          fulfillment = EXCLUDED.fulfillment,
          fbm_cost = EXCLUDED.fbm_cost,
          quantity = EXCLUDED.quantity,
          updated_at = EXCLUDED.updated_at
        WHERE scanneraz_product_costs.tenant_id = EXCLUDED.tenant_id
        RETURNING *
      `,
      [
        input.tenantId,
        input.connectionId,
        input.sku,
        input.asin ?? null,
        input.costPrice ?? null,
        input.salePrice ?? null,
        input.fulfillment,
        input.fbmCost,
        input.quantity,
        updatedAt
      ]
    );

    if (!result.rows[0]) {
      throw new Error("Product cost belongs to another tenant");
    }

    return fromRow(result.rows[0]);
  }

  assertLocalStoreAllowed();
  const cost = { ...input, updatedAt };
  localCosts.set(`${input.connectionId}\u0000${input.sku}`, cost);
  const { tenantId: _tenantId, ...publicCost } = cost;
  return publicCost;
}
