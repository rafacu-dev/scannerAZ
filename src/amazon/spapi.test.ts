import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAmazonSellerStoreName,
  buildAmazonReleaseCalendar,
  buildPreliminaryReleaseCalendar,
  buildAmazonItemOffersBatchRequest,
  buildAmazonCatalogSearchUrl,
  buildAmazonOrdersSearchUrl,
  getSpApiEndpoint,
  inferCatalogIdentifierType,
  normalizeAmazonDeferredTransactions,
  normalizeAmazonFeesEstimate,
  parseAmazonReturnsReport,
  normalizeAmazonItemOffers,
  normalizeAmazonItemOffersBatch,
  normalizeCatalogSearchResponse,
  normalizeAmazonOrderSearch,
  normalizePricingListings,
  prepareListingPriceUpdate,
  prepareListingRestock
} from "./spapi.js";

test("uses the North America sandbox endpoint when requested", () => {
  assert.equal(
    getSpApiEndpoint("na", "sandbox"),
    "https://sandbox.sellingpartnerapi-na.amazon.com"
  );
});

test("uses the regional production endpoint when requested", () => {
  assert.equal(
    getSpApiEndpoint("eu", "production"),
    "https://sellingpartnerapi-eu.amazon.com"
  );
});

test("keeps the original filters when continuing an Amazon Orders page", () => {
  const url = buildAmazonOrdersSearchUrl({
    marketplaceId: "ATVPDKIKX0DER",
    lastUpdatedAfter: "2026-09-01T00:00:00.000Z",
    paginationToken: "next-page-token",
    maxResultsPerPage: 100
  });

  assert.equal(url.pathname, "/orders/2026-01-01/orders");
  assert.equal(url.searchParams.get("marketplaceIds"), "ATVPDKIKX0DER");
  assert.equal(url.searchParams.get("lastUpdatedAfter"), "2026-09-01T00:00:00.000Z");
  assert.equal(url.searchParams.get("maxResultsPerPage"), "100");
  assert.equal(url.searchParams.get("includedData"), "FULFILLMENT,PROCEEDS");
  assert.equal(url.searchParams.get("paginationToken"), "next-page-token");
});

test("builds one exact UPC catalog lookup for a receipt batch", () => {
  const url = buildAmazonCatalogSearchUrl({
    identifiers: ["012345678905", "123456789012"],
    identifierType: "UPC",
    marketplaceId: "ATVPDKIKX0DER",
    limit: 20
  });

  assert.equal(url.pathname, "/catalog/2022-04-01/items");
  assert.equal(url.searchParams.get("marketplaceIds"), "ATVPDKIKX0DER");
  assert.equal(url.searchParams.get("identifiers"), "012345678905,123456789012");
  assert.equal(url.searchParams.get("identifiersType"), "UPC");
  assert.equal(url.searchParams.get("includedData"), "summaries,identifiers,images");
});

test("infers catalog identifier types without treating product names as identifiers", () => {
  assert.equal(inferCatalogIdentifierType("B0GSDRQN6L"), "ASIN");
  assert.equal(inferCatalogIdentifierType("0416044394225"), "EAN");
  assert.equal(inferCatalogIdentifierType("not an identifier"), undefined);
});

test("normalizes catalog summaries, identifiers, and the main image", () => {
  const candidates = normalizeCatalogSearchResponse({
    items: [
      {
        asin: "B0GSDRQN6L",
        summaries: [
          {
            marketplaceId: "ATVPDKIKX0DER",
            itemName: "Beautiful multi-cooker",
            brandName: "Beautiful"
          }
        ],
        identifiers: [
          {
            marketplaceId: "ATVPDKIKX0DER",
            identifiers: [
              { identifierType: "UPC", identifier: "123456789012" },
              { identifierType: "EAN", identifier: "0123456789012" }
            ]
          }
        ],
        images: [
          {
            marketplaceId: "ATVPDKIKX0DER",
            images: [
              { variant: "PT01", link: "https://images.example.test/alternate.jpg" },
              { variant: "MAIN", link: "https://images.example.test/main.jpg" }
            ]
          }
        ]
      }
    ]
  });

  assert.deepEqual(candidates, [
    {
      asin: "B0GSDRQN6L",
      title: "Beautiful multi-cooker",
      brand: "Beautiful",
      imageUrl: "https://images.example.test/main.jpg",
      upc: "123456789012",
      ean: "0123456789012",
      identifiers: [
        { type: "UPC", value: "123456789012" },
        { type: "EAN", value: "0123456789012" }
      ]
    }
  ]);
});

test("normalizes seller listings with their SKU, type, and current offer price", () => {
  const result = normalizePricingListings({
    items: [
      {
        sku: "beautiful-cooker-white",
        summaries: [
          {
            marketplaceId: "ATVPDKIKX0DER",
            asin: "B0GSDRQN6L",
            itemName: "Beautiful multi-cooker",
            status: ["BUYABLE", "DISCOVERABLE"]
          }
        ],
        productTypes: [
          { marketplaceId: "ATVPDKIKX0DER", productType: "KITCHEN" }
        ],
        attributes: {
          purchasable_offer: [
            {
              marketplace_id: "ATVPDKIKX0DER",
              audience: "ALL",
              currency: "USD",
              our_price: [{ schedule: [{ value_with_tax: 109.99 }] }]
            }
          ]
        }
      },
      {
        sku: "inactive-cooker",
        summaries: [
          {
            marketplaceId: "ATVPDKIKX0DER",
            asin: "B0INACTIVE",
            itemName: "Inactive multi-cooker",
            status: ["DISCOVERABLE"]
          }
        ],
        productTypes: [
          { marketplaceId: "ATVPDKIKX0DER", productType: "KITCHEN" }
        ],
        attributes: {
          purchasable_offer: [
            {
              marketplace_id: "ATVPDKIKX0DER",
              audience: "ALL",
              currency: "USD",
              our_price: [{ schedule: [{ value_with_tax: 19.99 }] }]
            }
          ]
        }
      }
    ],
    pagination: { nextToken: "next-page" }
  });

  assert.deepEqual(result, {
    listings: [
      {
        sku: "beautiful-cooker-white",
        asin: "B0GSDRQN6L",
        title: "Beautiful multi-cooker",
        productType: "KITCHEN",
        price: 109.99,
        currency: "USD"
      }
    ],
    nextPageToken: "next-page"
  });
});

test("builds current Product Pricing competitive-summary requests without a public storefront", () => {
  const batch = buildAmazonItemOffersBatchRequest({
    asins: ["B0GSDRQN6L", "B0GVLXSM9B", "B0GSDRQN6L"],
    marketplaceId: "ATVPDKIKX0DER"
  });

  assert.equal(batch.url.pathname, "/batches/products/pricing/2022-05-01/items/competitiveSummary");
  assert.deepEqual(batch.body, {
    requests: [
      {
        asin: "B0GSDRQN6L",
        marketplaceId: "ATVPDKIKX0DER",
        includedData: ["featuredBuyingOptions", "lowestPricedOffers"],
        lowestPricedOffersInputs: [{ itemCondition: "New", offerType: "Consumer" }],
        uri: "/products/pricing/2022-05-01/items/competitiveSummary",
        method: "GET",
      },
      {
        asin: "B0GVLXSM9B",
        marketplaceId: "ATVPDKIKX0DER",
        includedData: ["featuredBuyingOptions", "lowestPricedOffers"],
        lowestPricedOffersInputs: [{ itemCondition: "New", offerType: "Consumer" }],
        uri: "/products/pricing/2022-05-01/items/competitiveSummary",
        method: "GET",
      }
    ]
  });
});

test("normalizes current Product Pricing offers and the Featured Offer", () => {
  const offers = normalizeAmazonItemOffers({
    asin: "B0GSDRQN6L",
    featuredBuyingOptions: [{
      buyingOptionType: "New",
      segmentedFeaturedOffers: [{
        sellerId: "A-LOWEST",
        condition: "New",
        fulfillmentType: "MFN",
        listingPrice: { amount: 85, currencyCode: "USD" },
        shippingOptions: [{ shippingOptionType: "DEFAULT", price: { amount: 4.99, currencyCode: "USD" } }]
      }]
    }],
    lowestPricedOffers: [{
      lowestPricedOffersInput: { itemCondition: "New", offerType: "Consumer" },
      offers: [
        {
          sellerId: "A-LOWEST",
          condition: "New",
          fulfillmentType: "MFN",
          listingPrice: { amount: 85, currencyCode: "USD" },
          shippingOptions: [{ shippingOptionType: "DEFAULT", price: { amount: 4.99, currencyCode: "USD" } }]
        },
        {
          sellerId: "A-FBA",
          condition: "New",
          fulfillmentType: "AFN",
          listingPrice: { amount: 90, currencyCode: "USD" },
          primeDetails: { eligibleForPrime: true }
        }
      ]
    }]
  }, "B0GSDRQN6L");

  assert.deepEqual(offers, {
    asin: "B0GSDRQN6L",
    visibleOfferCount: 2,
    sellerCount: 2,
    fbaOfferCount: 1,
    fbmOfferCount: 1,
    amazonOfferCount: 0,
    buyBoxAvailable: true,
    buyBoxSellerId: "A-LOWEST",
    buyBoxPrice: 89.99,
    currency: "USD",
    offers: [
      {
        sellerId: "A-LOWEST",
        fulfillment: "FBM",
        condition: "New",
        listingPrice: 85,
        shippingPrice: 4.99,
        landedPrice: 89.99,
        currency: "USD",
        isBuyBoxWinner: true
      },
      {
        sellerId: "A-FBA",
        fulfillment: "FBA",
        condition: "New",
        listingPrice: 90,
        landedPrice: 90,
        currency: "USD",
        isPrime: true
      }
    ]
  });
});

test("adds the verified storefront name only to the authorized seller", () => {
  const details = normalizeAmazonItemOffers({
    asin: "B0GSDRQN6L",
    featuredBuyingOptions: [{
      segmentedFeaturedOffers: [{
        sellerId: "A-OWN",
        fulfillmentType: "MFN",
        listingPrice: { amount: 89.99, currencyCode: "USD" },
      }],
    }],
    lowestPricedOffers: [{
      offers: [
        { sellerId: "A-OWN", fulfillmentType: "MFN", listingPrice: { amount: 89.99, currencyCode: "USD" } },
        { sellerId: "A-OTHER", fulfillmentType: "AFN", listingPrice: { amount: 90, currencyCode: "USD" } },
      ],
    }],
  }, "B0GSDRQN6L");
  const named = applyAmazonSellerStoreName(details, "A-OWN", "Wara Shop US");

  assert.equal(named.buyBoxSellerName, "Wara Shop US");
  assert.equal(named.offers.find((offer) => offer.sellerId === "A-OWN")?.sellerName, "Wara Shop US");
  assert.equal(named.offers.find((offer) => offer.sellerId === "A-OTHER")?.sellerName, undefined);
});

test("keeps successful Product Pricing batch results when another ASIN fails", () => {
  const results = normalizeAmazonItemOffersBatch({
    responses: [
      {
        status: { statusCode: 200 },
        body: {
          asin: "B0GSDRQN6L",
          lowestPricedOffers: []
        }
      },
      {
        status: { statusCode: 400 },
        request: { ASIN: "B0GVLXSM9B" },
        body: { errors: [{ code: "InvalidInput", message: "ASIN is invalid" }] }
      }
    ]
  }, ["B0GSDRQN6L", "B0GVLXSM9B"]);

  assert.equal(results[0].asin, "B0GSDRQN6L");
  assert.equal(results[0].error, undefined);
  assert.equal(results[1].asin, "B0GVLXSM9B");
  assert.equal(results[1].error, "InvalidInput: ASIN is invalid");
});

test("normalizes fulfillment-only order lines without buyer or recipient data", () => {
  const result = normalizeAmazonOrderSearch({
    orders: [{
      orderId: "111-2222222-3333333",
      createdTime: "2026-09-01T10:00:00Z",
      lastUpdatedTime: "2026-09-02T12:00:00Z",
      fulfillment: {
        fulfillmentStatus: "PARTIALLY_SHIPPED",
        fulfilledBy: "AMAZON"
      },
      // These fields deliberately prove that the normalizer does not carry PII.
      buyer: { buyerName: "Do not retain", buyerEmail: "buyer@example.test" },
      recipient: { deliveryAddress: { addressLine1: "Do not retain" } },
      orderItems: [
        {
          orderItemId: "line-1",
          quantityOrdered: 3,
          product: {
            asin: "B0GSDRQN6L",
            sellerSku: "BEAUTIFUL-COOKER",
            title: "Beautiful multi-cooker",
            condition: { conditionType: "NEW" }
          },
          fulfillment: { quantityFulfilled: 2 }
        },
        {
          orderItemId: "line-2",
          quantityOrdered: 1,
          product: { asin: "B0OTHER000", sellerSku: "UNSHIPPED" }
        }
      ]
    }],
    pagination: { nextToken: "next-orders-page" }
  });

  assert.deepEqual(result, {
    lines: [
      {
        orderId: "111-2222222-3333333",
        orderItemId: "line-1",
        sellerSku: "BEAUTIFUL-COOKER",
        asin: "B0GSDRQN6L",
        title: "Beautiful multi-cooker",
        conditionType: "NEW",
        quantityOrdered: 3,
        quantityFulfilled: 2,
        fulfillmentStatus: "PARTIALLY_SHIPPED",
        fulfilledBy: "AMAZON",
        createdAt: "2026-09-01T10:00:00.000Z",
        lastUpdatedAt: "2026-09-02T12:00:00.000Z"
      },
      {
        orderId: "111-2222222-3333333",
        orderItemId: "line-2",
        sellerSku: "UNSHIPPED",
        asin: "B0OTHER000",
        quantityOrdered: 1,
        quantityFulfilled: 0,
        fulfillmentStatus: "PARTIALLY_SHIPPED",
        fulfilledBy: "AMAZON",
        createdAt: "2026-09-01T10:00:00.000Z",
        lastUpdatedAt: "2026-09-02T12:00:00.000Z"
      }
    ],
    nextPageToken: "next-orders-page"
  });
});

test("prepares a price patch while preserving existing offer fields", () => {
  const prepared = prepareListingPriceUpdate({
    sku: "beautiful-cooker-white",
    summaries: [
      {
        marketplaceId: "ATVPDKIKX0DER",
        asin: "B0GSDRQN6L",
        itemName: "Beautiful multi-cooker"
      }
    ],
    productTypes: [
      { marketplaceId: "ATVPDKIKX0DER", productType: "KITCHEN" }
    ],
    attributes: {
      purchasable_offer: [
        {
          marketplace_id: "ATVPDKIKX0DER",
          audience: "ALL",
          currency: "USD",
          quantity_discount_plan: "existing-discount",
          our_price: [{
            schedule: [
              { value_with_tax: 109.99 },
              { value_with_tax: 99.99, start_at: "2027-01-01T00:00:00Z" }
            ]
          }]
        },
        {
          marketplace_id: "ATVPDKIKX0DER",
          audience: "B2B",
          currency: "USD",
          our_price: [{ schedule: [{ value_with_tax: 89.99 }] }]
        }
      ]
    }
  }, "ATVPDKIKX0DER", 94.99);

  assert.equal(prepared.currentPrice, 109.99);
  assert.equal(prepared.patch.productType, "KITCHEN");

  const offers = prepared.patch.patches[0].value;
  assert.equal(offers[0].quantity_discount_plan, "existing-discount");
  assert.deepEqual(offers[0].our_price, [{
    schedule: [
      { value_with_tax: 94.99 },
      { value_with_tax: 99.99, start_at: "2027-01-01T00:00:00Z" }
    ]
  }]);
  assert.deepEqual(offers[1].our_price, [{ schedule: [{ value_with_tax: 89.99 }] }]);
});

test("groups deferred Amazon transactions by release date", () => {
  const page = normalizeAmazonDeferredTransactions({
    payload: {
      nextToken: "next-page",
      transactions: [
        {
          transactionId: "t1",
          transactionType: "Shipment",
          postedDate: "2026-09-28T10:00:00Z",
          totalAmount: { currencyCode: "USD", currencyAmount: 25.5 },
          relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "111-1" }],
          contexts: [{ contextType: "DeferredContext", deferralReason: "DD7", maturityDate: "2026-10-06T07:00:00Z" }]
        },
        {
          transactionId: "t2",
          totalAmount: { currencyCode: "USD", currencyAmount: -4.25 },
          contexts: [{ contextType: "DeferredContext", maturityDate: "2026-10-06T19:00:00Z" }]
        },
        {
          transactionId: "t3",
          totalAmount: { currencyCode: "USD", currencyAmount: 10 },
          contexts: [{ contextType: "DeferredContext", maturityDate: "2026-10-04T07:00:00Z" }]
        },
        {
          transactionId: "no-maturity",
          totalAmount: { currencyCode: "USD", currencyAmount: 99 },
          contexts: []
        }
      ]
    }
  });

  assert.equal(page.nextToken, "next-page");
  assert.equal(page.transactions.length, 3);
  assert.equal(page.transactions[0]?.orderId, "111-1");
  assert.equal(page.transactions[0]?.deferralReason, "DD7");
  assert.deepEqual(buildAmazonReleaseCalendar(page.transactions), [
    { date: "2026-10-04", amount: 10, currency: "USD", transactionCount: 1 },
    { date: "2026-10-06", amount: 21.25, currency: "USD", transactionCount: 2 }
  ]);
});

test("prepares a merchant quantity restock while keeping handling time", () => {
  const prepared = prepareListingRestock({
    sku: "SKU-1",
    summaries: [{ marketplaceId: "ATVPDKIKX0DER", asin: "B000000001", itemName: "Cart" }],
    productTypes: [{ marketplaceId: "ATVPDKIKX0DER", productType: "CART" }],
    attributes: {
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 0, lead_time_to_ship_max_days: 2 }]
    }
  }, "ATVPDKIKX0DER", 5);

  assert.equal(prepared.fulfillment, "merchant");
  assert.equal(prepared.currentQuantity, 0);
  assert.deepEqual(prepared.patch.patches[0]?.value, [
    { fulfillment_channel_code: "DEFAULT", quantity: 5, lead_time_to_ship_max_days: 2 }
  ]);
});

test("flags Amazon-fulfilled listings as not restockable", () => {
  const prepared = prepareListingRestock({
    sku: "SKU-2",
    productTypes: [{ productType: "CART" }],
    attributes: { fulfillment_availability: [{ fulfillment_channel_code: "AMAZON_NA" }] }
  }, "ATVPDKIKX0DER", 5);

  assert.equal(prepared.fulfillment, "amazon");
  assert.equal(prepared.currentQuantity, undefined);
});

test("estimates releases 7 days after delivery, net of an approximate fee", () => {
  const days = buildPreliminaryReleaseCalendar([
    { orderId: "1", amount: 100, currency: "USD", latestDeliveryDate: "2026-10-05T07:00:00Z" },
    { orderId: "2", amount: 20, currency: "USD", latestShipDate: "2026-10-01T07:00:00Z" },
    { orderId: "3", amount: 50, currency: "USD", latestDeliveryDate: "2026-09-01T07:00:00Z" },
    { orderId: "4", currency: "USD", latestDeliveryDate: "2026-10-05T07:00:00Z" }
  ], new Date("2026-10-03T12:00:00Z"));

  assert.deepEqual(days, [
    { date: "2026-10-12", amount: 85, currency: "USD", transactionCount: 1 },
    { date: "2026-10-13", amount: 17, currency: "USD", transactionCount: 1 }
  ]);
});

test("normalizes an Amazon fee estimate", () => {
  const estimate = normalizeAmazonFeesEstimate({
    payload: {
      FeesEstimateResult: {
        Status: "Success",
        FeesEstimate: {
          TotalFeesEstimate: { CurrencyCode: "USD", Amount: 5.52 },
          FeeDetailList: [
            { FeeType: "ReferralFee", FinalFee: { CurrencyCode: "USD", Amount: 5.52 } },
            { FeeType: "VariableClosingFee", FinalFee: { CurrencyCode: "USD", Amount: 0 } }
          ]
        }
      }
    }
  }, "B000000001", 46, false);

  assert.equal(estimate.totalFees, 5.52);
  assert.equal(estimate.error, undefined);
  assert.deepEqual(estimate.fees[0], { type: "ReferralFee", amount: 5.52 });
});

test("parses the FBM returns report", () => {
  const rows = parseAmazonReturnsReport([
    "Order ID\tOrder date\tReturn request date\tReturn request status\tASIN\tMerchant SKU\tItem Name\tReturn quantity\tReturn reason",
    "111-1\t2026-09-01\t2026-09-10\tApproved\tB000000001\tSKU-1\tMixer\t2\tDefective",
    "111-2\t2026-09-02\t2026-09-12\tPending\tB000000002\tSKU-2\tCooker\t1\tNo longer needed"
  ].join("\n"));

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    orderId: "111-1", requestDate: "2026-09-10", status: "Approved", asin: "B000000001",
    sku: "SKU-1", title: "Mixer", quantity: 2, reason: "Defective"
  });
});
