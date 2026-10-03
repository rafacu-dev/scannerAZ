import express from "express";
import { config } from "../config.js";
import { getAutomationPool } from "../amazon/repricing.js";

/**
 * Expo push delivery for ScannerAz accounts. Each signed-in device registers
 * its Expo push token; automation events notify every device of the tenant.
 */
export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

const expoPushUrl = "https://exp.host/--/api/v2/push/send";
const expoTokenPattern = /^Expo(nent)?PushToken\[[^\]]{8,200}\]$/;
const localDevices = new Map<string, { tenantId: string; platform: string }>();
let schemaPromise: Promise<void> | undefined;

export async function initializePushStore() {
  const pool = getAutomationPool();

  if (!pool || schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = pool
    .query(`
      CREATE TABLE IF NOT EXISTS scanneraz_push_devices (
        token TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scanneraz_push_devices_tenant_idx
      ON scanneraz_push_devices (tenant_id);
    `)
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaPromise = undefined;
      throw error;
    });

  return schemaPromise;
}

function assertLocalStoreAllowed() {
  if (config.NODE_ENV === "production") {
    throw new Error("Push devices require DATABASE_URL in production.");
  }
}

export function isExpoPushToken(value: string) {
  return expoTokenPattern.test(value);
}

async function savePushDevice(tenantId: string, token: string, platform: string) {
  const pool = getAutomationPool();
  const now = new Date().toISOString();

  if (pool) {
    await initializePushStore();
    // A token belongs to one device; the latest signed-in account owns it.
    await pool.query(
      `
        INSERT INTO scanneraz_push_devices (token, tenant_id, platform, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT (token) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          platform = EXCLUDED.platform,
          updated_at = EXCLUDED.updated_at
      `,
      [token, tenantId, platform, now]
    );
    return;
  }

  assertLocalStoreAllowed();
  localDevices.set(token, { tenantId, platform });
}

async function deletePushDevice(token: string, tenantId?: string) {
  const pool = getAutomationPool();

  if (pool) {
    await initializePushStore();
    await pool.query(
      tenantId
        ? `DELETE FROM scanneraz_push_devices WHERE token = $1 AND tenant_id = $2`
        : `DELETE FROM scanneraz_push_devices WHERE token = $1`,
      tenantId ? [token, tenantId] : [token]
    );
    return;
  }

  if (!tenantId || localDevices.get(token)?.tenantId === tenantId) {
    localDevices.delete(token);
  }
}

async function listTenantPushTokens(tenantId: string) {
  const pool = getAutomationPool();

  if (pool) {
    await initializePushStore();
    const result = await pool.query<{ token: string }>(
      `SELECT token FROM scanneraz_push_devices WHERE tenant_id = $1`,
      [tenantId]
    );
    return result.rows.map((row) => row.token);
  }

  return [...localDevices.entries()].filter(([, device]) => device.tenantId === tenantId).map(([token]) => token);
}

/**
 * Sends one notification to every device of a tenant. Tokens Expo reports as
 * DeviceNotRegistered (app uninstalled or permission revoked) are removed.
 */
export async function sendPushToTenant(tenantId: string, message: PushMessage) {
  const tokens = await listTenantPushTokens(tenantId);
  const errors: string[] = [];

  for (let index = 0; index < tokens.length; index += 100) {
    const chunk = tokens.slice(index, index + 100);
    const response = await fetch(expoPushUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(chunk.map((to) => ({
        to,
        title: message.title,
        body: message.body,
        data: message.data,
        sound: "default",
      }))),
    });
    const body = await response.json().catch(() => undefined) as
      | { data?: Array<{ status?: string; details?: { error?: string } }> }
      | undefined;

    if (!response.ok) {
      throw new Error(`Expo push failed: ${response.status}`);
    }

    const tickets = body?.data ?? [];

    for (const [ticketIndex, ticket] of tickets.entries()) {
      if (ticket.status !== "error") {
        continue;
      }

      if (ticket.details?.error === "DeviceNotRegistered" && chunk[ticketIndex]) {
        await deletePushDevice(chunk[ticketIndex]);
      } else {
        // e.g. InvalidCredentials when the iOS push key is missing in EAS.
        const reason = ticket.details?.error ?? "unknown";
        errors.push(reason);
        console.error(`Expo push ticket error: ${reason}`);
      }
    }
  }

  return { devices: tokens.length, errors };
}

export const notificationsRouter = express.Router();

function requireTenantId(req: express.Request) {
  const tenantId = req.scannerazTenantSession?.tenantId;

  if (!tenantId) {
    throw new Error("Tenant session middleware is required for notification routes");
  }

  return tenantId;
}

notificationsRouter.post("/devices", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const token = String(req.body?.token ?? "").trim();
    const platform = req.body?.platform === "android" ? "android" : "ios";

    if (!isExpoPushToken(token)) {
      res.status(400).json({ error: "token must be an Expo push token" });
      return;
    }

    await savePushDevice(tenantId, token, platform);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// Lets the seller confirm alerts reach their devices without waiting for a
// real automatic price change.
notificationsRouter.post("/test", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const result = await sendPushToTenant(tenantId, {
      title: "Notificaciones activadas",
      body: "Te avisaremos cada vez que ScannerAz ajuste un precio automáticamente.",
      data: { screen: "repricing-history" },
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

notificationsRouter.delete("/devices", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const token = String(req.body?.token ?? "").trim();

    if (!isExpoPushToken(token)) {
      res.status(400).json({ error: "token must be an Expo push token" });
      return;
    }

    await deletePushDevice(token, tenantId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
