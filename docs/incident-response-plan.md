# Incident response plan

## Scope

This plan covers security incidents involving ScannerAz systems that store, process, transmit, or access Amazon Information through Amazon SP-API.

## Incident response roles

- Incident Management Point of Contact: company owner/operator.
- Technical Lead: application maintainer.
- Communications Owner: company owner/operator.

For the current bootstrap phase, these roles may be held by the same person.

Each role must have a current contact method recorded in the private operating
runbook. The Communications Owner is responsible for opening the Amazon case
or sending the required notification; the Technical Lead is responsible for
containment and evidence preservation.

## Incident types

- Exposed API credentials.
- Exposed Amazon refresh token.
- Unauthorized access to application data.
- Unauthorized access to infrastructure.
- Accidental logging of secrets.
- Malicious traffic or suspected compromise.
- Loss of device containing Amazon Information or credentials.

## Response procedure

1. Identify the incident and affected systems.
2. Contain the issue:
   - disable compromised credentials
   - revoke affected refresh tokens
   - block suspicious access
   - take affected services offline if needed
3. Preserve evidence:
   - timestamps
   - logs
   - impacted accounts
   - affected endpoints
4. Assess whether Amazon Information was exposed.
5. Notify `security@amazon.com` within 24 hours of detecting a security incident involving Amazon Information. The Communications Owner records the delivery time and any Amazon case identifier in the private incident record.
6. Notify other parties or regulators if required by law.
7. Remediate the root cause.
8. Document the incident, remediation, and preventive control changes.
9. Review access keys, tokens, logs, and deployments before restoring normal operations.

## Review schedule

This incident response plan must be reviewed every 6 months and after any major system, infrastructure, permission, or data handling change.

Each review must record the date, reviewer, changes made, tabletop exercise
result, and any follow-up owner. Keep the review record in the private
operating runbook; do not store credentials or incident evidence in this repo.

## Amazon notification

If Amazon Information is affected, the Communications Owner sends the initial
notification to `security@amazon.com` within 24 hours of detection and uses
any additional current channel specified by Amazon's Data Protection Policy or
Solution Provider Portal. The private incident record must retain the delivery
timestamp and any Amazon case identifier.

The notification should include:

- company name
- application name
- incident detection timestamp
- summary of affected Amazon Information
- containment actions taken
- current remediation status
- incident point of contact
