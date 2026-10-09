type SaleImage = {
  asin?: string;
  sku?: string;
  connectionId: string;
  imageUrl?: string;
};

export function fillSaleImages<T extends SaleImage>(sales: T[]): T[] {
  const byAsin = new Map<string, string>();
  const bySku = new Map<string, Array<{ asin: string; imageUrl: string }>>();
  const asinKey = (sale: T) => sale.asin?.trim().toUpperCase() ?? "";
  const skuKey = (sale: T) => JSON.stringify([sale.connectionId, sale.sku?.trim()]);

  for (const sale of sales) {
    const imageUrl = sale.imageUrl?.trim();
    if (!imageUrl) continue;
    const asin = asinKey(sale);
    if (asin && !byAsin.has(asin)) byAsin.set(asin, imageUrl);
    if (sale.sku?.trim()) {
      const key = skuKey(sale);
      const candidates = bySku.get(key) ?? [];
      candidates.push({ asin, imageUrl });
      bySku.set(key, candidates);
    }
  }

  return sales.map(sale => {
    if (sale.imageUrl?.trim()) return sale;
    const asin = asinKey(sale);
    let imageUrl = asin ? byAsin.get(asin) : undefined;
    // A SKU may be reused in another account or reassigned to a different ASIN.
    if (!imageUrl && sale.sku?.trim()) {
      const candidates = bySku.get(skuKey(sale)) ?? [];
      const knownAsins = new Set(candidates.map(candidate => candidate.asin).filter(Boolean));
      if (knownAsins.size <= 1 && (!asin || !knownAsins.size || knownAsins.has(asin))) {
        imageUrl = candidates[0]?.imageUrl;
      }
    }
    return imageUrl ? { ...sale, imageUrl } : sale;
  });
}
