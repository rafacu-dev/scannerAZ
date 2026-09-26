import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { assertAmazonOAuthConfig, assertOAuthSecurityConfig, config } from "./config.js";
import {
  type AmazonWebsiteLoginRequest,
  createAmazonWebsiteLoginRequest,
  createOAuthState,
  decodeAmazonWebsiteLoginRequest,
  decodeState,
  encodeAmazonWebsiteLoginRequest,
  encodeState,
  exchangeAuthorizationCode,
  getAmazonAuthorizationUrl
} from "./amazon/oauth.js";
import { publicAmazonRouter } from "./amazon/publicRoutes.js";
import { amazonRouter } from "./amazon/routes.js";
import {
  clearSessionCookie,
  endRequestSession,
  loadOptionalTenantSession,
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
  changeAccountPassword,
  initializeAccountStore,
  InvalidCredentialsError,
  loginAccount,
  PasswordChangeNotAllowedError,
  PasswordExpiredError,
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

app.use(helmet({ referrerPolicy: { policy: "no-referrer" } }));
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

const oauthCookieName = "scanneraz_amazon_oauth_state";
const amazonWebsiteLoginCookieName = "scanneraz_amazon_website_login";
const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  legacyHeaders: false,
  standardHeaders: true,
  handler: (req, res) => {
    recordSecurityEvent("security.rate_limited", req, res, { scope: "operator_amazon" });
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
  handler: (req, res) => {
    recordSecurityEvent("security.rate_limited", req, res, { scope: "amazon_oauth" });
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
  handler: (req, res) => {
    recordSecurityEvent("security.rate_limited", req, res, { scope: "scanneraz_account" });
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
  handler: (req, res) => {
    recordSecurityEvent("security.rate_limited", req, res, { scope: "tenant_amazon" });
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

function getAmazonWebsiteLoginRequest(req: express.Request) {
  const value = getCookie(req, amazonWebsiteLoginCookieName);

  if (!value) {
    throw new Error("Missing Amazon website login request");
  }

  return decodeAmazonWebsiteLoginRequest(value);
}

function continueAmazonWebsiteAuthorization(
  res: express.Response,
  tenantId: string,
  request: AmazonWebsiteLoginRequest
) {
  const state = encodeState(createOAuthState({ tenantId }));
  const callbackUrl = new URL(request.amazonCallbackUri);
  callbackUrl.searchParams.set("amazon_state", request.amazonState);
  callbackUrl.searchParams.set("state", state);
  callbackUrl.searchParams.set("redirect_uri", `${config.APP_BASE_URL}/auth/amazon/callback`);

  if (config.AMAZON_OAUTH_VERSION) {
    callbackUrl.searchParams.set("version", config.AMAZON_OAUTH_VERSION);
  }

  res.cookie(oauthCookieName, state, getOAuthCookieOptions());
  res.clearCookie(amazonWebsiteLoginCookieName, getOAuthCookieOptions());
  res.redirect(callbackUrl.toString());
}

function sendAmazonWebsiteLoginPage(
  res: express.Response,
  options: { status?: number; message?: string } = {}
) {
  res.status(options.status ?? 200).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Connect Amazon | ScannerAz</title>
    <style>
      :root { color-scheme: light; font-family: Arial, sans-serif; }
      body { align-items: center; background: #f4f6f7; color: #19232f; display: flex; justify-content: center; margin: 0; min-height: 100vh; }
      main { background: #ffffff; border: 1px solid #d9e0e6; border-radius: 8px; box-shadow: 0 10px 28px rgba(25, 35, 47, 0.08); box-sizing: border-box; max-width: 420px; padding: 32px; width: calc(100% - 32px); }
      .brand { color: #087a73; font-size: 14px; font-weight: 700; letter-spacing: 0.08em; margin: 0 0 10px; text-transform: uppercase; }
      h1 { font-size: 24px; margin: 0 0 10px; }
      p { color: #52616f; line-height: 1.5; margin: 0 0 22px; }
      label { display: block; font-size: 14px; font-weight: 700; margin: 16px 0 7px; }
      input { border: 1px solid #b8c3cc; border-radius: 6px; box-sizing: border-box; font: inherit; padding: 12px; width: 100%; }
      button { background: #087a73; border: 0; border-radius: 6px; color: #ffffff; cursor: pointer; font: inherit; font-weight: 700; margin-top: 24px; padding: 12px 16px; width: 100%; }
      .notice { background: #fff3e7; border: 1px solid #f0c896; border-radius: 6px; color: #784a10; font-size: 14px; margin-bottom: 18px; padding: 12px; }
      .support { font-size: 13px; margin-top: 20px; }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">ScannerAz</div>
      <h1>Connect your Amazon account</h1>
      <p>Sign in to ScannerAz to finish connecting the Amazon account you just authorized.</p>
      ${options.message ? `<div class="notice" role="alert">${options.message}</div>` : ""}
      <form action="/auth/amazon/login/session" method="post">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" autocomplete="email" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Continue securely</button>
      </form>
      <p class="support">Need help? Contact <a href="mailto:Support.ScannerAz@drecom.dev">ScannerAz support</a>.</p>
    </main>
  </body>
</html>`);
}

function renderAmazonWebsiteLoginError() {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connection expired | ScannerAz</title></head>
  <body><main><h1>Connection request expired</h1><p>Return to ScannerAz and start the Amazon connection again.</p></main></body>
</html>`;
}

function isAmazonWebsiteLoginRequestError(error: unknown) {
  return (
    error instanceof Error &&
    /Amazon website login request|Amazon callback URI|Amazon authorization state/i.test(error.message)
  );
}

app.get("/health", (_req, res) => {
  // Render reaches this path directly for its platform health check. It exposes
  // no account, application, or Amazon information.
  res.setHeader("cache-control", "no-store");
  res.json({ ok: true });
});

// Once SCANNERAZ_EDGE_SHARED_SECRET is set, Render accepts public traffic only
// from the fixed-origin Cloudflare Worker. Keep /health above this middleware
// so the Render health probe can continue to reach the service directly.
app.use(requireTrustedEdge);
app.use(express.static(publicDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use("/api/keepa", keepaRouter);
app.use("/api/amazon", markSensitiveResponse, apiRateLimit, requireOperatorAccess, amazonRouter);
app.use(
  "/api/public/amazon",
  markSensitiveResponse,
  requirePublicAppAccess,
  requireTenantSession,
  publicTenantRateLimit,
  publicAmazonRouter
);
app.use("/api/retail", retailRouter);
app.use("/api/retail/target", targetRouter);
app.use("/auth/amazon", markSensitiveResponse, oauthRateLimit);

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
    if (error instanceof PasswordExpiredError) {
      res.status(403).json({
        error: "Password has expired. Contact ScannerAz support to reset it.",
        requestId: res.locals.requestId
      });
      return;
    }

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

app.post(
  "/auth/scanneraz/password",
  markSensitiveResponse,
  requirePublicAppAccess,
  requireTenantSession,
  accountRateLimit,
  async (req, res, next) => {
    try {
      await changeAccountPassword({
        userId: req.scannerazTenantSession!.userId,
        currentPassword: String(req.body?.currentPassword ?? ""),
        newPassword: String(req.body?.newPassword ?? "")
      });
      clearSessionCookie(res);
      res.status(204).end();
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        res.status(401).json({ error: "Current password is invalid.", requestId: res.locals.requestId });
        return;
      }

      if (error instanceof PasswordChangeNotAllowedError) {
        res.status(400).json({
          error: "The new password cannot be used yet.",
          requestId: res.locals.requestId
        });
        return;
      }

      if (error instanceof Error && /password/i.test(error.message)) {
        res.status(400).json({ error: "Password does not meet the requirements.", requestId: res.locals.requestId });
        return;
      }

      next(error);
    }
  }
);

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

app.get("/auth/amazon/login", requirePublicAppAccess, async (req, res, next) => {
  try {
    assertAmazonOAuthConfig();
    assertOAuthSecurityConfig();

    const request = createAmazonWebsiteLoginRequest({
      amazonCallbackUri: String(req.query.amazon_callback_uri || ""),
      amazonState: String(req.query.amazon_state || "")
    });
    res.cookie(
      amazonWebsiteLoginCookieName,
      encodeAmazonWebsiteLoginRequest(request),
      getOAuthCookieOptions()
    );

    const session = await loadOptionalTenantSession(req, res);

    if (!session) {
      sendAmazonWebsiteLoginPage(res);
      return;
    }

    continueAmazonWebsiteAuthorization(res, session.tenantId, request);
  } catch (error) {
    if (isAmazonWebsiteLoginRequestError(error)) {
      res.status(400).type("html").send(renderAmazonWebsiteLoginError());
      return;
    }

    next(error);
  }
});

app.post(
  "/auth/amazon/login/session",
  requirePublicAppAccess,
  accountRateLimit,
  async (req, res, next) => {
    try {
      assertAmazonOAuthConfig();
      assertOAuthSecurityConfig();
      const request = getAmazonWebsiteLoginRequest(req);
      const session = await loginAccount({
        email: String(req.body?.email ?? ""),
        password: String(req.body?.password ?? "")
      });

      setSessionCookie(res, session.accessToken);
      continueAmazonWebsiteAuthorization(res, session.tenantId, request);
    } catch (error) {
      if (error instanceof InvalidCredentialsError || error instanceof PasswordExpiredError) {
        sendAmazonWebsiteLoginPage(res, {
          status: error instanceof PasswordExpiredError ? 403 : 401,
          message:
            error instanceof PasswordExpiredError
              ? "Your password has expired. Contact ScannerAz support to continue."
              : "The email address or password was not accepted."
        });
        return;
      }

      if (isAmazonWebsiteLoginRequestError(error)) {
        res.status(400).type("html").send(renderAmazonWebsiteLoginError());
        return;
      }

      next(error);
    }
  }
);

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

app.get("/connections", markSensitiveResponse, requireOperatorAccess, async (_req, res, next) => {
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
      cfRay: req.get("cf-ray") || undefined,
      renderRequestId: req.get("rndr-id") || undefined,
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

function requireTrustedEdge(req: express.Request, res: express.Response, next: express.NextFunction) {
  const expectedSecret = config.SCANNERAZ_EDGE_SHARED_SECRET;

  // Local development does not run behind the Cloudflare Worker. Production
  // begins enforcing this boundary as soon as the Render secret is configured.
  if (!expectedSecret) {
    next();
    return;
  }

  const suppliedSecret = req.get("x-scanneraz-edge-auth") ?? "";

  if (!suppliedSecret || !safeEqual(suppliedSecret, expectedSecret)) {
    recordSecurityEvent("security.untrusted_origin_rejected", req, res);
    res.setHeader("cache-control", "no-store, private, max-age=0");
    res.status(403).json({
      error: "ScannerAz requests must use the configured public endpoint.",
      requestId: res.locals.requestId
    });
    return;
  }

  next();
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
    recordSecurityEvent("security.operator_auth_rejected", req, res);
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

function markSensitiveResponse(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  res.setHeader("cache-control", "no-store, private, max-age=0");
  res.setHeader("pragma", "no-cache");
  res.vary("authorization");
  res.vary("cookie");
  next();
}

function recordSecurityEvent(
  event: string,
  req: express.Request,
  res: express.Response,
  details: Record<string, string | number | boolean | undefined> = {}
) {
  // Trace edge and platform events without writing IPs, tokens, or request bodies.
  console.warn(
    JSON.stringify({
      event,
      requestId: res.locals.requestId,
      method: req.method,
      path: req.path,
      cfRay: req.get("cf-ray") || undefined,
      renderRequestId: req.get("rndr-id") || undefined,
      ...details
    })
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
