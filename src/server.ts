import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { assertAmazonOAuthConfig, assertTokenStorageConfig, config } from "./config.js";
import {
  createOAuthState,
  decodeState,
  encodeState,
  exchangeAuthorizationCode,
  getAmazonAuthorizationUrl
} from "./amazon/oauth.js";
import { amazonRouter } from "./amazon/routes.js";
import { listAmazonConnections, saveAmazonConnection } from "./storage/connections.js";
import { keepaRouter } from "./keepa/routes.js";
import { retailRouter } from "./retail/routes.js";
import "./retail/target/clearance.js";
import { targetRouter } from "./retail/target/routes.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

app.use(helmet());
app.use(express.json());
app.use(express.static(publicDir));

const oauthCookieName = "scanneraz_amazon_oauth_state";

function getOAuthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.APP_BASE_URL.startsWith("https://"),
    maxAge: 10 * 60 * 1000
  };
}

function getCookie(req: express.Request, name: string) {
  const cookies = req.headers.cookie?.split(";").map((cookie) => cookie.trim()) ?? [];
  const cookie = cookies.find((item) => item.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : undefined;
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/keepa", keepaRouter);
app.use("/api/amazon", amazonRouter);
app.use("/api/retail", retailRouter);
app.use("/api/retail/target", targetRouter);

app.get("/auth/amazon/start", (_req, res, next) => {
  try {
    assertAmazonOAuthConfig();
    assertTokenStorageConfig();
    const state = encodeState(createOAuthState());
    res.cookie(oauthCookieName, state, getOAuthCookieOptions());
    res.redirect(getAmazonAuthorizationUrl(state));
  } catch (error) {
    next(error);
  }
});

app.get("/auth/amazon/login", (req, res, next) => {
  try {
    assertAmazonOAuthConfig();
    assertTokenStorageConfig();

    const amazonCallbackUri = String(req.query.amazon_callback_uri || "");
    const amazonState = String(req.query.amazon_state || "");

    if (!amazonCallbackUri || !amazonState) {
      res.status(400).json({ error: "Missing Amazon login parameters" });
      return;
    }

    const state = encodeState(createOAuthState());
    const callbackUrl = new URL(amazonCallbackUri);
    callbackUrl.searchParams.set("amazon_state", amazonState);
    callbackUrl.searchParams.set("state", state);
    callbackUrl.searchParams.set("redirect_uri", `${config.APP_BASE_URL}/auth/amazon/callback`);

    if (config.AMAZON_OAUTH_VERSION) {
      callbackUrl.searchParams.set("version", config.AMAZON_OAUTH_VERSION);
    }

    res.cookie(oauthCookieName, state, getOAuthCookieOptions());
    res.redirect(callbackUrl.toString());
  } catch (error) {
    next(error);
  }
});

app.get("/auth/amazon/callback", async (req, res, next) => {
  try {
    const state = String(req.query.state || "");
    const code = String(req.query.spapi_oauth_code || req.query.code || "");
    const sellingPartnerId = req.query.selling_partner_id
      ? String(req.query.selling_partner_id)
      : undefined;
    const expectedState = getCookie(req, oauthCookieName);

    if (!state || !expectedState || state !== expectedState) {
      res.status(400).json({ error: "Invalid or expired OAuth state" });
      return;
    }

    res.clearCookie(oauthCookieName);
    decodeState(state);

    if (!code) {
      res.status(400).json({ error: "Missing Amazon authorization code" });
      return;
    }

    const tokenResponse = await exchangeAuthorizationCode(code);

    if (!tokenResponse.refresh_token) {
      res.status(400).json({ error: "Amazon did not return a refresh token" });
      return;
    }

    const id = crypto.randomUUID();
    saveAmazonConnection({
      id,
      sellerId: sellingPartnerId,
      marketplaceId: config.AMAZON_MARKETPLACE_ID,
      refreshToken: tokenResponse.refresh_token,
      connectedAt: new Date().toISOString()
    });

    res.json({
      ok: true,
      connectionId: id,
      sellerId: sellingPartnerId,
      marketplaceId: config.AMAZON_MARKETPLACE_ID
    });
  } catch (error) {
    next(error);
  }
});

app.get("/connections", (_req, res) => {
  res.json({ amazon: listAmazonConnections() });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  res.status(500).json({ error: message });
});

app.listen(config.PORT, () => {
  console.log(`ScannerAz listening at ${config.APP_BASE_URL}`);
});
