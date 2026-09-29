# ScannerAz inventory ledger

## Purpose

The inventory ledger records stock movements per ScannerAz tenant. It keeps
purchase invoices, Amazon sales, Amazon customer returns, and retailer return
shipments separate so a unit is never counted twice.

## First release

- Register an invoice with retailer, invoice number, date, currency, and one
  or more line items.
- Add purchase movements for each invoice line at its unit cost and condition.
- Register manual sales as outbound inventory movements.
- Track Amazon customer returns as restocked, pending inspection, or disposed.
- Track Walmart or another retailer return as an outbound movement until it is
  marked refunded or returned to stock.
- Show current units, average purchase cost, recent activity, and pending
  returns only to the authenticated tenant that owns the data.

The invoice record intentionally stores invoice metadata and line items first.
The Render filesystem is ephemeral, so invoice PDFs and photos must not be
stored there. A later attachment/OCR phase should use private object storage
with signed uploads and a human confirmation step before inventory is posted.

## Ledger rules

| Event | Inventory effect |
| --- | --- |
| Purchase invoice | Adds units |
| Amazon sale | Removes units |
| Amazon customer return restocked | Adds units in its selected condition |
| Amazon customer return pending or disposed | Does not add sellable units |
| Retailer return sent | Removes units |
| Retailer return rejected and received back | Adds units |
| Retailer return refunded | No additional unit movement |

## Amazon synchronization

The initial ledger accepts manual sales and return entries. Automated Amazon
sales and return synchronization must be added only after ScannerAz requests
and receives the required Amazon role for the exact operation. Do not request
buyer, recipient, or shipping data when inventory movement data alone is
sufficient. The sync will use the minimum fields necessary and keep buyer PII
out of ScannerAz.
