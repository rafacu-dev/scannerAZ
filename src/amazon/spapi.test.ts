import assert from "node:assert/strict";
import test from "node:test";
import {
  getSpApiEndpoint,
  inferCatalogIdentifierType,
  normalizeCatalogSearchResponse
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
