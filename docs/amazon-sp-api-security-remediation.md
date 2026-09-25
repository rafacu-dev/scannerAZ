# Amazon SP-API security remediation and resubmission checklist

## Why this document exists

Amazon's Developer Profile decision identified two missing areas:

1. Evidence of network controls: firewall, IDS/IPS, anti-malware protection,
   and network segmentation.
2. A documented incident response plan with defined roles, semiannual reviews,
   and an Amazon-notification process that starts within 24 hours.

This document is a preparation checklist. It must not be used to claim a
control that is not actually configured and operating.

## Current repository evidence

- `docs/security-controls.md` records the implemented application controls and
  the deployment controls still required before launch.
- `docs/incident-response-plan.md` defines incident roles, containment,
  evidence preservation, review cadence, and the 24-hour notification target.
- Refresh tokens are encrypted at rest with AES-256-GCM. In production, the
  application requires a managed PostgreSQL connection store; the local JSON
  fallback is development-only.
- OAuth state is signed, time-bound, and protected by an HTTP-only cookie.
- The server applies security headers, request-size limits, rate limits, and
  generic client errors that do not disclose provider responses.
- In production, Amazon routes are disabled until a server-only operator token
  is configured. That token is an internal bootstrap control, not a mobile
  credential and not a substitute for end-user authentication.

## Required production evidence before resubmission

Complete and retain evidence for every item below.

- [ ] Production architecture diagram that shows the mobile client, WAF or
      firewall, API service, private token store, monitoring, and the boundary
      between production and development.
- [ ] Screenshot or export showing the WAF/firewall's active rules and HTTPS
      configuration.
- [ ] Screenshot or export showing active threat detection/IDS/IPS alerts and
      the operator who receives them.
- [ ] Evidence of runtime or endpoint anti-malware protection for every host
      that can process Amazon Information.
- [ ] Database/secret-store configuration proving that token storage is not
      publicly reachable.
- [ ] MFA-enabled administrator roster for Amazon, cloud, source control, and
      deployment accounts.
- [ ] A dated review of `docs/incident-response-plan.md`, including a tabletop
      exercise and named owners.
- [ ] Production secrets set outside source control: `ENCRYPTION_KEY`,
      `SESSION_SECRET`, LWA client credentials, and the per-account refresh
      tokens.
- [ ] `SCANNERAZ_OPERATOR_TOKEN` is stored only in the server-side secret
      manager. It is not embedded in Expo or exposed to a browser.

## Developer Profile response template

Use this only after replacing bracketed text and verifying the corresponding
controls. It is intentionally specific so that the profile describes the real
deployment rather than aspirational controls.

### Network security controls

> ScannerAz is a private SP-API application used only by [organization name]
> for product eligibility and pricing workflows. Production traffic is
> encrypted with TLS 1.2+ and passes through [WAF/firewall provider] with
> managed application-protection rules. The production API is isolated from
> development, and Amazon refresh tokens are stored only in [private managed
> database/secret store], which is not publicly reachable. [Threat detection
> provider] monitors firewall and application events, and [runtime/endpoint
> protection provider] protects the hosts that process Amazon Information.
> Administrative access is restricted to approved operators and requires MFA.

### Incident response plan

> ScannerAz maintains a documented incident response plan with an Incident
> Management Point of Contact, Technical Lead, and Communications Owner. The
> plan covers credential exposure, unauthorized access, malicious traffic, and
> suspected compromise. It requires containment, evidence preservation,
> credential revocation, a documented recovery decision, and Amazon
> notification initiated within 24 hours when Amazon Information may be
> affected. The plan is reviewed at least every six months and after material
> security or data-handling changes; review and tabletop-exercise records are
> retained in the operating runbook.

## Portal sequence after the controls are verified

1. In Solution Provider Portal, open **Settings -> Developer Profile** and
   update the security-control answers truthfully.
2. Submit a new Developer Profile request. Amazon's prior case says not to
   reopen the closed case.
3. After the required roles are approved, assign them to ScannerAz Dev:
   `Product Listing` for eligibility and `Pricing` for pricing/offer data.
4. Self-authorize the private app for the seller account, then generate a new
   refresh token. A refresh token issued before the role changes must not be
   reused for the updated permissions.
5. Run `npm run amazon:check -- <ASIN>` and verify a real response before
   exposing the feature in the mobile app.

## Explicit non-goals

- Do not request buyer PII, payments, messages, tax data, or order data for
  the current ScannerAz use case.
- Do not submit infrastructure screenshots, secrets, refresh tokens, or
  Amazon credentials to source control or chat.
