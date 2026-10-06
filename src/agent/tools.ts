import { config } from "../config.js";
import { getAmazonFinancialEventGroups, listAmazonRecentOrders } from "../amazon/spapi.js";
import { getAmazonConnectionForTenant, listAmazonConnectionsForTenant } from "../storage/connections.js";

/**
 * Read-only tools the agent can call. Most reuse the app's own public API
 * in-process (same validation, caching and Amazon rate limiting as the app),
 * authenticated with the user's session. None of them change anything.
 */
export type AgentToolContext = {
  tenantId: string;
  sessionToken: string;
};

type ToolArgs = Record<string, unknown>;

type AgentTool = {
  description: string;
  args: string;
  run: (context: AgentToolContext, args: ToolArgs) => Promise<unknown>;
};

const maxResultCharacters = 7000;

function stringArg(args: ToolArgs, key: string) {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(args: ToolArgs, key: string) {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : undefined;
}

async function callApp(context: AgentToolContext, path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`http://127.0.0.1:${config.PORT}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${context.sessionToken}`,
      "content-type": "application/json",
      ...(config.SCANNERAZ_EDGE_SHARED_SECRET ? { "x-scanneraz-edge-auth": config.SCANNERAZ_EDGE_SHARED_SECRET } : {})
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(45_000)
  });
  const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;

  if (!response.ok) {
    return { error: payload?.error ?? `Request failed (${response.status})`, status: response.status };
  }

  return payload;
}

/** Store id from args, defaulting to the only/first linked store. */
async function resolveStore(context: AgentToolContext, args: ToolArgs) {
  const requested = stringArg(args, "storeId");
  const connections = await listAmazonConnectionsForTenant(context.tenantId);
  const match = requested ? connections.find((connection) => connection.id === requested) : connections[0];

  if (!match) {
    throw new Error(requested ? `Unknown storeId ${requested}. Call list_stores.` : "No Amazon store is linked.");
  }

  return match;
}

async function storePath(context: AgentToolContext, args: ToolArgs, suffix: string) {
  const store = await resolveStore(context, args);
  return `/api/public/amazon/connections/${encodeURIComponent(store.id)}${suffix}`;
}

function daysAgoIso(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export const agentTools: Record<string, AgentTool> = {
  list_stores: {
    description: "Linked Amazon stores with their storeId, name and seller id.",
    args: "{}",
    run: (context) => callApp(context, "/api/public/amazon/connections")
  },
  inventory_overview: {
    description: "Inventory totals plus every product: available units, sold, received, returns, average unit cost (cents) and value.",
    args: "{}",
    run: (context) => callApp(context, "/api/public/inventory/overview")
  },
  list_receipts: {
    description: "Purchase receipts/invoices recorded in inventory (supplier, date, units, total cost in cents). Use to compute total investment.",
    args: "{}",
    run: (context) => callApp(context, "/api/public/inventory/invoices")
  },
  receipt_detail: {
    description: "Lines of one receipt (products, quantities, unit costs).",
    args: "{\"invoiceId\": string}",
    run: (context, args) => callApp(context, `/api/public/inventory/invoices/${encodeURIComponent(stringArg(args, "invoiceId") ?? "")}`)
  },
  store_listings: {
    description: "All active listings of a store: SKU, ASIN, title, price, quantity.",
    args: "{\"storeId\"?: string}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/listings/all"))
  },
  search_listings: {
    description: "Find the store's own listings by name, ASIN or SKU.",
    args: "{\"storeId\"?: string, \"query\": string}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/listings/search"), {
      method: "POST",
      body: { query: stringArg(args, "query") ?? "", mode: "store" }
    })
  },
  product_costs: {
    description: "Saved calculator costs per product: purchase cost, FBM shipping cost, quantity. Use for profit estimates.",
    args: "{\"storeId\"?: string}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/product-costs"))
  },
  item_offers: {
    description: "Live Buy Box and competing offers (price, seller, FBA/FBM) for one ASIN from Amazon.",
    args: "{\"storeId\"?: string, \"asin\": string}",
    run: async (context, args) => callApp(context, await storePath(context, args, `/items/${encodeURIComponent(stringArg(args, "asin") ?? "")}/offers`))
  },
  fee_estimate: {
    description: "Amazon fee estimate (referral + FBA/closing) for an ASIN at a price.",
    args: "{\"storeId\"?: string, \"asin\": string, \"price\": number, \"fulfillment\"?: \"FBA\"|\"FBM\"}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/fees/estimate"), {
      method: "POST",
      body: { asin: stringArg(args, "asin"), price: numberArg(args, "price"), fulfillment: stringArg(args, "fulfillment") === "FBM" ? "FBM" : "FBA" }
    })
  },
  check_eligibility: {
    description: "Whether the store can sell up to 20 ASINs (new condition).",
    args: "{\"storeId\"?: string, \"asins\": string[]}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/restrictions/check-batch"), {
      method: "POST",
      body: { asins: Array.isArray(args.asins) ? args.asins.slice(0, 20) : [], conditionType: "new_new" }
    })
  },
  catalog_search: {
    description: "Search Amazon's catalog by keyword, UPC or ASIN.",
    args: "{\"storeId\"?: string, \"query\": string}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/catalog/search"), {
      method: "POST",
      body: { query: stringArg(args, "query") ?? "" }
    })
  },
  release_calendar: {
    description: "Funds held by Amazon and their release dates (Finance tab), or an order-based estimate if Finance access is missing.",
    args: "{\"storeId\"?: string}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/finances/release-calendar"))
  },
  payouts: {
    description: "Amazon settlement/payout groups (period, status, total amount) from the Finances API.",
    args: "{\"storeId\"?: string, \"days\"?: number}",
    run: async (context, args) => {
      const store = await resolveStore(context, args);
      const stored = await getAmazonConnectionForTenant(store.id, context.tenantId);
      if (!stored) {
        throw new Error("Store not found.");
      }
      return getAmazonFinancialEventGroups({
        refreshToken: stored.refreshToken,
        startedAfter: daysAgoIso(Math.min(Math.max(numberArg(args, "days") ?? 90, 1), 180)),
        // Amazon requires the end of the window to be at least 2 minutes in the past.
        startedBefore: new Date(Date.now() - 3 * 60 * 1000).toISOString()
      });
    }
  },
  recent_orders: {
    description: "Amazon orders of the last N days (max 30): date, status, FBA/FBM, order total. Use for revenue and sales counts.",
    args: "{\"storeId\"?: string, \"days\"?: number}",
    run: async (context, args) => {
      const store = await resolveStore(context, args);
      const stored = await getAmazonConnectionForTenant(store.id, context.tenantId);
      if (!stored) {
        throw new Error("Store not found.");
      }
      const result = await listAmazonRecentOrders({
        refreshToken: stored.refreshToken,
        marketplaceId: stored.marketplaceId || config.AMAZON_MARKETPLACE_ID,
        createdAfter: daysAgoIso(Math.min(Math.max(numberArg(args, "days") ?? 30, 1), 30))
      });
      const revenue = result.orders.reduce((sum, order) => sum + (order.amount ?? 0), 0);
      return { orderCount: result.orders.length, revenue: Math.round(revenue * 100) / 100, hasMore: Boolean(result.nextToken), orders: result.orders };
    }
  },
  repricing_rules: {
    description: "Auto-repricing rules of a store (SKU, strategy, minimum price, last price and status).",
    args: "{\"storeId\"?: string}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/repricing/rules"))
  },
  repricing_history: {
    description: "Recent automatic price changes and restocks sent to Amazon.",
    args: "{\"storeId\"?: string}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/repricing/history"))
  },
  restock_rules: {
    description: "Auto-restock (endless stock) rules of a store.",
    args: "{\"storeId\"?: string}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/restock/rules"))
  },
  returns_summary: {
    description: "Customer returns of the last 60 days from Amazon's returns report (rate, reasons, products).",
    args: "{\"storeId\"?: string}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/returns/summary"))
  },
  data_permissions: {
    description: "Which Amazon data each store's authorization reaches (listings, orders, finances).",
    args: "{\"storeId\"?: string}",
    run: async (context, args) => callApp(context, await storePath(context, args, "/permissions"))
  }
};

export function describeAgentTools() {
  return Object.entries(agentTools)
    .map(([name, tool]) => `- ${name} ${tool.args}: ${tool.description}`)
    .join("\n");
}

/** Runs one tool and returns a compact, size-limited JSON string for the model. */
export async function runAgentTool(context: AgentToolContext, name: string, args: ToolArgs) {
  const tool = agentTools[name];

  if (!tool) {
    return JSON.stringify({ error: `Unknown tool ${name}` });
  }

  try {
    const result = await tool.run(context, args ?? {});
    const text = JSON.stringify(result, (_key, value) => (value === null ? undefined : value));
    return text.length > maxResultCharacters
      ? `${text.slice(0, maxResultCharacters)}…(truncated; ask for something narrower if needed)`
      : text;
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : "Tool failed" });
  }
}
