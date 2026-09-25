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

- Build command: `npm ci --include=dev && npm run build`
- Start command: `npm start`
- Health check path: `/health`

The production Blueprint and operational sequence are documented in
[`render.yaml`](render.yaml) and
[`docs/render-production-runbook.md`](docs/render-production-runbook.md).
The Blueprint declares a private dedicated Postgres database, generated
server-only secrets, and disabled-by-default public Amazon flags. It does not
put credentials in source control.

## Amazon SP-API security

Before deploying Amazon OAuth or SP-API access, complete the production controls
and evidence checklist in [`docs/amazon-sp-api-security-remediation.md`](docs/amazon-sp-api-security-remediation.md).
The application expects HTTPS in production and requires `ENCRYPTION_KEY`,
`SESSION_SECRET`, and a managed PostgreSQL `DATABASE_URL` before Amazon OAuth
or connection-specific SP-API routes are enabled. Set a 32+ character
server-only `SCANNERAZ_OPERATOR_TOKEN` before enabling Amazon routes in
production; never place it in `EXPO_PUBLIC_*` or the mobile bundle. Set
`DATABASE_SSL=true` only if the managed PostgreSQL endpoint requires TLS.

## Public-selling-partner foundation

The public application routes remain disabled by default. They provide the
foundation for a ScannerAz user account, tenant-scoped Amazon connection, and
tenant-scoped eligibility check:

- `POST /auth/scanneraz/register`
- `POST /auth/scanneraz/login`
- `GET /auth/scanneraz/me`
- `POST /auth/scanneraz/logout`
- `GET /auth/amazon/connect`
- `GET /api/public/amazon/connections`
- `POST /api/public/amazon/connections/:connectionId/restrictions/check`
- `DELETE /api/public/amazon/connections/:connectionId`

Enable this surface only when all four prerequisites are true:

1. `DATABASE_URL` points to a private managed PostgreSQL database.
2. `ENCRYPTION_KEY` and `SESSION_SECRET` are configured in the production secret manager.
3. `SCANNERAZ_PUBLIC_APP_ENABLED=true` is configured server-side.
4. The production security and public-launch checklists have been completed.

Registration additionally requires `SCANNERAZ_PUBLIC_SIGNUP_ENABLED=true`.
The returned ScannerAz session token is not an Amazon credential; the mobile
client must keep it in secure device storage, never AsyncStorage or an
`EXPO_PUBLIC_*` setting.
