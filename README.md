# scannerAZ

ScannerAz is a small Express app for retail-to-Amazon product validation.

The current deployed page is a Walmart scan list with products confirmed as
sellable in Amazon/SellerAmp and visible UPC barcodes for quick lookup in the
Walmart app.

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm start
```

## Render

Use these settings:

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check path: `/health`

## Amazon SP-API security

Before deploying Amazon OAuth or SP-API access, complete the production controls
and evidence checklist in [`docs/amazon-sp-api-security-remediation.md`](docs/amazon-sp-api-security-remediation.md).
The application expects HTTPS in production and requires `ENCRYPTION_KEY`,
`SESSION_SECRET`, and a managed PostgreSQL `DATABASE_URL` before Amazon OAuth
or connection-specific SP-API routes are enabled. Set a 32+ character
server-only `SCANNERAZ_OPERATOR_TOKEN` before enabling Amazon routes in
production; never place it in `EXPO_PUBLIC_*` or the mobile bundle. Set
`DATABASE_SSL=true` only if the managed PostgreSQL endpoint requires TLS.
