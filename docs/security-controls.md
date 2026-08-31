# Security controls for Amazon SP-API access

## Scope

ScannerAz will access Amazon Selling Partner API only for authorized seller accounts. The initial use is product research, catalog matching, pricing review, and listing eligibility checks.

ScannerAz does not request buyer personal information, order data, payment data, buyer communication, or tax data.

## Network security controls

Production deployment must implement:

- HTTPS/TLS 1.2 or higher for all public traffic.
- Cloud firewall/security groups allowing only required inbound ports.
- WAF or equivalent application-layer protection for public endpoints.
- IDS/IPS or cloud-native threat detection where available.
- Malware protection or cloud-native runtime protection on systems that process Amazon Information.
- Separate production secrets from local development secrets.
- No direct public access to databases or token storage.

## Access controls

- Access to Amazon Information is limited to authorized users with business need.
- Programmatic credentials are stored in environment variables or secret storage.
- Refresh tokens are encrypted at rest.
- `.env`, token files, and local `data/` are excluded from source control.
- Administrative access requires strong passwords and MFA.

## Encryption

- Amazon Information transmitted over public networks must use HTTPS/TLS 1.2 or higher.
- Amazon refresh tokens are encrypted at rest using AES-256-GCM in local development.
- Production should use managed secret storage or encrypted database fields.

## Credential management

- No Amazon passwords are stored.
- No Seller Central cookies are stored.
- No Amazon credentials are committed to source control.
- API credentials are rotated at least annually or immediately upon suspected compromise.

## Logging

- Logs must not include access tokens, refresh tokens, client secrets, AWS secret keys, or full authorization headers.
- API errors may be logged with request id, endpoint, timestamp, and non-sensitive status details.

## Data sharing

Amazon Information is not shared with outside parties except infrastructure providers required to operate the application.

Retail product data from public retail websites may be used only for product research and comparison.
