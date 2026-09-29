import express from "express";
import multer, { MulterError } from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { config } from "../config.js";
import {
  detectInvoiceMimeType,
  extractInvoiceDocument,
  invoiceDocumentSha256,
  InvoiceExtractionDocumentError,
  InvoiceExtractionProviderError,
  InvoiceExtractionUnavailableError
} from "./extraction.js";
import {
  confirmInvoiceExtraction,
  createInventoryInvoice,
  DuplicateInventoryInvoiceError,
  findInvoiceExtractionByDocumentHash,
  getInventoryOverview,
  InsufficientInventoryError,
  InventoryExtractionNotFoundError,
  InvalidInventoryReturnResolutionError,
  InventoryProductNotFoundError,
  InventoryReturnNotFoundError,
  recordAmazonCustomerReturn,
  recordInventorySale,
  recordRetailerReturn,
  resolveInventoryReturn,
  saveInvoiceExtraction,
  type InventoryCondition
} from "./store.js";

export const inventoryRouter = express.Router();

const invoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: config.INVOICE_EXTRACTION_MAX_FILE_BYTES,
    fields: 4
  }
});

const invoiceExtractionRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 6,
  legacyHeaders: false,
  standardHeaders: true,
  keyGenerator: (req) => req.scannerazTenantSession?.tenantId ?? "missing-tenant",
  handler: (_req, res) => {
    res.status(429).json({ error: "Has alcanzado el limite temporal de analisis de facturas." });
  }
});

const conditionSchema = z.enum([
  "new",
  "used_like_new",
  "used_good",
  "used_acceptable",
  "unsellable"
]);
const optionalText = z.string().trim().max(500).optional().transform((value) => value || undefined);
const optionalReference = z.string().trim().max(160).optional().transform((value) => value || undefined);
const occurredAtSchema = z.string().datetime().optional();

const invoiceSchema = z.object({
  retailer: z.string().trim().min(1).max(100),
  invoiceNumber: optionalReference,
  purchasedAt: occurredAtSchema,
  currency: z.string().trim().length(3).default("USD"),
  notes: optionalText,
  documentName: z.string().trim().max(255).optional().transform((value) => value || undefined),
  lines: z.array(z.object({
    title: z.string().trim().min(1).max(500),
    quantity: z.coerce.number().int().positive().max(100000),
    unitCostCents: z.coerce.number().int().nonnegative().max(100000000),
    condition: conditionSchema.default("new"),
    sku: optionalReference,
    asin: optionalReference,
    upc: optionalReference,
    imageUrl: z.string().url().max(2000).optional()
  })).min(1).max(100)
});

const saleSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().int().positive().max(100000),
  condition: conditionSchema.default("new"),
  channel: z.string().trim().min(1).max(100).optional(),
  reference: optionalReference,
  notes: optionalText,
  occurredAt: occurredAtSchema
});

const amazonReturnSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().int().positive().max(100000),
  condition: conditionSchema,
  disposition: z.enum(["restock", "hold", "dispose"]),
  reference: optionalReference,
  notes: optionalText,
  occurredAt: occurredAtSchema
});

const retailerReturnSchema = z.object({
  productId: z.string().uuid(),
  retailer: z.string().trim().min(1).max(100),
  quantity: z.coerce.number().int().positive().max(100000),
  condition: conditionSchema.default("new"),
  reference: optionalReference,
  notes: optionalText,
  occurredAt: occurredAtSchema
});

const resolveReturnSchema = z.object({
  disposition: z.enum(["restock", "dispose", "refund", "return_to_stock"]),
  condition: conditionSchema.optional(),
  notes: optionalText
});

inventoryRouter.get("/overview", async (req, res, next) => {
  try {
    res.json(await getInventoryOverview(requireTenantId(req)));
  } catch (error) {
    next(error);
  }
});

inventoryRouter.post("/invoices", async (req, res, next) => {
  try {
    const invoice = await createInventoryInvoice(requireTenantId(req), invoiceSchema.parse(req.body));
    res.status(201).json({ invoice });
  } catch (error) {
    respondToInventoryError(error, res, next);
  }
});

inventoryRouter.post("/invoice-extractions", invoiceExtractionRateLimit, async (req, res, next) => {
  let file: Express.Multer.File | undefined;

  try {
    const tenantId = requireTenantId(req);
    file = await parseInvoiceUpload(req, res);
    const documentSha256 = invoiceDocumentSha256(file.buffer);
    const mimeType = detectInvoiceMimeType(file.buffer);

    if (!mimeType) {
      throw new InvoiceExtractionDocumentError("Usa un PDF, JPG, PNG o WEBP valido para analizar la factura.");
    }

    const existing = await findInvoiceExtractionByDocumentHash(tenantId, documentSha256);

    if (existing) {
      res.json({ extraction: existing, reused: true });
      return;
    }

    const extracted = await extractInvoiceDocument({
      filename: safeFilename(file.originalname),
      mimeType,
      buffer: file.buffer
    });
    const extraction = await saveInvoiceExtraction(tenantId, {
      sourceFilename: safeFilename(file.originalname),
      mimeType,
      sizeBytes: file.size,
      documentSha256: extracted.documentSha256,
      model: extracted.model,
      draft: extracted.draft
    });
    res.status(201).json({ extraction });
  } catch (error) {
    respondToInventoryError(error, res, next);
  } finally {
    // Multer is memory-only here. Do not retain an invoice in Node memory once
    // the extraction response has been created.
    file?.buffer.fill(0);
  }
});

inventoryRouter.post("/invoice-extractions/:extractionId/confirm", async (req, res, next) => {
  try {
    const result = await confirmInvoiceExtraction(requireTenantId(req), {
      extractionId: z.string().uuid().parse(req.params.extractionId),
      invoice: invoiceSchema.parse(req.body)
    });
    res.status(201).json(result);
  } catch (error) {
    respondToInventoryError(error, res, next);
  }
});

inventoryRouter.post("/sales", async (req, res, next) => {
  try {
    const activity = await recordInventorySale(requireTenantId(req), saleSchema.parse(req.body));
    res.status(201).json({ activity });
  } catch (error) {
    respondToInventoryError(error, res, next);
  }
});

inventoryRouter.post("/returns/amazon", async (req, res, next) => {
  try {
    const returnCase = await recordAmazonCustomerReturn(requireTenantId(req), amazonReturnSchema.parse(req.body));
    res.status(201).json({ return: returnCase });
  } catch (error) {
    respondToInventoryError(error, res, next);
  }
});

inventoryRouter.post("/returns/retailer", async (req, res, next) => {
  try {
    const returnCase = await recordRetailerReturn(requireTenantId(req), retailerReturnSchema.parse(req.body));
    res.status(201).json({ return: returnCase });
  } catch (error) {
    respondToInventoryError(error, res, next);
  }
});

inventoryRouter.post("/returns/:returnId/resolve", async (req, res, next) => {
  try {
    const input = resolveReturnSchema.parse(req.body);
    const returnCase = await resolveInventoryReturn(requireTenantId(req), {
      returnId: z.string().uuid().parse(req.params.returnId),
      disposition: input.disposition,
      condition: input.condition as InventoryCondition | undefined,
      notes: input.notes
    });
    res.json({ return: returnCase });
  } catch (error) {
    respondToInventoryError(error, res, next);
  }
});

function requireTenantId(req: express.Request) {
  const tenantId = req.scannerazTenantSession?.tenantId;

  if (!tenantId) {
    throw new Error("Tenant session middleware is required for inventory routes");
  }

  return tenantId;
}

function respondToInventoryError(
  error: unknown,
  res: express.Response,
  next: express.NextFunction
) {
  if (error instanceof MulterError) {
    res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error: error.code === "LIMIT_FILE_SIZE"
        ? "La factura excede el tamano permitido."
        : "Solo puedes adjuntar un documento de factura."
    });
    return;
  }

  if (error instanceof InvoiceExtractionUnavailableError) {
    res.status(503).json({ error: error.message });
    return;
  }

  if (error instanceof InvoiceExtractionDocumentError) {
    res.status(422).json({ error: error.message });
    return;
  }

  if (error instanceof InvoiceExtractionProviderError) {
    res.status(502).json({ error: error.message });
    return;
  }

  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Los datos de inventario no son validos." });
    return;
  }

  if (error instanceof DuplicateInventoryInvoiceError) {
    res.status(409).json({ error: error.message });
    return;
  }

  if (
    error instanceof InventoryProductNotFoundError ||
    error instanceof InventoryReturnNotFoundError ||
    error instanceof InventoryExtractionNotFoundError
  ) {
    res.status(404).json({ error: error.message });
    return;
  }

  if (error instanceof InsufficientInventoryError || error instanceof InvalidInventoryReturnResolutionError) {
    res.status(409).json({ error: error.message });
    return;
  }

  next(error);
}

function parseInvoiceUpload(req: express.Request, res: express.Response) {
  return new Promise<Express.Multer.File>((resolve, reject) => {
    invoiceUpload.single("document")(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }

      if (!req.file) {
        reject(new InvoiceExtractionDocumentError("Adjunta un PDF, imagen o foto de la factura."));
        return;
      }

      resolve(req.file);
    });
  });
}

function safeFilename(value: string) {
  const filename = value.replace(/[\\/\u0000-\u001f]/g, " ").trim().slice(0, 255);
  return filename || "factura";
}
