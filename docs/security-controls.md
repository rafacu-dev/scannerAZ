# Security controls for Amazon SP-API access

## Scope and data minimization

ScannerAz is intended for authorized seller accounts only. Its current SP-API
use cases are listing eligibility, catalog matching, price review, and offer
analysis. It does not request buyer PII, order data, payment data, buyer
messages, or tax data.

## Controls implemented in the application

| Control | Implementation | Evidence |
| --- | --- | --- |
| Transport protection | Helmet security headers; production deployments must use an HTTPS `APP_BASE_URL`. | `src/server.ts` |
| Edge DDoS and WAF protection | `scanneraz.warasoft.com` is served by an active Cloudflare zone with the Cloudflare Managed Ruleset enabled; Render also provides Cloudflare-backed DDoS protection. This is not a replacement for monitoring and documented response procedures. | Cloudflare zone configuration; `docs/production-architecture.md` |
| Edge proxy boundary | The Cloudflare Worker proxies only to the fixed `scanneraz-api.onrender.com` origin and preserves the original path and query string. It does not accept a caller-selected target. When its shared secret is configured on both sides, Render rejects direct-origin traffic other than its health probe. | `cloudflare/scanneraz-edge-proxy.js`, `src/server.ts` |
| Request abuse protection | Amazon routes are limited to 60 requests per minute per source IP; OAuth routes to 12 requests per 15 minutes. | `src/server.ts` |
| Security telemetry | Rejected operator authentication and rate-limit events log request, Cloudflare, and Render trace identifiers without credentials or request bodies. | `src/server.ts` |
| Input restraint | JSON request bodies are capped at 64 KB and route inputs are validated with Zod where structured input is accepted. | `src/server.ts`, route modules |
| OAuth integrity | OAuth state is HMAC-signed with `SESSION_SECRET`, matched with a secure cookie, and expires after 10 minutes. | `src/amazon/oauth.ts`, `src/server.ts` |
| Token encryption and storage | Refresh tokens are encrypted with AES-256-GCM. In production, Amazon routes require a configured managed PostgreSQL store; the local JSON file is development-only. | `src/security/crypto.ts`, `src/storage/connections.ts`, `src/server.ts` |
| Public tenant isolation | ScannerAz account sessions are opaque, stored only as hashes, and bind a user to a tenant. Public Amazon routes query connections by that tenant, and OAuth state carries a signed tenant ID. This surface is disabled until the managed store, secret configuration, and public-release flag are present. | `src/storage/accounts.ts`, `src/auth/session.ts`, `src/amazon/publicRoutes.ts`, `src/server.ts` |
| Password controls | New passwords require 12-128 characters with uppercase, lowercase, a number, and a special character, and cannot include the email local part. Passwords use scrypt; the last 10 password hashes are retained to prevent reuse, passwords expire after 365 days, and eight failed logins lock the account for 30 minutes. Changing a password revokes all active sessions. | `src/auth/passwords.ts`, `src/storage/accounts.ts`, `src/server.ts` |
| Sensitive-route gate | In production, Amazon OAuth, connection, and SP-API routes remain disabled unless a server-only operator bearer token is configured. | `src/server.ts` |
| Secret handling | `.env`, `data/`, and generated token files are excluded from source control. | `.gitignore` |
| Safe failure handling | Browser-facing errors contain a request ID, not upstream response bodies, credentials, or tokens. | `src/server.ts` |
| Dependency and source review | CI fails when production dependencies have a high-severity `npm audit` finding and scans tracked source with ClamAV signatures. Dependabot checks npm dependencies weekly. | `.github/workflows/verify.yml`, `.github/dependabot.yml` |

## Production controls that must be configured before SP-API launch

These are deployment obligations, not claims that source code alone fulfills.
Do not state that they are active in the Developer Profile until each item has
an owner and verifiable evidence.

- Terminate all public traffic with TLS 1.2+ and redirect HTTP to HTTPS.
- Place the API behind a managed WAF/firewall with managed OWASP rules and a
  documented allowlist for administrative access where feasible.
- After `scanneraz.warasoft.com` is live, disable the public `workers.dev`
  endpoint for `scanneraz-edge-proxy` and use the custom hostname as the only
  intended public entry point.
- Set the same high-entropy `SCANNERAZ_EDGE_SHARED_SECRET` as a Cloudflare
  Worker secret and a Render service secret. Verify that only `/health` remains
  reachable through `scanneraz-api.onrender.com`.
- Enable the provider's intrusion detection/prevention or equivalent managed
  threat detection, and configure alerts for WAF blocks, authentication abuse,
  configuration changes, and abnormal API error rates.
- Use provider-managed malware/runtime protection for the production workload,
  or maintain documented endpoint protection for every host that processes
  Amazon Information.
- Segment production from development and isolate token storage in a private,
  managed database or secret store. Never expose a database or token file to
  the public Internet.
- Give production secrets only to approved operators through a managed secret
  manager. Use distinct production, staging, and development credentials.
- Replace the temporary operator gate with individual user authentication and
  authorization before allowing accounts outside the operator's organization.
- Require MFA for infrastructure, source-control, cloud, and Amazon
  administrative accounts.

## Credential management and logging

- No Amazon password, Seller Central cookie, refresh token, client secret, or
  full authorization header may be committed, returned to a client, or written
  to application logs.
- Revoke and rotate affected credentials immediately after a suspected
  compromise, and at least annually as an operating review item.
- Logs may contain a request ID, route, timestamp, and status outcome only.

## Data sharing

Amazon Information is not shared with third parties except approved
infrastructure providers required to operate the service. Public retail data
is used only for product research and comparison.

## Operating records

Maintain the following records outside source control:

- WAF/firewall and threat-detection configuration evidence.
- Secret-access roster and MFA verification.
- Semiannual incident-response review record.
- Security incidents, containment actions, and Amazon notifications.

See `docs/incident-response-plan.md` and
`docs/amazon-sp-api-security-remediation.md` for the response process and
resubmission checklist.
