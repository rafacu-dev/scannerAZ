import assert from "node:assert/strict";
import test from "node:test";
import { computeRepricingTarget } from "./repricing.js";

const own = { sellerId: "OWN", fulfillment: "FBM" as const, condition: "new", listingPrice: 20, shippingPrice: 3, landedPrice: 23 };

test("stays 10 cents below the lowest competitor landed price net of own shipping", () => {
  const decision = computeRepricingTarget({
    offers: [
      own,
      { sellerId: "A", fulfillment: "FBA", condition: "new", listingPrice: 21.5, landedPrice: 21.5 },
      { sellerId: "B", fulfillment: "FBM", condition: "new", listingPrice: 19, shippingPrice: 4, landedPrice: 23 },
    ],
    ownSellerId: "own",
    currentPrice: 20,
    minPrice: 10,
    strategy: "undercut",
    undercutAmount: 0.1,
  });

  assert.deepEqual(decision, { status: "unchanged", competitorPrice: 21.5, targetPrice: 18.4 });
});

test("never goes below the seller minimum", () => {
  const decision = computeRepricingTarget({
    offers: [own, { sellerId: "A", fulfillment: "FBA", condition: "new", landedPrice: 12 }],
    ownSellerId: "OWN",
    currentPrice: 20,
    minPrice: 15,
    strategy: "undercut",
    undercutAmount: 0.1,
  });

  assert.deepEqual(decision, { status: "at_minimum", competitorPrice: 12, targetPrice: 15 });
});

test("ignores other conditions and reports when there is no competitor", () => {
  const decision = computeRepricingTarget({
    offers: [own, { sellerId: "A", fulfillment: "FBM", condition: "used", landedPrice: 5 }],
    ownSellerId: "OWN",
    currentPrice: 20,
    minPrice: 1,
    strategy: "undercut",
    undercutAmount: 0.1,
  });

  assert.deepEqual(decision, { status: "no_competitors" });
});

test("follows a competitor price increase while staying 10 cents below", () => {
  const decision = computeRepricingTarget({
    offers: [{ ...own, shippingPrice: 0, landedPrice: 18.9 }, { sellerId: "A", fulfillment: "FBA", condition: "new", landedPrice: 21 }],
    ownSellerId: "OWN",
    currentPrice: 18.9,
    minPrice: 15,
    strategy: "undercut",
    undercutAmount: 0.1,
  });

  assert.deepEqual(decision, { status: "unchanged", competitorPrice: 21, targetPrice: 20.9 });
});

test("match strategy equals the lowest competitor exactly", () => {
  const decision = computeRepricingTarget({
    offers: [own, { sellerId: "A", fulfillment: "FBA", condition: "new", landedPrice: 21.5 }],
    ownSellerId: "OWN",
    currentPrice: 20,
    minPrice: 10,
    strategy: "match",
    undercutAmount: 0.05,
  });

  assert.deepEqual(decision, { status: "unchanged", competitorPrice: 21.5, targetPrice: 18.5 });
});

test("undercut strategy uses the configured amount", () => {
  const decision = computeRepricingTarget({
    offers: [own, { sellerId: "A", fulfillment: "FBA", condition: "new", landedPrice: 21.5 }],
    ownSellerId: "OWN",
    currentPrice: 20,
    minPrice: 10,
    strategy: "undercut",
    undercutAmount: 0.05,
  });

  assert.deepEqual(decision, { status: "unchanged", competitorPrice: 21.5, targetPrice: 18.45 });
});

test("recognizes Expo push tokens", async () => {
  const { isExpoPushToken } = await import("../notifications/push.js");
  assert.equal(isExpoPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"), true);
  assert.equal(isExpoPushToken("not-a-token"), false);
});
