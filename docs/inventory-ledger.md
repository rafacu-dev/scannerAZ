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

## Invoice extraction

An authenticated tenant can attach a PDF, JPG, PNG, or WEBP invoice. The API
validates the file signature in memory and sends it to the configured model to
create a structured draft containing the supplier, invoice date and time,
invoice number, each product line, identifiers (SKU, UPC, and ASIN when
visible), quantities, unit and line prices, subtotal, tax, discounts, shipping,
other charges, total, currency, and warnings.

The document itself is never written to Render's ephemeral filesystem or the
database in this first release. After analysis its bytes are discarded; the
database retains only the reviewable structured draft, source metadata, and a
SHA-256 digest used to avoid analyzing the exact same document twice. The user
must review and explicitly confirm the draft before any purchase movement is
created. Confirmation records the extraction ID against the resulting invoice,
which preserves the extracted invoice-wide amounts and time for audit.

`OPENAI_API_KEY` is a Render-only secret. The mobile app never receives it.
`OPENAI_INVOICE_MODEL` defaults to `gpt-4o-mini` and can be changed on Render
when a higher-accuracy model is appropriate. The API rate-limits analysis per
tenant to control accidental repeat requests and cost.

To retain original PDFs/photos for audit or accounting, add private object
storage (for example R2/S3) with tenant-scoped signed uploads and short-lived
signed reads. Do not use the Render filesystem for that purpose.

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
