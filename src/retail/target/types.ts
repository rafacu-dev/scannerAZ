export type TargetSearchResult = {
  source: "target";
  provider: string;
  title: string;
  url?: string;
  tcin?: string;
  upc?: string;
  price?: number;
  salePrice?: number;
  availability?: string;
  imageUrl?: string;
  rating?: number;
  reviewCount?: number;
  raw?: unknown;
};

export type TargetSearchInput = {
  query: string;
  zipCode?: string;
  page?: number;
};
