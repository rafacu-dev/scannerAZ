import { assertKeepaConfig, config } from "../config.js";
import type {
  KeepaDomainId,
  KeepaProduct,
  KeepaProductFinderSelection,
  KeepaProductResponse,
  KeepaQueryResponse
} from "./types.js";

const keepaBaseUrl = "https://api.keepa.com";
const usDomain: KeepaDomainId = 1;

async function keepaFetch<T>(path: string, params: URLSearchParams, init?: RequestInit) {
  assertKeepaConfig();
  params.set("key", config.KEEPA_API_KEY!);

  const url = new URL(path, keepaBaseUrl);
  url.search = params.toString();

  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "accept-encoding": "gzip",
      ...init?.headers
    }
  });

  const text = await response.text();
  let body: T;

  try {
    body = JSON.parse(text) as T;
  } catch {
    throw new Error(`Keepa returned non-JSON response: ${response.status} ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Keepa request failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

export function createStarterSellerSelection(limit = 50): KeepaProductFinderSelection {
  return {
    page: 0,
    perPage: Math.max(50, limit),
    productType: 0,
    singleVariation: true,
    isHazMat: false,
    isHeatSensitive: false,
    isAdultProduct: false,
    buyBoxIsAmazon: false,
    current_BUY_BOX_SHIPPING_gte: 1500,
    current_BUY_BOX_SHIPPING_lte: 6000,
    current_SALES_lte: 150000,
    monthlySold_gte: 50,
    buyBoxStatsAmazon90_lte: 30,
    buyBoxStatsSellerCount90_gte: 3,
    buyBoxStatsSellerCount90_lte: 30,
    sort: [["current_SALES", "asc"]]
  };
}

export async function findCandidateAsins(selection: KeepaProductFinderSelection) {
  const params = new URLSearchParams({
    domain: String(usDomain)
  });

  const response = await keepaFetch<KeepaQueryResponse>("/query", params, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(selection)
  });

  return {
    asins: response.asinList ?? [],
    totalResults: response.totalResults ?? 0,
    tokensLeft: response.tokensLeft,
    tokensConsumed: response.tokensConsumed,
    refillIn: response.refillIn
  };
}

export async function getProducts(asins: string[]): Promise<KeepaProduct[]> {
  if (asins.length === 0) {
    return [];
  }

  const params = new URLSearchParams({
    domain: String(usDomain),
    asin: asins.join(","),
    stats: "90"
  });

  const response = await keepaFetch<KeepaProductResponse>("/product", params);

  return response.products ?? [];
}
