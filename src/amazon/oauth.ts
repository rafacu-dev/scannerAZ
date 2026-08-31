import crypto from "node:crypto";
import { config } from "../config.js";

export type AmazonOAuthState = {
  nonce: string;
  createdAt: string;
};

const authorizationHosts: Record<typeof config.AMAZON_REGION, string> = {
  na: "https://sellercentral.amazon.com",
  eu: "https://sellercentral-europe.amazon.com",
  fe: "https://sellercentral.amazon.co.jp"
};

export function createOAuthState(): AmazonOAuthState {
  return {
    nonce: crypto.randomBytes(24).toString("base64url"),
    createdAt: new Date().toISOString()
  };
}

export function encodeState(state: AmazonOAuthState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function decodeState(value: string): AmazonOAuthState {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

  if (typeof parsed?.nonce !== "string" || typeof parsed?.createdAt !== "string") {
    throw new Error("Invalid OAuth state");
  }

  return parsed;
}

export function getAmazonAuthorizationUrl(state: string): string {
  if (!config.AMAZON_SP_API_APP_ID) {
    throw new Error("Missing AMAZON_SP_API_APP_ID");
  }

  const baseUrl = authorizationHosts[config.AMAZON_REGION];
  const url = new URL("/apps/authorize/consent", baseUrl);

  url.searchParams.set("application_id", config.AMAZON_SP_API_APP_ID);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${config.APP_BASE_URL}/auth/amazon/callback`);
  if (config.AMAZON_OAUTH_VERSION) {
    url.searchParams.set("version", config.AMAZON_OAUTH_VERSION);
  }

  return url.toString();
}

export type AmazonTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
};

export async function exchangeAuthorizationCode(code: string): Promise<AmazonTokenResponse> {
  if (!config.AMAZON_LWA_CLIENT_ID || !config.AMAZON_LWA_CLIENT_SECRET) {
    throw new Error("Missing Login with Amazon client configuration");
  }

  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.AMAZON_LWA_CLIENT_ID,
      client_secret: config.AMAZON_LWA_CLIENT_SECRET,
      redirect_uri: `${config.APP_BASE_URL}/auth/amazon/callback`
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Amazon token exchange failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<AmazonTokenResponse>;
}
