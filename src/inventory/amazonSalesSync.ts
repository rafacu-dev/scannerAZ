import { config } from "../config.js";
import {
  getLwaAccessToken,
  normalizeAmazonOrderSearch,
  searchSellerOrders
} from "../amazon/spapi.js";
import { getAmazonConnectionForTenant, listAmazonConnections } from "../storage/connections.js";
import {
  AmazonSalesSyncInProgressError,
  beginAmazonSalesSync,
  completeAmazonSalesSync,
  failAmazonSalesSync,
  importAmazonSalesLines,
} from "./store.js";

/**
 * Pulls Amazon orders updated since the last sync and applies them to the
 * inventory (sales deduct stock; cancellations return it). Used by the app's
 * "sync" action and by the scheduled job, so stock moves even when the app
 * is closed.
 */
export async function syncAmazonSalesForConnection(input: {
  tenantId: string;
  connectionId: string;
  refreshToken: string;
  marketplaceId?: string;
  from: Date;
}) {
  const work = await beginAmazonSalesSync(input.tenantId, input.connectionId, input.from.toISOString());

  try {
    const accessToken = (await getLwaAccessToken(input.refreshToken)).access_token;
    let paginationToken = work.paginationToken;
    let pages = 0;
    let nextPageToken: string | undefined;
    const totals = {
      processedLines: 0,
      appliedLines: 0,
      appliedUnits: 0,
      reversedUnits: 0,
      unmatchedLines: 0,
      insufficientLines: 0,
      notFulfilledLines: 0
    };

    // Five 100-order pages stays below the documented burst allowance while
    // giving a first sync enough room for a meaningful inventory reconciliation.
    do {
      const response = await searchSellerOrders({
        refreshToken: input.refreshToken,
        accessToken,
        marketplaceId: input.marketplaceId || config.AMAZON_MARKETPLACE_ID,
        lastUpdatedAfter: work.lastUpdatedAfter,
        paginationToken,
        maxResultsPerPage: 100
      });
      const page = normalizeAmazonOrderSearch(response);
      const imported = await importAmazonSalesLines(input.tenantId, input.connectionId, page.lines);

      totals.processedLines += imported.processedLines;
      totals.appliedLines += imported.appliedLines;
      totals.appliedUnits += imported.appliedUnits;
      totals.reversedUnits += imported.reversedUnits;
      totals.unmatchedLines += imported.unmatchedLines;
      totals.insufficientLines += imported.insufficientLines;
      totals.notFulfilledLines += imported.notFulfilledLines;
      pages += 1;
      nextPageToken = page.nextPageToken;
      paginationToken = nextPageToken;
    } while (paginationToken && pages < 5);

    const sync = await completeAmazonSalesSync(input.tenantId, work, nextPageToken);
    return { pages, ...totals, sync };
  } catch (error) {
    await failAmazonSalesSync(input.tenantId, input.connectionId).catch(() => undefined);
    throw error;
  }
}

const backgroundIntervalMs = 4 * 60 * 1000;
let backgroundRunning = false;
let lastBackgroundStartedAt = 0;

/** Scheduled sales sync for every linked store (deduplicated per seller). */
export function triggerBackgroundAmazonSalesSync() {
  const now = Date.now();

  if (backgroundRunning || now - lastBackgroundStartedAt < backgroundIntervalMs) {
    return { status: backgroundRunning ? "running" : "too_soon" } as const;
  }

  backgroundRunning = true;
  lastBackgroundStartedAt = now;
  void runBackgroundAmazonSalesSync()
    .catch((error) => console.error("Background Amazon sales sync failed", error))
    .finally(() => {
      backgroundRunning = false;
    });
  return { status: "started" } as const;
}

async function runBackgroundAmazonSalesSync() {
  const connections = await listAmazonConnections();
  const seen = new Set<string>();
  let appliedUnits = 0;
  let reversedUnits = 0;

  for (const connection of connections) {
    if (!connection.tenantId) {
      continue;
    }

    const key = `${connection.tenantId}:${connection.sellerId ?? connection.id}:${connection.marketplaceId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    try {
      const stored = await getAmazonConnectionForTenant(connection.id, connection.tenantId);
      if (!stored) {
        continue;
      }
      const result = await syncAmazonSalesForConnection({
        tenantId: connection.tenantId,
        connectionId: connection.id,
        refreshToken: stored.refreshToken,
        marketplaceId: stored.marketplaceId,
        from: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      });
      appliedUnits += result.appliedUnits;
      reversedUnits += result.reversedUnits;
    } catch (error) {
      if (!(error instanceof AmazonSalesSyncInProgressError)) {
        // Missing Orders permission or Amazon throttling: try again next cycle.
        console.warn(JSON.stringify({
          event: "inventory.background_sales_sync_failed",
          connectionId: connection.id,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown"
        }));
      }
    }
  }

  console.info(JSON.stringify({ event: "inventory.background_sales_sync", connections: seen.size, appliedUnits, reversedUnits }));
}
