import express from "express";
import { APP_STORE_REVIEW_EMAIL } from "../storage/accounts.js";

export const appStoreReviewRouter = express.Router();
const connectionId = "app-store-review-connection";
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();

const products = [
  { id: "demo-product-mixer", sku: "DEMO-MIXER-001", asin: "B0DEMO0001", title: "3.5 Qt Stand Mixer", imageUrl: "/demo/stand-mixer.jpg", availableQuantity: 6, receivedQuantity: 12, soldQuantity: 6, customerReturnQuantity: 0, retailerReturnQuantity: 0, averageUnitCostCents: 4200, inventoryValueCents: 25200, lastActivityAt: iso(1) },
  { id: "demo-product-oil", sku: "DEMO-OIL-002", asin: "B0DEMO0002", title: "Pure Peanut Oil", imageUrl: "/demo/peanut-oil.jpg", availableQuantity: 14, receivedQuantity: 20, soldQuantity: 6, customerReturnQuantity: 1, retailerReturnQuantity: 0, averageUnitCostCents: 850, inventoryValueCents: 11900, lastActivityAt: iso(2) },
  { id: "demo-product-cooker", sku: "DEMO-COOKER-003", asin: "B0DEMO0003", title: "6 Qt Electric Multi-Cooker", imageUrl: "/demo/multi-cooker.jpg", availableQuantity: 3, receivedQuantity: 8, soldQuantity: 5, customerReturnQuantity: 0, retailerReturnQuantity: 1, averageUnitCostCents: 6100, inventoryValueCents: 18300, lastActivityAt: iso(3) },
];

const prices = [96.99, 79.5, 97];
const competitorPrices = [95.99, 78.5, 96.5];
const imageUrl = (req: express.Request, path: string) => {
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host");
  return `${req.protocol}://${host}${path}?v=20261010`;
};
const demoProducts = (req: express.Request) => products.map((product) => ({
  ...product,
  imageUrl: imageUrl(req, product.imageUrl),
}));
const demoOffers = (asin: string) => {
  const index = products.findIndex((product) => product.asin === asin);
  if (index < 0) return undefined;
  return {
    asin,
    visibleOfferCount: 2,
    sellerCount: 2,
    fbaOfferCount: 0,
    fbmOfferCount: 2,
    amazonOfferCount: 0,
    buyBoxAvailable: true,
    buyBoxSellerId: "TEST-COMPETITOR-001",
    buyBoxSellerName: "Demo competitor",
    buyBoxPrice: competitorPrices[index],
    currency: "USD",
    offers: [
      { sellerId: "TEST-COMPETITOR-001", sellerName: "Demo competitor", fulfillment: "FBM", condition: "New", listingPrice: competitorPrices[index], shippingPrice: 0, landedPrice: competitorPrices[index], currency: "USD", isBuyBoxWinner: true, isPrime: false },
      { sellerId: "TEST-SELLER-001", sellerName: "SellerAI Demo Store", fulfillment: "FBM", condition: "New", listingPrice: prices[index], shippingPrice: 0, landedPrice: prices[index], currency: "USD", isBuyBoxWinner: false, isPrime: false },
    ],
  };
};

const sales = [
  { id: "demo-sale-1", connectionId, title: products[0].title, asin: products[0].asin, sku: products[0].sku, imageUrl: products[0].imageUrl, quantity: 1, pendingQuantity: 0, unitPriceCents: 9699, pickup: true, shippingStatus: "delivered", fulfillmentStatus: "Shipped", status: "shipped", orderDate: iso(0), orderId: "DEMO-ORDER-1001", channel: "Amazon FBM" },
  { id: "demo-sale-2", connectionId, title: products[1].title, asin: products[1].asin, sku: products[1].sku, imageUrl: products[1].imageUrl, quantity: 2, pendingQuantity: 0, unitPriceCents: 7950, pickup: false, shippingStatus: "out_for_delivery", fulfillmentStatus: "Shipped", status: "confirmed", orderDate: iso(0), orderId: "DEMO-ORDER-1002", channel: "Amazon FBM" },
  { id: "demo-sale-3", connectionId, title: products[2].title, asin: products[2].asin, sku: products[2].sku, imageUrl: products[2].imageUrl, quantity: 1, pendingQuantity: 1, unitPriceCents: 9749, pickup: false, shippingStatus: "pending_pickup", fulfillmentStatus: "Pending", status: "pending", orderDate: iso(0), orderId: "DEMO-ORDER-1003", channel: "Amazon FBM" },
];

appStoreReviewRouter.use((req, _res, next) => {
  if (req.scannerazTenantSession?.email === APP_STORE_REVIEW_EMAIL) next();
  else next("router");
});

appStoreReviewRouter.use("/amazon/connections/:connectionId", (req, res, next) => {
  if (req.params.connectionId !== connectionId) {
    res.status(404).json({ error: "Demo store not found" });
    return;
  }
  next();
});

appStoreReviewRouter.get("/amazon/connections", (_req, res) => res.json({ amazon: [{ id: connectionId, sellerId: "TEST-SELLER-001", marketplaceId: "ATVPDKIKX0DER", connectedAt: iso(7), hasRefreshToken: true, storeName: "SellerAI Demo Store" }] }));
appStoreReviewRouter.get("/inventory/overview", (req, res) => res.json({ summary: { productCount: products.length, availableUnits: 23, unitsToBuy: 0, productsToBuy: 0, inventoryValueCents: 55400, totalInvestedCents: 116000, soldCostCents: 70500, soldUnits: 17, customerReturnUnits: 1, retailerReturnUnits: 1, pendingReturns: 0, unmatchedAmazonOrderLines: 0, insufficientAmazonOrderLines: 0, lastAmazonSalesSyncAt: iso(0) }, products: demoProducts(req), recentActivity: [], returns: [] }));
appStoreReviewRouter.get("/inventory/sales", (req, res) => res.json({ sales: sales.map((sale) => ({ ...sale, orderDate: iso(0), imageUrl: imageUrl(req, sale.imageUrl) })) }));
appStoreReviewRouter.get("/inventory/sales/columns", (_req, res) => res.json({ columns: [{ id: "demo-column-walmart", connectionId, name: "Pedido Walmart", checkedSaleIds: ["demo-sale-1"], createdAt: iso(5) }, { id: "demo-column-received", connectionId, name: "Recibido", checkedSaleIds: ["demo-sale-1", "demo-sale-2"], createdAt: iso(4) }] }));
appStoreReviewRouter.get("/inventory/invoices", (_req, res) => res.json({ invoices: [] }));
appStoreReviewRouter.get("/inventory/amazon-sales/:connectionId/sync-state", (_req, res) => res.json({ sync: { connectionId, lastSyncedAt: iso(0), status: "completed" } }));
appStoreReviewRouter.post("/inventory/amazon-sales/:connectionId/sync", (_req, res) => res.json({ connectionId, status: "completed", syncedOrders: sales.length, lastSyncedAt: iso(0) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/listings/pricing", (req, res) => res.json({ connectionId, marketplaceId: "ATVPDKIKX0DER", priceUpdatesEnabled: false, listings: demoProducts(req).map((p, index) => ({ sku: p.sku, asin: p.asin, title: p.title, imageUrl: p.imageUrl, price: prices[index], currency: "USD" })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/repricing/rules", (_req, res) => res.json({ connectionId, priceUpdatesEnabled: false, rules: products.map((p, index) => ({ connectionId, sku: p.sku, asin: p.asin, enabled: index < 2, minPrice: index === 1 ? 72 : 89.99, strategy: index === 1 ? "undercut" : "match", undercutAmount: 0.01, updatedAt: iso(index + 1), lastStatus: "updated", lastCompetitorPrice: 95.99, lastPrice: 96.99 })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/repricing/history", (req, res) => res.json({ connectionId, hasMore: false, events: demoProducts(req).map((p, index) => ({ id: `demo-event-${index}`, connectionId, kind: "price", source: "automatic", sku: p.sku, asin: p.asin, title: p.title, imageUrl: p.imageUrl, previousPrice: prices[index] - 2, newPrice: prices[index], competitorPrice: competitorPrices[index], strategy: "match", atMinimum: false, createdAt: iso(index + 1) })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/items/:asin/offers", (req, res) => {
  const offers = demoOffers(req.params.asin.toUpperCase());
  if (!offers) return res.status(404).json({ error: "Demo product not found" });
  return res.json({ connectionId, marketplaceId: "ATVPDKIKX0DER", cached: true, offers });
});
appStoreReviewRouter.post("/amazon/connections/:connectionId/listings/pricing/offers", (req, res) => {
  const asins = Array.isArray(req.body?.asins) ? req.body.asins : [];
  if (asins.length > 20 || asins.some((asin: unknown) => typeof asin !== "string")) {
    res.status(400).json({ error: "Invalid ASIN list" });
    return;
  }
  res.json({ connectionId, marketplaceId: "ATVPDKIKX0DER", offers: asins.map((asin: string) => demoOffers(asin.toUpperCase())).filter(Boolean) });
});
appStoreReviewRouter.get("/amazon/connections/:connectionId/listings/all", (req, res) => res.json({ connectionId, listings: demoProducts(req).map((p, index) => ({ sku: p.sku, asin: p.asin, title: p.title, imageUrl: p.imageUrl, price: prices[index] })) }));
appStoreReviewRouter.post("/amazon/connections/:connectionId/listings/prices", (req, res) => res.json({ connectionId, listings: products.filter((p) => req.body?.skus?.includes(p.sku) || req.body?.asins?.includes(p.asin)).map((p) => ({ sku: p.sku, asin: p.asin, price: prices[products.indexOf(p)], currency: "USD" })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/product-costs", (_req, res) => res.json({ connectionId, costs: products.map((p) => ({ connectionId, sku: p.sku, asin: p.asin, costPrice: p.averageUnitCostCents! / 100, salePrice: 96.99, fulfillment: "FBM", fbmCost: 10, quantity: p.availableQuantity, updatedAt: iso(2) })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/restock/rules", (_req, res) => res.json({ connectionId, rules: products.map((p) => ({ connectionId, sku: p.sku, enabled: true, quantity: 4, updatedAt: iso(3), lastStatus: "in_stock", lastQuantity: p.availableQuantity })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/permissions", (_req, res) => res.json({ connectionId, checkedAt: iso(0), permissions: [{ key: "orders", label: "Orders", status: "granted" }, { key: "listings", label: "Listings", status: "granted" }, { key: "finance", label: "Finance", status: "granted" }] }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/finances/release-calendar", (_req, res) => res.json({ connectionId, marketplaceId: "ATVPDKIKX0DER", authorizationRequired: false, generatedAt: iso(0), currency: "USD", totalPending: 412.76, days: [{ date: iso(0).slice(0, 10), amount: 412.76, currency: "USD", transactionCount: 5 }], transfers: [], preliminary: { available: true, ordersAuthorizationRequired: false, feeRate: 0.15, orderCount: 5, currency: "USD", totalPending: 412.76, days: [] } }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/returns/summary", (_req, res) => res.json({ connectionId, days: 60, authorizationRequired: false, returnedUnits: 1, returnRequests: 1, soldUnits: 17, topSkus: [{ sku: products[1].sku, asin: products[1].asin, title: products[1].title, units: 1 }], topReasons: [{ reason: "Customer return", units: 1 }], statuses: [{ status: "Completed", units: 1 }] }));
appStoreReviewRouter.get("/agent/messages", (_req, res) => res.json({ messages: [], hasMore: false }));
appStoreReviewRouter.post("/agent/messages", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const locale = req.body?.locale === "es" ? "es" : "en";
  if (!text) {
    res.status(400).json({ error: "Message text is required" });
    return;
  }

  const now = new Date().toISOString();
  const assistantContent = locale === "es"
    ? "Esta es una cuenta de demostración. Puedo mostrarte productos, inventario, ventas y precios de ejemplo para SellerAI."
    : "This is a demo account. I can show you sample products, inventory, sales, and pricing for SellerAI.";
  res.json({
    userMessage: { id: `demo-agent-user-${Date.now()}`, role: "user", content: text, inputKind: "text", createdAt: now },
    assistantMessage: { id: `demo-agent-assistant-${Date.now()}`, role: "assistant", content: assistantContent, inputKind: "text", createdAt: now },
  });
});

appStoreReviewRouter.use((_req, res) => {
  res.status(409).json({ error: "This action is unavailable in the App Store review demo.", code: "demo_action_unavailable" });
});
