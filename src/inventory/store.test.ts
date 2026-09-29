import assert from "node:assert/strict";
import test from "node:test";
import { inventoryProductKey } from "./store.js";

test("uses SKU before ASIN or UPC for a stable inventory product key", () => {
  assert.equal(
    inventoryProductKey({
      title: "Example product",
      sku: " seller-sku 1 ",
      asin: "B0GSDRQN6L",
      upc: "012345678905"
    }),
    "sku:SELLER-SKU1"
  );
});

test("falls back to a normalized title when an invoice line has no product code", () => {
  assert.equal(
    inventoryProductKey({
      title: "  Example    product  "
    }),
    "title:example product"
  );
});
