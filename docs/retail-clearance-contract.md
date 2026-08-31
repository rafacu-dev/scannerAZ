# Retail clearance contract

## Goal

Given a ZIP code, return clearance or discounted products from nearby retail stores.

The app should normalize every retailer into the same shape before matching products to Amazon.

## Request model

Endpoint:

```txt
GET /api/retail/clearance?retailer=target&zipCode=02205&radiusMiles=25&limit=100
```

Fields:

- `zipCode`: 5-digit US ZIP code.
- `retailer`: optional. One of `target`, `walmart`, `publix`.
- `radiusMiles`: optional. Default `25`.
- `limit`: optional. Default `100`.

## ZIP/store handling

Do not assume ZIP code is always sent as a header.

Common patterns:

- ZIP code as query parameter, for example `zipCode=02205`.
- Store id as query parameter, for example `storeId=1234`.
- ZIP and store id together.
- Location in POST JSON payload.
- Provider-specific location object.

Our internal contract always starts with `zipCode`. Each connector is responsible for translating that into whatever its upstream API requires.

For Target, the current implementation now attempts:

1. Geocode ZIP through Target's public geocode endpoint.
2. Resolve nearby stores through Target's nearby-store endpoint.
3. Use the first `store_id` if available.
4. Continue with generic Weekly Ad/Clearance if Target blocks nearby-store lookup.

Endpoint for debugging store lookup:

```txt
GET /api/retail/target/stores?zipCode=32605
```

## Walmart

Walmart has a documented realtime pricing and availability API that accepts `storeId` and/or `zipCode`.

Source:

- https://walmart.io/docs/opd/v1/catalog-pricing-and-availability-realtime

Important distinction:

- Walmart Marketplace APIs for sellers are not the same as consumer/local-store deal discovery.
- We need OPD/partner data or a licensed provider for local retail availability at scale.

## Target

Target does not currently have a simple public API we can treat like Amazon SP-API.

The implementation supports a provider-based connector so we can use a licensed data provider first and later replace it with official partner access if available.

Current endpoint:

```txt
GET /api/retail/clearance?retailer=target&zipCode=02205
```

Current provider behavior:

- Searches Target for `clearance` scoped to the ZIP when the provider supports it.
- Normalizes price, sale price, availability, TCIN, UPC, and URL if present.

## Clearance definition

Retailers use different labels:

- clearance
- sale
- rollback
- weekly ad
- closeout
- discontinued
- promotion

The connector should preserve the raw retailer/provider response so we can later improve classification.

## Product matching priority

For Amazon matching, prefer:

1. UPC/GTIN
2. Manufacturer part number/model
3. Exact brand + title + size/count
4. Fuzzy title matching only as low confidence

Never send a low-confidence retail match directly to the Amazon restriction checker as if it were a confirmed match.
