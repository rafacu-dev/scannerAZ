import type express from "express";
import { config } from "../config.js";
import {
  deleteTenantSession,
  getTenantSession,
  type TenantSession
} from "../storage/accounts.js";

const sessionCookieName = "scanneraz_session";
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

declare global {
  namespace Express {
    interface Request {
      scannerazTenantSession?: TenantSession;
      scannerazSessionToken?: string;
    }
  }
}

export async function requireTenantSession(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  try {
    const accessToken = getRequestAccessToken(req);

    if (!accessToken) {
      res.status(401).json({ error: "ScannerAz authentication is required" });
      return;
    }

    const session = await getTenantSession(accessToken);

    if (!session) {
      clearSessionCookie(res);
      res.status(401).json({ error: "ScannerAz session is invalid or expired" });
      return;
    }

    req.scannerazTenantSession = session;
    req.scannerazSessionToken = accessToken;
    next();
  } catch (error) {
    next(error);
  }
}

export function setSessionCookie(res: express.Response, accessToken: string) {
  res.cookie(sessionCookieName, accessToken, getCookieOptions());
}

export function clearSessionCookie(res: express.Response) {
  res.clearCookie(sessionCookieName, getCookieOptions());
}

export async function endRequestSession(req: express.Request, res: express.Response) {
  if (req.scannerazSessionToken) {
    await deleteTenantSession(req.scannerazSessionToken);
  }

  clearSessionCookie(res);
}

function getRequestAccessToken(req: express.Request) {
  const authorization = req.get("authorization") ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);
  const token = bearerMatch?.[1] ?? getCookie(req, sessionCookieName);

  if (!token || token.length > 200) {
    return undefined;
  }

  return token;
}

function getCookie(req: express.Request, name: string) {
  const cookies = req.headers.cookie?.split(";").map((cookie) => cookie.trim()) ?? [];
  const cookie = cookies.find((item) => item.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : undefined;
}

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.APP_BASE_URL.startsWith("https://"),
    maxAge: sessionLifetimeMs
  };
}
