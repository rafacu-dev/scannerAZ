import express from "express";
import { assertAmazonSpApiConfig, config } from "../config.js";
import {
  deleteAmazonConnectionForTenant,
  getAmazonConnectionForTenant,
  listAmazonConnectionsForTenant
} from "../storage/connections.js";
import { getListingsRestrictions, normalizeListingsRestrictions } from "./spapi.js";

export const publicAmazonRouter = express.Router();

publicAmazonRouter.get("/connections", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    res.json({ amazon: await listAmazonConnectionsForTenant(tenantId) });
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
