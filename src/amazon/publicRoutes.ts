import express from "express";
import { assertAmazonSpApiConfig, config } from "../config.js";
import {
  deleteAmazonConnectionForTenant,
  getAmazonConnectionForTenant,
  listAmazonConnectionsForTenant
} from "../storage/connections.js";
import {
  getListingsRestrictions,
  getLwaAccessToken,
  inferCatalogIdentifierType,
  normalizeCatalogSearchResponse,
  normalizeListingsRestrictions,
  searchCatalogItems
} from "./spapi.js";

export const publicAmazonRouter = express.Router();

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
