import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  AMAZON_REGION: z.enum(["na", "eu", "fe"]).default("na"),
  AMAZON_MARKETPLACE_ID: z.string().default("ATVPDKIKX0DER"),
  AMAZON_LWA_CLIENT_ID: z.string().min(1).optional(),
  AMAZON_LWA_CLIENT_SECRET: z.string().min(1).optional(),
  AMAZON_SP_API_APP_ID: z.string().min(1).optional(),
  AMAZON_OAUTH_VERSION: z.enum(["beta"]).optional(),
  AMAZON_REFRESH_TOKEN: z.string().min(1).optional(),
  AMAZON_SELLER_ID: z.string().min(1).optional(),
  KEEPA_API_KEY: z.string().min(1).optional(),
  TARGET_PROVIDER: z.enum(["public-web", "unwrangle"]).default("public-web"),
  TARGET_API_KEY: z.string().min(1).optional(),
  DATA_DIR: z.string().default("data"),
  ENCRYPTION_KEY: z.string().min(32).optional(),
  SESSION_SECRET: z.string().min(32).optional()
});

export const config = envSchema.parse(process.env);

export function assertAmazonOAuthConfig() {
  const missing = [
    ["AMAZON_LWA_CLIENT_ID", config.AMAZON_LWA_CLIENT_ID],
    ["AMAZON_LWA_CLIENT_SECRET", config.AMAZON_LWA_CLIENT_SECRET],
    ["AMAZON_SP_API_APP_ID", config.AMAZON_SP_API_APP_ID]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing Amazon OAuth configuration: ${missing.join(", ")}`);
  }
}

export function assertAmazonSpApiConfig() {
  const missing = [
    ["AMAZON_LWA_CLIENT_ID", config.AMAZON_LWA_CLIENT_ID],
    ["AMAZON_LWA_CLIENT_SECRET", config.AMAZON_LWA_CLIENT_SECRET],
    ["AMAZON_REFRESH_TOKEN", config.AMAZON_REFRESH_TOKEN]
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

export function assertKeepaConfig() {
  if (!config.KEEPA_API_KEY) {
    throw new Error("Missing Keepa configuration: KEEPA_API_KEY");
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
