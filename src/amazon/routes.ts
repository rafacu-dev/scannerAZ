import express from "express";
import { assertAmazonSpApiConfig, config } from "../config.js";
import { getListingsRestrictions, normalizeListingsRestrictions } from "./spapi.js";

export const amazonRouter = express.Router();

amazonRouter.post("/restrictions/check", async (req, res, next) => {
  try {
    assertAmazonSpApiConfig();

    const asin = String(req.body?.asin ?? "").trim().toUpperCase();
    const sellerId = String(req.body?.sellerId ?? config.AMAZON_SELLER_ID ?? "").trim();
    const conditionType = String(req.body?.conditionType ?? "new_new").trim();

    if (!asin) {
      res.status(400).json({ error: "Missing asin" });
      return;
    }

    if (!sellerId) {
      res.status(400).json({ error: "Missing sellerId or AMAZON_SELLER_ID" });
      return;
    }

    const response = await getListingsRestrictions({
      asin,
      sellerId,
      conditionType
    });
    const normalized = normalizeListingsRestrictions(response);

    res.json({
      asin,
      sellerId,
      marketplaceId: config.AMAZON_MARKETPLACE_ID,
      conditionType,
      ...normalized
    });
  } catch (error) {
    next(error);
  }
});
