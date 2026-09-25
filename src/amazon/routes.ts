import express from "express";
import { assertAmazonSpApiConfig, config } from "../config.js";
import { getListingsRestrictions, normalizeListingsRestrictions } from "./spapi.js";
import { getAmazonConnection, listAmazonConnections } from "../storage/connections.js";

export const amazonRouter = express.Router();

amazonRouter.get("/connections", async (_req, res, next) => {
  try {
    res.json({ amazon: await listAmazonConnections() });
  } catch (error) {
    next(error);
  }
});

async function checkRestrictions(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const connectionId = String(req.params.connectionId ?? req.body?.connectionId ?? "").trim();
    const connection = connectionId ? await getAmazonConnection(connectionId) : undefined;

    if (connectionId && !connection) {
      res.status(404).json({ error: "Amazon connection not found" });
      return;
    }

    const asin = String(req.body?.asin ?? "").trim().toUpperCase();
    const defaultSellerId = connection ? connection.sellerId : config.AMAZON_SELLER_ID;
    const sellerId = String(req.body?.sellerId ?? defaultSellerId ?? "").trim();
    const conditionType = String(req.body?.conditionType ?? "new_new").trim();
    const refreshToken = connection?.refreshToken ?? config.AMAZON_REFRESH_TOKEN;

    if (!asin) {
      res.status(400).json({ error: "Missing asin" });
      return;
    }

    if (!sellerId) {
      res.status(400).json({ error: "Missing sellerId for this connection" });
      return;
    }

    assertAmazonSpApiConfig(refreshToken);

    const response = await getListingsRestrictions({
      asin,
      sellerId,
      refreshToken: refreshToken!,
      conditionType
    });
    const normalized = normalizeListingsRestrictions(response);

    res.json({
      asin,
      sellerId,
      connectionId: connectionId || undefined,
      marketplaceId: config.AMAZON_MARKETPLACE_ID,
      spApiEnvironment: config.AMAZON_SP_API_ENVIRONMENT,
      conditionType,
      ...normalized
    });
  } catch (error) {
    next(error);
  }
}

amazonRouter.post("/restrictions/check", checkRestrictions);
amazonRouter.post("/connections/:connectionId/restrictions/check", checkRestrictions);
