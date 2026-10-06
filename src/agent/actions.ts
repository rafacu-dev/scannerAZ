import crypto from "node:crypto";
import { getAutomationPool } from "../amazon/repricing.js";

/**
 * Changes the agent proposes (restock, repricing, product costs). They are
 * stored as pending and only applied when the user taps "Confirm" in the app,
 * through the same API routes the app's own screens use.
 */
export type AgentActionKind = "set_restock" | "set_repricing" | "set_product_cost";
export type AgentActionStatus = "pending" | "confirmed" | "canceled" | "failed";

export type AgentAction = {
  id: string;
  tenantId: string;
  kind: AgentActionKind;
  storeId: string;
  sku: string;
  payload: Record<string, unknown>;
  title: string;
  detail: string;
  status: AgentActionStatus;
  result?: string;
  createdAt: string;
};

const localActions = new Map<string, AgentAction>();
let schemaPromise: Promise<void> | undefined;

async function initializeActionStore() {
  const pool = getAutomationPool();

  if (!pool || schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = pool
    .query(`
      CREATE TABLE IF NOT EXISTS scanneraz_agent_actions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        store_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        payload JSONB NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scanneraz_agent_actions_tenant_idx
      ON scanneraz_agent_actions (tenant_id, created_at DESC);
    `)
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaPromise = undefined;
      throw error;
    });

  return schemaPromise;
}

type ActionRow = {
  id: string;
  tenant_id: string;
  kind: AgentActionKind;
  store_id: string;
  sku: string;
  payload: Record<string, unknown>;
  title: string;
  detail: string;
  status: AgentActionStatus;
  result: string | null;
  created_at: Date | string;
};

function fromRow(row: ActionRow): AgentAction {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    storeId: row.store_id,
    sku: row.sku,
    payload: row.payload,
    title: row.title,
    detail: row.detail,
    status: row.status,
    result: row.result ?? undefined,
    createdAt: new Date(row.created_at).toISOString()
  };
}

export async function createAgentAction(input: Omit<AgentAction, "id" | "status" | "createdAt" | "result">) {
  const action: AgentAction = { ...input, id: crypto.randomUUID(), status: "pending", createdAt: new Date().toISOString() };
  const pool = getAutomationPool();

  if (!pool) {
    localActions.set(action.id, action);
    return action;
  }

  await initializeActionStore();
  await pool.query(
    `
      INSERT INTO scanneraz_agent_actions (id, tenant_id, kind, store_id, sku, payload, title, detail, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [action.id, action.tenantId, action.kind, action.storeId, action.sku, JSON.stringify(action.payload), action.title, action.detail, action.status, action.createdAt]
  );
  return action;
}

export async function getAgentAction(tenantId: string, actionId: string) {
  const pool = getAutomationPool();

  if (!pool) {
    const action = localActions.get(actionId);
    return action?.tenantId === tenantId ? action : undefined;
  }

  await initializeActionStore();
  const result = await pool.query<ActionRow>(
    "SELECT * FROM scanneraz_agent_actions WHERE tenant_id = $1 AND id = $2",
    [tenantId, actionId]
  );
  return result.rows[0] ? fromRow(result.rows[0]) : undefined;
}

export async function getAgentActionStatuses(tenantId: string, actionIds: string[]) {
  const statuses = new Map<string, { status: AgentActionStatus; result?: string }>();

  if (!actionIds.length) {
    return statuses;
  }

  const pool = getAutomationPool();

  if (!pool) {
    for (const id of actionIds) {
      const action = localActions.get(id);
      if (action?.tenantId === tenantId) {
        statuses.set(id, { status: action.status, result: action.result });
      }
    }
    return statuses;
  }

  await initializeActionStore();
  const result = await pool.query<Pick<ActionRow, "id" | "status" | "result">>(
    "SELECT id, status, result FROM scanneraz_agent_actions WHERE tenant_id = $1 AND id = ANY($2::text[])",
    [tenantId, actionIds]
  );
  for (const row of result.rows) {
    statuses.set(row.id, { status: row.status, result: row.result ?? undefined });
  }
  return statuses;
}

export async function setAgentActionStatus(action: AgentAction, status: AgentActionStatus, result?: string) {
  const pool = getAutomationPool();

  if (!pool) {
    localActions.set(action.id, { ...action, status, result });
    return;
  }

  await initializeActionStore();
  await pool.query(
    "UPDATE scanneraz_agent_actions SET status = $3, result = $4 WHERE tenant_id = $1 AND id = $2",
    [action.tenantId, action.id, status, result ?? null]
  );
}
