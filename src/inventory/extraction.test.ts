import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInvoiceExtractionGatewayRequest,
  buildInvoiceReferenceGatewayRequest,
  detectInvoiceMimeType,
  invoiceDocumentSha256,
  isSupportedInvoiceMimeType,
  normalizeExtractedInvoiceDraft
} from "./extraction.js";

test("recognizes the invoice document formats accepted by the extractor", () => {
  assert.equal(detectInvoiceMimeType(Buffer.from("%PDF-1.7\ninvoice")), "application/pdf");
  assert.equal(detectInvoiceMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(
    detectInvoiceMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/png"
  );
  assert.equal(detectInvoiceMimeType(Buffer.from("RIFF0000WEBPVP8 ")), "image/webp");
});

test("does not accept an arbitrary upload based on its declared file name or MIME type", () => {
  assert.equal(detectInvoiceMimeType(Buffer.from("not an image or PDF")), undefined);
  assert.equal(isSupportedInvoiceMimeType("application/pdf"), true);
  assert.equal(isSupportedInvoiceMimeType("image/heic"), false);
});

test("uses a stable digest to avoid repeated model analyses for the same invoice", () => {
  const document = Buffer.from("%PDF-1.7\ninvoice body");
  assert.equal(invoiceDocumentSha256(document), invoiceDocumentSha256(Buffer.from(document)));
  assert.notEqual(invoiceDocumentSha256(document), invoiceDocumentSha256(Buffer.from("%PDF-1.7\nother")));
});

test("builds a bounded Warasoft Responses request for a reviewable invoice draft", () => {
  const request = buildInvoiceExtractionGatewayRequest({
    filename: "receipt.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  }, "gpt-4o-mini");

  assert.equal(request.model, "gpt-4o-mini");
  assert.equal(request.max_output_tokens, 4_096);
  const document = request.input[1]?.content[0];
  assert.equal(document?.type, "input_image");
  assert.ok(document && "image_url" in document);
  assert.match(String(document.image_url), /^data:image\/jpeg;base64,/);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
});

test("uses a focused second pass for a retail receipt reference", () => {
  const request = buildInvoiceReferenceGatewayRequest({
    filename: "receipt.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\nreceipt")
  }, "gpt-4o-mini");

  assert.equal(request.max_output_tokens, 800);
  const prompt = request.input[0]?.content[0];
  assert.ok(prompt && "text" in prompt);
  assert.match(String(prompt.text), /TC#/);
  const document = request.input[1]?.content[0];
  assert.equal(document?.type, "input_file");
  assert.ok(document && "file_data" in document);
  assert.match(String(document.file_data), /^data:application\/pdf;base64,/);
});

test("moves a retail UPC out of a generic numeric SKU field", () => {
  const draft = normalizeExtractedInvoiceDraft({
    lines: [{
      title: "ELECSKILLET",
      quantity: 1,
      sku: "082948619534",
      unitCostCents: 5900
    }],
    warnings: []
  });

  assert.deepEqual(draft.lines[0], {
    title: "ELECSKILLET",
    quantity: 1,
    upc: "082948619534",
    unitCostCents: 5900,
    lineTotalCents: undefined,
    taxCents: undefined,
    discountCents: undefined,
    sku: undefined,
    asin: undefined
  });
});

test("uses a readable receipt barcode as the purchase reference when needed", () => {
  const draft = normalizeExtractedInvoiceDraft({
    invoiceBarcode: "TC-1610445422293821871",
    lines: [],
    warnings: []
  });

  assert.equal(draft.invoiceNumber, "TC-1610445422293821871");
  assert.equal(draft.invoiceReferenceLabel, "Código de barras");
});

test("groups repeated receipt lines with the same product and unit price", () => {
  const draft = normalizeExtractedInvoiceDraft({
    lines: [
      { title: "Cinta de montaje", quantity: 1, upc: "012345678905", unitCostCents: 599 },
      { title: "Cinta de montaje", quantity: 2, upc: "012345678905", unitCostCents: 599 }
    ],
    warnings: []
  });

  assert.equal(draft.lines.length, 1);
  assert.equal(draft.lines[0]?.quantity, 3);
});

test("keeps repeated products separate when their prices differ", () => {
  const draft = normalizeExtractedInvoiceDraft({
    lines: [
      { title: "Cinta de montaje", quantity: 1, upc: "012345678905", unitCostCents: 599 },
      { title: "Cinta de montaje", quantity: 1, upc: "012345678905", unitCostCents: 699 }
    ],
    warnings: []
  });

  assert.equal(draft.lines.length, 2);
});
