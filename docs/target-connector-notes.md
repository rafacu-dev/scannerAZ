# Target connector notes

## Current position

Target should not be part of the first automated MVP unless we get a stable API, approved feed, or reliable data provider.

The Amazon/Keepa path is cleaner:

1. Keepa gives ASIN candidates.
2. Amazon SP-API checks account-specific restrictions.
3. Retail connectors search only products already worth checking.

## Why Target waits

Target's consumer website has store and ZIP-based availability, but that is not the same as a supported API contract for a SaaS product.

Using a hidden website endpoint or controlled browser session would create:

- high breakage risk
- unclear terms-of-use risk
- weak product matching if UPC/GTIN is missing
- blocking/captcha/session issues at scale

## Acceptable connector options

- Official Target partner/feed access if available.
- Licensed third-party product availability provider.
- Manual CSV import from a data source during testing.

## Current implementation

The code has a provider-based Target connector.

Initial supported providers:

- `public-web`
- `unwrangle`

Required `.env` values:

- `TARGET_PROVIDER=public-web`

Optional paid provider mode:

- `TARGET_PROVIDER=unwrangle`
- `TARGET_API_KEY=...`

Endpoint:

- `GET /api/retail/target/search?query=keurig&zipCode=02205`

This is intentionally isolated behind `src/retail/target/client.ts` so it can be replaced by an official Target partner API or another licensed provider later.

The `public-web` provider reads Target's public clearance weekly ad page:

- https://www.target.com/c/clearance/weekly-ad/-/N-5q0gaZ55dgn

It does not log in, does not use user cookies, and does not control a browser session.

## MVP recommendation

Do not start with Target.

Start with:

1. Keepa ASIN discovery.
2. Amazon restriction validation.
3. Walmart local price/availability if API access is approved.
4. Target only after the Amazon restriction engine is proven.
