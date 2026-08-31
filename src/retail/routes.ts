import express from "express";
import { z } from "zod";
import { searchAllClearance, searchRetailerClearance } from "./clearance.js";
import type { Retailer } from "./types.js";

export const retailRouter = express.Router();

const clearanceSchema = z.object({
  zipCode: z.string().regex(/^\d{5}$/),
  retailer: z.enum(["target", "walmart", "publix"]).optional(),
  radiusMiles: z.coerce.number().positive().max(100).default(25),
  limit: z.coerce.number().int().positive().max(500).default(100)
});

retailRouter.get("/clearance", async (req, res, next) => {
  try {
    const input = clearanceSchema.parse(req.query);

    if (input.retailer) {
      const products = await searchRetailerClearance(input.retailer as Retailer, input);
      res.json({
        zipCode: input.zipCode,
        retailer: input.retailer,
        count: products.length,
        products
      });
      return;
    }

    const results = await searchAllClearance(input);

    res.json({
      zipCode: input.zipCode,
      results
    });
  } catch (error) {
    next(error);
  }
});

retailRouter.get("/clearance.csv", async (req, res, next) => {
  try {
    const input = clearanceSchema.parse(req.query);
    const retailer = input.retailer ?? "target";
    const products = await searchRetailerClearance(retailer as Retailer, input);
    const header = [
      "search_term",
      "retailer",
      "retailer_product_id",
      "price",
      "regular_price",
      "discount_percent",
      "url"
    ];
    const rows = products.map((product) => [
      product.title,
      product.retailer,
      product.retailerProductId ?? "",
      product.price ?? "",
      product.regularPrice ?? "",
      product.discountPercent ?? "",
      product.url ?? ""
    ]);

    const csv = [header, ...rows]
      .map((row) =>
        row
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(",")
      )
      .join("\n");

    res
      .type("text/csv")
      .setHeader(
        "content-disposition",
        `attachment; filename="${retailer}-clearance-${input.zipCode}.csv"`
      )
      .send(`${csv}\n`);
  } catch (error) {
    next(error);
  }
});
