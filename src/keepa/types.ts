export type KeepaDomainId = 1;

export type KeepaProductFinderSelection = {
  page?: number;
  perPage?: number;
  sort?: [string, "asc" | "desc"][];
  rootCategory?: number[];
  categories_include?: number[];
  categories_exclude?: number[];
  productType?: number;
  singleVariation?: boolean;
  isHazMat?: boolean;
  isHeatSensitive?: boolean;
  isAdultProduct?: boolean;
  buyBoxIsAmazon?: boolean;
  buyBoxIsFBA?: boolean;
  current_BUY_BOX_SHIPPING_gte?: number;
  current_BUY_BOX_SHIPPING_lte?: number;
  current_SALES_lte?: number;
  monthlySold_gte?: number;
  outOfStockPercentage90_gte?: number;
  buyBoxStatsAmazon90_lte?: number;
  buyBoxStatsSellerCount90_gte?: number;
  buyBoxStatsSellerCount90_lte?: number;
};

export type KeepaQueryResponse = {
  asinList?: string[];
  totalResults?: number;
  tokensLeft?: number;
  tokensConsumed?: number;
  refillIn?: number;
  error?: unknown;
};

export type KeepaProduct = {
  asin: string;
  title?: string;
  brand?: string;
  manufacturer?: string;
  rootCategory?: number;
  salesRankReference?: number;
  monthlySold?: number;
  buyBoxSellerIdHistory?: string[];
};

export type KeepaProductResponse = {
  products?: KeepaProduct[];
  tokensLeft?: number;
  tokensConsumed?: number;
  refillIn?: number;
  error?: unknown;
};
