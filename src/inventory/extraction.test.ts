import assert from "node:assert/strict";
import test from "node:test";
import {
  detectInvoiceMimeType,
  invoiceDocumentSha256,
  isSupportedInvoiceMimeType
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
