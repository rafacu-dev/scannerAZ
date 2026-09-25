# ScannerAz public Developer Profile draft

## Purpose

This is the working draft for a **public** Amazon Selling Partner API (SP-API)
Developer Profile for ScannerAz. It is not a submission script. Complete every
unchecked production prerequisite before answering a security question in the
Amazon portal.

ScannerAz is operated by **DRECOM LLC**, an active Florida limited liability
company. Keep the company's legal-contact details in the portal, not in this
repository.

## Product classification and initial roles

- Developer type: **Public developer**.
- Application type: **Public application**.
- Application name: **ScannerAz**.
- Initial roles: **Product Listing** and **Pricing** only.
- Do not request Orders, Buyer Communication, Direct-to-Consumer Shipping,
  Finance and Accounting, Inventory and Order Tracking, Merchant Fulfillment,
  Notifications, Selling Partner Insights, Tax Remittance, or any other role
  until a feature requires it and its data-protection review is complete.

## Website to provide during registration

Temporary review URL while the custom domain is being configured:

`https://scanneraz-api.onrender.com/scanneraz/`

The site describes ScannerAz, DRECOM LLC, product scope, pricing, privacy,
security, support, and data deletion. Before Appstore launch, replace this
temporary URL with the production company subdomain and verify every page is
publicly reachable over HTTPS.

## Contact information

Use the legal company information that DRECOM LLC controls:

- Organization name: `DRECOM LLC`
- Country: `United States`
- Website: the verified ScannerAz public URL above
- Primary contact, email, and phone: use a monitored company-controlled
  support contact, not a personal or temporary contact

Do not put a home address, personal credentials, Amazon tokens, or cloud
secrets in this repository or in a public support request.

## Draft business activity

Use only after the supporting controls below are active:

> ScannerAz is a mobile product-research application for Amazon selling
> partners. It helps an authorized seller match retail products to Amazon
> catalog records, review listing eligibility, and evaluate seller-facing
> offer and pricing signals before making a sourcing decision. ScannerAz does
> not process buyer, order, payment, tax, messaging, or shipping data in its
> initial release.

## Draft use case

Use only after the supporting controls below are active:

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

## Security-answer gate

Amazon previously rejected the profile because the evidence for network
controls and incident response was insufficient. Do not answer **Yes** to
these controls until all evidence exists and has an owner.

- [ ] A WAF or firewall protects the public API and HTTPS is enforced.
- [ ] Threat detection or IDS/IPS-equivalent monitoring is enabled, with
      alert recipients and retained evidence.
- [ ] Runtime or endpoint anti-malware protection covers every system that
      processes Amazon Information.
- [ ] Production is segmented from development, with a private managed token
      store and production secrets in a managed secret manager.
- [ ] Administrator MFA is enabled for Amazon, cloud hosting, source control,
      and deployment accounts.
- [ ] The incident response plan has named private contacts, a documented
      tabletop exercise, a six-month review schedule, and a process to begin
      Amazon notification within 24 hours of an incident involving Amazon
      Information.
- [ ] ScannerAz user authentication, tenant ownership checks, and a seller
      disconnect workflow are implemented before any external seller can
      connect.
- [ ] A direct, monitored public support channel is published on the ScannerAz
      website.

Until every item above is true, the truthful answer is that the control is not
yet fully implemented. The current source-level controls are documented in
`docs/security-controls.md`; the resubmission evidence list is in
`docs/amazon-sp-api-security-remediation.md`.

## Outside parties and data processing

When Amazon asks about external parties, list only vendors that actually
receive, process, or store Amazon Information in the production architecture.
For each vendor, retain a private record of the legal name, service used, data
category, location or processing region, security review, and contract or
terms reference.

At the time of this draft, the public website is hosted on Render, but public
seller connections are intentionally disabled. Do not state that Render or
any other vendor processes Amazon Information until the production token store
and Amazon integration are enabled.

## Submission sequence

1. Configure the production architecture and collect the evidence listed in
   `docs/amazon-sp-api-security-remediation.md`.
2. Implement ScannerAz end-user authentication, tenant ownership, and seller
   connection management as described in `docs/public-sp-api-product-plan.md`.
3. Publish the verified public ScannerAz domain and a direct monitored support
   channel.
4. Update the Developer Profile at Amazon Seller Central with truthful
   security answers and submit a **new** profile request; do not reopen the
   rejected case.
5. After approval, register/configure the production app, OAuth redirect URI,
   LWA credentials, and the two minimal SP-API roles.
6. Complete Amazon's public-app and Appstore review, then begin with a
   limited pilot before broad commercial availability.
