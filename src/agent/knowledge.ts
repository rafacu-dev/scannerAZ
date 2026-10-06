/**
 * Built-in Amazon seller knowledge for the SellerAI agent, so it can answer
 * policy and troubleshooting questions without external lookups. Policies
 * change: the agent must present this as general guidance and point to
 * Seller Central Help for the authoritative, current rule.
 */
export const sellerKnowledge = `
AMAZON SELLER KNOWLEDGE (general guidance; always suggest confirming the current rule in Seller Central > Help or Account Health)

Account health targets (Seller Central > Performance > Account Health):
- Order Defect Rate (ODR: negative feedback + A-to-z claims + chargebacks) under 1%.
- Pre-fulfillment cancel rate under 2.5% (FBM). Late shipment rate under 4% (FBM). Valid tracking rate above 95% (FBM).
- Policy violations (IP complaints, authenticity, safety, restricted products) weigh heavily on the Account Health Rating; keep it "Healthy".
- Respond to buyer messages within 24 hours. Missing these targets can lead to warnings, loss of the Buy Box or deactivation.

Deactivation / suspension and appeals:
- Amazon asks for an appeal or Plan of Action (POA): 1) root cause, 2) corrective actions already taken, 3) preventive measures. Be specific and factual, no blaming.
- Authenticity / counterfeit / "inauthentic" complaints usually require supplier invoices (manufacturer or authorized distributor) matching the units sold. Retail receipts are often rejected.
- IP complaints (trademark, copyright, patent): contact the rights owner for a retraction or prove the complaint is invalid; repeated IP complaints risk deactivation.

Restricted and gated products:
- Some categories, brands and ASINs need approval ("You need approval to list", "listing limitations apply"). Request it from the listing page or Add a Product.
- Ungating typically needs invoices from a manufacturer or distributor, dated within the last 180 days, showing a meaningful quantity (often at least 10 units), with supplier and seller names/addresses that match. Retail receipts usually do not work.
- Hazmat/dangerous goods may need a Safety Data Sheet and review before FBA. Some products are prohibited entirely (recalled, illegal, unsafe).

Drop shipping policy (important for SellerAI's Dropship tool):
- Allowed only if you are the seller of record: your name on packing slips, invoices and external packaging, you accept and process returns, and you remove any third-party seller identification.
- NOT allowed: buying from another online retailer (e.g., Walmart, Target) and having that retailer ship directly to the Amazon customer. This "retail-to-customer" drop shipping risks suspension.
- Safe pattern: buy from the retailer, receive the goods yourself (or at your prep center), then ship or send them to FBA.

Condition and listing rules:
- Sell "New" only if the item is brand new, unused, in original packaging, with any warranty intact. Otherwise use the proper Used/Collectible condition when allowed for that category.
- Match the existing ASIN exactly (brand, model, size, pack quantity). Creating duplicate listings or mismatched bundles is a policy violation.
- Listings can be suppressed for missing images/attributes, title issues or pricing errors; fix them in Inventory > Fix Your Products / Improve listing quality.

Pricing and Buy Box (Featured Offer):
- Buy Box eligibility depends on price (including shipping), fulfillment method (FBA usually wins ties), seller performance, stock availability and delivery speed.
- Amazon may suppress the Buy Box or deactivate a listing if the price is much higher than recent prices on or off Amazon (Fair Pricing Policy) or if it looks like a pricing error.
- Repricing is allowed. Always set a minimum price that covers cost + fees + shipping to avoid selling at a loss or racing to the bottom.
- Brands may enforce MAP privately; Amazon itself does not enforce MAP, but the brand can file complaints.

Fees and money:
- Main fees: referral fee (usually about 8-15% depending on category), FBA fulfillment fee per unit, monthly storage, possible aged-inventory surcharges and low-inventory fees, closing fee on media.
- Funds from orders are held until the delivery date plus 7 days (DD+7) before becoming available (Account Level Reserve). SellerAI's Finance tab shows these release dates.
- In most US states Amazon collects and remits sales tax as marketplace facilitator.

FBA basics:
- Each unit needs a scannable barcode (FNSKU label or manufacturer barcode if eligible); follow prep and packaging requirements (poly bags, bubble wrap, suffocation warnings).
- Capacity limits restrict how much you can send; sell-through and the Inventory Performance Index (IPI) influence them.
- Stranded inventory = units in FBA without an active offer; fix the listing or create a removal order.
- Dated products need enough remaining shelf life when received (commonly 105+ days).
- Customer returns for FBA come back to your inventory if sellable; otherwise they are marked unfulfillable and you can request removal or reimbursement when Amazon is at fault.

Customer issues:
- A-to-z Guarantee claims: respond quickly with tracking and proof; refunding proactively avoids ODR hits.
- Negative feedback can only be removed if it is a product review, contains obscene language/personal info, or is about an FBA fulfillment issue (Amazon strikes it).
- Never ask for positive reviews in exchange for anything, nor contact buyers outside allowed message types. Review manipulation leads to suspension.
- Standard returns window is 30 days for most items; FBM sellers must offer prepaid returns for eligible orders.

Common problems and first checks:
- "Listing not eligible / needs approval": check category/brand gating, request approval, prepare distributor invoices.
- "Lost the Buy Box": compare price + shipping with the featured offer, check stock, account health and if Amazon itself is selling.
- "Repricer stuck at minimum": competitors are below your floor; review costs, consider lowering the minimum only if still profitable, or wait.
- "Listing suppressed / inactive": open Inventory > Fix Your Products, add missing info or correct the price.
- "Funds on hold": normal DD+7 reserve; larger holds follow account health issues or new accounts.
- "Units stranded or unfulfillable": fix the offer or create a removal order; request reimbursement for lost/damaged FBA units.
- "Account health warning": read the notice, act on the specific item, submit an appeal/POA if requested.
`.trim();
