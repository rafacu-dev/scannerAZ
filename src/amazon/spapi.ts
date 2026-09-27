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

export type RestrictionStatus = "sellable" | "approval_required" | "blocked" | "unknown";

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
  query: string;
  refreshToken: string;
  accessToken?: string;
  marketplaceId?: string;
  limit?: number;
  identifierType?: CatalogIdentifierType;
}) {
  const endpoint = getSpApiEndpoint(config.AMAZON_REGION, config.AMAZON_SP_API_ENVIRONMENT);
  const accessToken = input.accessToken ?? (await getLwaAccessToken(input.refreshToken)).access_token;
  const url = new URL("/catalog/2022-04-01/items", endpoint);

  url.searchParams.set("marketplaceIds", input.marketplaceId ?? config.AMAZON_MARKETPLACE_ID);
  url.searchParams.set("includedData", "summaries,identifiers,images");
  url.searchParams.set("locale", "en_US");
  url.searchParams.set("pageSize", String(Math.max(1, Math.min(input.limit ?? 10, 20))));

  if (input.identifierType) {
    url.searchParams.set("identifiers", input.query);
    url.searchParams.set("identifiersType", input.identifierType);
  } else {
    url.searchParams.set("keywords", input.query);
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
    throw new Error(formatSpApiError("Amazon Catalog Items", response.status, parsedBody));
  }

  return parsedBody as CatalogSearchResponse;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function marketplaceRecord(value: unknown, marketplaceId: string) {
  const records = Array.isArray(value)
    ? value.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record))
    : [];

  return records.find((record) => stringValue(record.marketplaceId) === marketplaceId) ?? records[0];
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

function formatSpApiError(operation: string, status: number, body: unknown) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);

  if (status === 401 || status === 403) {
    return `${operation} failed: ${status}. Check that the refresh token belongs to this SP-API app, the seller has authorized it, and the app has the required Product Listing role. Body: ${payload}`;
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
