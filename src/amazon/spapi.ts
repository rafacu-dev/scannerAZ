import { config } from "../config.js";

type RegionConfig = {
  productionEndpoint: string;
  sandboxEndpoint: string;
};

const regionConfig: Record<typeof config.AMAZON_REGION, RegionConfig> = {
  na: {
    productionEndpoint: "https://sellingpartnerapi-na.amazon.com",
    sandboxEndpoint: "https://sandbox.sellingpartnerapi-na.amazon.com"
  },
  eu: {
    productionEndpoint: "https://sellingpartnerapi-eu.amazon.com",
    sandboxEndpoint: "https://sandbox.sellingpartnerapi-eu.amazon.com"
  },
  fe: {
    productionEndpoint: "https://sellingpartnerapi-fe.amazon.com",
    sandboxEndpoint: "https://sandbox.sellingpartnerapi-fe.amazon.com"
  }
};

export function getSpApiEndpoint(
  region: typeof config.AMAZON_REGION,
  environment: typeof config.AMAZON_SP_API_ENVIRONMENT
) {
  const endpoints = regionConfig[region];
  return environment === "sandbox" ? endpoints.sandboxEndpoint : endpoints.productionEndpoint;
}

type LwaTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

export type ListingsRestrictionReason = {
  reasonCode?: string;
  message?: string;
  links?: Array<{
    resource?: string;
    verb?: string;
    title?: string;
    type?: string;
  }>;
};

export type ListingsRestriction = {
  marketplaceId?: string;
  conditionType?: string;
  reasons?: ListingsRestrictionReason[];
};

type ListingsRestrictionsResponse = {
  restrictions?: ListingsRestriction[];
};

export type CatalogIdentifierType = "ASIN" | "EAN" | "GTIN" | "UPC";

export type CatalogCandidate = {
  asin: string;
  title?: string;
  brand?: string;
  imageUrl?: string;
  upc?: string;
  ean?: string;
  identifiers: Array<{ type: string; value: string }>;
};

type CatalogSearchResponse = {
  items?: unknown[];
};

type SellerListingsSearchResponse = {
  items?: unknown[];
  pagination?: {
    nextToken?: string;
  };
};

export type AmazonPricingListing = {
  sku: string;
  asin?: string;
  title?: string;
  productType?: string;
  price?: number;
  currency?: string;
};

/**
 * A payment group is Amazon's authoritative grouping for a disbursement.  It
 * is intentionally kept separate from order data: the transfer date and
 * amount must come from Finances, not from an estimate based on sales.
 */
export type AmazonFinancialEventGroup = {
  id: string;
  startedAt?: string;
  transferDate?: string;
  processingStatus?: string;
  transferStatus?: string;
  amount?: number;
  currency?: string;
};

/**
 * Product Pricing v2022 returns up to 20 lowest-priced offers for an ASIN,
 * plus the featured offers. It does not claim to enumerate every seller in
 * the marketplace.
 */
export type AmazonItemOffer = {
  sellerId?: string;
  sellerName?: string;
  fulfillment: "FBA" | "FBM" | "AMZ" | "Unknown";
  condition?: string;
  listingPrice?: number;
  shippingPrice?: number;
  landedPrice?: number;
  currency?: string;
  isBuyBoxWinner?: boolean;
  isPrime?: boolean;
};

export type AmazonItemOffers = {
  asin: string;
  visibleOfferCount: number;
  sellerCount: number;
  fbaOfferCount: number;
  fbmOfferCount: number;
  amazonOfferCount: number;
  buyBoxAvailable: boolean;
  buyBoxSellerId?: string;
  buyBoxSellerName?: string;
  buyBoxPrice?: number;
  currency?: string;
  offers: AmazonItemOffer[];
  error?: string;
};

/**
 * Operational order data needed to reconcile a seller's own inventory. This
 * deliberately excludes buyer, address, payment, tax, package, and tracking
 * fields. It is normalized from Orders API v2026-01-01 responses.
 */
export type AmazonFulfilledOrderLine = {
  orderId: string;
  orderItemId: string;
  sellerSku?: string;
  asin?: string;
  title?: string;
  conditionType?: string;
  quantityOrdered: number;
  quantityFulfilled: number;
  fulfillmentStatus?: string;
  fulfilledBy?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
};

export type AmazonOrderSearchPage = {
  lines: AmazonFulfilledOrderLine[];
  nextPageToken?: string;
};

type AmazonOrdersSearchResponse = {
  orders?: unknown[];
  pagination?: {
    nextToken?: string;
  };
};

export class AmazonOrdersRequestError extends Error {
  readonly status: number;

  constructor(status: number, _body: unknown) {
    super(
      status === 401 || status === 403
        ? `Amazon Orders access failed: ${status}. The seller must authorize this app and it needs an Orders-capable role such as Inventory and Order Tracking.`
        : `Amazon Orders request failed: ${status}.`
    );
    this.name = "AmazonOrdersRequestError";
    this.status = status;
  }
}

export type PreparedListingPriceUpdate = {
  sku: string;
  asin?: string;
  title?: string;
  productType: string;
  currentPrice?: number;
  targetPrice: number;
  currency: string;
  patch: {
    productType: string;
    patches: Array<{
      op: "replace";
      path: "/attributes/purchasable_offer";
      value: Array<Record<string, unknown>>;
    }>;
  };
};

export type RestrictionStatus = "sellable" | "approval_required" | "blocked" | "unknown";

export function buildAmazonOrdersSearchUrl(input: {
  marketplaceId?: string;
  lastUpdatedAfter?: string;
  paginationToken?: string;
  maxResultsPerPage?: number;
}) {
  if (!input.lastUpdatedAfter) {
    throw new Error("lastUpdatedAfter is required for every Amazon Orders request.");
  }

  const endpoint = getSpApiEndpoint(config.AMAZON_REGION, config.AMAZON_SP_API_ENVIRONMENT);
  const url = new URL("/orders/2026-01-01/orders", endpoint);

  // searchOrders validates that every filter matches the original request
  // when a pagination token is present.
  url.searchParams.set("marketplaceIds", input.marketplaceId ?? config.AMAZON_MARKETPLACE_ID);
  url.searchParams.set("lastUpdatedAfter", input.lastUpdatedAfter);
  url.searchParams.set("maxResultsPerPage", String(Math.max(1, Math.min(input.maxResultsPerPage ?? 100, 100))));
  url.searchParams.set("includedData", "FULFILLMENT");

  if (input.paginationToken) {
    url.searchParams.set("paginationToken", input.paginationToken);
  }

  return url;
}

export async function getLwaAccessToken(refreshToken: string) {
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.AMAZON_LWA_CLIENT_ID!,
      client_secret: config.AMAZON_LWA_CLIENT_SECRET!
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Amazon LWA refresh failed: ${response.status} ${body}`);
  }

  return (await response.json()) as LwaTokenResponse;
}

export async function getListingsRestrictions(input: {
  asin: string;
  sellerId: string;
  refreshToken: string;
  accessToken?: string;
  conditionType?: string;
  marketplaceId?: string;
}) {
  const endpoint = getSpApiEndpoint(config.AMAZON_REGION, config.AMAZON_SP_API_ENVIRONMENT);
  const accessToken = input.accessToken ?? (await getLwaAccessToken(input.refreshToken)).access_token;
  const url = new URL("/listings/2021-08-01/restrictions", endpoint);

  url.searchParams.set("asin", input.asin);
  url.searchParams.set("sellerId", input.sellerId);
  url.searchParams.set("marketplaceIds", input.marketplaceId ?? config.AMAZON_MARKETPLACE_ID);
  url.searchParams.set("conditionType", input.conditionType ?? "new_new");
  url.searchParams.set("reasonLocale", "en_US");

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "ScannerAz/0.1.0 (Language=Node.js; Platform=backend)",
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
    }
  });
  const body = await response.text();
  const parsedBody = parseJsonBody(body);

  if (!response.ok) {
    throw new Error(formatSpApiError("Amazon Listings Restrictions", response.status, parsedBody));
  }

  return parsedBody as ListingsRestrictionsResponse;
}

/**
 * Resolve a UPC/EAN/GTIN or product phrase into catalog candidates. The caller
 * still has to run getListingsRestrictions for the connected seller; catalog
 * membership alone never means that the seller can list the item.
 */
export async function searchCatalogItems(input: {
  query?: string;
  identifiers?: string[];
  refreshToken: string;
  accessToken?: string;
  marketplaceId?: string;
  limit?: number;
  identifierType?: CatalogIdentifierType;
}) {
  const accessToken = input.accessToken ?? (await getLwaAccessToken(input.refreshToken)).access_token;
  const url = buildAmazonCatalogSearchUrl(input);

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "ScannerAz/0.1.0 (Language=Node.js; Platform=backend)",
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
    }
  });
  const body = await response.text();
  const parsedBody = parseJsonBody(body);

  if (!response.ok) {
    throw new Error(formatSpApiError("Amazon Catalog Items", response.status, parsedBody));
  }

  return parsedBody as CatalogSearchResponse;
}

export function buildAmazonCatalogSearchUrl(input: {
  query?: string;
  identifiers?: string[];
  marketplaceId?: string;
  limit?: number;
  identifierType?: CatalogIdentifierType;
}) {
  const endpoint = getSpApiEndpoint(config.AMAZON_REGION, config.AMAZON_SP_API_ENVIRONMENT);
  const url = new URL("/catalog/2022-04-01/items", endpoint);
  const query = input.query?.trim();
  const identifiers = Array.from(new Set((input.identifiers ?? [])
    .map((value) => value.trim())
    .filter(Boolean))).slice(0, 20);

  url.searchParams.set("marketplaceIds", input.marketplaceId ?? config.AMAZON_MARKETPLACE_ID);
  url.searchParams.set("includedData", "summaries,identifiers,images");
  url.searchParams.set("locale", "en_US");
  url.searchParams.set("pageSize", String(Math.max(1, Math.min(input.limit ?? 10, 20))));

  if (input.identifierType) {
    const values = identifiers.length > 0 ? identifiers : query ? [query] : [];

    if (!values.length) {
      throw new Error("At least one catalog identifier is required.");
    }

    url.searchParams.set("identifiers", values.join(","));
    url.searchParams.set("identifiersType", input.identifierType);
  } else {
    if (!query) {
      throw new Error("A catalog keyword query is required.");
    }

    url.searchParams.set("keywords", query);
  }

  return url;
}

/** Return the seller's own listings. The SKU is required before a price can be changed. */
export async function searchSellerListings(input: {
  sellerId: string;
  refreshToken: string;
  accessToken?: string;
  marketplaceId?: string;
  pageSize?: number;
  pageToken?: string;
  withStatus?: "BUYABLE" | "DISCOVERABLE";
}) {
  const endpoint = getSpApiEndpoint(config.AMAZON_REGION, config.AMAZON_SP_API_ENVIRONMENT);
  const accessToken = input.accessToken ?? (await getLwaAccessToken(input.refreshToken)).access_token;
  const url = new URL(
    `/listings/2021-08-01/items/${encodeURIComponent(input.sellerId)}`,
    endpoint
  );

  url.searchParams.set("marketplaceIds", input.marketplaceId ?? config.AMAZON_MARKETPLACE_ID);
  url.searchParams.set("includedData", "summaries,attributes,productTypes");
  url.searchParams.set("issueLocale", "en_US");
  url.searchParams.set("pageSize", String(Math.max(1, Math.min(input.pageSize ?? 20, 20))));

  if (input.withStatus) {
    url.searchParams.set("withStatus", input.withStatus);
  }

  if (input.pageToken) {
    url.searchParams.set("pageToken", input.pageToken);
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "ScannerAz/0.1.0 (Language=Node.js; Platform=backend)",
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
    }
  });
  const body = await response.text();
  const parsedBody = parseJsonBody(body);

  if (!response.ok) {
    throw new Error(formatSpApiError("Amazon Listings Items", response.status, parsedBody, "Pricing and Product Listing"));
  }

  return parsedBody as SellerListingsSearchResponse;
}

/**
 * Product Pricing v2022-05-01 returns the competitive summary for up to 20
 * ASINs. It includes the featured offers and up to 20 lowest-priced offers,
 * without requesting the customer-facing Amazon page.
 */
export async function getAmazonItemOffersBatch(input: {
  asins: string[];
  refreshToken: string;
  accessToken?: string;
  marketplaceId?: string;
}) {
  const accessToken = input.accessToken ?? (await getLwaAccessToken(input.refreshToken)).access_token;
  const request = buildAmazonItemOffersBatchRequest(input);
  const response = await fetch(request.url, {
    method: "POST",
    headers: {
      ...spApiReadHeaders(accessToken),
      "content-type": "application/json"
    },
    body: JSON.stringify(request.body)
  });
  const body = await response.text();
  const parsedBody = parseJsonBody(body);

  if (!response.ok) {
    throw new Error(formatSpApiError("Amazon Product Pricing batch", response.status, parsedBody, "Pricing and Product Listing"));
  }

  return parsedBody;
}

/**
 * Sellers API only identifies the authorized seller's own storefront. It is
 * deliberately not used to infer names for competing Seller IDs.
 */
export async function getAmazonSellerStoreName(input: {
  refreshToken: string;
  accessToken?: string;
  marketplaceId?: string;
}) {
  const endpoint = getSpApiEndpoint(config.AMAZON_REGION, config.AMAZON_SP_API_ENVIRONMENT);
  const accessToken = input.accessToken ?? (await getLwaAccessToken(input.refreshToken)).access_token;
  const url = new URL("/sellers/v1/marketplaceParticipations", endpoint);
  const response = await fetch(url, {
    headers: spApiReadHeaders(accessToken)
  });
  const body = await response.text();
  const parsedBody = parseJsonBody(body);

  if (!response.ok) {
    throw new Error(formatSpApiError("Amazon Sellers", response.status, parsedBody, "Selling Partner Insights"));
  }

  return normalizeAmazonSellerStoreName(parsedBody, input.marketplaceId ?? config.AMAZON_MARKETPLACE_ID);
}

/**
 * Finances v0 exposes Amazon's payment groups, including their transfer date
 * and original total. It requires the Finance and Accounting SP-API role.
 */
export async function getAmazonFinancialEventGroups(input: {
  refreshToken: string;
  accessToken?: string;
  startedAfter: string;
  startedBefore: string;
  maxResultsPerPage?: number;
}) {
  const endpoint = getSpApiEndpoint(config.AMAZON_REGION, config.AMAZON_SP_API_ENVIRONMENT);
  const accessToken = input.accessToken ?? (await getLwaAccessToken(input.refreshToken)).access_token;
  const url = new URL("/finances/v0/financialEventGroups", endpoint);
  url.searchParams.set("FinancialEventGroupStartedAfter", input.startedAfter);
  url.searchParams.set("FinancialEventGroupStartedBefore", input.startedBefore);
  url.searchParams.set("MaxResultsPerPage", String(Math.max(1, Math.min(input.maxResultsPerPage ?? 100, 100))));

  const response = await fetch(url, { headers: spApiReadHeaders(accessToken) });
  const body = await response.text();
  const parsedBody = parseJsonBody(body);

  if (!response.ok) {
    throw new Error(formatSpApiError("Amazon Finances", response.status, parsedBody, "Finance and Accounting"));
  }

  return normalizeAmazonFinancialEventGroups(parsedBody);
}

export function normalizeAmazonFinancialEventGroups(value: unknown): AmazonFinancialEventGroup[] {
  const root = asRecord(value);
  const payload = asRecord(recordValue(root, ["payload"])) ?? root;
  const groups = recordArray(recordValue(payload, ["FinancialEventGroupList", "financialEventGroupList", "financialEventGroups"]));

  return groups.map((entry) => {
    const group = asRecord(entry);
    const total = asRecord(recordValue(group, ["OriginalTotal", "originalTotal"]));
    const amount = numberValue(recordValue(total, ["CurrencyAmount", "currencyAmount"]));
    const id = stringValue(recordValue(group, ["FinancialEventGroupId", "financialEventGroupId", "id"])) ?? "";

    return {
      id,
      startedAt: stringValue(recordValue(group, ["FinancialEventGroupStartedDate", "financialEventGroupStartedDate"])),
      transferDate: stringValue(recordValue(group, ["FundTransferDate", "fundTransferDate"])),
      processingStatus: stringValue(recordValue(group, ["ProcessingStatus", "processingStatus"])),
      transferStatus: stringValue(recordValue(group, ["FundTransferStatus", "fundTransferStatus"])),
      amount,
      currency: stringValue(recordValue(total, ["CurrencyCode", "currencyCode"])),
    };
  }).filter((group) => Boolean(group.id));
}

/**
 * A deferred transaction is sale money Amazon is holding (for example under
 * the DD+7 delivery-date policy). Its maturity date is the day Amazon says
 * the funds are released into the seller's available balance.
 */
export type AmazonDeferredTransaction = {
  id?: string;
  type?: string;
  description?: string;
  postedDate?: string;
  maturityDate: string;
  deferralReason?: string;
  orderId?: string;
  amount: number;
  currency?: string;
};

export type AmazonReleaseCalendarDay = {
  date: string;
  amount: number;
  currency?: string;
  transactionCount: number;
};

/**
 * Finances 2024-06-19 lists deferred transactions with their release date.
 * It requires the Finance and Accounting SP-API role, like Finances v0.
 */
export async function listAmazonDeferredTransactions(input: {
  refreshToken: string;
  accessToken?: string;
  postedAfter: string;
  marketplaceId?: string;
  nextToken?: string;
}) {
  const endpoint = getSpApiEndpoint(config.AMAZON_REGION, config.AMAZON_SP_API_ENVIRONMENT);
  const accessToken = input.accessToken ?? (await getLwaAccessToken(input.refreshToken)).access_token;
  const url = new URL("/finances/2024-06-19/transactions", endpoint);
  url.searchParams.set("postedAfter", input.postedAfter);
  url.searchParams.set("transactionStatus", "DEFERRED");

  if (input.marketplaceId) {
    url.searchParams.set("marketplaceId", input.marketplaceId);
  }

  if (input.nextToken) {
    url.searchParams.set("nextToken", input.nextToken);
  }

  const response = await fetch(url, { headers: spApiReadHeaders(accessToken) });
  const body = await response.text();
  const parsedBody = parseJsonBody(body);

  if (!response.ok) {
    throw new Error(formatSpApiError("Amazon Finances", response.status, parsedBody, "Finance and Accounting"));
  }

  return normalizeAmazonDeferredTransactions(parsedBody);
}

export function normalizeAmazonDeferredTransactions(value: unknown): {
  transactions: AmazonDeferredTransaction[];
  nextToken?: string;
} {
  const root = asRecord(value);
  const payload = asRecord(recordValue(root, ["payload"])) ?? root;
  const transactions = recordArray(recordValue(payload, ["transactions"])).flatMap((transaction) => {
    const deferredContext = recordArray(recordValue(transaction, ["contexts"]))
      .find((context) => recordValue(context, ["maturityDate"]) !== undefined);
    const maturityDate = stringValue(recordValue(deferredContext, ["maturityDate"]));
    const total = asRecord(recordValue(transaction, ["totalAmount"]));
    const amount = numberValue(recordValue(total, ["currencyAmount"]));

    if (!maturityDate || amount === undefined) {
      return [];
    }

    const orderId = recordArray(recordValue(transaction, ["relatedIdentifiers"]))
      .find((identifier) => stringValue(recordValue(identifier, ["relatedIdentifierName"])) === "ORDER_ID");

    return [{
      id: stringValue(recordValue(transaction, ["transactionId"])),
      type: stringValue(recordValue(transaction, ["transactionType"])),
      description: stringValue(recordValue(transaction, ["description"])),
      postedDate: stringValue(recordValue(transaction, ["postedDate"])),
      maturityDate,
      deferralReason: stringValue(recordValue(deferredContext, ["deferralReason"])),
      orderId: stringValue(recordValue(orderId, ["relatedIdentifierValue"])),
      amount,
      currency: stringValue(recordValue(total, ["currencyCode"])),
    }];
  });

  return {
    transactions,
    nextToken: stringValue(recordValue(payload, ["nextToken"])),
  };
}

/**
 * Sums deferred transactions by their UTC release day. Amounts are net:
 * refunds and fees that mature on the same day reduce that day's release.
 */
export function buildAmazonReleaseCalendar(transactions: AmazonDeferredTransaction[]): AmazonReleaseCalendarDay[] {
  const days = new Map<string, AmazonReleaseCalendarDay>();

  for (const transaction of transactions) {
    const date = transaction.maturityDate.slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue;
    }

    const day = days.get(date) ?? { date, amount: 0, currency: transaction.currency, transactionCount: 0 };
    day.amount = Math.round((day.amount + transaction.amount) * 100) / 100;
    day.transactionCount += 1;
    days.set(date, day);
  }

  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function normalizeAmazonSellerStoreName(response: unknown, marketplaceId: string) {
  const root = asRecord(response);
  const payload = recordValue(root, ["payload", "marketplaceParticipations"]);
  const payloadRecord = asRecord(payload);
  const participations = [
    ...recordArray(payload),
    ...recordArray(recordValue(payloadRecord, ["marketplaceParticipations", "participations"])),
  ];
  const entry = participations.find((participation) => {
    const marketplace = asRecord(recordValue(participation, ["marketplace", "Marketplace"]));
    return stringValue(recordValue(participation, ["marketplaceId", "MarketplaceId"])) === marketplaceId ||
      stringValue(recordValue(marketplace, ["id", "marketplaceId", "MarketplaceId"])) === marketplaceId;
  }) ?? (participations.length === 1 ? participations[0] : undefined);
  const marketplace = asRecord(recordValue(entry, ["marketplace", "Marketplace"]));

  return stringValue(recordValue(entry, ["storeName", "StoreName", "sellerStoreName", "SellerStoreName"])) ??
    stringValue(recordValue(marketplace, ["storeName", "StoreName"]));
}

export function buildAmazonItemOffersBatchRequest(input: {
  asins: string[];
  marketplaceId?: string;
  itemCondition?: string;
}) {
  const asins = Array.from(new Set(input.asins.map(normalizeAsin))).slice(0, 20);

  if (!asins.length) {
    throw new Error("At least one ASIN is required for Product Pricing.");
  }

  const marketplaceId = input.marketplaceId ?? config.AMAZON_MARKETPLACE_ID;
  const itemCondition = input.itemCondition ?? "New";
  const endpoint = getSpApiEndpoint(config.AMAZON_REGION, config.AMAZON_SP_API_ENVIRONMENT);

  return {
    asins,
    url: new URL("/batches/products/pricing/2022-05-01/items/competitiveSummary", endpoint),
    body: {
      requests: asins.map((asin) => ({
        asin,
        marketplaceId,
        includedData: ["featuredBuyingOptions", "lowestPricedOffers"],
        lowestPricedOffersInputs: [
          {
            itemCondition,
            offerType: "Consumer"
          }
        ],
        uri: "/products/pricing/2022-05-01/items/competitiveSummary",
        method: "GET",
      }))
    }
  };
}

/** Normalize Product Pricing v2022's competitive-summary response shape. */
export function normalizeAmazonItemOffers(
  response: unknown,
  asin: string
): AmazonItemOffers {
  const normalizedAsin = normalizeAsin(asin);
  const body = asRecord(response);
  const lowestOfferGroups = recordArray(recordValue(body, ["lowestPricedOffers"]));
  const featuredBuyingOptions = recordArray(recordValue(body, ["featuredBuyingOptions"]));
  const lowestOffers = lowestOfferGroups.flatMap((group) =>
    recordArray(recordValue(group, ["offers"])),
  );
  const featuredOffers = featuredBuyingOptions.flatMap((option) =>
    recordArray(recordValue(option, ["segmentedFeaturedOffers"])),
  );
  const offers = mergeAmazonItemOffers([
    ...lowestOffers.map((offer) => normalizeAmazonItemOffer(offer)),
    ...featuredOffers.map((offer) => ({ ...normalizeAmazonItemOffer(offer), isBuyBoxWinner: true })),
  ]);
  const winningOffer = offers.find((offer) => offer.isBuyBoxWinner);
  const buyBoxPrice = winningOffer?.landedPrice ?? winningOffer?.listingPrice;
  const currency = winningOffer?.currency ?? offers.find((offer) => offer.currency)?.currency;
  const visibleFulfillmentCounts = countOfferFulfillment(offers);
  const sellerIds = new Set(offers.map((offer) => offer.sellerId).filter((sellerId): sellerId is string => Boolean(sellerId)));

  return {
    asin: stringValue(recordValue(body, ["asin", "ASIN"]))?.toUpperCase() ?? normalizedAsin,
    visibleOfferCount: offers.length,
    sellerCount: sellerIds.size,
    fbaOfferCount: visibleFulfillmentCounts.fba,
    fbmOfferCount: visibleFulfillmentCounts.fbm,
    amazonOfferCount: visibleFulfillmentCounts.amz,
    buyBoxAvailable: Boolean(winningOffer),
    ...(winningOffer?.sellerId ? { buyBoxSellerId: winningOffer.sellerId } : {}),
    ...(winningOffer?.sellerName ? { buyBoxSellerName: winningOffer.sellerName } : {}),
    ...(buyBoxPrice !== undefined ? { buyBoxPrice } : {}),
    ...(currency ? { currency } : {}),
    offers
  };
}

/**
 * Batch calls can succeed overall while one ASIN fails. Keep each result so
 * the mobile client can still render the remaining price comparisons.
 */
export function normalizeAmazonItemOffersBatch(
  response: unknown,
  asins: string[]
): AmazonItemOffers[] {
  const normalizedAsins = Array.from(new Set(asins.map(normalizeAsin))).slice(0, 20);
  const root = asRecord(response);
  const responses = recordArray(root?.responses);

  return normalizedAsins.map((asin, index) => {
    const entry = responses.find((candidate) => batchResponseAsin(candidate) === asin) ?? responses[index];

    if (!entry) {
      return emptyAmazonItemOffers(asin, "Amazon did not return a result for this ASIN.");
    }

    const status = asRecord(entry.status);
    const statusCode = numericValue(status?.statusCode) ?? numericValue(entry.statusCode);
    const body = entry.body ?? entry;

    if (statusCode !== undefined && statusCode >= 300) {
      return emptyAmazonItemOffers(asin, amazonBatchErrorMessage(body, statusCode));
    }

    return normalizeAmazonItemOffers(body, asin);
  });
}

/**
 * Searches Amazon Orders API v2026-01-01. The request intentionally asks for
 * FULFILLMENT only: no buyer, recipient, payment, tax, promotion, package, or
 * tracking data is requested or returned to ScannerAz.
 */
export async function searchSellerOrders(input: {
  refreshToken: string;
  accessToken?: string;
  marketplaceId?: string;
  lastUpdatedAfter?: string;
  paginationToken?: string;
  maxResultsPerPage?: number;
}) {
  const accessToken = input.accessToken ?? (await getLwaAccessToken(input.refreshToken)).access_token;
  const url = buildAmazonOrdersSearchUrl(input);

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "ScannerAz/0.1.0 (Language=Node.js; Platform=backend)",
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
    }
  });
  const body = await response.text();
  const parsedBody = parseJsonBody(body);

  if (!response.ok) {
    throw new AmazonOrdersRequestError(response.status, parsedBody);
  }

  return parsedBody as AmazonOrdersSearchResponse;
}

/**
 * Orders v2026-01-01 returns the order items with searchOrders, so no per-line
 * follow-up request is necessary. Items are kept even when their fulfilled
 * quantity is zero; a later order-state update can then reverse an earlier
 * inventory movement safely.
 */
export function normalizeAmazonOrderSearch(response: AmazonOrdersSearchResponse): AmazonOrderSearchPage {
  const orders = (response.orders ?? []).flatMap((rawOrder) => {
    const order = asRecord(rawOrder);
    const orderId = stringValue(order?.orderId);

    if (!orderId) {
      return [];
    }

    const fulfillment = asRecord(order?.fulfillment);
    const fulfillmentStatus = stringValue(fulfillment?.fulfillmentStatus)?.toUpperCase();
    const fulfilledBy = stringValue(fulfillment?.fulfilledBy)?.toUpperCase();
    const createdAt = isoDateValue(order?.createdTime);
    const lastUpdatedAt = isoDateValue(order?.lastUpdatedTime);

    return recordArray(order?.orderItems).flatMap((item) => {
      const orderItemId = stringValue(item.orderItemId);
      const product = asRecord(item.product);
      const itemFulfillment = asRecord(item.fulfillment);
      const sellerSku = stringValue(product?.sellerSku);
      const asin = stringValue(product?.asin)?.toUpperCase();
      const title = stringValue(product?.title);
      const conditionType = stringValue(asRecord(product?.condition)?.conditionType);
      const quantityOrdered = nonNegativeNumericValue(item.quantityOrdered) ?? 0;
      const explicitFulfilled = nonNegativeNumericValue(itemFulfillment?.quantityFulfilled);
      const quantityFulfilled = explicitFulfilled ?? (
        fulfillmentStatus === "SHIPPED" ? quantityOrdered : 0
      );

      if (!orderItemId || quantityOrdered <= 0) {
        return [];
      }

      return [{
        orderId,
        orderItemId,
        quantityOrdered,
        quantityFulfilled: Math.min(quantityOrdered, quantityFulfilled),
        ...(sellerSku ? { sellerSku } : {}),
        ...(asin ? { asin } : {}),
        ...(title ? { title } : {}),
        ...(conditionType ? { conditionType } : {}),
        ...(fulfillmentStatus ? { fulfillmentStatus } : {}),
        ...(fulfilledBy ? { fulfilledBy } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(lastUpdatedAt ? { lastUpdatedAt } : {})
      } satisfies AmazonFulfilledOrderLine];
    });
  });
  const pagination = asRecord(response.pagination);

  return {
    lines: orders,
    nextPageToken: stringValue(pagination?.nextToken)
  };
}

export async function getSellerListingItem(input: {
  sellerId: string;
  sku: string;
  refreshToken: string;
  accessToken?: string;
  marketplaceId?: string;
}) {
  const endpoint = getSpApiEndpoint(config.AMAZON_REGION, config.AMAZON_SP_API_ENVIRONMENT);
  const accessToken = input.accessToken ?? (await getLwaAccessToken(input.refreshToken)).access_token;
  const url = new URL(
    `/listings/2021-08-01/items/${encodeURIComponent(input.sellerId)}/${encodeURIComponent(input.sku)}`,
    endpoint
  );

  url.searchParams.set("marketplaceIds", input.marketplaceId ?? config.AMAZON_MARKETPLACE_ID);
  url.searchParams.set("includedData", "summaries,attributes,productTypes");
  url.searchParams.set("issueLocale", "en_US");

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "ScannerAz/0.1.0 (Language=Node.js; Platform=backend)",
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
    }
  });
  const body = await response.text();
  const parsedBody = parseJsonBody(body);

  if (!response.ok) {
    throw new Error(formatSpApiError("Amazon Listings Items", response.status, parsedBody, "Pricing and Product Listing"));
  }

  return parsedBody;
}

export async function patchSellerListingPrice(input: {
  sellerId: string;
  sku: string;
  refreshToken: string;
  accessToken?: string;
  marketplaceId?: string;
  patch: PreparedListingPriceUpdate["patch"] | PreparedListingRestock["patch"];
}) {
  const endpoint = getSpApiEndpoint(config.AMAZON_REGION, config.AMAZON_SP_API_ENVIRONMENT);
  const accessToken = input.accessToken ?? (await getLwaAccessToken(input.refreshToken)).access_token;
  const url = new URL(
    `/listings/2021-08-01/items/${encodeURIComponent(input.sellerId)}/${encodeURIComponent(input.sku)}`,
    endpoint
  );

  url.searchParams.set("marketplaceIds", input.marketplaceId ?? config.AMAZON_MARKETPLACE_ID);
  url.searchParams.set("issueLocale", "en_US");

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "ScannerAz/0.1.0 (Language=Node.js; Platform=backend)",
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
    },
    body: JSON.stringify(input.patch)
  });
  const body = await response.text();
  const parsedBody = parseJsonBody(body);

  if (!response.ok) {
    throw new Error(formatSpApiError("Amazon price update", response.status, parsedBody, "Pricing and Product Listing"));
  }

  return parsedBody;
}

export function normalizePricingListings(
  response: SellerListingsSearchResponse,
  marketplaceId = config.AMAZON_MARKETPLACE_ID
) {
  const seenSkus = new Set<string>();
  const listings = (response.items ?? []).flatMap((rawItem) => {
    const item = asRecord(rawItem);
    const sku = stringValue(item?.sku);
    const summary = marketplaceRecord(item?.summaries, marketplaceId);

    if (!sku || seenSkus.has(sku) || !listingSummaryIsBuyable(summary)) {
      return [];
    }

    seenSkus.add(sku);
    const productType = listingProductType(item, marketplaceId);
    const offer = matchingPurchasableOffer(item?.attributes, marketplaceId);
    const price = priceFromPurchasableOffer(offer);
    const currency = stringValue(offer?.currency) ?? "USD";

    return [{
      sku,
      asin: stringValue(summary?.asin),
      title: stringValue(summary?.itemName) ?? stringValue(summary?.item_name),
      productType,
      price,
      currency
    } satisfies AmazonPricingListing];
  });

  const pagination = asRecord(response.pagination);
  return {
    listings,
    nextPageToken: stringValue(pagination?.nextToken)
  };
}

/**
 * Build a price-only patch from the listing currently held by Amazon. Keeping
 * the existing purchasable_offer object preserves any sale schedule or fields
 * that ScannerAz is not responsible for.
 */
export function prepareListingPriceUpdate(
  rawListing: unknown,
  marketplaceId: string,
  targetPrice: number
): PreparedListingPriceUpdate {
  const listing = asRecord(rawListing);
  const sku = stringValue(listing?.sku);
  const productType = listingProductType(listing, marketplaceId);

  if (!sku || !productType) {
    throw new Error("Amazon did not return the SKU and product type required to update this price.");
  }

  const summary = marketplaceRecord(listing?.summaries, marketplaceId);
  const originalOffers = recordArray(asRecord(listing?.attributes)?.purchasable_offer);
  const offerIndex = originalOffers.findIndex((offer) => isMatchingPurchasableOffer(offer, marketplaceId));

  if (offerIndex < 0) {
    throw new Error("Amazon did not return a purchasable offer for this SKU.");
  }

  const currentOffer = originalOffers[offerIndex];
  const currentPrice = priceFromPurchasableOffer(currentOffer);
  const currency = stringValue(currentOffer.currency) ?? "USD";
  const updatedOffers = cloneJson(originalOffers);
  const updatedOffer = updatedOffers[offerIndex];

  if (!stringValue(updatedOffer.marketplace_id)) {
    updatedOffer.marketplace_id = marketplaceId;
  }

  if (!stringValue(updatedOffer.currency)) {
    updatedOffer.currency = currency;
  }

  const ourPrices = recordArray(updatedOffer.our_price);
  const priceEntry = ourPrices[0] ?? {};
  const schedules = recordArray(priceEntry.schedule);
  const activeScheduleIndex = schedules.findIndex((schedule) => !schedule.start_at && !schedule.end_at);
  const scheduleIndex = activeScheduleIndex >= 0 ? activeScheduleIndex : 0;
  const nextSchedule = {
    ...(schedules[scheduleIndex] ?? {}),
    value_with_tax: targetPrice
  };
  const nextSchedules = schedules.length
    ? schedules.map((schedule, index) => index === scheduleIndex ? nextSchedule : schedule)
    : [nextSchedule];
  const nextOurPrice = {
    ...priceEntry,
    schedule: nextSchedules
  };

  updatedOffer.our_price = ourPrices.length
    ? ourPrices.map((value, index) => index === 0 ? nextOurPrice : value)
    : [nextOurPrice];

  return {
    sku,
    asin: stringValue(summary?.asin),
    title: stringValue(summary?.itemName) ?? stringValue(summary?.item_name),
    productType,
    currentPrice,
    targetPrice,
    currency,
    patch: {
      productType,
      patches: [{
        op: "replace",
        path: "/attributes/purchasable_offer",
        value: updatedOffers
      }]
    }
  };
}

export type PreparedListingRestock = {
  sku: string;
  title?: string;
  productType: string;
  /** Only merchant-fulfilled (FBM) quantity can be written through Listings Items. */
  fulfillment: "merchant" | "amazon" | "unknown";
  currentQuantity?: number;
  targetQuantity: number;
  patch: {
    productType: string;
    patches: Array<{
      op: "replace";
      path: "/attributes/fulfillment_availability";
      value: Array<Record<string, unknown>>;
    }>;
  };
};

/**
 * Prepares a Listings Items patch that sets the merchant-fulfilled quantity.
 * Existing fulfillment fields such as handling time are preserved.
 */
export function prepareListingRestock(
  rawListing: unknown,
  marketplaceId: string,
  targetQuantity: number
): PreparedListingRestock {
  const listing = asRecord(rawListing);
  const sku = stringValue(listing?.sku);
  const productType = listingProductType(listing, marketplaceId);

  if (!sku || !productType) {
    throw new Error("Amazon did not return the SKU and product type required to update this quantity.");
  }

  const summary = marketplaceRecord(listing?.summaries, marketplaceId);
  const availability = recordArray(asRecord(listing?.attributes)?.fulfillment_availability);
  const merchantIndex = availability.findIndex((entry) =>
    (stringValue(entry.fulfillment_channel_code) ?? "DEFAULT").toUpperCase() === "DEFAULT");
  const fulfillment = merchantIndex >= 0
    ? "merchant"
    : availability.length
      ? "amazon"
      : "unknown";
  const currentQuantity = merchantIndex >= 0 ? numberValue(availability[merchantIndex].quantity) : undefined;
  const updated = cloneJson(availability);

  if (merchantIndex >= 0) {
    updated[merchantIndex] = { ...updated[merchantIndex], quantity: targetQuantity };
  } else {
    updated.push({ fulfillment_channel_code: "DEFAULT", quantity: targetQuantity });
  }

  return {
    sku,
    title: stringValue(summary?.itemName) ?? stringValue(summary?.item_name),
    productType,
    fulfillment,
    currentQuantity,
    targetQuantity,
    patch: {
      productType,
      patches: [{
        op: "replace",
        path: "/attributes/fulfillment_availability",
        value: updated
      }]
    }
  };
}

export function inferCatalogIdentifierType(value: string): CatalogIdentifierType | undefined {
  const normalized = value.trim().toUpperCase();

  if (/^B[A-Z0-9]{9}$/.test(normalized)) {
    return "ASIN";
  }

  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  if (normalized.length === 12) {
    return "UPC";
  }

  if (normalized.length === 13) {
    return "EAN";
  }

  if (normalized.length === 14) {
    return "GTIN";
  }

  if (normalized.length === 8) {
    return "GTIN";
  }

  return undefined;
}

export function normalizeCatalogSearchResponse(
  response: CatalogSearchResponse,
  marketplaceId = config.AMAZON_MARKETPLACE_ID
): CatalogCandidate[] {
  const seenAsins = new Set<string>();

  return (response.items ?? []).flatMap((rawItem) => {
    const item = asRecord(rawItem);
    const asin = stringValue(item?.asin)?.toUpperCase();

    if (!asin || seenAsins.has(asin)) {
      return [];
    }

    seenAsins.add(asin);
    const summary = marketplaceRecord(item?.summaries, marketplaceId);
    const identifiers = collectCatalogIdentifiers(item?.identifiers, marketplaceId);
    const upc = identifiers.find((identifier) => identifier.type === "UPC")?.value;
    const ean = identifiers.find((identifier) => identifier.type === "EAN")?.value;

    return [{
      asin,
      title: stringValue(summary?.itemName) ?? stringValue(summary?.item_name),
      brand: stringValue(summary?.brandName) ?? stringValue(summary?.brand),
      imageUrl: catalogImageUrl(item?.images, marketplaceId),
      upc,
      ean,
      identifiers
    }];
  });
}

function parseJsonBody(body: string) {
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function spApiReadHeaders(accessToken: string) {
  return {
    accept: "application/json",
    "user-agent": "ScannerAz/0.1.0 (Language=Node.js; Platform=backend)",
    "x-amz-access-token": accessToken,
    "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
  };
}

function normalizeAsin(value: string) {
  const asin = value.trim().toUpperCase();

  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new Error("ASIN must be a 10-character Amazon identifier.");
  }

  return asin;
}

function recordValue(record: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    if (record?.[key] !== undefined) {
      return record[key];
    }
  }

  return undefined;
}

function booleanValue(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }

  return false;
}

function pricingMoney(value: unknown) {
  const record = asRecord(value);
  const amount = numericValue(recordValue(record, ["Amount", "amount", "Value", "value"]) ?? value);

  if (amount === undefined) {
    return undefined;
  }

  return {
    amount,
    currency: stringValue(recordValue(record, ["CurrencyCode", "currencyCode", "Currency", "currency"]))
  };
}

function offerMoney(offer: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const money = pricingMoney(offer[key]);

    if (money) {
      return money;
    }
  }

  return undefined;
}

function fulfillmentFromChannel(value: unknown): "FBA" | "FBM" | undefined {
  const channel = stringValue(value)?.toUpperCase();

  if (!channel) {
    return undefined;
  }

  if (["AMAZON", "AFN", "FBA"].includes(channel)) {
    return "FBA";
  }

  if (["MERCHANT", "MFN", "FBM"].includes(channel)) {
    return "FBM";
  }

  return undefined;
}

function normalizeAmazonItemOffer(offer: Record<string, unknown>): AmazonItemOffer {
  const sellerId = stringValue(recordValue(offer, ["SellerId", "sellerId"]));
  const sellerName = stringValue(recordValue(offer, ["SellerName", "sellerName", "SellerStoreName", "sellerStoreName", "storeName"]));
  const listing = offerMoney(offer, ["ListingPrice", "listingPrice"]);
  const shippingOptions = recordArray(recordValue(offer, ["shippingOptions", "ShippingOptions"]));
  const defaultShipping = shippingOptions.find((option) =>
    stringValue(recordValue(option, ["shippingOptionType", "ShippingOptionType"]))?.toUpperCase() === "DEFAULT",
  ) ?? shippingOptions[0];
  const shipping = pricingMoney(recordValue(defaultShipping, ["price", "Price"])) ??
    offerMoney(offer, ["Shipping", "shipping"]);
  const landed = offerMoney(offer, ["LandedPrice", "landedPrice"]);
  const fulfillment = booleanValue(recordValue(offer, ["IsAmazon", "isAmazon", "IsAmazonSeller", "isAmazonSeller"]))
    ? "AMZ"
    : booleanValue(recordValue(offer, ["IsFulfilledByAmazon", "isFulfilledByAmazon"]))
      ? "FBA"
      : fulfillmentFromChannel(recordValue(offer, ["fulfillmentType", "FulfillmentType", "FulfillmentChannel", "fulfillmentChannel"])) ?? "FBM";
  const landedPrice = landed?.amount ?? (
    listing?.amount !== undefined
      ? listing.amount + (shipping?.amount ?? 0)
      : undefined
  );
  const primeDetails = recordValue(offer, ["IsPrime", "isPrime", "PrimeInformation", "primeInformation", "primeDetails", "PrimeDetails"]);

  return {
    ...(sellerId ? { sellerId } : {}),
    ...(sellerName ? { sellerName } : {}),
    fulfillment,
    ...(stringValue(recordValue(offer, ["subCondition", "SubCondition", "condition", "Condition"]))
      ? { condition: stringValue(recordValue(offer, ["subCondition", "SubCondition", "condition", "Condition"])) }
      : {}),
    ...(listing?.amount !== undefined ? { listingPrice: listing.amount } : {}),
    ...(shipping?.amount !== undefined ? { shippingPrice: shipping.amount } : {}),
    ...(landedPrice !== undefined ? { landedPrice } : {}),
    ...(landed?.currency || listing?.currency || shipping?.currency
      ? { currency: landed?.currency ?? listing?.currency ?? shipping?.currency }
      : {}),
    ...(booleanValue(recordValue(offer, ["IsBuyBoxWinner", "isBuyBoxWinner", "IsFeaturedMerchant", "isFeaturedMerchant"]))
      ? { isBuyBoxWinner: true }
      : {}),
    ...(booleanValue(primeDetails) || Boolean(asRecord(primeDetails))
      ? { isPrime: true }
    : {})
  };
}

/** Add a verified display name when it belongs to the authorized seller. */
export function applyAmazonSellerStoreName(
  details: AmazonItemOffers,
  sellerId: string | undefined,
  sellerName: string | undefined,
): AmazonItemOffers {
  const normalizedSellerId = sellerId?.trim().toUpperCase();
  const normalizedSellerName = sellerName?.trim();

  if (!normalizedSellerId || !normalizedSellerName) {
    return details;
  }

  const offers = details.offers.map((offer) =>
    offer.sellerId?.trim().toUpperCase() === normalizedSellerId && !offer.sellerName
      ? { ...offer, sellerName: normalizedSellerName }
      : offer,
  );

  return {
    ...details,
    ...(details.buyBoxSellerId?.trim().toUpperCase() === normalizedSellerId && !details.buyBoxSellerName
      ? { buyBoxSellerName: normalizedSellerName }
      : {}),
    offers,
  };
}

function mergeAmazonItemOffers(offers: AmazonItemOffer[]) {
  const byOfferKey = new Map<string, AmazonItemOffer>();

  for (const offer of offers) {
    const key = [
      offer.sellerId ?? "unknown",
      offer.fulfillment,
      offer.landedPrice ?? offer.listingPrice ?? "price-unknown",
    ].join(":");
    const current = byOfferKey.get(key);

    byOfferKey.set(key, current ? {
      ...current,
      ...offer,
      ...(current.isBuyBoxWinner || offer.isBuyBoxWinner ? { isBuyBoxWinner: true } : {}),
      ...(current.isPrime || offer.isPrime ? { isPrime: true } : {}),
    } : offer);
  }

  return Array.from(byOfferKey.values());
}

function countOfferFulfillment(offers: AmazonItemOffer[]) {
  return offers.reduce(
    (counts, offer) => {
      if (offer.fulfillment === "FBA") {
        counts.fba += 1;
      } else if (offer.fulfillment === "FBM") {
        counts.fbm += 1;
      } else if (offer.fulfillment === "AMZ") {
        counts.amz += 1;
      }

      return counts;
    },
    { fba: 0, fbm: 0, amz: 0 }
  );
}

function batchResponseAsin(response: Record<string, unknown>) {
  const request = asRecord(response.request);
  const body = asRecord(response.body);
  return stringValue(recordValue(body, ["ASIN", "asin"]))?.toUpperCase() ??
    stringValue(recordValue(request, ["ASIN", "asin"]))?.toUpperCase();
}

function amazonBatchErrorMessage(body: unknown, statusCode: number) {
  const errors = recordArray(asRecord(body)?.errors);
  const error = errors[0];
  const detail = [
    stringValue(error?.code),
    stringValue(error?.message)
  ].filter(Boolean).join(": ");

  return detail || `Amazon Product Pricing returned ${statusCode} for this ASIN.`;
}

function emptyAmazonItemOffers(asin: string, error: string): AmazonItemOffers {
  return {
    asin,
    visibleOfferCount: 0,
    sellerCount: 0,
    fbaOfferCount: 0,
    fbmOfferCount: 0,
    amazonOfferCount: 0,
    buyBoxAvailable: false,
    offers: [],
    error
  };
}

function recordArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record))
    : [];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function listingProductType(value: unknown, marketplaceId: string) {
  const item = asRecord(value);
  const productTypes = recordArray(item?.productTypes);
  const matchingType = productTypes.find((entry) => {
    const entryMarketplaceId = stringValue(entry.marketplaceId) ?? stringValue(entry.marketplace_id);
    return !entryMarketplaceId || entryMarketplaceId === marketplaceId;
  }) ?? productTypes[0];
  const summary = marketplaceRecord(item?.summaries, marketplaceId);

  return stringValue(matchingType?.productType) ??
    stringValue(matchingType?.product_type) ??
    stringValue(summary?.productType) ??
    stringValue(summary?.product_type);
}

function isMatchingPurchasableOffer(offer: Record<string, unknown>, marketplaceId: string) {
  const offerMarketplaceId = stringValue(offer.marketplace_id) ?? stringValue(offer.marketplaceId);
  const audience = stringValue(offer.audience)?.toUpperCase();

  return (!offerMarketplaceId || offerMarketplaceId === marketplaceId) &&
    (!audience || audience === "ALL");
}

function matchingPurchasableOffer(attributes: unknown, marketplaceId: string) {
  const offers = recordArray(asRecord(attributes)?.purchasable_offer);

  return offers.find((offer) => isMatchingPurchasableOffer(offer, marketplaceId)) ??
    offers.find((offer) => {
      const offerMarketplaceId = stringValue(offer.marketplace_id) ?? stringValue(offer.marketplaceId);
      return !offerMarketplaceId || offerMarketplaceId === marketplaceId;
    }) ??
    offers[0];
}

function numericValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function nonNegativeNumericValue(value: unknown) {
  const number = numericValue(value);
  return number !== undefined && number >= 0 ? Math.floor(number) : undefined;
}

function isoDateValue(value: unknown) {
  const text = stringValue(value);

  if (!text) {
    return undefined;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function priceFromPurchasableOffer(offer?: Record<string, unknown>) {
  for (const price of recordArray(offer?.our_price)) {
    const schedules = recordArray(price.schedule);
    const activeSchedule = schedules.find((schedule) => !schedule.start_at && !schedule.end_at) ?? schedules[0];
    const amount = numericValue(activeSchedule?.value_with_tax);

    if (amount !== undefined) {
      return amount;
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function marketplaceRecord(value: unknown, marketplaceId: string) {
  const records = Array.isArray(value)
    ? value.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record))
    : [];

  return records.find((record) => stringValue(record.marketplaceId) === marketplaceId) ?? records[0];
}

function listingSummaryIsBuyable(summary?: Record<string, unknown>) {
  const statuses = Array.isArray(summary?.status)
    ? summary.status
        .map(stringValue)
        .filter((status): status is string => Boolean(status))
        .map((status) => status.toUpperCase())
    : [];

  return statuses.includes("BUYABLE");
}

function collectCatalogIdentifiers(value: unknown, marketplaceId: string) {
  const groups = Array.isArray(value)
    ? value.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record))
    : [];
  const matchingGroups = groups.filter((group) => {
    const groupMarketplaceId = stringValue(group.marketplaceId);
    return !groupMarketplaceId || groupMarketplaceId === marketplaceId;
  });
  const identifiers: Array<{ type: string; value: string }> = [];

  for (const group of matchingGroups.length ? matchingGroups : groups) {
    const values = Array.isArray(group.identifiers) ? group.identifiers : [];

    for (const rawIdentifier of values) {
      const identifier = asRecord(rawIdentifier);
      const type = stringValue(identifier?.identifierType)?.toUpperCase();
      const value = stringValue(identifier?.identifier);

      if (type && value && !identifiers.some((entry) => entry.type === type && entry.value === value)) {
        identifiers.push({ type, value });
      }
    }
  }

  return identifiers;
}

function catalogImageUrl(value: unknown, marketplaceId: string) {
  const groups = Array.isArray(value)
    ? value.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record))
    : [];
  const group = groups.find((entry) => stringValue(entry.marketplaceId) === marketplaceId) ?? groups[0];
  const images = Array.isArray(group?.images)
    ? group.images.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record))
    : [];
  const image = images.find((entry) => stringValue(entry.variant)?.toUpperCase() === "MAIN") ?? images[0];

  return stringValue(image?.link);
}

function formatSpApiError(
  operation: string,
  status: number,
  body: unknown,
  requiredRole = "Product Listing"
) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);

  if (status === 401 || status === 403) {
    return `${operation} failed: ${status}. Check that the refresh token belongs to this SP-API app, the seller has authorized it, and the app has the required ${requiredRole} role. Body: ${payload}`;
  }

  if (status === 429) {
    return `${operation} rate limited: ${status}. Body: ${payload}`;
  }

  return `${operation} failed: ${status}. Body: ${payload}`;
}

export function normalizeListingsRestrictions(response: ListingsRestrictionsResponse): {
  status: RestrictionStatus;
  restrictions: ListingsRestriction[];
} {
  const restrictions = response.restrictions ?? [];

  if (restrictions.length === 0) {
    return { status: "sellable", restrictions };
  }

  const reasons = restrictions.flatMap((restriction) => restriction.reasons ?? []);
  const hasApprovalPath = reasons.some((reason) => {
    const reasonCode = reason.reasonCode?.toLowerCase() ?? "";
    return reasonCode.includes("approval") || (reason.links?.length ?? 0) > 0;
  });

  return {
    status: hasApprovalPath ? "approval_required" : "blocked",
    restrictions
  };
}
