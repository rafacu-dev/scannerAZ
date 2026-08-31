import type { ClearanceProduct, ClearanceSearchInput, Retailer } from "./types.js";

export type ClearanceConnector = {
  retailer: Retailer;
  searchClearance(input: ClearanceSearchInput): Promise<ClearanceProduct[]>;
};

const connectors = new Map<Retailer, ClearanceConnector>();

export function registerClearanceConnector(connector: ClearanceConnector) {
  connectors.set(connector.retailer, connector);
}

export async function searchRetailerClearance(
  retailer: Retailer,
  input: ClearanceSearchInput
): Promise<ClearanceProduct[]> {
  const connector = connectors.get(retailer);

  if (!connector) {
    throw new Error(`No clearance connector configured for retailer: ${retailer}`);
  }

  return connector.searchClearance(input);
}

export async function searchAllClearance(input: ClearanceSearchInput) {
  const results = await Promise.allSettled(
    Array.from(connectors.values()).map(async (connector) => ({
      retailer: connector.retailer,
      products: await connector.searchClearance(input)
    }))
  );

  const retailers = Array.from(connectors.keys());

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    return {
      retailer: retailers[index],
      products: [],
      error: result.reason instanceof Error ? result.reason.message : "Unknown clearance error"
    };
  });
}
