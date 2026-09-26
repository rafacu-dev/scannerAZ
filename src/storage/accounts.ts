import crypto from "node:crypto";
import { Pool } from "pg";
import { config } from "../config.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";

const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const passwordMaximumAgeMs = 365 * 24 * 60 * 60 * 1000;
const passwordMinimumAgeMs = 24 * 60 * 60 * 1000;
const loginLockThreshold = 8;
let pool: Pool | undefined;
let schemaPromise: Promise<void> | undefined;

export type TenantSession = {
  userId: string;
  tenantId: string;
  email: string;
  role: "owner" | "member";
  expiresAt: string;
};

export type NewAccountSession = TenantSession & {
  accessToken: string;
};

type AccountRow = {
  user_id: string;
  email: string;
  password_hash: string;
  password_changed_at: Date | string;
  failed_login_attempts: number;
  locked_until: Date | string | null;
  tenant_id: string;
  role: "owner" | "member";
};

type SessionRow = {
  user_id: string;
  tenant_id: string;
  email: string;
  role: "owner" | "member";
  expires_at: Date | string;
};

export class AccountAlreadyExistsError extends Error {
  constructor() {
    super("An account already exists for this email address");
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password");
  }
}

export class PasswordExpiredError extends Error {
  constructor() {
    super("Password has expired");
  }
}

export class PasswordChangeNotAllowedError extends Error {
  constructor() {
    super("Password change is not currently allowed");
  }
}

export function usesManagedAccountStore() {
  return Boolean(config.DATABASE_URL);
}

export async function initializeAccountStore() {
  const accountPool = getPool();

  if (!accountPool || schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = accountPool
    .query(`
      CREATE TABLE IF NOT EXISTS scanneraz_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_changed_at TIMESTAMPTZ NOT NULL,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      );

      ALTER TABLE scanneraz_users
        ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
      ALTER TABLE scanneraz_users
        ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE scanneraz_users
        ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
      UPDATE scanneraz_users
        SET password_changed_at = created_at
        WHERE password_changed_at IS NULL;
      ALTER TABLE scanneraz_users
        ALTER COLUMN password_changed_at SET NOT NULL;
      ALTER TABLE scanneraz_users
        ALTER COLUMN password_changed_at SET DEFAULT NOW();

      CREATE TABLE IF NOT EXISTS scanneraz_password_history (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES scanneraz_users(id) ON DELETE CASCADE,
        password_hash TEXT NOT NULL,
        changed_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scanneraz_password_history_user_changed_idx
      ON scanneraz_password_history (user_id, changed_at DESC);

      CREATE TABLE IF NOT EXISTS scanneraz_tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scanneraz_tenant_memberships (
        tenant_id TEXT NOT NULL REFERENCES scanneraz_tenants(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES scanneraz_users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS scanneraz_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES scanneraz_users(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES scanneraz_tenants(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scanneraz_sessions_expires_at_idx
      ON scanneraz_sessions (expires_at);
    `)
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaPromise = undefined;
      throw error;
    });

  return schemaPromise;
}

export async function registerAccount(input: { email: string; password: string }): Promise<NewAccountSession> {
  const accountPool = requirePool();
  await initializeAccountStore();
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password, email);
  const userId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();
  const createdAt = new Date();
  const client = await accountPool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO scanneraz_users (id, email, password_hash, password_changed_at, created_at)
        VALUES ($1, $2, $3, $4, $4)
      `,
      [userId, email, passwordHash, createdAt]
    );
    await client.query(
      `
        INSERT INTO scanneraz_password_history (user_id, password_hash, changed_at)
        VALUES ($1, $2, $3)
      `,
      [userId, passwordHash, createdAt]
    );
    await client.query(
      `
        INSERT INTO scanneraz_tenants (id, name, created_at)
        VALUES ($1, $2, $3)
      `,
      [tenantId, "Personal workspace", createdAt]
    );
    await client.query(
      `
        INSERT INTO scanneraz_tenant_memberships (tenant_id, user_id, role, created_at)
        VALUES ($1, $2, 'owner', $3)
      `,
      [tenantId, userId, createdAt]
    );

    const session = await insertSession(client, { userId, tenantId, email, role: "owner" });
    await client.query("COMMIT");
    return session;
  } catch (error) {
    await client.query("ROLLBACK");

    if (isUniqueViolation(error)) {
      throw new AccountAlreadyExistsError();
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function loginAccount(input: { email: string; password: string }): Promise<NewAccountSession> {
  const accountPool = requirePool();
  const email = normalizeEmail(input.email);
  await initializeAccountStore();

  const account = await accountPool.query<AccountRow>(
    `
      SELECT
        scanneraz_users.id AS user_id,
        scanneraz_users.email,
        scanneraz_users.password_hash,
        scanneraz_users.password_changed_at,
        scanneraz_users.failed_login_attempts,
        scanneraz_users.locked_until,
        scanneraz_tenant_memberships.tenant_id,
        scanneraz_tenant_memberships.role
      FROM scanneraz_users
      JOIN scanneraz_tenant_memberships
        ON scanneraz_tenant_memberships.user_id = scanneraz_users.id
      WHERE scanneraz_users.email = $1
      ORDER BY scanneraz_tenant_memberships.role = 'owner' DESC
      LIMIT 1
    `,
    [email]
  );
  const row = account.rows[0];

  if (!row || isAccountLocked(row) || !(await verifyPassword(input.password, row.password_hash))) {
    if (row && !isAccountLocked(row)) {
      await recordFailedLogin(accountPool, row.user_id);
    }
    throw new InvalidCredentialsError();
  }

  if (Date.now() - new Date(row.password_changed_at).getTime() > passwordMaximumAgeMs) {
    throw new PasswordExpiredError();
  }

  await accountPool.query(
    `
      UPDATE scanneraz_users
      SET failed_login_attempts = 0, locked_until = NULL
      WHERE id = $1
    `,
    [row.user_id]
  );

  return insertSession(accountPool, {
    userId: row.user_id,
    tenantId: row.tenant_id,
    email: row.email,
    role: row.role
  });
}

export async function changeAccountPassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}) {
  const accountPool = requirePool();
  await initializeAccountStore();
  const account = await accountPool.query<
    Pick<AccountRow, "user_id" | "email" | "password_hash" | "password_changed_at">
  >(
    `
      SELECT id AS user_id, email, password_hash, password_changed_at
      FROM scanneraz_users
      WHERE id = $1
      LIMIT 1
    `,
    [input.userId]
  );
  const row = account.rows[0];

  if (!row || !(await verifyPassword(input.currentPassword, row.password_hash))) {
    throw new InvalidCredentialsError();
  }

  if (Date.now() - new Date(row.password_changed_at).getTime() < passwordMinimumAgeMs) {
    throw new PasswordChangeNotAllowedError();
  }

  const previousPasswords = await accountPool.query<{ password_hash: string }>(
    `
      SELECT password_hash
      FROM scanneraz_password_history
      WHERE user_id = $1
      ORDER BY changed_at DESC, id DESC
      LIMIT 10
    `,
    [row.user_id]
  );
  const isReused = await Promise.all(
    [row.password_hash, ...previousPasswords.rows.map((password) => password.password_hash)].map((hash) =>
      verifyPassword(input.newPassword, hash)
    )
  );

  if (isReused.some(Boolean)) {
    throw new PasswordChangeNotAllowedError();
  }

  const passwordHash = await hashPassword(input.newPassword, row.email);
  const changedAt = new Date();
  const client = await accountPool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE scanneraz_users
        SET password_hash = $2,
            password_changed_at = $3,
            failed_login_attempts = 0,
            locked_until = NULL
        WHERE id = $1
      `,
      [row.user_id, passwordHash, changedAt]
    );
    await client.query(
      `
        INSERT INTO scanneraz_password_history (user_id, password_hash, changed_at)
        VALUES ($1, $2, $3)
      `,
      [row.user_id, passwordHash, changedAt]
    );
    await client.query(
      `
        DELETE FROM scanneraz_password_history
        WHERE user_id = $1
          AND id NOT IN (
            SELECT id
            FROM scanneraz_password_history
            WHERE user_id = $1
            ORDER BY changed_at DESC, id DESC
            LIMIT 10
          )
      `,
      [row.user_id]
    );
    await client.query("DELETE FROM scanneraz_sessions WHERE user_id = $1", [row.user_id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getTenantSession(accessToken: string): Promise<TenantSession | undefined> {
  const accountPool = requirePool();
  await initializeAccountStore();
  const result = await accountPool.query<SessionRow>(
    `
      SELECT
        scanneraz_sessions.user_id,
        scanneraz_sessions.tenant_id,
        scanneraz_users.email,
        scanneraz_tenant_memberships.role,
        scanneraz_sessions.expires_at
      FROM scanneraz_sessions
      JOIN scanneraz_users ON scanneraz_users.id = scanneraz_sessions.user_id
      JOIN scanneraz_tenant_memberships
        ON scanneraz_tenant_memberships.user_id = scanneraz_sessions.user_id
        AND scanneraz_tenant_memberships.tenant_id = scanneraz_sessions.tenant_id
      WHERE scanneraz_sessions.token_hash = $1
        AND scanneraz_sessions.expires_at > NOW()
      LIMIT 1
    `,
    [hashSessionToken(accessToken)]
  );
  const row = result.rows[0];

  if (!row) {
    return undefined;
  }

  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    email: row.email,
    role: row.role,
    expiresAt: new Date(row.expires_at).toISOString()
  };
}

export async function deleteTenantSession(accessToken: string) {
  const accountPool = requirePool();
  await initializeAccountStore();
  await accountPool.query("DELETE FROM scanneraz_sessions WHERE token_hash = $1", [
    hashSessionToken(accessToken)
  ]);
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

function requirePool() {
  const accountPool = getPool();

  if (!accountPool) {
    throw new Error("ScannerAz account storage requires DATABASE_URL");
  }

  return accountPool;
}

async function insertSession(
  client: Pick<Pool, "query">,
  input: Omit<TenantSession, "expiresAt">
): Promise<NewAccountSession> {
  const accessToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionLifetimeMs);

  await client.query(
    `
      INSERT INTO scanneraz_sessions (token_hash, user_id, tenant_id, expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [hashSessionToken(accessToken), input.userId, input.tenantId, expiresAt, new Date()]
  );

  return {
    ...input,
    accessToken,
    expiresAt: expiresAt.toISOString()
  };
}

function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();

  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Email address is invalid");
  }

  return email;
}

function hashSessionToken(accessToken: string) {
  return crypto.createHash("sha256").update(accessToken, "utf8").digest("base64url");
}

function isAccountLocked(account: Pick<AccountRow, "locked_until">) {
  return Boolean(account.locked_until && new Date(account.locked_until).getTime() > Date.now());
}

async function recordFailedLogin(accountPool: Pool, userId: string) {
  await accountPool.query(
    `
      UPDATE scanneraz_users
      SET failed_login_attempts = failed_login_attempts + 1,
          locked_until = CASE
            WHEN failed_login_attempts + 1 >= $2 THEN NOW() + INTERVAL '30 minutes'
            ELSE locked_until
          END
      WHERE id = $1
    `,
    [userId, loginLockThreshold]
  );
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}
