import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  AMAZON_REGION: z.enum(["na", "eu", "fe"]).default("na"),
  // Sandbox must remain explicit so mocked eligibility data is never mistaken
  // for a production seller decision.
  AMAZON_SP_API_ENVIRONMENT: z.enum(["sandbox", "production"]).default("production"),
  AMAZON_MARKETPLACE_ID: z.string().default("ATVPDKIKX0DER"),
  AMAZON_LWA_CLIENT_ID: z.string().min(1).optional(),
  AMAZON_LWA_CLIENT_SECRET: z.string().min(1).optional(),
  AMAZON_SP_API_APP_ID: z.string().min(1).optional(),
  AMAZON_OAUTH_VERSION: z.enum(["beta"]).optional(),
  AMAZON_REFRESH_TOKEN: z.string().min(1).optional(),
  AMAZON_SELLER_ID: z.string().min(1).optional(),
  // Shared only by the Cloudflare Worker and Render. When set in production,
  // every request except Render's health probe must come through the Worker.
  SCANNERAZ_EDGE_SHARED_SECRET: z.string().min(32).optional(),
  SCANNERAZ_OPERATOR_TOKEN: z.string().min(32).optional(),
  SCANNERAZ_PUBLIC_APP_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SCANNERAZ_PUBLIC_SIGNUP_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Price writes are deliberately opt-in. Previewing a price batch remains
  // possible, but production listing prices cannot change until this is set.
  SCANNERAZ_PRICE_UPDATES_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  KEEPA_API_KEY: z.string().min(1).optional(),
  // Invoice documents go through the private Warasoft AI Gateway. The
  // gateway key stays server-side in Render and is never sent to Expo.
  WARASOFT_AI_GATEWAY_URL: z.string().url().optional(),
  WARASOFT_AI_GATEWAY_KEY: z.string().min(1).optional(),
  WARASOFT_AI_INVOICE_MODEL: z.string().trim().min(1).default("gpt-4o-mini"),
  WARASOFT_AI_PROJECT: z.coerce.number().int().positive().optional(),
  INVOICE_EXTRACTION_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(120_000).default(115_000),
  INVOICE_EXTRACTION_MAX_FILE_BYTES: z.coerce.number().int().min(1_000_000).max(50_000_000).default(20_000_000),
  TARGET_PROVIDER: z.enum(["public-web", "unwrangle"]).default("public-web"),
  TARGET_API_KEY: z.string().min(1).optional(),
  DATA_DIR: z.string().default("data"),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ENCRYPTION_KEY: z.string().min(32).optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  // Outgoing mail for sign-in codes. Set the SMTP_* values in Render only.
  SMTP_HOST: z.string().trim().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
  SMTP_USER: z.string().trim().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  EMAIL_FROM: z.string().trim().min(3).default("ScannerAz <no-reply@warasoft.com>")
});

export const config = envSchema.parse(process.env);

export function assertAmazonLwaConfig() {
  const missing = [
    ["AMAZON_LWA_CLIENT_ID", config.AMAZON_LWA_CLIENT_ID],
    ["AMAZON_LWA_CLIENT_SECRET", config.AMAZON_LWA_CLIENT_SECRET]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing Amazon OAuth configuration: ${missing.join(", ")}`);
  }
}

export function assertAmazonOAuthConfig() {
  assertAmazonLwaConfig();

  if (!config.AMAZON_SP_API_APP_ID) {
    throw new Error("Missing Amazon OAuth configuration: AMAZON_SP_API_APP_ID");
  }
}

export function assertAmazonSpApiConfig(refreshToken = config.AMAZON_REFRESH_TOKEN) {
  assertAmazonLwaConfig();

  const missing = [
    ["AMAZON_REFRESH_TOKEN or an authorized connection", refreshToken]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing Amazon SP-API configuration: ${missing.join(", ")}`);
  }
}

export function assertTokenStorageConfig() {
  if (!config.ENCRYPTION_KEY) {
    throw new Error("Missing token storage configuration: ENCRYPTION_KEY");
  }
}

export function assertOAuthSecurityConfig() {
  const missing = [
    ["ENCRYPTION_KEY", config.ENCRYPTION_KEY],
    ["SESSION_SECRET", config.SESSION_SECRET]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing OAuth security configuration: ${missing.join(", ")}`);
  }
}

export function assertKeepaConfig() {
  if (!config.KEEPA_API_KEY) {
    throw new Error("Missing Keepa configuration: KEEPA_API_KEY");
  }
}

export function assertInvoiceExtractionConfig() {
  const missing = [
    ["WARASOFT_AI_GATEWAY_URL", config.WARASOFT_AI_GATEWAY_URL],
    ["WARASOFT_AI_GATEWAY_KEY", config.WARASOFT_AI_GATEWAY_KEY]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing invoice extraction configuration: ${missing.join(", ")}`);
  }
}

export function assertTargetConfig() {
  const missing = [["TARGET_PROVIDER", config.TARGET_PROVIDER]]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (config.TARGET_PROVIDER === "unwrangle" && !config.TARGET_API_KEY) {
    missing.push("TARGET_API_KEY");
  }

  if (missing.length > 0) {
    throw new Error(`Missing Target configuration: ${missing.join(", ")}`);
  }
}
