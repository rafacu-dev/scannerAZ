import { config } from "../../config.js";
import type { ClearanceProduct, ClearanceSearchInput } from "../types.js";
import { getTargetProductDetails } from "./details.js";
import { searchTargetPublicClearance } from "./publicWeb.js";
import type { TargetSearchInput, TargetSearchResult } from "./types.js";
import { searchTargetWithUnwrangle } from "./unwrangle.js";

export async function searchTarget(input: TargetSearchInput): Promise<TargetSearchResult[]> {
  if (config.TARGET_PROVIDER === "public-web") {
    throw new Error("Target public-web provider supports clearance scans, not keyword search.");
  }

  if (config.TARGET_PROVIDER === "unwrangle") {
    return searchTargetWithUnwrangle(input);
  }

  throw new Error("Target provider is not configured.");
}

export async function searchTargetClearance(input: ClearanceSearchInput): Promise<ClearanceProduct[]> {
  if (config.TARGET_PROVIDER === "public-web") {
    return searchTargetPublicClearance(input);
  }

  const products = await searchTarget({
    query: "clearance",
    zipCode: input.zipCode
  });

  return products.slice(0, input.limit ?? 100).map((product) => {
    const price = product.salePrice ?? product.price;
    const regularPrice = product.salePrice && product.price ? product.price : undefined;
    const discountPercent =
      regularPrice && price ? Math.round(((regularPrice - price) / regularPrice) * 100) : undefined;

    return {
      retailer: "target",
      provider: product.provider,
      title: product.title,
      url: product.url,
      retailerProductId: product.tcin,
      upc: product.upc,
      price,
      regularPrice,
      discountPercent,
      availability: product.availability,
      imageUrl: product.imageUrl,
      raw: product.raw
    };
  });
}

export async function searchTargetClearanceWithDetails(input: ClearanceSearchInput) {
  const products = await searchTargetClearance(input);

  return Promise.all(
    products.map(async (product) => {
      if (!product.url || !product.retailerProductId) {
        return product;
      }

      try {
        const details = await getTargetProductDetails(product.url, product.retailerProductId);

        return {
          ...product,
          title: details.title ?? product.title,
          upc: details.gtin13 ?? product.upc,
          price: details.price ?? product.price,
          regularPrice: details.regularPrice ?? product.regularPrice,
          availability: details.availability ?? product.availability,
          imageUrl: details.imageUrl ?? product.imageUrl,
          raw: {
            ...((product.raw as Record<string, unknown> | undefined) ?? {}),
            details
          }
        };
      } catch (error) {
        return {
          ...product,
          raw: {
            ...((product.raw as Record<string, unknown> | undefined) ?? {}),
            detailsError: error instanceof Error ? error.message : "Unknown Target details error"
          }
        };
      }
    })
  );
}
