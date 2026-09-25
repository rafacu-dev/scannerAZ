import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { assertAmazonOAuthConfig, assertOAuthSecurityConfig, config } from "./config.js";
import {
  createOAuthState,
  decodeState,
  encodeState,
  exchangeAuthorizationCode,
  getAmazonAuthorizationUrl
} from "./amazon/oauth.js";
import { publicAmazonRouter } from "./amazon/publicRoutes.js";
import { amazonRouter } from "./amazon/routes.js";
import {
  endRequestSession,
  requireTenantSession,
  setSessionCookie
} from "./auth/session.js";
import {
  initializeAmazonConnectionStore,
  listAmazonConnections,
  saveAmazonConnection,
  usesManagedAmazonConnectionStore
} from "./storage/connections.js";
import {
  AccountAlreadyExistsError,
  initializeAccountStore,
  InvalidCredentialsError,
  loginAccount,
  registerAccount,
  usesManagedAccountStore
} from "./storage/accounts.js";
import { keepaRouter } from "./keepa/routes.js";
import { retailRouter } from "./retail/routes.js";
import "./retail/target/clearance.js";
import { targetRouter } from "./retail/target/routes.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

app.disable("x-powered-by");

if (config.NODE_ENV === "production") {
  // Render and similar PaaS deployments terminate TLS before the application.
  app.set("trust proxy", 1);
}

app.use((_req, res, next) => {
  const requestId = crypto.randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
});

app.use(helmet());
app.use(express.json({ limit: "64kb" }));
app.use(express.static(publicDir));

const oauthCookieName = "scanneraz_amazon_oauth_state";
const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  legacyHeaders: false,
  standardHeaders: true,
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many requests. Try again shortly.",
      requestId: res.locals.requestId
    });
  }
});
const oauthRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  legacyHeaders: false,
  standardHeaders: true,
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many authorization attempts. Try again later.",
      requestId: res.locals.requestId
    });
  }
});
const accountRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  legacyHeaders: false,
  standardHeaders: true,
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many account attempts. Try again later.",
      requestId: res.locals.requestId
    });
  }
});
const publicTenantRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  legacyHeaders: false,
  standardHeaders: true,
  keyGenerator: (req) => req.scannerazTenantSession?.tenantId ?? "missing-tenant",
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many product checks. Try again shortly.",
      requestId: res.locals.requestId
    });
  }
});

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
app.use("/api/amazon", apiRateLimit, requireOperatorAccess, amazonRouter);
app.use(
  "/api/public/amazon",
  requirePublicAppAccess,
  requireTenantSession,
  publicTenantRateLimit,
  publicAmazonRouter
);
app.use("/api/retail", retailRouter);
app.use("/api/retail/target", targetRouter);
app.use("/auth/amazon", oauthRateLimit);

app.post("/auth/scanneraz/register", requirePublicAppAccess, accountRateLimit, async (req, res, next) => {
  try {
    if (!config.SCANNERAZ_PUBLIC_SIGNUP_ENABLED) {
      res.status(503).json({
        error: "ScannerAz public registration is not enabled yet.",
        requestId: res.locals.requestId
      });
      return;
    }

    const session = await registerAccount({
      email: String(req.body?.email ?? ""),
      password: String(req.body?.password ?? "")
    });
    sendSession(res, session, 201);
  } catch (error) {
    if (error instanceof AccountAlreadyExistsError) {
      res.status(409).json({ error: "An account already exists for this email address." });
      return;
    }

    if (error instanceof Error && /email|password/i.test(error.message)) {
      res.status(400).json({ error: "Email or password does not meet the requirements." });
      return;
    }

    next(error);
  }
});

app.post("/auth/scanneraz/login", requirePublicAppAccess, accountRateLimit, async (req, res, next) => {
  try {
    const session = await loginAccount({
      email: String(req.body?.email ?? ""),
      password: String(req.body?.password ?? "")
    });
    sendSession(res, session);
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }

    if (error instanceof Error && /email/i.test(error.message)) {
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }

    next(error);
  }
});

app.get("/auth/scanneraz/me", requirePublicAppAccess, requireTenantSession, (req, res) => {
  const session = req.scannerazTenantSession!;
  res.setHeader("cache-control", "no-store");
  res.json({
    user: { id: session.userId, email: session.email },
    tenant: { id: session.tenantId, role: session.role },
    expiresAt: session.expiresAt
  });
});

app.post("/auth/scanneraz/logout", requirePublicAppAccess, requireTenantSession, async (req, res, next) => {
  try {
    await endRequestSession(req, res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/auth/amazon/start", requireOperatorAccess, (_req, res, next) => {
  try {
    assertAmazonOAuthConfig();
    assertOAuthSecurityConfig();
    const state = encodeState(createOAuthState());
    res.cookie(oauthCookieName, state, getOAuthCookieOptions());
    res.redirect(getAmazonAuthorizationUrl(state));
  } catch (error) {
    next(error);
  }
});

app.get("/auth/amazon/login", requireOperatorAccess, (req, res, next) => {
  try {
    assertAmazonOAuthConfig();
    assertOAuthSecurityConfig();

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

app.get("/auth/amazon/connect", requirePublicAppAccess, requireTenantSession, (req, res, next) => {
  try {
    assertAmazonOAuthConfig();
    assertOAuthSecurityConfig();
    const state = encodeState(createOAuthState({ tenantId: req.scannerazTenantSession!.tenantId }));
    res.cookie(oauthCookieName, state, getOAuthCookieOptions());
    res.redirect(getAmazonAuthorizationUrl(state));
  } catch (error) {
    next(error);
  }
});

app.get("/auth/amazon/callback", async (req, res, next) => {
  try {
    assertAmazonOAuthConfig();
    assertOAuthSecurityConfig();
    const state = String(req.query.state || "");
    const code = String(req.query.spapi_oauth_code || req.query.code || "");
    const sellingPartnerId = req.query.selling_partner_id
      ? String(req.query.selling_partner_id)
      : undefined;
    const expectedState = getCookie(req, oauthCookieName);

    if (!state || !expectedState || !safeEqual(state, expectedState)) {
      res.status(400).json({ error: "Invalid or expired OAuth state" });
      return;
    }

    res.clearCookie(oauthCookieName);
    const oauthState = decodeState(state);

    if (oauthState.tenantId && !isPublicAppReady()) {
      res.status(503).json({
        error: "ScannerAz public account connections are not enabled yet.",
        requestId: res.locals.requestId
      });
      return;
    }

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
    await saveAmazonConnection({
      id,
      tenantId: oauthState.tenantId,
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

app.get("/connections", requireOperatorAccess, async (_req, res, next) => {
  try {
    res.json({ amazon: await listAmazonConnections() });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Errors from upstream providers can contain response bodies. Do not echo or log them.
  console.error(
    JSON.stringify({
      event: "request.failed",
      requestId: res.locals.requestId,
      method: req.method,
      path: req.path,
      errorName: error instanceof Error ? error.name : "UnknownError"
    })
  );

  res.status(500).json({
    error: "Request failed. Use the requestId when contacting support.",
    requestId: res.locals.requestId
  });
});

void startServer();

async function startServer() {
  try {
    await Promise.all([initializeAmazonConnectionStore(), initializeAccountStore()]);
    app.listen(config.PORT, () => {
      console.log(`ScannerAz listening at ${config.APP_BASE_URL}`);
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "connection-store.initialization-failed",
        errorName: error instanceof Error ? error.name : "UnknownError"
      })
    );
    process.exitCode = 1;
  }
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireOperatorAccess(req: express.Request, res: express.Response, next: express.NextFunction) {
  const expectedToken = config.SCANNERAZ_OPERATOR_TOKEN;

  if (!expectedToken) {
    if (config.NODE_ENV !== "production") {
      next();
      return;
    }

    res.status(503).json({
      error: "Amazon access is disabled until a server-side operator token is configured.",
      requestId: res.locals.requestId
    });
    return;
  }

  if (config.NODE_ENV === "production" && !usesManagedAmazonConnectionStore()) {
    res.status(503).json({
      error: "Amazon access is disabled until a managed connection store is configured.",
      requestId: res.locals.requestId
    });
    return;
  }

  const authorization = req.get("authorization") ?? "";
  const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";

  if (!suppliedToken || !safeEqual(suppliedToken, expectedToken)) {
    res.status(401).json({
      error: "Operator authentication is required.",
      requestId: res.locals.requestId
    });
    return;
  }

  next();
}

function requirePublicAppAccess(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!isPublicAppReady()) {
    res.status(503).json({
      error: "ScannerAz public account connections are not enabled yet.",
      requestId: res.locals.requestId
    });
    return;
  }

  next();
}

function isPublicAppReady() {
  return (
    config.SCANNERAZ_PUBLIC_APP_ENABLED &&
    usesManagedAmazonConnectionStore() &&
    usesManagedAccountStore() &&
    Boolean(config.ENCRYPTION_KEY && config.SESSION_SECRET)
  );
}

function sendSession(
  res: express.Response,
  session: {
    accessToken: string;
    userId: string;
    email: string;
    tenantId: string;
    role: "owner" | "member";
    expiresAt: string;
  },
  status = 200
) {
  setSessionCookie(res, session.accessToken);
  res.setHeader("cache-control", "no-store");
  res.status(status).json({
    user: { id: session.userId, email: session.email },
    tenant: { id: session.tenantId, role: session.role },
    accessToken: session.accessToken,
    expiresAt: session.expiresAt
  });
}
