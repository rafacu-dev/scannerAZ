# Amazon public Developer Profile submission checklist

## Purpose

Use this checklist to prepare a truthful public SP-API Developer Profile for
ScannerAz. It does not authorize a submission and it does not replace the
Amazon Data Protection Policy (DPP) or Acceptable Use Policy (AUP).

## Proposed profile

| Amazon field | Prepared value |
| --- | --- |
| Organization | DRECOM LLC |
| Country | United States |
| Website | `https://scanneraz.warasoft.com/scanneraz/` |
| Developer type | Public Developer |
| Application | ScannerAz |
| Initial roles | Product Listing; Pricing |
| Public support | `Support.ScannerAz@drecom.dev` |

The portal contact name, email, and telephone number must be a monitored,
company-controlled contact. Keep those personal contact details out of this
repository.

## Business activity (under 500 characters)

> ScannerAz is a mobile product-research application for Amazon selling
> partners. It helps an authorized seller match retail products to Amazon
> catalog records, review listing eligibility, and evaluate seller-facing
> offer and pricing signals before making a sourcing decision. ScannerAz does
> not process buyer, order, payment, tax, messaging, or shipping data in its
> initial release.

## Use case

> A seller creates a ScannerAz account and explicitly authorizes its own
> Amazon account through Amazon OAuth. ScannerAz uses Product Listing data to
> match an ASIN, UPC, or product name to catalog candidates and to show the
> seller whether the requested listing workflow has restrictions. ScannerAz
> uses Pricing data to present seller-facing offer and price signals for the
> candidate product. Each connection is scoped to a single ScannerAz tenant;
> the mobile client receives feature results only and never receives Amazon
> client secrets, OAuth refresh tokens, or another seller's data. Sellers can
> disconnect their Amazon connection and request deletion of stored
> authorization data.

## Third parties

List only the providers actually used in production when Amazon asks about
outside parties:

- Cloudflare, Inc.: HTTPS edge proxy, baseline DDoS protection, an active
  custom firewall rule, and routing. Do not claim Cloudflare Managed WAF rules
  until they are enabled on the selected plan.
- Render Services, Inc.: API hosting and managed PostgreSQL storage for
  encrypted authorization records.

For external non-Amazon sources that retrieve Amazon Information, answer
`None`: ScannerAz retrieves Amazon Information directly from SP-API.

## Evidence gate before choosing Yes in the portal

- [x] `SCANNERAZ_EDGE_SHARED_SECRET` is stored only in Cloudflare Workers and
      Render; the origin rejects non-health direct requests and HTTPS redirects
      are verified.
- [ ] A WAF/firewall, DDoS control, and monitoring/alerting configuration are
      enabled and screenshots or export evidence are retained privately.
- [ ] Every workstation and hosted runtime that can access Amazon Information
      has current endpoint/runtime anti-malware protection; review evidence is
      retained privately.
- [ ] MFA is enabled and tested for Amazon, Cloudflare, Render, GitHub,
      Hostinger/domain DNS, and the support mailbox. Only named approved users
      can access each service.
- [ ] The private operating runbook names the IMPOC, Technical Lead, and
      Communications Owner, with current contact methods and escalation path.
- [ ] A tabletop incident exercise and a six-month plan review are completed,
      including the process to notify `security@amazon.com` within 24 hours.
- [ ] Production and development credentials are separate; no public flag is
      enabled until Amazon approves the Developer Profile and the production
      OAuth flow is configured.
- [ ] The custom domain, privacy policy, terms, security page, data deletion
      page, support email, and all public links return successfully over HTTPS.

Do not answer affirmatively for a control merely because it is planned or
partially implemented. The source-level controls are documented in
`docs/security-controls.md`; operational proof belongs in the private runbook.
