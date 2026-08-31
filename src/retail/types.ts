export type Retailer = "target" | "walmart" | "publix";

export type RetailStore = {
  retailer: Retailer;
  storeId: string;
  name: string;
  zipCode?: string;
  address?: string;
  distanceMiles?: number;
};

export type ClearanceProduct = {
  retailer: Retailer;
  provider: string;
  storeId?: string;
  title: string;
  url?: string;
  retailerProductId?: string;
  upc?: string;
  price?: number;
  regularPrice?: number;
  discountPercent?: number;
  availability?: string;
  imageUrl?: string;
  raw?: unknown;
};

export type ClearanceSearchInput = {
  zipCode: string;
  radiusMiles?: number;
  limit?: number;
};
