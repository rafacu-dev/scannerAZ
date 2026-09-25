import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { config } from "../config.js";
import { decryptSecret, encryptSecret } from "../security/crypto.js";

export type AmazonConnection = {
  id: string;
  tenantId?: string;
  sellerId?: string;
  marketplaceId: string;
  refreshToken: string;
  connectedAt: string;
};

type StoredAmazonConnection = Omit<AmazonConnection, "refreshToken"> & {
  encryptedRefreshToken: string;
};

type DatabaseConnectionRow = {
  id: string;
  tenant_id: string | null;
  seller_id: string | null;
  marketplace_id: string;
  encrypted_refresh_token: string;
  connected_at: Date | string;
};

const storagePath = path.resolve(config.DATA_DIR, "amazon-connections.json");
let pool: Pool | undefined;
let schemaPromise: Promise<void> | undefined;

export function usesManagedAmazonConnectionStore() {
  return Boolean(config.DATABASE_URL);
}

function getPool() {
  if (!config.DATABASE_URL) {
    return undefined;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : undefined
    });
  }

  return pool;
}

export async function initializeAmazonConnectionStore() {
  const connectionPool = getPool();

  if (!connectionPool || schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = connectionPool
    .query(`
      CREATE TABLE IF NOT EXISTS scanneraz_amazon_connections (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        seller_id TEXT,
        marketplace_id TEXT NOT NULL,
        encrypted_refresh_token TEXT NOT NULL,
        connected_at TIMESTAMPTZ NOT NULL
      );

      ALTER TABLE scanneraz_amazon_connections
      ADD COLUMN IF NOT EXISTS tenant_id TEXT;

      CREATE INDEX IF NOT EXISTS scanneraz_amazon_connections_tenant_id_idx
      ON scanneraz_amazon_connections (tenant_id, connected_at DESC);
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
    throw new Error(
      "Amazon connection storage requires DATABASE_URL in production. Local JSON storage is development-only."
    );
  }
}

function ensureStorageDir() {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
}

function readLocalConnections(): StoredAmazonConnection[] {
  if (!fs.existsSync(storagePath)) {
    return [];
  }

  const raw = fs.readFileSync(storagePath, "utf8");
  if (!raw.trim()) {
    return [];
  }

  return JSON.parse(raw) as StoredAmazonConnection[];
}

function writeLocalConnections(connections: StoredAmazonConnection[]) {
  ensureStorageDir();
  fs.writeFileSync(storagePath, `${JSON.stringify(connections, null, 2)}\n`, {
    mode: 0o600
  });
  fs.chmodSync(storagePath, 0o600);
}

function toStoredConnection(connection: AmazonConnection): StoredAmazonConnection {
  return {
    id: connection.id,
    tenantId: connection.tenantId,
    sellerId: connection.sellerId,
    marketplaceId: connection.marketplaceId,
    encryptedRefreshToken: encryptSecret(connection.refreshToken),
    connectedAt: connection.connectedAt
  };
}

function fromDatabaseRow(row: DatabaseConnectionRow): StoredAmazonConnection {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? undefined,
    sellerId: row.seller_id ?? undefined,
    marketplaceId: row.marketplace_id,
    encryptedRefreshToken: row.encrypted_refresh_token,
    connectedAt: new Date(row.connected_at).toISOString()
  };
}

async function readStoredConnections(): Promise<StoredAmazonConnection[]> {
  const connectionPool = getPool();

  if (connectionPool) {
    await initializeAmazonConnectionStore();
    const result = await connectionPool.query<DatabaseConnectionRow>(
      `
        SELECT id, tenant_id, seller_id, marketplace_id, encrypted_refresh_token, connected_at
        FROM scanneraz_amazon_connections
        ORDER BY connected_at DESC
      `
    );
    return result.rows.map(fromDatabaseRow);
  }

  assertLocalStoreAllowed();
  return readLocalConnections();
}

export async function saveAmazonConnection(connection: AmazonConnection) {
  const stored = toStoredConnection(connection);
  const connectionPool = getPool();

  if (connectionPool) {
    await initializeAmazonConnectionStore();
    await connectionPool.query(
      `
        INSERT INTO scanneraz_amazon_connections (
          id, tenant_id, seller_id, marketplace_id, encrypted_refresh_token, connected_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          seller_id = EXCLUDED.seller_id,
          marketplace_id = EXCLUDED.marketplace_id,
          encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
          connected_at = EXCLUDED.connected_at
      `,
      [
        stored.id,
        stored.tenantId ?? null,
        stored.sellerId ?? null,
        stored.marketplaceId,
        stored.encryptedRefreshToken,
        stored.connectedAt
      ]
    );
    return;
  }

  assertLocalStoreAllowed();
  const connections = readLocalConnections().filter((item) => item.id !== connection.id);
  connections.push(stored);
  writeLocalConnections(connections);
}

export async function getAmazonConnection(id: string): Promise<AmazonConnection | undefined> {
  const connection = (await readStoredConnections()).find((item) => item.id === id);

  if (!connection) {
    return undefined;
  }

  return {
    id: connection.id,
    tenantId: connection.tenantId,
    sellerId: connection.sellerId,
    marketplaceId: connection.marketplaceId,
    refreshToken: decryptSecret(connection.encryptedRefreshToken),
    connectedAt: connection.connectedAt
  };
}

export async function listAmazonConnections() {
  return (await readStoredConnections()).map(({ encryptedRefreshToken, ...connection }) => ({
    ...connection,
    hasRefreshToken: Boolean(encryptedRefreshToken)
  }));
}

export async function getAmazonConnectionForTenant(id: string, tenantId: string) {
  const connectionPool = getPool();

  if (connectionPool) {
    await initializeAmazonConnectionStore();
    const result = await connectionPool.query<DatabaseConnectionRow>(
      `
        SELECT id, tenant_id, seller_id, marketplace_id, encrypted_refresh_token, connected_at
        FROM scanneraz_amazon_connections
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1
      `,
      [id, tenantId]
    );
    const row = result.rows[0];

    if (!row) {
      return undefined;
    }

    return toAmazonConnection(fromDatabaseRow(row));
  }

  assertLocalStoreAllowed();
  const connection = readLocalConnections().find(
    (item) => item.id === id && item.tenantId === tenantId
  );

  if (!connection) {
    return undefined;
  }

  return toAmazonConnection(connection);
}

export async function listAmazonConnectionsForTenant(tenantId: string) {
  const connectionPool = getPool();

  if (connectionPool) {
    await initializeAmazonConnectionStore();
    const result = await connectionPool.query<DatabaseConnectionRow>(
      `
        SELECT id, tenant_id, seller_id, marketplace_id, encrypted_refresh_token, connected_at
        FROM scanneraz_amazon_connections
        WHERE tenant_id = $1
        ORDER BY connected_at DESC
      `,
      [tenantId]
    );

    return result.rows.map((row) => toPublicConnection(fromDatabaseRow(row)));
  }

  assertLocalStoreAllowed();
  return readLocalConnections()
    .filter((connection) => connection.tenantId === tenantId)
    .map(({ encryptedRefreshToken, tenantId: _tenantId, ...connection }) => ({
      ...connection,
      hasRefreshToken: Boolean(encryptedRefreshToken)
    }));
}

export async function deleteAmazonConnectionForTenant(id: string, tenantId: string) {
  const connectionPool = getPool();

  if (connectionPool) {
    await initializeAmazonConnectionStore();
    const result = await connectionPool.query(
      `
        DELETE FROM scanneraz_amazon_connections
        WHERE id = $1 AND tenant_id = $2
      `,
      [id, tenantId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  assertLocalStoreAllowed();
  const connections = readLocalConnections();
  const remainingConnections = connections.filter(
    (connection) => connection.id !== id || connection.tenantId !== tenantId
  );

  if (remainingConnections.length === connections.length) {
    return false;
  }

  writeLocalConnections(remainingConnections);
  return true;
}

function toAmazonConnection(connection: StoredAmazonConnection): AmazonConnection {
  return {
    id: connection.id,
    tenantId: connection.tenantId,
    sellerId: connection.sellerId,
    marketplaceId: connection.marketplaceId,
    refreshToken: decryptSecret(connection.encryptedRefreshToken),
    connectedAt: connection.connectedAt
  };
}

function toPublicConnection(connection: StoredAmazonConnection) {
  const { encryptedRefreshToken, tenantId: _tenantId, ...publicConnection } = connection;

  return {
    ...publicConnection,
    hasRefreshToken: Boolean(encryptedRefreshToken)
  };
}
