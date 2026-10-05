import express from "express";
import { assertAmazonSpApiConfig, config } from "../config.js";
import {
  deleteAmazonConnectionForTenant,
  getAmazonConnectionForTenant,
  listAmazonConnectionsForTenant
} from "../storage/connections.js";
import {
  applyAmazonSellerStoreName,
  type AmazonDeferredTransaction,
  type AmazonFinancialEventGroup,
  type AmazonPricingListing,
  buildAmazonReleaseCalendar,
  buildPreliminaryReleaseCalendar,
  getAmazonFeesEstimate,
  createAmazonReport,
  searchSellerOrders,
  AmazonOrdersRequestError,
  fetchAmazonReportIfReady,
  parseAmazonReturnsReport,
  listAmazonRecentOrders,
  preliminaryFeeRate,
  type AmazonRecentOrder,
  getAmazonFinancialEventGroups,
  getAmazonItemOffersBatch,
  getAmazonSellerStoreName,
  getListingsRestrictions,
  getSellerListingItem,
  getLwaAccessToken,
  inferCatalogIdentifierType,
  listAmazonDeferredTransactions,
  normalizeAmazonItemOffers,
  normalizeAmazonItemOffersBatch,
  normalizeCatalogSearchResponse,
  normalizeListingsRestrictions,
  normalizePricingListings,
  patchSellerListingPrice,
  prepareListingPriceUpdate,
  searchCatalogItems,
  searchSellerListings
} from "./spapi.js";
import { withItemOffersBatchSlot } from "./offersRateLimit.js";
import {
  defaultRepricingUndercut,
  listRepricingEventsForConnection,
  listRepricingRulesForConnection,
  recordPriceChangeEvent,
  saveRepricingRule
} from "./repricing.js";
import { listRestockRulesForConnection, saveRestockRule } from "./restock.js";
import { attachCompetitorSellerNames } from "./sellerNames.js";
import { listProductCosts, saveProductCost } from "./productCosts.js";
import { soldAmazonUnitsSince } from "../inventory/store.js";

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
  authorizationRequired?: boolean;
};

const itemOffersCache = new Map<string, { expiresAt: number; value: ReturnType<typeof normalizeAmazonItemOffers> }>();
const itemOffersCacheTtlMs = 90_000;
const sellerStoreNameCache = new Map<string, { expiresAt: number; value?: string }>();
const sellerStoreNameCacheTtlMs = 6 * 60 * 60 * 1000;
const sellerStoreNameFailureCacheTtlMs = 5 * 60 * 1000;
const feesEstimateCache = new Map<string, { expiresAt: number; value: unknown }>();
const feesEstimateCacheTtlMs = 10 * 60 * 1000;
let nextFeesEstimateAt = 0;
const releaseCalendarCache = new Map<string, { expiresAt: number; value: unknown }>();
const releaseCalendarCacheTtlMs = 5 * 60 * 1000;
const releaseCalendarLookbackDays = 90;
const releaseCalendarMaxPages = 10;

function isAmazonAuthorizationFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return /failed:\s*(401|403)\b|\bunauthori[sz]ed\b|\bforbidden\b|access denied/i.test(message);
}

/**
 * One entry per connected Amazon seller account (newest first). Older
 * duplicates from earlier re-authorizations are hidden; their inventory sync
 * data is kept. Each entry carries the store name for the account switcher.
 */
publicAmazonRouter.get("/connections", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const seen = new Set<string>();
    const connections = (await listAmazonConnectionsForTenant(tenantId)).filter((connection) => {
      const key = `${connection.sellerId ?? connection.id}:${connection.marketplaceId}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
    const amazon = await Promise.all(connections.map(async (connection) => {
      const stored = await getAmazonConnectionForTenant(connection.id, tenantId);
      const storeName = stored
        ? await getCachedAmazonSellerStoreName({
          connectionId: connection.id,
          sellerId: stored.sellerId,
          refreshToken: stored.refreshToken,
          marketplaceId: stored.marketplaceId || config.AMAZON_MARKETPLACE_ID,
        })
        : undefined;

      return { ...connection, storeName };
    }));

    res.json({ amazon });
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
    const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
    const response = await searchSellerListings({
      sellerId: connection.sellerId,
      refreshToken: connection.refreshToken,
      accessToken,
      marketplaceId,
      pageSize,
      pageToken: pageToken || undefined,
      withStatus: "BUYABLE"
    });
    const normalized = normalizePricingListings(response, marketplaceId);
    const listings = await attachCatalogImagesToPricingListings({
      listings: normalized.listings,
      refreshToken: connection.refreshToken,
      accessToken,
      marketplaceId,
    });

    res.json({
      connectionId,
      marketplaceId,
      priceUpdatesEnabled: config.SCANNERAZ_PRICE_UPDATES_ENABLED,
      ...normalized,
      listings,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Load seller offers for one ASIN only when a user opens its details. Product
 * Pricing v2022 returns competitive offers and Featured Offer context without
 * loading or parsing the public Amazon retail page.
 */
publicAmazonRouter.get("/connections/:connectionId/items/:asin/offers", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const asin = String(req.params.asin ?? "").trim().toUpperCase();

    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      res.status(400).json({ error: "asin must be a 10-character ASIN" });
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const cacheKey = itemOffersCacheKey(tenantId, connectionId, marketplaceId, asin);
    const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
    const sellerStoreName = await getCachedAmazonSellerStoreName({
      connectionId,
      sellerId: connection.sellerId,
      refreshToken: connection.refreshToken,
      accessToken,
      marketplaceId,
    });
    const cached = getCachedItemOffers(cacheKey);

    if (cached) {
      res.json({
        connectionId,
        marketplaceId,
        cached: true,
        offers: (await attachCompetitorSellerNames([
          applyAmazonSellerStoreName(cached, connection.sellerId, sellerStoreName),
        ]))[0],
      });
      return;
    }

    const response = await withItemOffersBatchSlot(() => getAmazonItemOffersBatch({
      asins: [asin],
      refreshToken: connection.refreshToken,
      accessToken,
      marketplaceId
    }));
    const offers = normalizeAmazonItemOffersBatch(response, [asin])[0] ?? emptyItemOffersResult(asin);

    if (!offers.error) {
      cacheItemOffers(cacheKey, offers);
    }

    res.json({
      connectionId,
      marketplaceId,
      cached: false,
      offers: (await attachCompetitorSellerNames([
        applyAmazonSellerStoreName(offers, connection.sellerId, sellerStoreName),
      ]))[0],
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Compare the first page of active listings in one official Product Pricing
 * batch. Amazon permits at most 20 ASINs and gives this operation a low
 * default rate, so cache results briefly and pace uncached batch calls.
 */
publicAmazonRouter.post("/connections/:connectionId/listings/pricing/offers", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const asins = parseAmazonAsins(req.body?.asins);

    if (typeof asins === "string") {
      res.status(400).json({ error: asins });
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const cachedByAsin = new Map<string, ReturnType<typeof normalizeAmazonItemOffers>>();
    const missingAsins: string[] = [];

    for (const asin of asins) {
      const cached = getCachedItemOffers(itemOffersCacheKey(tenantId, connectionId, marketplaceId, asin));

      if (cached) {
        cachedByAsin.set(asin, cached);
      } else {
        missingAsins.push(asin);
      }
    }

    if (missingAsins.length) {
      const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
      const response = await withItemOffersBatchSlot(() => getAmazonItemOffersBatch({
        asins: missingAsins,
        refreshToken: connection.refreshToken,
        accessToken,
        marketplaceId
      }));
      const freshOffers = normalizeAmazonItemOffersBatch(response, missingAsins);

      for (const offers of freshOffers) {
        if (!offers.error) {
          cacheItemOffers(itemOffersCacheKey(tenantId, connectionId, marketplaceId, offers.asin), offers);
        }

        cachedByAsin.set(offers.asin, offers);
      }
    }

    res.json({
      connectionId,
      marketplaceId,
      offers: await attachCompetitorSellerNames(
        asins.map((asin) => cachedByAsin.get(asin) ?? emptyItemOffersResult(asin)),
      )
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
        code: "price_updates_disabled",
        error: "Price updates are paused by the ScannerAz server safety policy. This does not indicate that Amazon denied the app."
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

        try {
          await recordPriceChangeEvent({
            tenantId,
            connectionId,
            source: "manual",
            sku: prepared.sku,
            asin: prepared.asin,
            title: prepared.title,
            imageUrl: prepared.imageUrl,
            previousPrice: prepared.currentPrice,
            newPrice: prepared.targetPrice,
          });
        } catch (error) {
          // Amazon already accepted the change; history is best-effort.
          console.error(`Could not record manual price history for ${prepared.sku}`, error);
        }

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
          error: error instanceof Error ? error.message : "No pude preparar el cambio de precio.",
          authorizationRequired: isAmazonAuthorizationFailure(error)
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

/**
 * Release calendar for the Finances tab. Every amount comes from Amazon's
 * deferred transactions and their maturity date; nothing is estimated from
 * order data. Recent payment groups are added as bank-transfer markers.
 */
publicAmazonRouter.get("/connections/:connectionId/finances/release-calendar", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const cacheKey = `${tenantId}:${connectionId}`;
    const cached = releaseCalendarCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now() && req.query.refresh !== "1") {
      res.json(cached.value);
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
    const now = Date.now();
    const postedAfter = new Date(now - releaseCalendarLookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const transactions: AmazonDeferredTransaction[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    try {
      do {
        const page = await listAmazonDeferredTransactions({
          refreshToken: connection.refreshToken,
          accessToken,
          postedAfter,
          marketplaceId,
          nextToken,
        });
        transactions.push(...page.transactions);
        nextToken = page.nextToken;
        pages += 1;
      } while (nextToken && pages < releaseCalendarMaxPages);
    } catch (error) {
      if (!isAmazonAuthorizationFailure(error)) {
        throw error;
      }

      const preliminary = await buildPreliminaryReleaseEstimate({
        refreshToken: connection.refreshToken,
        accessToken,
        marketplaceId,
        now,
      });
      const value = {
        connectionId,
        marketplaceId,
        authorizationRequired: true,
        error: "Amazon requires the Finance and Accounting role to read payouts.",
        days: [],
        transfers: [],
        preliminary,
      };

      releaseCalendarCache.set(cacheKey, { value, expiresAt: now + releaseCalendarCacheTtlMs });
      res.json(value);
      return;
    }

    let transfers: AmazonFinancialEventGroup[] = [];

    try {
      transfers = (await getAmazonFinancialEventGroups({
        refreshToken: connection.refreshToken,
        accessToken,
        startedAfter: postedAfter,
        startedBefore: new Date(now - 3 * 60 * 1000).toISOString(),
      })).filter((group) => group.transferDate && group.amount !== undefined);
    } catch {
      // Transfers are supplementary context; the release calendar stands alone.
    }

    const days = buildAmazonReleaseCalendar(transactions);
    const value = {
      connectionId,
      marketplaceId,
      authorizationRequired: false,
      generatedAt: new Date(now).toISOString(),
      truncated: Boolean(nextToken),
      currency: days[0]?.currency ?? transfers[0]?.currency,
      totalPending: Math.round(days.reduce((sum, day) => sum + day.amount, 0) * 100) / 100,
      days,
      transfers,
    };

    releaseCalendarCache.set(cacheKey, { value, expiresAt: now + releaseCalendarCacheTtlMs });
    res.json(value);
  } catch (error) {
    next(error);
  }
});

publicAmazonRouter.get("/connections/:connectionId/repricing/rules", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    res.json({
      connectionId,
      priceUpdatesEnabled: config.SCANNERAZ_PRICE_UPDATES_ENABLED,
      rules: await listRepricingRulesForConnection(tenantId, connectionId),
    });
  } catch (error) {
    next(error);
  }
});

publicAmazonRouter.get("/connections/:connectionId/restock/rules", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    res.json({ connectionId, rules: await listRestockRulesForConnection(tenantId, connectionId) });
  } catch (error) {
    next(error);
  }
});

/**
 * Save the automatic restock rule for one SKU: when Amazon reports 0 units,
 * the scheduled cycle sets the merchant-fulfilled quantity back to `quantity`.
 */
publicAmazonRouter.put("/connections/:connectionId/restock/rules/:sku", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const sku = String(req.params.sku ?? "").trim();
    const quantity = Number(req.body?.quantity);

    if (!sku || sku.length > 200) {
      res.status(400).json({ error: "sku is invalid" });
      return;
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
      res.status(400).json({ error: "quantity must be a whole number between 1 and 10000" });
      return;
    }

    const rule = await saveRestockRule({
      tenantId,
      connectionId,
      sku,
      enabled: req.body?.enabled === true,
      quantity,
    });

    res.json({ rule });
  } catch (error) {
    next(error);
  }
});

publicAmazonRouter.get("/connections/:connectionId/repricing/history", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const requestedLimit = Number(req.query.limit ?? 100);
    const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 500
      ? requestedLimit
      : 100;

    res.json({
      connectionId,
      events: await listRepricingEventsForConnection(tenantId, connectionId, limit),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Save the automatic repricing rule for one SKU. The background repricer
 * matches the lowest competing offer and never goes below minPrice.
 */
publicAmazonRouter.put("/connections/:connectionId/repricing/rules/:sku", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const sku = String(req.params.sku ?? "").trim();
    const asin = String(req.body?.asin ?? "").trim().toUpperCase();
    const minPrice = Number(req.body?.minPrice);
    const enabled = req.body?.enabled === true;
    const strategy = req.body?.strategy === "match" ? "match" : "undercut";
    const undercutAmount = req.body?.undercutAmount === undefined
      ? defaultRepricingUndercut
      : Number(req.body.undercutAmount);

    if (!sku || sku.length > 200) {
      res.status(400).json({ error: "sku is invalid" });
      return;
    }

    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      res.status(400).json({ error: "asin is invalid" });
      return;
    }

    if (!Number.isFinite(minPrice) || minPrice <= 0 || minPrice > 100000) {
      res.status(400).json({ error: "minPrice must be greater than 0" });
      return;
    }

    if (strategy === "undercut" && (!Number.isFinite(undercutAmount) || undercutAmount < 0.01 || undercutAmount > 1000)) {
      res.status(400).json({ error: "undercutAmount must be at least 0.01" });
      return;
    }

    const rule = await saveRepricingRule({
      tenantId,
      connectionId,
      sku,
      asin,
      enabled,
      minPrice: Math.round(minPrice * 100) / 100,
      strategy,
      undercutAmount: Math.round((strategy === "undercut" ? undercutAmount : defaultRepricingUndercut) * 100) / 100,
    });

    res.json({ priceUpdatesEnabled: config.SCANNERAZ_PRICE_UPDATES_ENABLED, rule });
  } catch (error) {
    next(error);
  }
});

/**
 * Preliminary payout calendar from the last 30 days of orders, used while the
 * Finance and Accounting role is not authorized. Orders may need their own
 * role; when Amazon refuses, the caller learns that instead of an estimate.
 */
async function buildPreliminaryReleaseEstimate(input: {
  refreshToken: string;
  accessToken: string;
  marketplaceId: string;
  now: number;
}) {
  const orders: AmazonRecentOrder[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  try {
    do {
      const page = await listAmazonRecentOrders({
        refreshToken: input.refreshToken,
        accessToken: input.accessToken,
        marketplaceId: input.marketplaceId,
        createdAfter: new Date(input.now - 30 * 24 * 60 * 60 * 1000).toISOString(),
        nextToken,
      });
      orders.push(...page.orders);
      nextToken = page.nextToken;
      pages += 1;
    } while (nextToken && pages < 5);
  } catch (error) {
    return {
      available: false,
      ordersAuthorizationRequired: isAmazonAuthorizationFailure(error),
      days: [],
    };
  }

  const days = buildPreliminaryReleaseCalendar(orders, new Date(input.now));

  return {
    available: true,
    ordersAuthorizationRequired: false,
    feeRate: preliminaryFeeRate,
    orderCount: orders.length,
    truncated: Boolean(nextToken),
    currency: days[0]?.currency,
    totalPending: Math.round(days.reduce((sum, day) => sum + day.amount, 0) * 100) / 100,
    days,
  };
}

/**
 * Amazon's fee estimate for one ASIN at a price, FBA or FBM. Cached briefly;
 * calls are spaced to respect the 1 request/second limit.
 */
publicAmazonRouter.post("/connections/:connectionId/fees/estimate", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const asin = String(req.body?.asin ?? "").trim().toUpperCase();
    const price = Math.round(Number(req.body?.price) * 100) / 100;
    const isAmazonFulfilled = req.body?.fulfillment === "FBA";

    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      res.status(400).json({ error: "asin is invalid" });
      return;
    }

    if (!Number.isFinite(price) || price <= 0 || price > 100000) {
      res.status(400).json({ error: "price must be greater than 0" });
      return;
    }

    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const cacheKey = `${marketplaceId}:${asin}:${price}:${isAmazonFulfilled}`;
    const cached = feesEstimateCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.value);
      return;
    }

    const now = Date.now();
    const startAt = Math.max(now, nextFeesEstimateAt);
    nextFeesEstimateAt = startAt + 1100;

    if (startAt > now) {
      await delay(startAt - now);
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const value = await getAmazonFeesEstimate({
      refreshToken: connection.refreshToken,
      asin,
      price,
      isAmazonFulfilled,
      marketplaceId,
    });

    if (!value.error) {
      feesEstimateCache.set(cacheKey, { value, expiresAt: Date.now() + feesEstimateCacheTtlMs });
    }

    res.json(value);
  } catch (error) {
    next(error);
  }
});

publicAmazonRouter.get("/connections/:connectionId/product-costs", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    res.json({ connectionId, costs: await listProductCosts(tenantId, connectionId) });
  } catch (error) {
    next(error);
  }
});

publicAmazonRouter.put("/connections/:connectionId/product-costs/:sku", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const sku = String(req.params.sku ?? "").trim();
    const money = (value: unknown) => {
      if (value === undefined || value === null || value === "") {
        return undefined;
      }

      const number = Math.round(Number(value) * 100) / 100;
      return Number.isFinite(number) && number >= 0 && number <= 100000 ? number : NaN;
    };
    const costPrice = money(req.body?.costPrice);
    const salePrice = money(req.body?.salePrice);
    const fbmCost = money(req.body?.fbmCost) ?? 0;
    const quantity = Number(req.body?.quantity ?? 1);
    const asin = String(req.body?.asin ?? "").trim().toUpperCase();

    if (!sku || sku.length > 200) {
      res.status(400).json({ error: "sku is invalid" });
      return;
    }

    if ([costPrice, salePrice, fbmCost].some((value) => Number.isNaN(value))) {
      res.status(400).json({ error: "prices must be between 0 and 100000" });
      return;
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
      res.status(400).json({ error: "quantity must be a whole number of at least 1" });
      return;
    }

    const cost = await saveProductCost({
      tenantId,
      connectionId,
      sku,
      asin: /^[A-Z0-9]{10}$/.test(asin) ? asin : undefined,
      costPrice,
      salePrice,
      fulfillment: req.body?.fulfillment === "FBA" ? "FBA" : "FBM",
      fbmCost,
      quantity,
    });

    res.json({ cost });
  } catch (error) {
    next(error);
  }
});

/**
 * Current listing prices for specific products of this store (by ASIN or
 * SKU), e.g. to value inventory without paging through every listing.
 */
publicAmazonRouter.post("/connections/:connectionId/listings/prices", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection?.sellerId) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const clean = (value: unknown, pattern: RegExp) => Array.isArray(value)
      ? [...new Set(value.map((item) => String(item ?? "").trim()).filter((item) => pattern.test(item)))].slice(0, 100)
      : [];
    const asins = clean(req.body?.asins, /^[A-Za-z0-9]{10}$/).map((asin) => asin.toUpperCase());
    const skus = clean(req.body?.skus, /^.{1,200}$/);

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
    const prices = new Map<string, AmazonPricingListing>();
    const batches: Array<{ type: "ASIN" | "SKU"; ids: string[] }> = [];

    for (let index = 0; index < asins.length; index += 20) {
      batches.push({ type: "ASIN", ids: asins.slice(index, index + 20) });
    }

    for (let index = 0; index < skus.length; index += 20) {
      batches.push({ type: "SKU", ids: skus.slice(index, index + 20) });
    }

    for (const batch of batches) {
      const response = await searchSellerListings({
        sellerId: connection.sellerId,
        refreshToken: connection.refreshToken,
        accessToken,
        marketplaceId,
        pageSize: 20,
        identifiers: batch.ids,
        identifiersType: batch.type,
      });

      for (const listing of normalizePricingListings(response, marketplaceId).listings) {
        // Keep only exact matches for the requested identifiers.
        const matches = batch.type === "ASIN"
          ? Boolean(listing.asin && batch.ids.includes(listing.asin.toUpperCase()))
          : batch.ids.includes(listing.sku);

        if (matches) {
          prices.set(listing.sku, listing);
        }
      }
    }

    res.json({
      connectionId,
      listings: [...prices.values()].map((listing) => ({
        sku: listing.sku,
        asin: listing.asin,
        price: listing.price,
        currency: listing.currency,
      })),
    });
  } catch (error) {
    next(error);
  }
});

const storeListingsCache = new Map<string, { expiresAt: number; listings: AmazonPricingListing[] }>();
const storeListingsCacheTtlMs = 10 * 60 * 1000;

function titleTokens(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

const listingImageCache = new Map<string, string>();

/** Every active listing of a store, paged once and cached for 10 minutes. */
async function loadAllStoreListings(
  connectionId: string,
  connection: { sellerId?: string; refreshToken: string; marketplaceId?: string }
) {
  const cached = storeListingsCache.get(connectionId);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.listings;
  }

  const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
  const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
  const listings: AmazonPricingListing[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const response = await searchSellerListings({
      sellerId: connection.sellerId!,
      refreshToken: connection.refreshToken,
      accessToken,
      marketplaceId,
      pageSize: 20,
      pageToken,
    });
    const page = normalizePricingListings(response, marketplaceId);
    listings.push(...page.listings);
    pageToken = page.nextPageToken;
    pages += 1;
  } while (pageToken && pages < 50);

  storeListingsCache.set(connectionId, { listings, expiresAt: Date.now() + storeListingsCacheTtlMs });
  return listings;
}

/**
 * All of a store's active listings with images, for the Stock view. Images
 * are looked up 20 ASINs at a time and cached by ASIN.
 */
publicAmazonRouter.get("/connections/:connectionId/listings/all", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection?.sellerId) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const listings = await loadAllStoreListings(connectionId, connection);
    const missing = [...new Set(listings
      .map((listing) => listing.asin?.toUpperCase())
      .filter((asin): asin is string => Boolean(asin) && !listingImageCache.has(asin!)))].slice(0, 200);

    if (missing.length) {
      const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;

      for (let index = 0; index < missing.length; index += 20) {
        const chunk = missing.slice(index, index + 20).map((asin) => ({ asin } as AmazonPricingListing & { sku: string }));
        const withImages = await attachCatalogImagesToPricingListings({
          listings: chunk.map((entry) => ({ ...entry, sku: entry.asin! })),
          refreshToken: connection.refreshToken,
          accessToken,
          marketplaceId,
        });

        for (const entry of withImages as Array<AmazonPricingListing & { imageUrl?: string }>) {
          if (entry.asin && entry.imageUrl) {
            listingImageCache.set(entry.asin.toUpperCase(), entry.imageUrl);
          }
        }
      }
    }

    res.json({
      connectionId,
      listings: listings.map((listing) => ({
        sku: listing.sku,
        asin: listing.asin,
        title: listing.title,
        price: listing.price,
        imageUrl: listing.asin ? listingImageCache.get(listing.asin.toUpperCase()) : undefined,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Search this store's own listings by title. The catalog keyword search can
 * miss a seller's product when Amazon titles it differently, so receipts are
 * matched against the store's listings directly. Listings are paged once and
 * cached briefly.
 */
publicAmazonRouter.post("/connections/:connectionId/listings/search", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection?.sellerId) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const query = String(req.body?.query ?? "").trim().slice(0, 300);
    const queryTokens = [...new Set(titleTokens(query))];

    if (!queryTokens.length) {
      res.status(400).json({ error: "query is required" });
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const cached = { listings: await loadAllStoreListings(connectionId, connection) };

    const scored = cached.listings
      .map((listing) => {
        const tokens = new Set(titleTokens(listing.title ?? ""));
        const hits = queryTokens.filter((token) => tokens.has(token)).length;
        return { listing, score: hits / queryTokens.length };
      })
      .filter((entry) => entry.score >= 0.4)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
    const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
    const withImages = await attachCatalogImagesToPricingListings({
      listings: scored.map((entry) => entry.listing),
      refreshToken: connection.refreshToken,
      accessToken,
      marketplaceId,
    });

    res.json({
      connectionId,
      listings: withImages.map((listing, index) => ({ ...listing, score: scored[index]?.score })),
    });
  } catch (error) {
    next(error);
  }
});

const returnsSummaryCache = new Map<string, { expiresAt: number; value: unknown }>();
const pendingReturnsReports = new Map<string, { reportId: string; createdAt: number }>();
const returnsWindowDays = 60;

/**
 * Return rate for a store over the last 60 days from Amazon's FBM returns
 * report (every return request, whatever its status) against units sold in
 * synced Amazon orders. Reports are generated asynchronously: the first call
 * may answer `pending` and the app asks again shortly.
 */
publicAmazonRouter.get("/connections/:connectionId/returns/summary", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const cacheKey = `${tenantId}:${connectionId}`;
    const cached = returnsSummaryCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now() && req.query.refresh !== "1") {
      res.json(cached.value);
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const since = new Date(Date.now() - returnsWindowDays * 24 * 60 * 60 * 1000);
    const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
    let report: string | undefined;

    try {
      let pending = pendingReturnsReports.get(cacheKey);

      // A report request older than 10 minutes is abandoned and re-requested.
      if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
        const reportId = await createAmazonReport({
          refreshToken: connection.refreshToken,
          accessToken,
          reportType: "GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE",
          marketplaceId,
          dataStartTime: since.toISOString(),
        });
        pending = { reportId, createdAt: Date.now() };
        pendingReturnsReports.set(cacheKey, pending);
      }

      for (let attempt = 0; attempt < 5 && report === undefined; attempt += 1) {
        if (attempt > 0) {
          await delay(4000);
        }

        report = await fetchAmazonReportIfReady({
          refreshToken: connection.refreshToken,
          accessToken,
          reportId: pending.reportId,
        });
      }
    } catch (error) {
      if (isAmazonAuthorizationFailure(error)) {
        // Amazon's message tells whether the role is missing from the token.
        console.warn(JSON.stringify({
          event: "amazon.returns_report.denied",
          connectionId,
          message: error instanceof Error ? error.message.slice(0, 400) : String(error),
        }));
        res.json({ connectionId, days: returnsWindowDays, authorizationRequired: true });
        return;
      }

      throw error;
    }

    if (report === undefined) {
      res.json({ connectionId, days: returnsWindowDays, authorizationRequired: false, pending: true });
      return;
    }

    pendingReturnsReports.delete(cacheKey);
    const rows = parseAmazonReturnsReport(report);
    const countBy = (key: (row: (typeof rows)[number]) => string | undefined) => {
      const counts = new Map<string, number>();

      for (const row of rows) {
        const value = key(row);

        if (value) {
          counts.set(value, (counts.get(value) ?? 0) + row.quantity);
        }
      }

      return [...counts.entries()].sort((left, right) => right[1] - left[1]);
    };

    const value = {
      connectionId,
      days: returnsWindowDays,
      authorizationRequired: false,
      pending: false,
      returnedUnits: rows.reduce((sum, row) => sum + row.quantity, 0),
      returnRequests: rows.length,
      soldUnits: await soldAmazonUnitsSince(tenantId, connectionId, since),
      topSkus: countBy((row) => row.sku).slice(0, 5).map(([sku, units]) => ({ sku, units })),
      topReasons: countBy((row) => row.reason).slice(0, 3).map(([reason, units]) => ({ reason, units })),
      statuses: countBy((row) => row.status).map(([status, units]) => ({ status, units })),
    };

    returnsSummaryCache.set(cacheKey, { value, expiresAt: Date.now() + 30 * 60 * 1000 });
    res.json(value);
  } catch (error) {
    next(error);
  }
});

/**
 * Which data this store's authorization actually reaches: one minimal call
 * per area. "denied" means Amazon refused it (role missing from the store's
 * token, so the store must re-authorize); "error" is any other failure.
 */
publicAmazonRouter.get("/connections/:connectionId/permissions", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection?.sellerId) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;
    const probe = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return "granted" as const;
      } catch (error) {
        const denied = error instanceof AmazonOrdersRequestError
          ? error.status === 401 || error.status === 403
          : isAmazonAuthorizationFailure(error);
        return denied ? "denied" as const : "error" as const;
      }
    };
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [listings, orders, finances] = await Promise.all([
      probe(() => searchSellerListings({
        sellerId: connection.sellerId!,
        refreshToken: connection.refreshToken,
        accessToken,
        marketplaceId,
        pageSize: 1,
      })),
      probe(() => searchSellerOrders({
        refreshToken: connection.refreshToken,
        accessToken,
        marketplaceId,
        lastUpdatedAfter: dayAgo,
        maxResultsPerPage: 1,
      })),
      probe(() => getAmazonFinancialEventGroups({
        refreshToken: connection.refreshToken,
        accessToken,
        startedAfter: dayAgo,
        startedBefore: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        maxResultsPerPage: 1,
      })),
    ]);

    res.json({
      connectionId,
      checkedAt: new Date().toISOString(),
      permissions: [
        { key: "listings", label: "Productos y precios (Listings, Pricing)", status: listings },
        { key: "orders", label: "Pedidos y devoluciones", status: orders },
        { key: "finances", label: "Finanzas y pagos", status: finances },
      ],
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

function parseAmazonAsins(value: unknown): string[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    return "asins must contain between 1 and 20 ASINs";
  }

  const asins = Array.from(new Set(
    value
      .map((item) => String(item ?? "").trim().toUpperCase())
      .filter((asin) => /^[A-Z0-9]{10}$/.test(asin))
  ));

  if (!asins.length || asins.length !== value.length) {
    return "Each item in asins must be a 10-character ASIN";
  }

  return asins;
}

function itemOffersCacheKey(tenantId: string, connectionId: string, marketplaceId: string, asin: string) {
  return `${tenantId}:${connectionId}:${marketplaceId}:${asin}`;
}

function getCachedItemOffers(cacheKey: string) {
  const entry = itemOffersCache.get(cacheKey);

  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    itemOffersCache.delete(cacheKey);
    return undefined;
  }

  return entry.value;
}

function cacheItemOffers(cacheKey: string, value: ReturnType<typeof normalizeAmazonItemOffers>) {
  itemOffersCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + itemOffersCacheTtlMs
  });
}

async function attachCatalogImagesToPricingListings(input: {
  listings: AmazonPricingListing[];
  refreshToken: string;
  accessToken: string;
  marketplaceId: string;
}) {
  const asins = Array.from(new Set(
    input.listings
      .map((listing) => listing.asin?.trim().toUpperCase())
      .filter((asin): asin is string => Boolean(asin)),
  )).slice(0, 20);

  if (!asins.length) {
    return input.listings;
  }

  try {
    const response = await searchCatalogItems({
      identifiers: asins,
      identifierType: "ASIN",
      refreshToken: input.refreshToken,
      accessToken: input.accessToken,
      marketplaceId: input.marketplaceId,
      limit: asins.length,
    });
    const imageUrlByAsin = new Map(
      normalizeCatalogSearchResponse(response, input.marketplaceId)
        .filter((candidate) => Boolean(candidate.imageUrl))
        .map((candidate) => [candidate.asin.toUpperCase(), candidate.imageUrl!] as const),
    );

    return input.listings.map((listing) => {
      const imageUrl = listing.asin ? imageUrlByAsin.get(listing.asin.toUpperCase()) : undefined;
      return imageUrl ? { ...listing, imageUrl } : listing;
    });
  } catch {
    // Catalog Images is supplementary. Listings remain available when a
    // connection lacks the Catalog Items role or Amazon temporarily declines it.
    return input.listings;
  }
}

async function getCachedAmazonSellerStoreName(input: {
  connectionId: string;
  sellerId?: string;
  refreshToken: string;
  accessToken?: string;
  marketplaceId: string;
}) {
  if (!input.sellerId) {
    return undefined;
  }

  const cacheKey = `${input.connectionId}:${input.marketplaceId}`;
  const cached = sellerStoreNameCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const value = await getAmazonSellerStoreName({
      refreshToken: input.refreshToken,
      accessToken: input.accessToken,
      marketplaceId: input.marketplaceId,
    });

    sellerStoreNameCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + sellerStoreNameCacheTtlMs,
    });

    return value;
  } catch {
    // Product Pricing remains useful even when the optional Sellers role is
    // unavailable. Retry the storefront-name lookup after a short delay.
    sellerStoreNameCache.set(cacheKey, {
      expiresAt: Date.now() + sellerStoreNameFailureCacheTtlMs,
    });
    return undefined;
  }
}

function emptyItemOffersResult(asin: string) {
  return {
    asin,
    visibleOfferCount: 0,
    sellerCount: 0,
    fbaOfferCount: 0,
    fbmOfferCount: 0,
    amazonOfferCount: 0,
    buyBoxAvailable: false,
    offers: [],
    error: "Amazon did not return an offer result for this ASIN."
  };
}
