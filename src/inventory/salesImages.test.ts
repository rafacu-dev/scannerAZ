import assert from "node:assert/strict";
import test from "node:test";
import { fillSaleImages } from "./salesImages.js";

test("fills a new order from the same ASIN even with a different SKU or account", () => {
  const sales = [
    { connectionId: "a", asin: "B012345678", sku: "new", imageUrl: " " },
    { connectionId: "b", asin: "B012345678", sku: "old", imageUrl: "https://example.com/oil.jpg" }
  ];
  const filled = fillSaleImages(sales);
  assert.equal(filled[0]?.imageUrl, sales[1]?.imageUrl);
  assert.equal(sales[0]?.imageUrl, " ");
  assert.equal(filled[1], sales[1]);
});

test("uses SKU only within the same account and without a conflicting ASIN", () => {
  const imageUrl = "https://example.com/product.jpg";
  const filled = fillSaleImages([
    { connectionId: "a", sku: "sku", asin: "B012345678", imageUrl },
    { connectionId: "a", sku: "sku" },
    { connectionId: "b", sku: "sku" },
    { connectionId: "a", sku: "sku", asin: "B098765432" }
  ]);
  assert.equal(filled[1]?.imageUrl, imageUrl);
  assert.equal(filled[2]?.imageUrl, undefined);
  assert.equal(filled[3]?.imageUrl, undefined);
});

test("does not guess images by title or use an ambiguous reassigned SKU", () => {
  const filled = fillSaleImages([
    { connectionId: "a", sku: "sku", asin: "B012345678", imageUrl: "https://example.com/a.jpg" },
    { connectionId: "a", sku: "sku", asin: "B098765432", imageUrl: "https://example.com/b.jpg" },
    { connectionId: "a", sku: "sku" },
    { connectionId: "a", title: "Same product title" }
  ]);
  assert.equal(filled[2]?.imageUrl, undefined);
  assert.equal(filled[3]?.imageUrl, undefined);
});
