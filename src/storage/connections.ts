import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptSecret, encryptSecret } from "../security/crypto.js";

export type AmazonConnection = {
  id: string;
  sellerId?: string;
  marketplaceId: string;
  refreshToken: string;
  connectedAt: string;
};

type StoredAmazonConnection = Omit<AmazonConnection, "refreshToken"> & {
  encryptedRefreshToken: string;
};

const storagePath = path.resolve(config.DATA_DIR, "amazon-connections.json");

function ensureStorageDir() {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
}

function readStoredConnections(): StoredAmazonConnection[] {
  if (!fs.existsSync(storagePath)) {
    return [];
  }

  const raw = fs.readFileSync(storagePath, "utf8");
  if (!raw.trim()) {
    return [];
  }

  return JSON.parse(raw) as StoredAmazonConnection[];
}

function writeStoredConnections(connections: StoredAmazonConnection[]) {
  ensureStorageDir();
  fs.writeFileSync(storagePath, `${JSON.stringify(connections, null, 2)}\n`, {
    mode: 0o600
  });
}

export function saveAmazonConnection(connection: AmazonConnection) {
  const connections = readStoredConnections().filter((item) => item.id !== connection.id);
  connections.push({
    id: connection.id,
    sellerId: connection.sellerId,
    marketplaceId: connection.marketplaceId,
    encryptedRefreshToken: encryptSecret(connection.refreshToken),
    connectedAt: connection.connectedAt
  });
  writeStoredConnections(connections);
}

export function getAmazonConnection(id: string): AmazonConnection | undefined {
  const connection = readStoredConnections().find((item) => item.id === id);

  if (!connection) {
    return undefined;
  }

  return {
    id: connection.id,
    sellerId: connection.sellerId,
    marketplaceId: connection.marketplaceId,
    refreshToken: decryptSecret(connection.encryptedRefreshToken),
    connectedAt: connection.connectedAt
  };
}

export function listAmazonConnections() {
  return readStoredConnections().map(({ encryptedRefreshToken, ...connection }) => ({
    ...connection,
    hasRefreshToken: Boolean(encryptedRefreshToken)
  }));
}
