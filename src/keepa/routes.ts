import express from "express";
import {
  createStarterSellerSelection,
  findCandidateAsins,
  getProducts
} from "./client.js";

export const keepaRouter = express.Router();

keepaRouter.get("/candidates", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const candidateLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 50), 200) : 50;
    const selection = createStarterSellerSelection(candidateLimit);
    const candidates = await findCandidateAsins(selection);
    const products = await getProducts(candidates.asins.slice(0, candidateLimit));

    res.json({
      ...candidates,
      products: products.map((product) => ({
        asin: product.asin,
        title: product.title,
        brand: product.brand,
        manufacturer: product.manufacturer,
        rootCategory: product.rootCategory,
        salesRankReference: product.salesRankReference,
        monthlySold: product.monthlySold
      }))
    });
  } catch (error) {
    next(error);
  }
});
