import express from "express";
import { requireTenantSession } from "../auth/session.js";
import { APP_STORE_REVIEW_EMAIL } from "../storage/accounts.js";

export const appStoreReviewRouter = express.Router();
const connectionId = "app-store-review-connection";
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * 86400000).toISOString();

const products = [
  { id: "demo-product-mixer", sku: "DEMO-MIXER-001", asin: "B0DEMO0001", title: "Beautiful 3.5 Qt Stand Mixer", imageUrl: "https://placehold.co/160x160/png?text=Mixer", availableQuantity: 6, receivedQuantity: 12, soldQuantity: 6, customerReturnQuantity: 0, retailerReturnQuantity: 0, averageUnitCostCents: 4200, inventoryValueCents: 25200, lastActivityAt: iso(1) },
  { id: "demo-product-oil", sku: "DEMO-OIL-002", asin: "B0DEMO0002", title: "100% Pure Peanut Oil", imageUrl: "https://placehold.co/160x160/png?text=Oil", availableQuantity: 14, receivedQuantity: 20, soldQuantity: 6, customerReturnQuantity: 1, retailerReturnQuantity: 0, averageUnitCostCents: 850, inventoryValueCents: 11900, lastActivityAt: iso(2) },
  { id: "demo-product-cooker", sku: "DEMO-COOKER-003", asin: "B0DEMO0003", title: "6 Qt Electric Multi-Cooker", imageUrl: "https://placehold.co/160x160/png?text=Cooker", availableQuantity: 3, receivedQuantity: 8, soldQuantity: 5, customerReturnQuantity: 0, retailerReturnQuantity: 1, averageUnitCostCents: 6100, inventoryValueCents: 18300, lastActivityAt: iso(3) },
];

const sales = [
  { id: "demo-sale-1", connectionId, title: products[0].title, asin: products[0].asin, sku: products[0].sku, imageUrl: products[0].imageUrl, quantity: 1, pendingQuantity: 0, unitPriceCents: 9699, pickup: true, shippingStatus: "delivered", fulfillmentStatus: "Shipped", status: "shipped", orderDate: iso(0), orderId: "DEMO-ORDER-1001", channel: "Amazon FBM" },
  { id: "demo-sale-2", connectionId, title: products[1].title, asin: products[1].asin, sku: products[1].sku, imageUrl: products[1].imageUrl, quantity: 2, pendingQuantity: 0, unitPriceCents: 7950, pickup: false, shippingStatus: "out_for_delivery", fulfillmentStatus: "Shipped", status: "confirmed", orderDate: iso(0), orderId: "DEMO-ORDER-1002", channel: "Amazon FBM" },
  { id: "demo-sale-3", connectionId, title: products[2].title, asin: products[2].asin, sku: products[2].sku, imageUrl: products[2].imageUrl, quantity: 1, pendingQuantity: 1, unitPriceCents: 9749, pickup: false, shippingStatus: "pending_pickup", fulfillmentStatus: "Pending", status: "pending", orderDate: iso(0), orderId: "DEMO-ORDER-1003", channel: "Amazon FBM" },
];

appStoreReviewRouter.use(requireTenantSession, (req, _res, next) => {
  if (req.scannerazTenantSession?.email === APP_STORE_REVIEW_EMAIL) next();
  else next("route");
});

appStoreReviewRouter.get("/amazon/connections", (_req, res) => res.json({ amazon: [{ id: connectionId, sellerId: "TEST-SELLER-001", marketplaceId: "ATVPDKIKX0DER", connectedAt: iso(7), hasRefreshToken: true, storeName: "SellerAI Demo Store" }] }));
appStoreReviewRouter.get("/inventory/overview", (_req, res) => res.json({ summary: { productCount: products.length, availableUnits: 23, unitsToBuy: 0, productsToBuy: 0, inventoryValueCents: 55400, totalInvestedCents: 116000, soldCostCents: 70500, soldUnits: 17, customerReturnUnits: 1, retailerReturnUnits: 1, pendingReturns: 0, unmatchedAmazonOrderLines: 0, insufficientAmazonOrderLines: 0, lastAmazonSalesSyncAt: iso(0) }, products, recentActivity: [], returns: [] }));
appStoreReviewRouter.get("/inventory/sales", (_req, res) => res.json({ sales }));
appStoreReviewRouter.get("/inventory/sales/columns", (_req, res) => res.json({ columns: [{ id: "demo-column-walmart", connectionId, name: "Pedido Walmart", checkedSaleIds: ["demo-sale-1"], createdAt: iso(5) }, { id: "demo-column-received", connectionId, name: "Recibido", checkedSaleIds: ["demo-sale-1", "demo-sale-2"], createdAt: iso(4) }] }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/listings/pricing", (_req, res) => res.json({ connectionId, marketplaceId: "ATVPDKIKX0DER", priceUpdatesEnabled: false, listings: products.map((p) => ({ sku: p.sku, asin: p.asin, title: p.title, imageUrl: p.imageUrl, price: 96.99, currency: "USD" })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/repricing/rules", (_req, res) => res.json({ connectionId, priceUpdatesEnabled: false, rules: products.map((p, index) => ({ connectionId, sku: p.sku, asin: p.asin, enabled: index < 2, minPrice: index === 1 ? 72 : 89.99, strategy: index === 1 ? "undercut" : "match", undercutAmount: 0.01, updatedAt: iso(index + 1), lastStatus: "updated", lastCompetitorPrice: 95.99, lastPrice: 96.99 })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/repricing/history", (_req, res) => res.json({ connectionId, hasMore: false, events: products.map((p, index) => ({ id: `demo-event-${index}`, connectionId, kind: "price", source: "automatic", sku: p.sku, asin: p.asin, title: p.title, imageUrl: p.imageUrl, previousPrice: 94.99, newPrice: 96.99, competitorPrice: 96.99, strategy: "match", atMinimum: false, createdAt: iso(index + 1) })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/items/:asin/offers", (req, res) => res.json({ connectionId, marketplaceId: "ATVPDKIKX0DER", cached: true, offers: { asin: req.params.asin, visibleOfferCount: 8, sellerCount: 8, fbaOfferCount: 3, fbmOfferCount: 5, amazonOfferCount: 0, buyBoxAvailable: true, buyBoxSellerId: "TEST-SELLER-001", buyBoxSellerName: "SellerAI Demo Store", buyBoxPrice: 96.99, currency: "USD", offers: [{ sellerId: "TEST-SELLER-001", sellerName: "SellerAI Demo Store", fulfillment: "FBM", condition: "New", listingPrice: 96.99, shippingPrice: 0, landedPrice: 96.99, currency: "USD", isBuyBoxWinner: true, isPrime: false }] } }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/listings/all", (_req, res) => res.json({ connectionId, listings: products.map(({ sku, asin, title, imageUrl }) => ({ sku, asin, title, imageUrl })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/product-costs", (_req, res) => res.json({ connectionId, costs: products.map((p) => ({ connectionId, sku: p.sku, asin: p.asin, costPrice: p.averageUnitCostCents! / 100, salePrice: 96.99, fulfillment: "FBM", fbmCost: 10, quantity: p.availableQuantity, updatedAt: iso(2) })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/restock/rules", (_req, res) => res.json({ connectionId, rules: products.map((p) => ({ connectionId, sku: p.sku, enabled: true, quantity: 4, updatedAt: iso(3), lastStatus: "in_stock", lastQuantity: p.availableQuantity })) }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/permissions", (_req, res) => res.json({ connectionId, checkedAt: iso(0), permissions: [{ key: "orders", label: "Orders", status: "granted" }, { key: "listings", label: "Listings", status: "granted" }, { key: "finance", label: "Finance", status: "granted" }] }));
appStoreReviewRouter.get("/amazon/connections/:connectionId/finances/release-calendar", (_req, res) => res.json({ connectionId, marketplaceId: "ATVPDKIKX0DER", authorizationRequired: false, generatedAt: iso(0), currency: "USD", totalPending: 412.76, days: [{ date: iso(0).slice(0, 10), amount: 412.76, currency: "USD", transactionCount: 5 }], transfers: [], preliminary: { available: true, ordersAuthorizationRequired: false, feeRate: 0.15, orderCount: 5, currency: "USD", totalPending: 412.76, days: [] } }));
