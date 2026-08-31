import { config } from "../config.js";

type RegionConfig = {
  endpoint: string;
};

const regionConfig: Record<typeof config.AMAZON_REGION, RegionConfig> = {
  na: {
    endpoint: "https://sellingpartnerapi-na.amazon.com"
  },
  eu: {
    endpoint: "https://sellingpartnerapi-eu.amazon.com"
  },
  fe: {
    endpoint: "https://sellingpartnerapi-fe.amazon.com"
  }
};

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

export type RestrictionStatus = "sellable" | "approval_required" | "blocked" | "unknown";

async function getLwaAccessToken() {
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.AMAZON_REFRESH_TOKEN!,
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
  conditionType?: string;
  marketplaceId?: string;
}) {
  const { endpoint } = regionConfig[config.AMAZON_REGION];
  const accessToken = (await getLwaAccessToken()).access_token;
  const url = new URL("/listings/2021-08-01/restrictions", endpoint);

  url.searchParams.set("asin", input.asin);
  url.searchParams.set("sellerId", input.sellerId);
  url.searchParams.set("marketplaceIds", input.marketplaceId ?? config.AMAZON_MARKETPLACE_ID);
  url.searchParams.set("conditionType", input.conditionType ?? "new_new");
  url.searchParams.set("reasonLocale", "en_US");

  const response = await fetch(url, {
    headers: {
      "x-amz-access-token": accessToken
    }
  });
  const body = await response.text();
  const parsedBody = body ? JSON.parse(body) : {};

  if (!response.ok) {
    throw new Error(`Amazon Listings Restrictions failed: ${response.status} ${body}`);
  }

  return parsedBody as ListingsRestrictionsResponse;
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
