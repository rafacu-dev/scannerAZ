import type { RetailStore } from "../types.js";

const targetPublicKey = "9f36aeafbe60771e321a7cc95a78140772ab3e96";

type TargetGeocodeResponse = {
  locations?: Array<{
    address?: {
      latitude?: number;
      longitude?: number;
      city?: string;
      subdivision?: string;
      postalCode?: string;
      formattedAddress?: string;
    };
  }>;
};

type TargetNearbyStoresResponse = {
  nearby_stores?: {
    stores?: TargetNearbyStore[];
  };
};

type TargetNearbyStore = {
  store_id?: string;
  location_name?: string;
  distance?: number;
  mailing_address?: {
    address_line1?: string;
    city?: string;
    region?: string;
    postal_code?: string;
  };
};

export type TargetStoreLookupResult = {
  zipCode: string;
  latitude?: number;
  longitude?: number;
  stores: RetailStore[];
  warning?: string;
};

export async function findTargetStoresByZip(zipCode: string): Promise<TargetStoreLookupResult> {
  const geocode = await geocodeTargetZip(zipCode);

  if (!geocode.latitude || !geocode.longitude) {
    return {
      zipCode,
      stores: [],
      warning: "Target geocoding did not return coordinates for this ZIP code."
    };
  }

  try {
    const stores = await fetchTargetNearbyStores(zipCode);
    return {
      zipCode,
      latitude: geocode.latitude,
      longitude: geocode.longitude,
      stores
    };
  } catch (error) {
    return {
      zipCode,
      latitude: geocode.latitude,
      longitude: geocode.longitude,
      stores: [],
      warning: error instanceof Error ? error.message : "Target store lookup failed."
    };
  }
}

async function geocodeTargetZip(zipCode: string) {
  const url = new URL("https://api.target.com/location_proximities/v1/geocodes");
  url.searchParams.set("key", targetPublicKey);
  url.searchParams.set("place", zipCode);

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Target ZIP geocode failed: ${response.status}`);
  }

  const body = (await response.json()) as TargetGeocodeResponse;
  const address = body.locations?.[0]?.address;

  return {
    latitude: address?.latitude,
    longitude: address?.longitude,
    city: address?.city,
    state: address?.subdivision,
    postalCode: address?.postalCode,
    formattedAddress: address?.formattedAddress
  };
}

async function fetchTargetNearbyStores(zipCode: string): Promise<RetailStore[]> {
  const url = new URL("https://redsky.target.com/redsky_aggregations/v1/web/nearby_stores_v1");
  url.searchParams.set("key", targetPublicKey);
  url.searchParams.set("limit", "5");
  url.searchParams.set("place", zipCode);

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (response.status === 403) {
    throw new Error("Target nearby-store endpoint returned 403/captcha; continuing without store_id.");
  }

  if (!response.ok) {
    throw new Error(`Target nearby-store lookup failed: ${response.status}`);
  }

  const body = (await response.json()) as TargetNearbyStoresResponse;

  return (body.nearby_stores?.stores ?? [])
    .filter((store) => store.store_id && store.location_name)
    .map((store) => ({
      retailer: "target",
      storeId: store.store_id!,
      name: store.location_name!,
      zipCode: store.mailing_address?.postal_code,
      address: [
        store.mailing_address?.address_line1,
        store.mailing_address?.city,
        store.mailing_address?.region
      ]
        .filter(Boolean)
        .join(", "),
      distanceMiles: store.distance
    }));
}
