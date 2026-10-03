import { Pool } from "pg";
import { assertAmazonSpApiConfig, config } from "../config.js";
import { getAmazonConnection } from "../storage/connections.js";
import { withItemOffersBatchSlot } from "./offersRateLimit.js";
import { runRestockCycle } from "./restock.js";
import { sendPushToTenant } from "../notifications/push.js";
import {
  type AmazonItemOffer,
  getAmazonItemOffersBatch,
  getLwaAccessToken,
  getSellerListingItem,
  normalizeAmazonItemOffersBatch,
  patchSellerListingPrice,
  prepareListingPriceUpdate
} from "./spapi.js";

/**
 * A seller-defined automatic repricing rule for one SKU. ScannerAz either
 * matches the lowest competing offer or stays undercutAmount below it,
 * following it both down and up, and never prices below the seller's minimum.
 */
export type RepricingRule = {
  tenantId: string;
  connectionId: string;
  sku: string;
  asin: string;
  enabled: boolean;
  minPrice: number;
  strategy: RepricingStrategy;
  undercutAmount: number;
  updatedAt: string;
  lastCheckedAt?: string;
  lastStatus?: RepricingStatus;
  lastMessage?: string;
  lastCompetitorPrice?: number;
  lastPrice?: number;
};

export type RepricingStrategy = "match" | "undercut";

export type RepricingStatus = "updated" | "unchanged" | "at_minimum" | "no_competitors" | "failed";

/**
 * One price change submitted to Amazon, either by the automatic repricer or
 * manually by the seller from the app's repricing batch.
 */
export type RepricingEvent = {
  id: string;
  connectionId: string;
  kind: RepricingEventKind;
  source: RepricingEventSource;
  sku: string;
  asin?: string;
  title?: string;
  imageUrl?: string;
  previousPrice?: number;
  newPrice?: number;
  previousQuantity?: number;
  newQuantity?: number;
  competitorPrice?: number;
  strategy?: RepricingStrategy;
  atMinimum: boolean;
  createdAt: string;
};

export type RepricingEventSource = "automatic" | "manual";

/** Price changes and automatic restocks share one history. */
export type RepricingEventKind = "price" | "restock";

type RepricingEventRow = {
  id: string | number;
  connection_id: string;
  kind: RepricingEventKind;
  source: RepricingEventSource;
  sku: string;
  asin: string | null;
  title: string | null;
  image_url: string | null;
  previous_price: string | number | null;
  new_price: string | number | null;
  previous_quantity: number | null;
  new_quantity: number | null;
  competitor_price: string | number | null;
  strategy: RepricingStrategy | null;
  at_minimum: boolean;
  created_at: Date | string;
};

type RepricingRuleRow = {
  tenant_id: string;
  connection_id: string;
  sku: string;
  asin: string;
  enabled: boolean;
  min_price: string | number;
  strategy: RepricingStrategy;
  undercut_amount: string | number;
  updated_at: Date | string;
  last_checked_at: Date | string | null;
  last_status: RepricingStatus | null;
  last_message: string | null;
  last_competitor_price: string | number | null;
  last_price: string | number | null;
};

// The external worker is expected to call the trigger about every 5 minutes.
// Calls arriving sooner are ignored, so the unauthenticated endpoint cannot be
// used to run more cycles (or Amazon requests) than that schedule allows.
const repricingMinimumIntervalMs = 4 * 60 * 1000;
let lastRepricingCycleStartedAt = 0;
const localRules = new Map<string, RepricingRule>();
const localEvents: Array<RepricingEvent & { tenantId: string }> = [];
let pool: Pool | undefined;
let schemaPromise: Promise<void> | undefined;
let repricingCycleRunning = false;

/** Shared with the restock automation, which lives in the same database. */
export function getAutomationPool() {
  return getPool();
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

export async function initializeRepricingStore() {
  const connectionPool = getPool();

  if (!connectionPool || schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = connectionPool
    .query(`
      CREATE TABLE IF NOT EXISTS scanneraz_repricing_rules (
        tenant_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        asin TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        min_price NUMERIC(12, 2) NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_checked_at TIMESTAMPTZ,
        last_status TEXT,
        last_message TEXT,
        last_competitor_price NUMERIC(12, 2),
        last_price NUMERIC(12, 2),
        PRIMARY KEY (connection_id, sku)
      );

      -- Rules saved before the strategy choice kept a fixed $0.10 undercut.
      ALTER TABLE scanneraz_repricing_rules
      ADD COLUMN IF NOT EXISTS strategy TEXT NOT NULL DEFAULT 'undercut';

      ALTER TABLE scanneraz_repricing_rules
      ADD COLUMN IF NOT EXISTS undercut_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.10;

      CREATE INDEX IF NOT EXISTS scanneraz_repricing_rules_enabled_idx
      ON scanneraz_repricing_rules (enabled, connection_id);

      CREATE TABLE IF NOT EXISTS scanneraz_repricing_events (
        id BIGSERIAL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        asin TEXT NOT NULL,
        title TEXT,
        previous_price NUMERIC(12, 2) NOT NULL,
        new_price NUMERIC(12, 2) NOT NULL,
        competitor_price NUMERIC(12, 2),
        strategy TEXT NOT NULL,
        at_minimum BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL
      );

      -- Manual batch changes share this log; they may lack an ASIN, a known
      -- previous price, or a strategy.
      ALTER TABLE scanneraz_repricing_events
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'automatic';

      ALTER TABLE scanneraz_repricing_events ALTER COLUMN asin DROP NOT NULL;
      ALTER TABLE scanneraz_repricing_events ALTER COLUMN previous_price DROP NOT NULL;
      ALTER TABLE scanneraz_repricing_events ALTER COLUMN strategy DROP NOT NULL;

      ALTER TABLE scanneraz_repricing_events
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'price';

      ALTER TABLE scanneraz_repricing_events ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE scanneraz_repricing_events ADD COLUMN IF NOT EXISTS previous_quantity INTEGER;
      ALTER TABLE scanneraz_repricing_events ADD COLUMN IF NOT EXISTS new_quantity INTEGER;
      ALTER TABLE scanneraz_repricing_events ALTER COLUMN new_price DROP NOT NULL;

      CREATE INDEX IF NOT EXISTS scanneraz_repricing_events_connection_idx
      ON scanneraz_repricing_events (tenant_id, connection_id, created_at DESC);
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

function fromRow(row: RepricingRuleRow): RepricingRule {
  return {
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    sku: row.sku,
    asin: row.asin,
    enabled: row.enabled,
    minPrice: Number(row.min_price),
    strategy: row.strategy,
    undercutAmount: Number(row.undercut_amount),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : undefined,
    lastStatus: row.last_status ?? undefined,
    lastMessage: row.last_message ?? undefined,
    lastCompetitorPrice: optionalNumber(row.last_competitor_price),
    lastPrice: optionalNumber(row.last_price),
  };
}

function assertLocalStoreAllowed() {
  if (config.NODE_ENV === "production") {
    throw new Error("Repricing rules require DATABASE_URL in production.");
  }
}

function localKey(connectionId: string, sku: string) {
  return `${connectionId}\u0000${sku}`;
}

function eventFromRow(row: RepricingEventRow): RepricingEvent {
  return {
    id: String(row.id),
    connectionId: row.connection_id,
    kind: row.kind,
    source: row.source,
    sku: row.sku,
    asin: row.asin ?? undefined,
    title: row.title ?? undefined,
    imageUrl: row.image_url ?? undefined,
    previousPrice: optionalNumber(row.previous_price),
    newPrice: optionalNumber(row.new_price),
    previousQuantity: row.previous_quantity ?? undefined,
    newQuantity: row.new_quantity ?? undefined,
    competitorPrice: optionalNumber(row.competitor_price),
    strategy: row.strategy ?? undefined,
    atMinimum: row.at_minimum,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listRepricingEventsForConnection(tenantId: string, connectionId: string, limit = 100) {
  const connectionPool = getPool();

  if (connectionPool) {
    await initializeRepricingStore();
    const result = await connectionPool.query<RepricingEventRow>(
      `
        SELECT * FROM scanneraz_repricing_events
        WHERE tenant_id = $1 AND connection_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3
      `,
      [tenantId, connectionId, limit]
    );
    return result.rows.map(eventFromRow);
  }

  assertLocalStoreAllowed();
  return localEvents
    .filter((event) => event.tenantId === tenantId && event.connectionId === connectionId)
    .slice(-limit)
    .reverse()
    .map(({ tenantId: _tenantId, ...event }) => event);
}

export async function recordPriceChangeEvent(event: {
  tenantId: string;
  connectionId: string;
  kind?: RepricingEventKind;
  source: RepricingEventSource;
  sku: string;
  asin?: string;
  title?: string;
  imageUrl?: string;
  previousPrice?: number;
  newPrice?: number;
  previousQuantity?: number;
  newQuantity?: number;
  competitorPrice?: number;
  strategy?: RepricingStrategy;
  atMinimum?: boolean;
}) {
  const createdAt = new Date().toISOString();
  const connectionPool = getPool();

  if (connectionPool) {
    await initializeRepricingStore();
    await connectionPool.query(
      `
        INSERT INTO scanneraz_repricing_events (
          tenant_id, connection_id, kind, source, sku, asin, title, image_url, previous_price, new_price,
          previous_quantity, new_quantity, competitor_price, strategy, at_minimum, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `,
      [
        event.tenantId,
        event.connectionId,
        event.kind ?? "price",
        event.source,
        event.sku,
        event.asin ?? null,
        event.title ?? null,
        event.imageUrl ?? null,
        event.previousPrice ?? null,
        event.newPrice ?? null,
        event.previousQuantity ?? null,
        event.newQuantity ?? null,
        event.competitorPrice ?? null,
        event.strategy ?? null,
        event.atMinimum ?? false,
        createdAt
      ]
    );
    return;
  }

  localEvents.push({
    id: String(localEvents.length + 1),
    tenantId: event.tenantId,
    connectionId: event.connectionId,
    kind: event.kind ?? "price",
    source: event.source,
    sku: event.sku,
    asin: event.asin,
    title: event.title,
    imageUrl: event.imageUrl,
    previousPrice: event.previousPrice,
    newPrice: event.newPrice,
    previousQuantity: event.previousQuantity,
    newQuantity: event.newQuantity,
    competitorPrice: event.competitorPrice,
    strategy: event.strategy,
    atMinimum: event.atMinimum ?? false,
    createdAt,
  });
}

/**
 * Earlier re-authorizations created a new connection ID each time, leaving
 * repricing/restock rules and history on the older ID. Move them to the newest
 * connection of the same tenant and seller. Idempotent; runs at startup.
 * A rule already present on the newest connection wins over an older copy.
 */
export async function consolidateDuplicateAmazonConnections() {
  const pool = getPool();

  if (!pool) {
    return;
  }

  await initializeRepricingStore();
  const { rows: moves } = await pool.query<{ old_id: string; keep_id: string }>(`
    SELECT id AS old_id, keep_id FROM (
      SELECT id, first_value(id) OVER (
        PARTITION BY tenant_id, seller_id, marketplace_id ORDER BY connected_at DESC
      ) AS keep_id
      FROM scanneraz_amazon_connections
      WHERE tenant_id IS NOT NULL AND seller_id IS NOT NULL
    ) ranked
    WHERE id <> keep_id
  `);

  for (const move of moves) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE scanneraz_repricing_events SET connection_id = $2 WHERE connection_id = $1`,
        [move.old_id, move.keep_id]
      );

      for (const table of ["scanneraz_repricing_rules", "scanneraz_restock_rules"]) {
        const exists = await client.query<{ present: string | null }>(
          `SELECT to_regclass($1) AS present`,
          [table]
        );

        if (!exists.rows[0]?.present) {
          continue;
        }

        await client.query(
          `
            UPDATE ${table} AS moved SET connection_id = $2
            WHERE moved.connection_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM ${table} AS kept WHERE kept.connection_id = $2 AND kept.sku = moved.sku
              )
          `,
          [move.old_id, move.keep_id]
        );
        // Anything left is superseded by a rule on the newest connection.
        await client.query(`DELETE FROM ${table} WHERE connection_id = $1`, [move.old_id]);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`Could not consolidate connection ${move.old_id}`, error);
    } finally {
      client.release();
    }
  }

  if (moves.length) {
    console.log(JSON.stringify({ event: "automation.connections_consolidated", moved: moves.length }));
  }
}

export async function listRepricingRulesForConnection(tenantId: string, connectionId: string) {
  const connectionPool = getPool();

  if (connectionPool) {
    await initializeRepricingStore();
    const result = await connectionPool.query<RepricingRuleRow>(
      `SELECT * FROM scanneraz_repricing_rules WHERE tenant_id = $1 AND connection_id = $2 ORDER BY sku`,
      [tenantId, connectionId]
    );
    return result.rows.map(fromRow);
  }

  assertLocalStoreAllowed();
  return [...localRules.values()].filter((rule) => rule.tenantId === tenantId && rule.connectionId === connectionId);
}

export async function saveRepricingRule(input: {
  tenantId: string;
  connectionId: string;
  sku: string;
  asin: string;
  enabled: boolean;
  minPrice: number;
  strategy: RepricingStrategy;
  undercutAmount: number;
}) {
  const updatedAt = new Date().toISOString();
  const connectionPool = getPool();

  if (connectionPool) {
    await initializeRepricingStore();
    const result = await connectionPool.query<RepricingRuleRow>(
      `
        INSERT INTO scanneraz_repricing_rules
          (tenant_id, connection_id, sku, asin, enabled, min_price, strategy, undercut_amount, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (connection_id, sku) DO UPDATE SET
          asin = EXCLUDED.asin,
          enabled = EXCLUDED.enabled,
          min_price = EXCLUDED.min_price,
          strategy = EXCLUDED.strategy,
          undercut_amount = EXCLUDED.undercut_amount,
          updated_at = EXCLUDED.updated_at
        WHERE scanneraz_repricing_rules.tenant_id = EXCLUDED.tenant_id
        RETURNING *
      `,
      [
        input.tenantId,
        input.connectionId,
        input.sku,
        input.asin,
        input.enabled,
        input.minPrice,
        input.strategy,
        input.undercutAmount,
        updatedAt
      ]
    );

    if (!result.rows[0]) {
      throw new Error("Repricing rule belongs to another tenant");
    }

    return fromRow(result.rows[0]);
  }

  assertLocalStoreAllowed();
  const key = localKey(input.connectionId, input.sku);
  const rule: RepricingRule = { ...localRules.get(key), ...input, updatedAt };
  localRules.set(key, rule);
  return rule;
}

async function listEnabledRepricingRules() {
  const connectionPool = getPool();

  if (connectionPool) {
    await initializeRepricingStore();
    const result = await connectionPool.query<RepricingRuleRow>(
      `SELECT * FROM scanneraz_repricing_rules WHERE enabled ORDER BY connection_id, sku`
    );
    return result.rows.map(fromRow);
  }

  return config.NODE_ENV === "production" ? [] : [...localRules.values()].filter((rule) => rule.enabled);
}

async function recordRepricingResult(rule: RepricingRule, result: {
  status: RepricingStatus;
  message?: string;
  competitorPrice?: number;
  price?: number;
}) {
  const checkedAt = new Date().toISOString();
  const connectionPool = getPool();

  if (connectionPool) {
    await connectionPool.query(
      `
        UPDATE scanneraz_repricing_rules SET
          last_checked_at = $3,
          last_status = $4,
          last_message = $5,
          last_competitor_price = $6,
          last_price = $7
        WHERE connection_id = $1 AND sku = $2
      `,
      [rule.connectionId, rule.sku, checkedAt, result.status, result.message ?? null, result.competitorPrice ?? null, result.price ?? null]
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
      lastCompetitorPrice: result.competitorPrice,
      lastPrice: result.price,
    });
  }
}

export const defaultRepricingUndercut = 0.05;

function roundPrice(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * Picks the listing price that matches, or sits undercutAmount below, the
 * lowest competing offer in the same condition. The same rule applies when the
 * competitor lowers or raises its price, so the result is stable between runs. Competitor prices are compared as landed prices (item plus
 * shipping), so the seller's own shipping charge is subtracted from the
 * target. The result never goes below the seller's minimum.
 */
export function computeRepricingTarget(input: {
  offers: AmazonItemOffer[];
  ownSellerId?: string;
  currentPrice: number;
  minPrice: number;
  strategy: RepricingStrategy;
  undercutAmount: number;
}): { status: Exclude<RepricingStatus, "updated" | "failed">; competitorPrice?: number; targetPrice?: number } {
  const ownSellerId = input.ownSellerId?.trim().toUpperCase();
  const ownOffer = input.offers.find((offer) => offer.sellerId?.trim().toUpperCase() === ownSellerId);
  const ownShipping = ownOffer?.landedPrice !== undefined && ownOffer.listingPrice !== undefined
    ? Math.max(0, ownOffer.landedPrice - ownOffer.listingPrice)
    : 0;
  const ownCondition = ownOffer?.condition?.trim().toLowerCase();
  const competitorPrices = input.offers.flatMap((offer) => {
    const sellerId = offer.sellerId?.trim().toUpperCase();
    const condition = offer.condition?.trim().toLowerCase();

    if (!sellerId || sellerId === ownSellerId || (ownCondition && condition && condition !== ownCondition)) {
      return [];
    }

    const price = offer.landedPrice ?? (offer.listingPrice === undefined
      ? undefined
      : offer.listingPrice + (offer.shippingPrice ?? 0));

    return price !== undefined && Number.isFinite(price) && price > 0 ? [price] : [];
  });

  if (!competitorPrices.length) {
    return { status: "no_competitors" };
  }

  const competitorPrice = roundPrice(Math.min(...competitorPrices));
  const offset = input.strategy === "undercut" ? input.undercutAmount : 0;
  const matchedPrice = roundPrice(competitorPrice - ownShipping - offset);
  const targetPrice = roundPrice(Math.max(matchedPrice, input.minPrice));

  return { status: matchedPrice < input.minPrice ? "at_minimum" : "unchanged", competitorPrice, targetPrice };
}

type AutomaticPriceChange = {
  tenantId: string;
  sku: string;
  title?: string;
  previousPrice: number;
  newPrice: number;
};

function shortTitle(change: AutomaticPriceChange) {
  const title = change.title?.trim() || change.sku;
  return title.length > 60 ? `${title.slice(0, 57)}...` : title;
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`;
}

/**
 * One push per tenant and cycle: a single change names the product, several
 * changes are summarized so a busy cycle does not flood the devices.
 */
async function notifyAutomaticPriceChanges(changes: AutomaticPriceChange[]) {
  const changesByTenant = new Map<string, AutomaticPriceChange[]>();

  for (const change of changes) {
    changesByTenant.set(change.tenantId, [...(changesByTenant.get(change.tenantId) ?? []), change]);
  }

  for (const [tenantId, tenantChanges] of changesByTenant) {
    const [first] = tenantChanges;
    const message = tenantChanges.length === 1
      ? {
        title: "Precio ajustado automáticamente",
        body: `${shortTitle(first)}: ${formatUsd(first.previousPrice)} → ${formatUsd(first.newPrice)}`,
      }
      : {
        title: `${tenantChanges.length} precios ajustados automáticamente`,
        body: tenantChanges.slice(0, 3).map(shortTitle).join(", ") +
          (tenantChanges.length > 3 ? ` y ${tenantChanges.length - 3} más` : ""),
      };

    try {
      await sendPushToTenant(tenantId, { ...message, data: { screen: "repricing-history" } });
    } catch (error) {
      console.error(`Could not send repricing push to tenant ${tenantId}`, error);
    }
  }
}

async function repriceConnection(connectionId: string, rules: RepricingRule[], changes: AutomaticPriceChange[]) {
  const connection = await getAmazonConnection(connectionId);

  if (!connection?.sellerId) {
    for (const rule of rules) {
      await recordRepricingResult(rule, { status: "failed", message: "La conexión de Amazon ya no está disponible." });
    }
    return;
  }

  assertAmazonSpApiConfig(connection.refreshToken);
  const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
  const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
  const ownedRules = rules.filter((rule) => rule.tenantId === connection.tenantId);

  for (let index = 0; index < ownedRules.length; index += 20) {
    const chunk = ownedRules.slice(index, index + 20);
    const asins = [...new Set(chunk.map((rule) => rule.asin))];
    const response = await withItemOffersBatchSlot(() => getAmazonItemOffersBatch({
      asins,
      refreshToken: connection.refreshToken,
      accessToken,
      marketplaceId
    }));
    const offersByAsin = new Map(normalizeAmazonItemOffersBatch(response, asins).map((offers) => [offers.asin, offers]));

    for (const rule of chunk) {
      try {
        const offers = offersByAsin.get(rule.asin);

        if (!offers || offers.error) {
          await recordRepricingResult(rule, { status: "failed", message: offers?.error ?? "Amazon no devolvió ofertas." });
          continue;
        }

        // Listings Items allows 5 requests per second; reads and writes are paced.
        await new Promise((resolve) => setTimeout(resolve, 250));
        const rawListing = await getSellerListingItem({
          sellerId: connection.sellerId,
          sku: rule.sku,
          refreshToken: connection.refreshToken,
          accessToken,
          marketplaceId
        });
        const current = prepareListingPriceUpdate(rawListing, marketplaceId, rule.minPrice);

        if (current.currentPrice === undefined) {
          await recordRepricingResult(rule, { status: "failed", message: "Amazon no devolvió el precio actual del SKU." });
          continue;
        }

        const decision = computeRepricingTarget({
          offers: offers.offers,
          ownSellerId: connection.sellerId,
          currentPrice: current.currentPrice,
          minPrice: rule.minPrice,
          strategy: rule.strategy,
          undercutAmount: rule.undercutAmount,
        });

        if (decision.targetPrice === undefined || Math.abs(decision.targetPrice - current.currentPrice) <= 0.005) {
          await recordRepricingResult(rule, {
            status: decision.status,
            competitorPrice: decision.competitorPrice,
            price: current.currentPrice,
          });
          continue;
        }

        const prepared = prepareListingPriceUpdate(rawListing, marketplaceId, decision.targetPrice);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await patchSellerListingPrice({
          sellerId: connection.sellerId,
          sku: rule.sku,
          refreshToken: connection.refreshToken,
          accessToken,
          marketplaceId,
          patch: prepared.patch
        });
        await recordRepricingResult(rule, {
          status: "updated",
          message: decision.status === "at_minimum" ? "Ajustado a tu precio mínimo." : undefined,
          competitorPrice: decision.competitorPrice,
          price: decision.targetPrice,
        });

        try {
          await recordPriceChangeEvent({
            tenantId: rule.tenantId,
            connectionId: rule.connectionId,
            source: "automatic",
            sku: rule.sku,
            asin: rule.asin,
            strategy: rule.strategy,
            title: prepared.title,
            imageUrl: prepared.imageUrl,
            previousPrice: current.currentPrice,
            newPrice: decision.targetPrice,
            competitorPrice: decision.competitorPrice,
            atMinimum: decision.status === "at_minimum",
          });
        } catch (error) {
          // The price already changed on Amazon; a history write must not
          // turn that success into a reported failure.
          console.error(`Could not record repricing history for ${rule.sku}`, error);
        }

        changes.push({
          tenantId: rule.tenantId,
          sku: rule.sku,
          title: prepared.title,
          previousPrice: current.currentPrice,
          newPrice: decision.targetPrice,
        });
      } catch (error) {
        await recordRepricingResult(rule, {
          status: "failed",
          message: error instanceof Error ? error.message.slice(0, 500) : "No pude repreciar este SKU.",
        });
      }
    }
  }
}

export async function runRepricingCycle() {
  if (repricingCycleRunning || !config.SCANNERAZ_PRICE_UPDATES_ENABLED) {
    return;
  }

  repricingCycleRunning = true;

  try {
    // Restock runs first: it only reads and patches listings, while repricing
    // waits on Product Pricing's slow rate limit.
    try {
      await runRestockCycle();
    } catch (error) {
      console.error("Restock cycle failed", error);
    }

    const rules = await listEnabledRepricingRules();
    const rulesByConnection = new Map<string, RepricingRule[]>();
    const changes: AutomaticPriceChange[] = [];

    for (const rule of rules) {
      rulesByConnection.set(rule.connectionId, [...(rulesByConnection.get(rule.connectionId) ?? []), rule]);
    }

    for (const [connectionId, connectionRules] of rulesByConnection) {
      try {
        await repriceConnection(connectionId, connectionRules, changes);
      } catch (error) {
        console.error(`Repricing failed for connection ${connectionId}`, error);
      }
    }

    await notifyAutomaticPriceChanges(changes);
  } finally {
    repricingCycleRunning = false;
  }
}

export function triggerRepricingCycle() {
  if (!config.SCANNERAZ_PRICE_UPDATES_ENABLED) {
    return { status: "disabled" as const };
  }

  if (repricingCycleRunning) {
    return { status: "running" as const };
  }

  const now = Date.now();
  const nextAllowedAt = lastRepricingCycleStartedAt + repricingMinimumIntervalMs;

  if (now < nextAllowedAt) {
    return { status: "too_soon" as const, retryAfterSeconds: Math.ceil((nextAllowedAt - now) / 1000) };
  }

  lastRepricingCycleStartedAt = now;
  void runRepricingCycle().catch((error) => console.error("Repricing cycle failed", error));
  return { status: "started" as const };
}
