import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { appStoreReviewRouter } from "./appStoreReview.js";

test("review account receives complete product offers without reaching live Amazon routes", async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.scannerazTenantSession = {
      userId: "review-user",
      tenantId: "review-tenant",
      email: req.get("x-test-email") || "test@warasoft.com",
      role: "owner",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    next();
  });
  app.use("/api/public", appStoreReviewRouter);
  app.use("/api/public", (_req, res) => res.status(599).json({ error: "live route reached" }));

  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/public`;
    const listingsResponse = await fetch(`${base}/amazon/connections/app-store-review-connection/listings/pricing`, {
      headers: { "x-forwarded-host": "scanneraz.warasoft.com", "x-forwarded-proto": "https" },
    });
    assert.equal(listingsResponse.status, 200);
    const listings = await listingsResponse.json() as { listings: Array<{ asin: string; imageUrl: string }> };
    assert.equal(listings.listings.length, 3);
    assert.equal(listings.listings[0].imageUrl, "http://scanneraz.warasoft.com/demo/stand-mixer.jpg?v=20261010");

    const offersResponse = await fetch(`${base}/amazon/connections/app-store-review-connection/listings/pricing/offers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asins: listings.listings.map((listing) => listing.asin) }),
    });
    assert.equal(offersResponse.status, 200);
    const result = await offersResponse.json() as { offers: Array<{ asin: string; buyBoxPrice: number; offers: unknown[] }> };
    assert.equal(result.offers.length, 3);
    assert.ok(result.offers.every((offer) => offer.buyBoxPrice > 0 && offer.offers.length === 2));

    const agentResponse = await fetch(`${base}/agent/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hola", locale: "es" }),
    });
    assert.equal(agentResponse.status, 200);
    const agentResult = await agentResponse.json() as { assistantMessage: { content: string } };
    assert.match(agentResult.assistantMessage.content, /demostración/);

    const unsupported = await fetch(`${base}/amazon/connections/app-store-review-connection/listings/pricing/match-buy-box`, { method: "POST" });
    assert.equal(unsupported.status, 409);

    const normalUser = await fetch(`${base}/amazon/connections/app-store-review-connection/listings/pricing/offers`, {
      method: "POST",
      headers: { "x-test-email": "regular@example.com" },
    });
    assert.equal(normalUser.status, 599);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
