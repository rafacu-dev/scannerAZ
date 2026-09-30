import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAmazonOrdersSearchUrl,
  getSpApiEndpoint,
  inferCatalogIdentifierType,
  normalizeCatalogSearchResponse,
  normalizeAmazonOrderSearch,
  normalizePricingListings,
  prepareListingPriceUpdate
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
  assert.equal(url.searchParams.get("includedData"), "FULFILLMENT");
  assert.equal(url.searchParams.get("paginationToken"), "next-page-token");
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
