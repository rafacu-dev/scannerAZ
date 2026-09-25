# Render production runbook

This runbook describes the deployment boundary for the ScannerAz API. It is
not permission to enable public Amazon connections before the controls in
`docs/amazon-sp-api-security-remediation.md` have been implemented and
verified.

## Intended production resources

- `scanneraz-api`: Node web service in Render's Oregon region.
- `scanneraz-db`: PostgreSQL 18 in the same region, with no public ingress.
- `scanneraz-production-runtime`: an environment group for non-secret
  production switches shared by ScannerAz services.

`render.yaml` is the source-controlled declaration of this layout. It leaves
the application feature flags off by default. Creating or applying a Blueprint
is an operational action; review the Render plan and billing total in the
dashboard before applying it.

## Database choice

Use a dedicated database rather than an existing database for another product.
The initial configuration is intentionally small:

- Plan: `0.1c-256mb`.
- Storage: 1 GB.
- Storage autoscaling: off.
- Connection pool: PgBouncer.
- External IP allowlist: empty, so only Render private-network clients can
  connect.

As of September 2026, Render's published pricing lists the `0.1c-256mb`
Postgres compute plan at $6/month and expandable Postgres storage at
$0.30/GB-month. The initial configuration should therefore be reviewed as
about $6.30/month before taxes or later storage changes. Confirm the current
dashboard total immediately before creation; provider pricing can change.

## Environment and secret boundaries

| Variable | Class | Owner | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | non-secret | Render group | Must be `production`. |
| `APP_BASE_URL` | non-secret | service | Current public API origin. Update only after the custom domain is verified. |
| `DATABASE_URL` | secret | Render database reference | Use the private `connectionString`; never copy it to Expo or Git. |
| `DATABASE_SSL` | non-secret | Render group | `false` for the private Render Postgres connection unless Render changes the endpoint requirement. |
| `ENCRYPTION_KEY` | secret | Render-generated | Encrypts Amazon refresh tokens at rest. Rotation requires a deliberate token migration plan. |
| `SESSION_SECRET` | secret | Render-generated | Signs OAuth state. Rotation invalidates outstanding OAuth state. |
| `SCANNERAZ_OPERATOR_TOKEN` | secret | Render secret manager | Add only when operator-only Amazon routes are intentionally enabled. |
| `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_SP_API_APP_ID` | secret | Render secret manager | Add only after Amazon approves the public app and roles. |
| `SCANNERAZ_PUBLIC_APP_ENABLED` | non-secret feature flag | Render group | Keep `false` until the Amazon security launch gate is complete. |
| `SCANNERAZ_PUBLIC_SIGNUP_ENABLED` | non-secret feature flag | Render group | Keep `false` until registration, reset, and verification operations are ready. |

Never use a `SECRET`, `TOKEN`, client secret, database URL, refresh token, or
operator token in an `EXPO_PUBLIC_*` variable. `EXPO_PUBLIC_*` values are
compiled into the mobile application and are visible to users.

## First deployment checklist

1. Create `scanneraz-db` in Oregon with the database settings above.
2. Attach `DATABASE_URL` from the database's private connection string to
   `scanneraz-api`.
3. Let Render generate `ENCRYPTION_KEY` and `SESSION_SECRET` in its secret
   manager. Do not export their values to a local file.
4. Keep both public feature flags `false`; deploy and confirm `/health` returns
   `200`.
5. Inspect the service logs for successful schema initialization. The service
   creates only its `scanneraz_*` tables.
6. Before enabling seller OAuth, configure the WAF/firewall, threat detection,
   endpoint/runtime protection, MFA, incident-response record, and evidence
   listed in `docs/amazon-sp-api-security-remediation.md`.
7. After the Amazon Developer Profile and app roles are approved, add the LWA
   variables in Render's secret manager, configure the verified OAuth callback,
   and perform a limited pilot before changing the public flags.

## Mobile distribution configuration

The mobile project uses two independent EAS Update channels:

- `preview`: internal QA/TestFlight testing.
- `production`: App Store/TestFlight production builds.

The environment for a preview build must remain `preview`; the environment for
a store build must remain `production`. Set only the public API base URL in EAS
for those environments. Publish an update to `preview`, verify it on a preview
build, then republish that tested update to `production`. A change to native
modules, `app.json`, runtime version, or permissions requires a new native
build rather than an OTA update.
