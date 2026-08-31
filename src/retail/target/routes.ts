import express from "express";
import { z } from "zod";
import { searchTarget, searchTargetClearanceWithDetails } from "./client.js";
import { findTargetStoresByZip } from "./stores.js";

export const targetRouter = express.Router();

const searchSchema = z.object({
  query: z.string().min(2),
  zipCode: z.string().regex(/^\d{5}$/).optional(),
  page: z.coerce.number().int().positive().optional()
});

targetRouter.get("/search", async (req, res, next) => {
  try {
    const input = searchSchema.parse(req.query);
    const results = await searchTarget(input);

    res.json({
      query: input.query,
      zipCode: input.zipCode,
      count: results.length,
      results
    });
  } catch (error) {
    next(error);
  }
});

targetRouter.get("/stores", async (req, res, next) => {
  try {
    const input = z.object({ zipCode: z.string().regex(/^\d{5}$/) }).parse(req.query);
    res.json(await findTargetStoresByZip(input.zipCode));
  } catch (error) {
    next(error);
  }
});

targetRouter.get("/clearance/details", async (req, res, next) => {
  try {
    const input = z
      .object({
        zipCode: z.string().regex(/^\d{5}$/),
        limit: z.coerce.number().int().positive().max(25).default(10)
      })
      .parse(req.query);

    const products = await searchTargetClearanceWithDetails(input);

    res.json({
      zipCode: input.zipCode,
      count: products.length,
      products
    });
  } catch (error) {
    next(error);
  }
});

targetRouter.get("/clearance/details.csv", async (req, res, next) => {
  try {
    const input = z
      .object({
        zipCode: z.string().regex(/^\d{5}$/),
        limit: z.coerce.number().int().positive().max(100).default(33)
      })
      .parse(req.query);

    const products = await searchTargetClearanceWithDetails(input);
    const header = [
      "amazon_search_id",
      "target_tcin",
      "title",
      "price",
      "regular_price",
      "discount_percent",
      "target_url"
    ];
    const rows = products.map((product) => [
      product.upc ?? "",
      product.retailerProductId ?? "",
      product.title,
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
        `attachment; filename="target-clearance-details-${input.zipCode}.csv"`
      )
      .send(`${csv}\n`);
  } catch (error) {
    next(error);
  }
});
