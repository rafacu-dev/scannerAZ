import { config } from "../config.js";
import { getAutomationPool } from "./repricing.js";
import type { AmazonItemOffers } from "./spapi.js";

/**
 * Competitor storefront names. SP-API only names the authorized seller, so
 * other sellers' names come from Keepa's seller lookup and are cached in the
 * database (names rarely change; each ID costs one Keepa token).
 */
const keepaSellerUrl = "https://api.keepa.com/seller";
const usDomain = 1;
const nameMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
// IDs Keepa does not know are retried after a day, not on every request.
const missingRetryMs = 24 * 60 * 60 * 1000;
const memoryCache = new Map<string, { name?: string; fetchedAt: number }>();
let schemaPromise: Promise<void> | undefined;

async function initializeSellerNameStore() {
  const pool = getAutomationPool();

  if (!pool || schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = pool
    .query(`
      CREATE TABLE IF NOT EXISTS scanneraz_seller_names (
        seller_id TEXT PRIMARY KEY,
        seller_name TEXT,
        fetched_at TIMESTAMPTZ NOT NULL
      );
    `)
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaPromise = undefined;
      throw error;
    });

  return schemaPromise;
}

async function readCachedNames(sellerIds: string[]) {
  const pool = getAutomationPool();
  const cached = new Map<string, { name?: string; fetchedAt: number }>();

  if (pool) {
    await initializeSellerNameStore();
    const result = await pool.query<{ seller_id: string; seller_name: string | null; fetched_at: Date }>(
      `SELECT seller_id, seller_name, fetched_at FROM scanneraz_seller_names WHERE seller_id = ANY($1)`,
      [sellerIds]
    );

    for (const row of result.rows) {
      cached.set(row.seller_id, { name: row.seller_name ?? undefined, fetchedAt: new Date(row.fetched_at).getTime() });
    }
  } else {
    for (const sellerId of sellerIds) {
      const entry = memoryCache.get(sellerId);

      if (entry) {
        cached.set(sellerId, entry);
      }
    }
  }

  return cached;
}

async function storeNames(names: Map<string, string | undefined>) {
  const pool = getAutomationPool();
  const now = new Date();

  if (!pool) {
    for (const [sellerId, name] of names) {
      memoryCache.set(sellerId, { name, fetchedAt: now.getTime() });
    }
    return;
  }

  for (const [sellerId, name] of names) {
    await pool.query(
      `
        INSERT INTO scanneraz_seller_names (seller_id, seller_name, fetched_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (seller_id) DO UPDATE SET seller_name = EXCLUDED.seller_name, fetched_at = EXCLUDED.fetched_at
      `,
      [sellerId, name ?? null, now]
    );
  }
}

async function fetchKeepaSellerNames(sellerIds: string[]) {
  const names = new Map<string, string | undefined>();

  for (let index = 0; index < sellerIds.length; index += 100) {
    const chunk = sellerIds.slice(index, index + 100);
    const url = new URL(keepaSellerUrl);
    url.searchParams.set("key", config.KEEPA_API_KEY!);
    url.searchParams.set("domain", String(usDomain));
    url.searchParams.set("seller", chunk.join(","));

    const response = await fetch(url, { headers: { accept: "application/json", "accept-encoding": "gzip" } });

    if (!response.ok) {
      throw new Error(`Keepa seller lookup failed: ${response.status}`);
    }

    const body = await response.json() as { sellers?: Record<string, { sellerName?: string } | null> };

    for (const sellerId of chunk) {
      const name = body.sellers?.[sellerId]?.sellerName?.trim();
      names.set(sellerId, name || undefined);
    }
  }

  return names;
}

export async function getSellerNames(sellerIds: string[]) {
  const ids = [...new Set(sellerIds.map((id) => id.trim().toUpperCase()).filter((id) => /^[A-Z0-9]{8,20}$/.test(id)))];
  const names = new Map<string, string>();

  if (!ids.length) {
    return names;
  }

  const cached = await readCachedNames(ids);
  const now = Date.now();
  const stale: string[] = [];

  for (const id of ids) {
    const entry = cached.get(id);

    if (entry?.name) {
      names.set(id, entry.name);
    }

    const maxAge = entry?.name ? nameMaxAgeMs : missingRetryMs;

    if (!entry || now - entry.fetchedAt > maxAge) {
      stale.push(id);
    }
  }

  if (stale.length && config.KEEPA_API_KEY) {
    try {
      const fetched = await fetchKeepaSellerNames(stale);
      await storeNames(fetched);

      for (const [id, name] of fetched) {
        if (name) {
          names.set(id, name);
        }
      }
    } catch (error) {
      // Names are cosmetic; offers still load without them.
      console.error("Keepa seller lookup failed", error);
    }
  }

  return names;
}

/** Fills missing seller names in offer results from the cache or Keepa. */
export async function attachCompetitorSellerNames<T extends AmazonItemOffers>(results: T[]): Promise<T[]> {
  const missing = results.flatMap((result) => [
    ...result.offers.filter((offer) => offer.sellerId && !offer.sellerName).map((offer) => offer.sellerId!),
    ...(result.buyBoxSellerId && !result.buyBoxSellerName ? [result.buyBoxSellerId] : []),
  ]);

  if (!missing.length) {
    return results;
  }

  const names = await getSellerNames(missing);

  return results.map((result) => ({
    ...result,
    ...(result.buyBoxSellerId && !result.buyBoxSellerName && names.get(result.buyBoxSellerId.trim().toUpperCase())
      ? { buyBoxSellerName: names.get(result.buyBoxSellerId.trim().toUpperCase()) }
      : {}),
    offers: result.offers.map((offer) => {
      const name = offer.sellerId && !offer.sellerName ? names.get(offer.sellerId.trim().toUpperCase()) : undefined;
      return name ? { ...offer, sellerName: name } : offer;
    }),
  }));
}
