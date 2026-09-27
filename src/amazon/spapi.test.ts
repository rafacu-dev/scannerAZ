import assert from "node:assert/strict";
import test from "node:test";
import {
  getSpApiEndpoint,
  inferCatalogIdentifierType,
  normalizeCatalogSearchResponse,
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
              our_price: [{ schedule: [{ value_with_tax: 109.99 }] }]
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
