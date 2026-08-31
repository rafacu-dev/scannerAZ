import { assertTargetConfig, config } from "../../config.js";
import type { TargetSearchInput, TargetSearchResult } from "./types.js";

type UnwrangleSearchItem = {
  name?: string;
  title?: string;
  url?: string;
  product_url?: string;
  tcin?: string;
  upc?: string;
  price?: string | number;
  sale_price?: string | number;
  availability?: string;
  image?: string;
  image_url?: string;
  rating?: string | number;
  reviews_count?: string | number;
};

type UnwrangleSearchResponse = {
  success?: boolean;
  results?: UnwrangleSearchItem[];
  search_results?: UnwrangleSearchItem[];
  error?: unknown;
};

function parseMoney(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNumber(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function searchTargetWithUnwrangle(input: TargetSearchInput): Promise<TargetSearchResult[]> {
  assertTargetConfig();

  const url = new URL("https://data.unwrangle.com/api/getter/");
  url.searchParams.set("platform", "target_search");
  url.searchParams.set("search", input.query);
  url.searchParams.set("api_key", config.TARGET_API_KEY!);

  if (input.zipCode) {
    url.searchParams.set("zipcode", input.zipCode);
  }

  if (input.page) {
    url.searchParams.set("page", String(input.page));
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  const body = (await response.json()) as UnwrangleSearchResponse;

  if (!response.ok || body.error) {
    throw new Error(`Target provider request failed: ${response.status} ${JSON.stringify(body.error ?? body)}`);
  }

  const items = body.results ?? body.search_results ?? [];

  return items
    .filter((item) => item.name || item.title)
    .map((item) => ({
      source: "target",
      provider: "unwrangle",
      title: item.name ?? item.title ?? "",
      url: item.url ?? item.product_url,
      tcin: item.tcin,
      upc: item.upc,
      price: parseMoney(item.price),
      salePrice: parseMoney(item.sale_price),
      availability: item.availability,
      imageUrl: item.image_url ?? item.image,
      rating: parseNumber(item.rating),
      reviewCount: parseNumber(item.reviews_count),
      raw: item
    }));
}
