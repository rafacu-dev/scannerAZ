# ScannerAz public SP-API product plan

## Product classification

ScannerAz is intended to become a commercial application used by multiple
Amazon selling partners. It must therefore follow Amazon's public-developer
and public-application path, rather than the private developer path used only
by one organization.

Each selling partner must explicitly authorize ScannerAz through Amazon's
OAuth flow. ScannerAz must never reuse one seller's refresh token, cookies, or
Amazon connection for another seller.

## Initial requested scope

Request only the non-restricted roles required by the first product release:

- `Product Listing` for catalog/listing eligibility and restrictions.
- `Pricing` for offer and pricing analysis.

Do not request buyer PII, order, payment, message, tax, or shipping roles
until a specific product feature needs them and its security review is complete.

## Authorization model

1. A user creates and signs in to a ScannerAz account.
2. The user chooses **Connect Amazon Seller Central**.
3. ScannerAz initiates Amazon OAuth with a signed, short-lived state value.
4. Amazon redirects to ScannerAz after the seller grants consent.
5. The backend exchanges the authorization code and encrypts the refresh token
   in the tenant's private record.
6. Every SP-API request resolves the authenticated ScannerAz user and tenant
   before selecting that tenant's Amazon connection.
7. Users can disconnect their Amazon account, which revokes the ScannerAz
   connection and removes the encrypted token record.

## Current implementation and required work

The backend already has a signed OAuth state flow, AES-256-GCM refresh-token
encryption, a PostgreSQL connection store, and connection IDs. It is currently
an operator-only bootstrap integration, not a customer-facing multi-tenant
authorization system.

Before external sellers can use ScannerAz, implement:

- ScannerAz end-user authentication and user-to-tenant membership.
- A tenant ID and ownership rules for every Amazon connection and API request.
- A secure connection-management screen with connect, status, and disconnect.
- Authorization event logs that exclude tokens and credentials.
- Rate limits and quotas per tenant, seller account, and feature.
- Consent, privacy, support, terms, and data-deletion pages on the public
  ScannerAz website.
- Production secret management, private database storage, monitoring, alerting,
  and a documented incident-response review process.

## Amazon registration and release sequence

1. Complete the Developer Profile as a public developer with truthful security
   controls and the minimal roles above.
2. Obtain approval for the Developer Profile and roles.
3. Register the production application in Solution Provider Portal.
4. Configure the public OAuth redirect URI and generate production LWA
   credentials.
5. Complete Amazon's production and Appstore review requirements for the
   public application.
6. Pilot with a small number of invited sellers before broadly publishing the
   application.

## Security boundary

Amazon credentials, refresh tokens, client secrets, and signed request headers
stay server-side. The Expo application receives only ScannerAz session data and
feature responses. It never receives Amazon client secrets or another seller's
connection identifier.
