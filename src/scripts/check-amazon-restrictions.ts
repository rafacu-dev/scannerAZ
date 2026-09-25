import { assertAmazonSpApiConfig, config } from "../config.js";
import { getListingsRestrictions, normalizeListingsRestrictions } from "../amazon/spapi.js";

const asin = process.argv[2]?.trim().toUpperCase();
const sellerId = process.argv[3]?.trim() || config.AMAZON_SELLER_ID;
const conditionType = process.argv[4]?.trim() || "new_new";

if (!asin) {
  console.error("Usage: npm run amazon:check -- <ASIN> [sellerId] [conditionType]");
  process.exit(1);
}

if (!sellerId) {
  console.error("Missing seller id. Pass it as an argument or set AMAZON_SELLER_ID.");
  process.exit(1);
}

assertAmazonSpApiConfig(config.AMAZON_REFRESH_TOKEN);

const response = await getListingsRestrictions({
  asin,
  conditionType,
  refreshToken: config.AMAZON_REFRESH_TOKEN!,
  sellerId
});
const normalized = normalizeListingsRestrictions(response);

console.log(
  JSON.stringify(
    {
      asin,
      sellerId,
      marketplaceId: config.AMAZON_MARKETPLACE_ID,
      conditionType,
      ...normalized
    },
    null,
    2
  )
);
