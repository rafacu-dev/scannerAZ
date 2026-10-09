export function classifyAmazonSale(fulfillmentStatus?: string | null) {
  const status = fulfillmentStatus?.trim().toUpperCase() ?? '';
  if (/CANCEL|UNFULFILLABLE/.test(status)) return 'canceled' as const;
  if (status === 'PENDING' || status === 'PENDING_AVAILABILITY') return 'pending' as const;
  if (['UNSHIPPED', 'SHIPPING', 'PARTIALLY_SHIPPED', 'SHIPPED', 'INVOICE_UNCONFIRMED'].includes(status)) {
    return 'confirmed' as const;
  }
  return 'unknown' as const;
}
