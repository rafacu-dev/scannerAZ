# ScannerAz API-first plan

## Objective

Build a web scanner for newer Amazon sellers that finds candidate retail arbitrage products and verifies whether each product can be sold by the connected Amazon seller account.

The product must not rely on browser scraping or Seller Central screen automation for the core restriction check. The final sellability status must come from Amazon Selling Partner API (SP-API).

## Core principle

There is no universal "ungated product" result. A product is sellable only for:

- one seller account
- one marketplace
- one ASIN
- one condition
- one point in time

For the US marketplace, the marketplace id is `ATVPDKIKX0DER`.

## API sources

### Amazon SP-API

Required for account-specific selling eligibility.

Primary APIs:

- `Listings Restrictions API`
  - Endpoint: `getListingsRestrictions`
  - Purpose: check whether restrictions prevent the connected seller from creating a listing for an ASIN.
  - Inputs: `sellerId`, `marketplaceIds`, `asin`, `conditionType`.
  - Expected conditions for MVP: `new_new`.

- `Catalog Items API`
  - Purpose: resolve UPC/EAN/GTIN or product search terms to ASIN candidates.

- Optional later:
  - `Product Fees API` for FBA/referral fee estimates.
  - `Product Pricing API` for Buy Box and offer context.
  - `Listings Items API` for deeper listing validation or listing creation.

Authorization:

- Login with Amazon OAuth.
- Store refresh tokens encrypted.
- Each user must authorize the app.
- Do not assume one user's eligibility applies to another user.

### Keepa API

Required for candidate ASIN discovery.

Use cases:

- Product Finder queries.
- Deals and price history.
- Sales rank and sales-rank-drop filters.
- Buy Box price history.
- Amazon in-stock/out-of-stock signals.
- Seller count.
- Review/rating filters.
- Category and brand filters.

Keepa should generate candidate ASINs, not final restriction decisions.

### Walmart

Potentially viable API source for local pricing and availability.

Use:

- Realtime pricing and availability by ZIP or store when access is approved.
- Match by UPC/GTIN when available.

Risk:

- Public/approved access may be limited depending on Walmart program access.

### Target

No stable public retail inventory API is assumed for MVP.

Options:

- Approved partner/data provider.
- Affiliate/product feed if it contains enough product identifiers.
- Add after Walmart once the Amazon/Keepa flow is proven.

### Publix

No stable public retail inventory API is assumed for MVP.

Options:

- Approved partner/data provider.
- Weekly ad/deals source if terms allow it.
- Add later as a separate connector.

## MVP workflow

1. User signs in.
2. User connects Amazon Seller account through SP-API OAuth.
3. User enters ZIP code.
4. Backend runs a Keepa Product Finder query to get ASIN candidates.
5. Backend filters obvious high-risk products before Amazon checks:
   - restricted-heavy categories
   - hazardous or meltable products
   - adult products
   - known protected brands
   - products with weak demand
   - products where Amazon dominates the Buy Box
6. Backend checks each ASIN through Amazon `getListingsRestrictions`.
7. Backend keeps only products with no blocking restriction for the connected seller.
8. Backend checks retail availability/pricing near ZIP, starting with Walmart.
9. Backend calculates rough profit:
   - Amazon current selling price
   - retail buy cost
   - referral fee/FBA estimate when available
   - expected margin and ROI
10. UI shows a ranked product table.

## Product status model

- `sellable`
  - Amazon returned no blocking listing restrictions for the connected account.

- `approval_required`
  - Amazon returned an approval requirement or approval links.

- `blocked`
  - Amazon returned a restriction with no immediate listing path.

- `unknown`
  - API failed, rate-limited, missing ASIN, or missing Amazon account authorization.

- `retail_match_found`
  - Product was matched to a retail listing near the ZIP.

- `retail_match_missing`
  - Amazon candidate exists, but no retail offer was found.

## Required credentials

Create these before production integration:

- `KEEPA_API_KEY`
- Amazon SP-API application:
  - `AMAZON_LWA_CLIENT_ID`
  - `AMAZON_LWA_CLIENT_SECRET`
  - `AMAZON_SP_API_APP_ID`
  - AWS IAM role or credentials required by SP-API signing
- Walmart API credentials, if approved:
  - `WALMART_CLIENT_ID`
  - `WALMART_CLIENT_SECRET`

## First validation test

Before building the full UI, run a backend-only test:

1. Pull 50 ASINs from Keepa.
2. Check each ASIN against one connected Amazon seller account.
3. Save a CSV with:
   - ASIN
   - title
   - brand
   - category
   - Amazon sellability status
   - restriction reasons
   - current Buy Box price
   - estimated monthly demand signal
4. Manually compare 10 ASINs in Seller Central > Add Products.
5. Only proceed if API and Seller Central agree.

## Sources checked

- Amazon Listings Restrictions API: https://developer-docs.amazon.com/sp-api/lang-US/docs/get-listings-restrictions
- Amazon SP-API authorization: https://developer-docs.amazon/sp-api/docs/authorizing-selling-partner-api-applications
- Keepa API overview: https://keepa.com/api-docs/
- Keepa Python client docs: https://keepaapi.readthedocs.io/
- Walmart realtime pricing and availability: https://walmart.io/docs/opd/v1/catalog-pricing-and-availability-realtime
