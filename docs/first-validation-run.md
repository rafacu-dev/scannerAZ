# First validation run

## Goal

Prove that ScannerAz can take Amazon product candidates from Keepa and verify the seller-account-specific listing restriction through Amazon SP-API.

Do not use retail matching until this passes.

## Inputs

- One Keepa API key.
- One Amazon seller account connected through SP-API OAuth.
- Marketplace: US (`ATVPDKIKX0DER`).
- Condition: new (`new_new`).
- Candidate count: 50 ASINs.

## Keepa candidate filters

Start conservative for new sellers:

- Exclude adult products.
- Exclude hazmat-prone products where detectable.
- Exclude high-risk categories at first:
  - Beauty
  - Grocery
  - Health and Personal Care
  - Supplements
  - Baby ingestibles/topicals
  - Major apparel/shoe brands
- Prefer:
  - Office products
  - Home and kitchen accessories
  - Tools/home improvement accessories
  - Pet accessories, excluding food/medicine
- Buy Box price: target $15-$60.
- Avoid listings where Amazon is consistently in stock.
- Prefer enough seller count to indicate resale activity, but avoid extreme competition.

## Amazon restriction check

For each ASIN:

1. Call `getListingsRestrictions`.
2. Pass the connected seller id.
3. Pass marketplace id `ATVPDKIKX0DER`.
4. Pass condition `new_new`.
5. Normalize the response:
   - no blocking restriction -> `sellable`
   - approval workflow returned -> `approval_required`
   - hard restriction/no path -> `blocked`
   - API or matching error -> `unknown`

## Manual audit

Open Seller Central and compare at least 10 ASINs:

1. Go to `Catalog > Add Products`.
2. Search the ASIN.
3. Record whether Seller Central shows:
   - `Sell this product`
   - `Apply to sell`
   - `Listing limitations apply`
   - `Your account does not qualify`
4. Compare against the SP-API result.

## Pass criteria

- At least 95% agreement between SP-API and Seller Central for audited ASINs.
- No product is shown to the user as `sellable` unless Amazon returned no blocking restriction.
- `unknown` is allowed when the API is unavailable or rate-limited.

## Output CSV

Columns:

- `asin`
- `title`
- `brand`
- `category`
- `keepa_source`
- `buy_box_price`
- `sales_rank`
- `seller_count`
- `amazon_in_stock_signal`
- `restriction_status`
- `restriction_reasons`
- `checked_at`
