import express from "express";
import { assertAmazonSpApiConfig, config } from "../config.js";
import {
  deleteAmazonConnectionForTenant,
  getAmazonConnectionForTenant,
  listAmazonConnectionsForTenant
} from "../storage/connections.js";
import {
  getListingsRestrictions,
  getSellerListingItem,
  getLwaAccessToken,
  inferCatalogIdentifierType,
  normalizeCatalogSearchResponse,
  normalizeListingsRestrictions,
  normalizePricingListings,
  patchSellerListingPrice,
  prepareListingPriceUpdate,
  searchCatalogItems,
  searchSellerListings
} from "./spapi.js";

export const publicAmazonRouter = express.Router();

type PriceUpdateRequest = {
  sku: string;
  targetPrice: number;
  expectedCurrentPrice?: number;
};

type PriceUpdateResult = {
  sku: string;
  targetPrice: number;
  currentPrice?: number;
  title?: string;
  status: "ready" | "unchanged" | "stale" | "submitted" | "failed";
  submissionId?: string;
  error?: string;
};

publicAmazonRouter.get("/connections", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    res.json({ amazon: await listAmazonConnectionsForTenant(tenantId) });
  } catch (error) {
    next(error);
  }
});

publicAmazonRouter.post("/connections/:connectionId/catalog/search", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const query = String(req.body?.query ?? "").trim();

    if (!query || query.length > 200) {
      res.status(400).json({ error: "query must contain between 1 and 200 characters" });
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const response = await searchCatalogItems({
      query,
      refreshToken: connection.refreshToken,
      marketplaceId,
      identifierType: inferCatalogIdentifierType(query)
    });

    res.json({
      query,
      connectionId,
      marketplaceId,
      candidates: normalizeCatalogSearchResponse(response, marketplaceId)
    });
  } catch (error) {
    next(error);
  }
});

publicAmazonRouter.post("/connections/:connectionId/restrictions/check", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const asin = String(req.body?.asin ?? "").trim().toUpperCase();
    const conditionType = String(req.body?.conditionType ?? "new_new").trim().toLowerCase();

    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      res.status(400).json({ error: "asin must be a 10-character ASIN" });
      return;
    }

    if (!/^[a-z_]{3,40}$/.test(conditionType)) {
      res.status(400).json({ error: "conditionType is invalid" });
      return;
    }

    if (!connection.sellerId) {
      res.status(409).json({ error: "The authorized Amazon connection is missing a seller ID" });
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const response = await getListingsRestrictions({
      asin,
      sellerId: connection.sellerId,
      refreshToken: connection.refreshToken,
      conditionType,
      marketplaceId: connection.marketplaceId || config.AMAZON_MARKETPLACE_ID
    });

    res.json({
      asin,
      connectionId,
      marketplaceId: connection.marketplaceId,
      spApiEnvironment: config.AMAZON_SP_API_ENVIRONMENT,
      conditionType,
      ...normalizeListingsRestrictions(response)
    });
  } catch (error) {
    next(error);
  }
});

publicAmazonRouter.post("/connections/:connectionId/restrictions/check-batch", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const rawAsins: unknown[] = Array.isArray(req.body?.asins) ? req.body.asins : [];
    const asins = Array.from(new Set<string>(
      rawAsins
        .map((value: unknown) => String(value ?? "").trim().toUpperCase())
        .filter((asin: string) => /^[A-Z0-9]{10}$/.test(asin))
    )).slice(0, 20);
    const conditionType = String(req.body?.conditionType ?? "new_new").trim().toLowerCase();

    if (!asins.length) {
      res.status(400).json({ error: "asins must contain between 1 and 20 valid ASINs" });
      return;
    }

    if (!/^[a-z_]{3,40}$/.test(conditionType)) {
      res.status(400).json({ error: "conditionType is invalid" });
      return;
    }

    const sellerId = connection.sellerId;

    if (!sellerId) {
      res.status(409).json({ error: "The authorized Amazon connection is missing a seller ID" });
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    // Reuse one short-lived LWA token and keep the request start rate below
    // the default Listings Restrictions API allowance.
    const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
    const results = await mapWithConcurrency(asins, 2, async (asin) => {
      try {
        const response = await getListingsRestrictions({
          asin,
          sellerId,
          refreshToken: connection.refreshToken,
          accessToken,
          conditionType,
          marketplaceId
        });

        return { asin, ...normalizeListingsRestrictions(response) };
      } catch (error) {
        return {
          asin,
          status: "unknown" as const,
          restrictions: [],
          error: batchFailureCode(error)
        };
      }
    });

    res.json({
      connectionId,
      marketplaceId,
      spApiEnvironment: config.AMAZON_SP_API_ENVIRONMENT,
      conditionType,
      results
    });
  } catch (error) {
    next(error);
  }
});

publicAmazonRouter.get("/connections/:connectionId/listings/pricing", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    if (!connection.sellerId) {
      res.status(409).json({ error: "The authorized Amazon connection is missing a seller ID" });
      return;
    }

    const requestedLimit = Number(req.query.limit ?? 20);
    const pageSize = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 20
      ? requestedLimit
      : 20;
    const pageToken = typeof req.query.pageToken === "string" ? req.query.pageToken.trim() : "";

    if (pageToken.length > 2048) {
      res.status(400).json({ error: "pageToken is invalid" });
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const response = await searchSellerListings({
      sellerId: connection.sellerId,
      refreshToken: connection.refreshToken,
      marketplaceId,
      pageSize,
      pageToken: pageToken || undefined,
      withStatus: "BUYABLE"
    });
    const normalized = normalizePricingListings(response, marketplaceId);

    res.json({
      connectionId,
      marketplaceId,
      priceUpdatesEnabled: config.SCANNERAZ_PRICE_UPDATES_ENABLED,
      ...normalized
    });
  } catch (error) {
    next(error);
  }
});

publicAmazonRouter.post("/connections/:connectionId/listings/pricing/match-buy-box", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    if (!connection.sellerId) {
      res.status(409).json({ error: "The authorized Amazon connection is missing a seller ID" });
      return;
    }

    const parsedUpdates = parsePriceUpdateRequests(req.body?.updates);

    if (typeof parsedUpdates === "string") {
      res.status(400).json({ error: parsedUpdates });
      return;
    }

    // A missing dryRun flag never writes a seller's listing. The app must make
    // an explicit second request after the batch review is visible to the user.
    const dryRun = req.body?.dryRun !== false;

    if (!dryRun && !config.SCANNERAZ_PRICE_UPDATES_ENABLED) {
      res.status(409).json({
        error: "Price updates are not enabled. Activate the Pricing and Product Listing roles, then enable SCANNERAZ_PRICE_UPDATES_ENABLED on the server."
      });
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
    const results: PriceUpdateResult[] = [];

    for (const update of parsedUpdates) {
      try {
        // Listings Items defaults to 5 requests per second. A read and a
        // potential write are paced separately so a 20-item batch stays safe.
        await delay(250);
        const rawListing = await getSellerListingItem({
          sellerId: connection.sellerId,
          sku: update.sku,
          refreshToken: connection.refreshToken,
          accessToken,
          marketplaceId
        });
        const prepared = prepareListingPriceUpdate(rawListing, marketplaceId, update.targetPrice);

        if (
          update.expectedCurrentPrice !== undefined &&
          prepared.currentPrice !== undefined &&
          Math.abs(update.expectedCurrentPrice - prepared.currentPrice) > 0.005
        ) {
          results.push({
            sku: prepared.sku,
            title: prepared.title,
            currentPrice: prepared.currentPrice,
            targetPrice: prepared.targetPrice,
            status: "stale",
            error: "El precio propio cambio desde que se preparo el lote. Actualiza la lista antes de aplicar el cambio."
          });
          continue;
        }

        if (
          prepared.currentPrice !== undefined &&
          Math.abs(prepared.currentPrice - prepared.targetPrice) <= 0.005
        ) {
          results.push({
            sku: prepared.sku,
            title: prepared.title,
            currentPrice: prepared.currentPrice,
            targetPrice: prepared.targetPrice,
            status: "unchanged"
          });
          continue;
        }

        if (dryRun) {
          results.push({
            sku: prepared.sku,
            title: prepared.title,
            currentPrice: prepared.currentPrice,
            targetPrice: prepared.targetPrice,
            status: "ready"
          });
          continue;
        }

        await delay(250);
        const submission = await patchSellerListingPrice({
          sellerId: connection.sellerId,
          sku: prepared.sku,
          refreshToken: connection.refreshToken,
          accessToken,
          marketplaceId,
          patch: prepared.patch
        });
        const submissionId = stringResponseValue(submission, "submissionId");

        results.push({
          sku: prepared.sku,
          title: prepared.title,
          currentPrice: prepared.currentPrice,
          targetPrice: prepared.targetPrice,
          status: "submitted",
          submissionId
        });
      } catch (error) {
        results.push({
          sku: update.sku,
          targetPrice: update.targetPrice,
          status: "failed",
          error: error instanceof Error ? error.message : "No pude preparar el cambio de precio."
        });
      }
    }

    res.json({
      connectionId,
      marketplaceId,
      dryRun,
      priceUpdatesEnabled: config.SCANNERAZ_PRICE_UPDATES_ENABLED,
      results
    });
  } catch (error) {
    next(error);
  }
});

publicAmazonRouter.delete("/connections/:connectionId", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const deleted = await deleteAmazonConnectionForTenant(connectionId, tenantId);

    if (!deleted) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

function requireTenantId(req: express.Request) {
  const tenantId = req.scannerazTenantSession?.tenantId;

  if (!tenantId) {
    throw new Error("Tenant session middleware is required for public Amazon routes");
  }

  return tenantId;
}

function parsePriceUpdateRequests(value: unknown): PriceUpdateRequest[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    return "updates must contain between 1 and 20 price changes";
  }

  const seenSkus = new Set<string>();
  const updates: PriceUpdateRequest[] = [];

  for (const rawUpdate of value) {
    const update = asRecord(rawUpdate);
    const sku = String(update?.sku ?? "").trim();
    const targetPrice = moneyValue(update?.targetPrice);
    const expectedCurrentPrice = update?.expectedCurrentPrice === undefined
      ? undefined
      : moneyValue(update.expectedCurrentPrice);

    if (!sku || sku.length > 200 || !targetPrice) {
      return "Each price change needs a valid SKU and a target price between $0.01 and $1,000,000.00";
    }

    if (update?.expectedCurrentPrice !== undefined && expectedCurrentPrice === undefined) {
      return "expectedCurrentPrice must be a valid monetary amount";
    }

    if (seenSkus.has(sku)) {
      return "Each SKU can appear only once in a price batch";
    }

    seenSkus.add(sku);
    updates.push({ sku, targetPrice, expectedCurrentPrice });
  }

  return updates;
}

function moneyValue(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numeric) || numeric < 0.01 || numeric > 1_000_000) {
    return undefined;
  }

  const cents = Math.round(numeric * 100);
  return Math.abs(numeric * 100 - cents) < 0.00001 ? cents / 100 : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringResponseValue(value: unknown, key: string) {
  const candidate = asRecord(value)?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  worker: (value: Input) => Promise<Output>
) {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  let nextRequestStartAt = 0;

  async function waitForRequestSlot() {
    const now = Date.now();
    const startAt = Math.max(now, nextRequestStartAt);
    nextRequestStartAt = startAt + 250;

    if (startAt > now) {
      await new Promise((resolve) => setTimeout(resolve, startAt - now));
    }
  }

  async function runWorker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await waitForRequestSlot();
      results[index] = await worker(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, runWorker));
  return results;
}

function batchFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("rate limited") ? "rate_limited" : "unavailable";
}
