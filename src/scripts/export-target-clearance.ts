import fs from "node:fs";
import path from "node:path";
import { searchTargetClearanceWithDetails } from "../retail/target/client.js";

const zipCode = process.argv[2] ?? "32605";
const limit = Number(process.argv[3] ?? 33);
const outputPath = path.resolve("exports", `target-clearance-details-${zipCode}.csv`);

function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

const products = await searchTargetClearanceWithDetails({ zipCode, limit });
const header = [
  "amazon_search_id",
  "target_tcin",
  "title",
  "price",
  "regular_price",
  "discount_percent",
  "target_url"
];
const rows = products.map((product) => [
  product.upc ?? "",
  product.retailerProductId ?? "",
  product.title,
  product.price ?? "",
  product.regularPrice ?? "",
  product.discountPercent ?? "",
  product.url ?? ""
]);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`
);

const withAmazonSearchId = products.filter((product) => product.upc).length;

console.log(`Exported ${products.length} Target clearance products to ${outputPath}`);
console.log(`Rows with GTIN/UPC/EAN for Amazon Seller search: ${withAmazonSearchId}`);
console.log(`Rows without GTIN/UPC/EAN: ${products.length - withAmazonSearchId}`);
