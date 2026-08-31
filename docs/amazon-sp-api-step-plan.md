# Amazon SP-API step-by-step plan

## Goal

Let normal users connect their Amazon Seller account safely through Amazon's official OAuth flow, then verify whether their account can sell specific ASINs.

The first production-critical feature is not product discovery. It is this:

> Given a connected seller account, marketplace, ASIN, and condition, return whether that seller can list the product.

## Recommended path

Use Amazon SP-API authorization through Login with Amazon OAuth.

Do not use a controlled WebView for Amazon Seller Central login. The browser can be used only as the normal user-agent during the official OAuth redirect flow.

## Phase 0: Decisions before implementation

### Marketplace

Start with Amazon US only.

- Marketplace id: `ATVPDKIKX0DER`
- Region: North America
- Default condition: `new_new`

### App type

Start as a private/test SP-API app if we are validating with your own seller account.

Move to public app flow before onboarding real external users.

### First success condition

The first milestone is a CSV/table like:

- ASIN
- seller id
- marketplace id
- condition
- restriction status
- restriction reason
- checked timestamp

No Keepa, Walmart, Target, or Publix until this works.

## Phase 1: Amazon developer setup

### Tasks

1. Create or access Amazon Solution Provider Portal.
2. Register as an SP-API developer.
3. Create an SP-API application.
4. Configure OAuth redirect URL for local development.
5. Identify required roles/scopes for Listings Restrictions and Catalog data.

### Expected outputs

- LWA client id.
- LWA client secret.
- SP-API application id.
- OAuth redirect URI configured in Amazon.
- AWS IAM role/credentials for SP-API request signing.

### Risks

- Amazon may take time to approve the developer profile.
- Public app approval can require security/compliance answers.
- Some roles may need justification.

## Phase 2: Local OAuth callback

### Tasks

1. Build a minimal backend route:
   - `GET /auth/amazon/start`
   - `GET /auth/amazon/callback`
2. `/auth/amazon/start` redirects the user to Amazon's consent URL.
3. `/auth/amazon/callback` receives Amazon parameters.
4. Backend validates `state`.
5. Backend exchanges the authorization code for tokens.
6. Store the refresh token encrypted.

### Expected outputs

- A connected seller record in the database.
- Encrypted Amazon refresh token.
- Seller account metadata if available.

### First test

Click "Connect Amazon Seller Account" locally, authorize the app, and confirm the callback saves a refresh token.

## Phase 3: First authenticated SP-API call

### Tasks

1. Use the refresh token to request a short-lived LWA access token.
2. Sign an SP-API request using AWS SigV4.
3. Call a low-risk endpoint to verify credentials work.

### Expected outputs

- Successful SP-API response.
- Clean error handling for:
  - invalid refresh token
  - invalid AWS signature
  - expired credentials
  - wrong region
  - missing role permission

### First test

Run one backend command that proves the seller connection is usable.

## Phase 4: Listings Restrictions MVP

### Tasks

1. Create a function:
   - input: `sellerId`, `asin`, `marketplaceId`, `conditionType`
   - output: normalized restriction status
2. Call Amazon `getListingsRestrictions`.
3. Normalize Amazon responses into app statuses:
   - `sellable`
   - `approval_required`
   - `blocked`
   - `unknown`
4. Persist each check result.

### Expected outputs

- One endpoint:
  - `POST /api/amazon/restrictions/check`
- One CLI/dev script:
  - check a single ASIN for the connected test seller.

### First test

Check 5 ASINs manually in Seller Central and compare them with the API response.

## Phase 5: Batch ASIN checks

### Tasks

1. Accept a pasted list or CSV of ASINs.
2. Queue restriction checks.
3. Respect Amazon rate limits.
4. Retry transient failures.
5. Export results as CSV.

### Expected outputs

- A batch run screen.
- CSV export.
- Clear statuses per ASIN.

### First test

Run 50 ASINs and manually audit 10 in Seller Central.

## Phase 6: Keepa integration

### Tasks

1. Add `KEEPA_API_KEY`.
2. Query Keepa for candidate ASINs.
3. Apply conservative filters for new sellers.
4. Send resulting ASINs to the Amazon restriction checker.

### Expected outputs

- Candidate ASIN list.
- Sellability-filtered ASIN list for the connected seller.

### First test

Pull 50 Keepa candidates and compare Amazon restriction results.

## Phase 7: Retail availability

### Tasks

1. Start with Walmart API or approved data provider.
2. Match products by UPC/GTIN where possible.
3. Use ZIP code to find nearby stores.
4. Retrieve local availability and price.
5. Join retail offers back to Amazon ASINs.

### Expected outputs

- Product table with:
  - ASIN
  - Amazon sellability
  - retail store
  - local price
  - distance
  - confidence score

### First test

Use only products already marked `sellable` by Amazon.

## Phase 8: User-facing app

### Tasks

1. Login/signup.
2. Connect Amazon Seller account.
3. Enter ZIP code.
4. Run scan.
5. Show results.
6. Export CSV.

### Required user-facing states

- Amazon account not connected.
- Amazon connection expired.
- No sellable products found.
- API rate limited.
- Retail data unavailable.
- Product match uncertain.

## Development order

1. Create app skeleton.
2. Implement environment/config validation.
3. Implement Amazon OAuth start/callback.
4. Store encrypted refresh token.
5. Implement first SP-API signed request.
6. Implement single-ASIN restriction check.
7. Implement batch ASIN restriction check.
8. Add Keepa.
9. Add Walmart.
10. Add Target/Publix only after the core flow is proven.

## Non-negotiables

- Never show a product as sellable unless Amazon confirms it for that connected account.
- Never store Amazon user passwords.
- Never ask users to paste Seller Central cookies.
- Encrypt refresh tokens.
- Log API failures without exposing secrets.
- Treat all restriction results as time-sensitive.
