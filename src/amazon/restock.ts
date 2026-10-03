import { assertAmazonSpApiConfig, config } from "../config.js";
import { getAmazonConnection } from "../storage/connections.js";
import { getAutomationPool } from "./repricing.js";
import {
  getLwaAccessToken,
  getSellerListingItem,
  patchSellerListingPrice,
  prepareListingRestock
} from "./spapi.js";

/**
 * Automatic restock for one merchant-fulfilled SKU: when Amazon reports a
 * quantity of 0, ScannerAz sets it back to `quantity`.
 */
export type RestockRule = {
  tenantId: string;
  connectionId: string;
  sku: string;
  enabled: boolean;
  quantity: number;
  updatedAt: string;
  lastCheckedAt?: string;
  lastStatus?: RestockStatus;
  lastMessage?: string;
  lastQuantity?: number;
  lastRestockedAt?: string;
};

export type RestockStatus = "restocked" | "in_stock" | "fba" | "failed";

type RestockRuleRow = {
  tenant_id: string;
  connection_id: string;
  sku: string;
  enabled: boolean;
  quantity: number;
  updated_at: Date | string;
  last_checked_at: Date | string | null;
  last_status: RestockStatus | null;
  last_message: string | null;
  last_quantity: number | null;
  last_restocked_at: Date | string | null;
};

const localRules = new Map<string, RestockRule>();
let schemaPromise: Promise<void> | undefined;

function isoOrUndefined(value: Date | string | null) {
  return value ? new Date(value).toISOString() : undefined;
}

function fromRow(row: RestockRuleRow): RestockRule {
  return {
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    sku: row.sku,
    enabled: row.enabled,
    quantity: row.quantity,
    updatedAt: new Date(row.updated_at).toISOString(),
    lastCheckedAt: isoOrUndefined(row.last_checked_at),
    lastStatus: row.last_status ?? undefined,
    lastMessage: row.last_message ?? undefined,
    lastQuantity: row.last_quantity ?? undefined,
    lastRestockedAt: isoOrUndefined(row.last_restocked_at),
  };
}

export async function initializeRestockStore() {
  const pool = getAutomationPool();

  if (!pool || schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = pool
    .query(`
      CREATE TABLE IF NOT EXISTS scanneraz_restock_rules (
        tenant_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        quantity INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_checked_at TIMESTAMPTZ,
        last_status TEXT,
        last_message TEXT,
        last_quantity INTEGER,
        last_restocked_at TIMESTAMPTZ,
        PRIMARY KEY (connection_id, sku)
      );

      CREATE INDEX IF NOT EXISTS scanneraz_restock_rules_enabled_idx
      ON scanneraz_restock_rules (enabled, connection_id);
    `)
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaPromise = undefined;
      throw error;
    });

  return schemaPromise;
}

function assertLocalStoreAllowed() {
  if (config.NODE_ENV === "production") {
    throw new Error("Restock rules require DATABASE_URL in production.");
  }
}

function localKey(connectionId: string, sku: string) {
  return `${connectionId}\u0000${sku}`;
}

export async function listRestockRulesForConnection(tenantId: string, connectionId: string) {
  const pool = getAutomationPool();

  if (pool) {
    await initializeRestockStore();
    const result = await pool.query<RestockRuleRow>(
      `SELECT * FROM scanneraz_restock_rules WHERE tenant_id = $1 AND connection_id = $2 ORDER BY sku`,
      [tenantId, connectionId]
    );
    return result.rows.map(fromRow);
  }

  assertLocalStoreAllowed();
  return [...localRules.values()].filter((rule) => rule.tenantId === tenantId && rule.connectionId === connectionId);
}

export async function saveRestockRule(input: {
  tenantId: string;
  connectionId: string;
  sku: string;
  enabled: boolean;
  quantity: number;
}) {
  const updatedAt = new Date().toISOString();
  const pool = getAutomationPool();

  if (pool) {
    await initializeRestockStore();
    const result = await pool.query<RestockRuleRow>(
      `
        INSERT INTO scanneraz_restock_rules (tenant_id, connection_id, sku, enabled, quantity, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (connection_id, sku) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          quantity = EXCLUDED.quantity,
          updated_at = EXCLUDED.updated_at
        WHERE scanneraz_restock_rules.tenant_id = EXCLUDED.tenant_id
        RETURNING *
      `,
      [input.tenantId, input.connectionId, input.sku, input.enabled, input.quantity, updatedAt]
    );

    if (!result.rows[0]) {
      throw new Error("Restock rule belongs to another tenant");
    }

    return fromRow(result.rows[0]);
  }

  assertLocalStoreAllowed();
  const key = localKey(input.connectionId, input.sku);
  const rule: RestockRule = { ...localRules.get(key), ...input, updatedAt };
  localRules.set(key, rule);
  return rule;
}

async function listEnabledRestockRules() {
  const pool = getAutomationPool();

  if (pool) {
    await initializeRestockStore();
    const result = await pool.query<RestockRuleRow>(
      `SELECT * FROM scanneraz_restock_rules WHERE enabled ORDER BY connection_id, sku`
    );
    return result.rows.map(fromRow);
  }

  return config.NODE_ENV === "production" ? [] : [...localRules.values()].filter((rule) => rule.enabled);
}

async function recordRestockResult(rule: RestockRule, result: {
  status: RestockStatus;
  message?: string;
  quantity?: number;
  restocked?: boolean;
}) {
  const checkedAt = new Date().toISOString();
  const pool = getAutomationPool();

  if (pool) {
    await pool.query(
      `
        UPDATE scanneraz_restock_rules SET
          last_checked_at = $3,
          last_status = $4,
          last_message = $5,
          last_quantity = $6,
          last_restocked_at = CASE WHEN $7 THEN $3::timestamptz ELSE last_restocked_at END
        WHERE connection_id = $1 AND sku = $2
      `,
      [rule.connectionId, rule.sku, checkedAt, result.status, result.message ?? null, result.quantity ?? null, Boolean(result.restocked)]
    );
    return;
  }

  const key = localKey(rule.connectionId, rule.sku);
  const current = localRules.get(key);

  if (current) {
    localRules.set(key, {
      ...current,
      lastCheckedAt: checkedAt,
      lastStatus: result.status,
      lastMessage: result.message,
      lastQuantity: result.quantity,
      lastRestockedAt: result.restocked ? checkedAt : current.lastRestockedAt,
    });
  }
}

async function restockConnection(connectionId: string, rules: RestockRule[]) {
  const connection = await getAmazonConnection(connectionId);

  if (!connection?.sellerId) {
    for (const rule of rules) {
      await recordRestockResult(rule, { status: "failed", message: "La conexión de Amazon ya no está disponible." });
    }
    return;
  }

  assertAmazonSpApiConfig(connection.refreshToken);
  const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
  const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;

  for (const rule of rules.filter((candidate) => candidate.tenantId === connection.tenantId)) {
    try {
      // Listings Items allows 5 requests per second; reads and writes are paced.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const rawListing = await getSellerListingItem({
        sellerId: connection.sellerId,
        sku: rule.sku,
        refreshToken: connection.refreshToken,
        accessToken,
        marketplaceId
      });
      const prepared = prepareListingRestock(rawListing, marketplaceId, rule.quantity);

      if (prepared.fulfillment === "amazon") {
        await recordRestockResult(rule, {
          status: "fba",
          message: "Amazon gestiona el stock de este producto (FBA); no se puede reponer desde ScannerAz.",
        });
        continue;
      }

      const currentQuantity = prepared.currentQuantity ?? 0;

      if (currentQuantity > 0) {
        await recordRestockResult(rule, { status: "in_stock", quantity: currentQuantity });
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
      await patchSellerListingPrice({
        sellerId: connection.sellerId,
        sku: rule.sku,
        refreshToken: connection.refreshToken,
        accessToken,
        marketplaceId,
        patch: prepared.patch
      });
      await recordRestockResult(rule, { status: "restocked", quantity: rule.quantity, restocked: true });
    } catch (error) {
      await recordRestockResult(rule, {
        status: "failed",
        message: error instanceof Error ? error.message.slice(0, 500) : "No pude reponer el stock de este SKU.",
      });
    }
  }
}

export async function runRestockCycle() {
  const rules = await listEnabledRestockRules();
  const rulesByConnection = new Map<string, RestockRule[]>();

  for (const rule of rules) {
    rulesByConnection.set(rule.connectionId, [...(rulesByConnection.get(rule.connectionId) ?? []), rule]);
  }

  for (const [connectionId, connectionRules] of rulesByConnection) {
    try {
      await restockConnection(connectionId, connectionRules);
    } catch (error) {
      console.error(`Restock failed for connection ${connectionId}`, error);
    }
  }
}
