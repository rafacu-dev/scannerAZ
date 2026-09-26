import crypto from "node:crypto";
import { config } from "../config.js";
import { decryptSecret, encryptSecret } from "../security/crypto.js";

export type AmazonOAuthState = {
  nonce: string;
  createdAt: string;
  tenantId?: string;
};

const authorizationHosts: Record<typeof config.AMAZON_REGION, string> = {
  na: "https://sellercentral.amazon.com",
  eu: "https://sellercentral-europe.amazon.com",
  fe: "https://sellercentral.amazon.co.jp"
};

const oauthStateMaxAgeMs = 10 * 60 * 1000;
const oauthStateClockSkewMs = 60 * 1000;

export type AmazonWebsiteLoginRequest = {
  amazonCallbackUri: string;
  amazonState: string;
  createdAt: string;
};

export function createOAuthState(input: { tenantId?: string } = {}): AmazonOAuthState {
  if (input.tenantId && !/^[a-f0-9-]{36}$/i.test(input.tenantId)) {
    throw new Error("Invalid OAuth tenant state");
  }

  return {
    nonce: crypto.randomBytes(24).toString("base64url"),
    createdAt: new Date().toISOString(),
    ...(input.tenantId ? { tenantId: input.tenantId } : {})
  };
}

export function encodeState(state: AmazonOAuthState): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${payload}.${signState(payload)}`;
}

export function decodeState(value: string): AmazonOAuthState {
  const [payload, signature, ...extra] = value.split(".");

  if (!payload || !signature || extra.length > 0 || !safeEqual(signature, signState(payload))) {
    throw new Error("Invalid OAuth state signature");
  }

  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

  if (
    typeof parsed?.nonce !== "string" ||
    typeof parsed?.createdAt !== "string" ||
    (parsed?.tenantId !== undefined &&
      (typeof parsed.tenantId !== "string" || !/^[a-f0-9-]{36}$/i.test(parsed.tenantId)))
  ) {
    throw new Error("Invalid OAuth state");
  }

  const createdAtMs = Date.parse(parsed.createdAt);
  if (
    Number.isNaN(createdAtMs) ||
    createdAtMs > Date.now() + oauthStateClockSkewMs ||
    Date.now() - createdAtMs > oauthStateMaxAgeMs
  ) {
    throw new Error("Expired OAuth state");
  }

  return parsed as AmazonOAuthState;
}

export function createAmazonWebsiteLoginRequest(input: {
  amazonCallbackUri: string;
  amazonState: string;
}): AmazonWebsiteLoginRequest {
  if (!config.AMAZON_SP_API_APP_ID) {
    throw new Error("Missing Amazon OAuth configuration: AMAZON_SP_API_APP_ID");
  }

  const amazonState = input.amazonState.trim();

  if (!amazonState || amazonState.length > 2048) {
    throw new Error("Invalid Amazon authorization state");
  }

  let callbackUrl: URL;

  try {
    callbackUrl = new URL(input.amazonCallbackUri);
  } catch {
    throw new Error("Invalid Amazon callback URI");
  }
  const expectedOrigin = authorizationHosts[config.AMAZON_REGION];
  const expectedPath = `/apps/authorize/confirm/${config.AMAZON_SP_API_APP_ID}`;

  if (
    callbackUrl.origin !== expectedOrigin ||
    callbackUrl.pathname !== expectedPath ||
    callbackUrl.protocol !== "https:"
  ) {
    throw new Error("Invalid Amazon callback URI");
  }

  return {
    amazonCallbackUri: callbackUrl.toString(),
    amazonState,
    createdAt: new Date().toISOString()
  };
}

export function encodeAmazonWebsiteLoginRequest(request: AmazonWebsiteLoginRequest) {
  return encryptSecret(JSON.stringify(request));
}

export function decodeAmazonWebsiteLoginRequest(value: string): AmazonWebsiteLoginRequest {
  const parsed = JSON.parse(decryptSecret(value));

  if (
    typeof parsed?.amazonCallbackUri !== "string" ||
    typeof parsed?.amazonState !== "string" ||
    typeof parsed?.createdAt !== "string"
  ) {
    throw new Error("Invalid Amazon website login request");
  }

  const createdAtMs = Date.parse(parsed.createdAt);

  if (
    Number.isNaN(createdAtMs) ||
    createdAtMs > Date.now() + oauthStateClockSkewMs ||
    Date.now() - createdAtMs > oauthStateMaxAgeMs
  ) {
    throw new Error("Expired Amazon website login request");
  }

  const validated = createAmazonWebsiteLoginRequest({
    amazonCallbackUri: parsed.amazonCallbackUri,
    amazonState: parsed.amazonState
  });

  return { ...validated, createdAt: parsed.createdAt };
}

function signState(payload: string) {
  if (!config.SESSION_SECRET) {
    throw new Error("Missing SESSION_SECRET");
  }

  return crypto.createHmac("sha256", config.SESSION_SECRET).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
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
