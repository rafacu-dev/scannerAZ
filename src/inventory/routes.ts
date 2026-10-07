import express from "express";
import multer, { MulterError } from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { assertAmazonSpApiConfig, config } from "../config.js";
import { getAmazonConnectionForTenant, listAmazonConnectionsForTenant } from "../storage/connections.js";
import {
  AmazonOrdersRequestError,
  getLwaAccessToken,
  normalizeCatalogSearchResponse,
  searchCatalogItems,
} from "../amazon/spapi.js";
import {
  detectInvoiceMimeType,
  extractInvoiceDocument,
  invoiceDocumentSha256,
  InvoiceExtractionDocumentError,
  InvoiceExtractionProviderError,
  InvoiceExtractionUnavailableError
} from "./extraction.js";
import {
  AmazonSalesSyncInProgressError,
  confirmInvoiceExtraction,
  createInventoryInvoice,
  DuplicateInventoryInvoiceError,
  findInvoiceExtractionByDocumentHash,
  getAmazonSalesSyncState,
  getInventoryOverview,
  listInventoryInvoices,
  getInventoryInvoice,
  deleteInventoryInvoice,
  InventoryInvoiceInUseError,
  InventoryInvoiceNotFoundError,
  saveInventoryProductImages,
  resolveInventoryNameMappings,
  saveInventoryProductLink,
  recordInventoryAdjustment,
  InsufficientInventoryError,
  InventoryExtractionNotFoundError,
  InvalidInventoryReturnResolutionError,
  InventoryProductNotFoundError,
  InventoryReturnNotFoundError,
  recordAmazonCustomerReturn,
  recordInventorySale,
  recordRetailerReturn,
  refreshPendingInvoiceExtraction,
  resolveInventoryAsinMappings,
  resolveInventoryReturn,
  saveInvoiceExtraction,
  type InventoryCondition
} from "./store.js";
import { syncAmazonSalesForConnection } from "./amazonSalesSync.js";

export const inventoryRouter = express.Router();

const invoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: config.INVOICE_EXTRACTION_MAX_FILE_BYTES,
    fields: 4
  }
});

// searchOrders has a conservative default usage plan. A tenant can continue a
// paginated sync, but cannot turn the action into a rapid polling loop.
// The app syncs every linked store when Inventory opens; allow a few stores.
const amazonSalesSyncRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  legacyHeaders: false,
  standardHeaders: true,
  keyGenerator: (req) => req.scannerazTenantSession?.tenantId ?? "missing-tenant",
  handler: (_req, res) => {
    res.status(429).json({ error: "Espera un momento antes de volver a sincronizar ventas de Amazon." });
  }
});

// Catalog lookups happen while reviewing a receipt. Keep the batch endpoint
// bounded so a malformed invoice cannot fan out into an unbounded SP-API job.
const invoiceAsinResolutionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  legacyHeaders: false,
  standardHeaders: true,
  keyGenerator: (req) => req.scannerazTenantSession?.tenantId ?? "missing-tenant",
  handler: (_req, res) => {
    res.status(429).json({ error: "Espera un momento antes de volver a vincular UPCs con Amazon." });
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
const requiredInvoiceReference = z.string().trim().min(1).max(160);
const occurredAtSchema = z.string().datetime().optional();
const amazonSalesSyncSchema = z.object({
  // A first sync defaults to ninety days. Amazon keeps order history for a
  // limited period, and selecting a smaller initial window avoids an expensive
  // surprise for a new seller account.
  from: z.string().datetime().optional()
});

const invoiceSchema = z.object({
  retailer: z.string().trim().min(1).max(100),
  invoiceNumber: requiredInvoiceReference,
  invoiceBarcode: optionalReference,
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

const asinMappingResolutionSchema = z.object({
  connectionId: z.string().trim().min(1).max(200).optional(),
  upcs: z.array(z.string().trim().min(1).max(64)).min(1).max(100)
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

const adjustmentSchema = z.object({
  productId: z.string().uuid(),
  mode: z.enum(["add", "remove", "count"]),
  quantity: z.coerce.number().int().min(-100000).max(100000),
  condition: conditionSchema.optional(),
  unitCostCents: z.coerce.number().int().min(0).max(100000000).optional(),
  reason: z.string().trim().max(200).optional(),
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
    const tenantId = requireTenantId(req);
    const overview = await getInventoryOverview(tenantId);
    res.json(await attachMissingProductImages(tenantId, overview));
  } catch (error) {
    next(error);
  }
});

/**
 * Products created from receipts usually have no image. Look up to 20 of
 * them by ASIN in Catalog Items once and store the image, so stock is easy
 * to recognize. Best-effort: the overview is returned either way.
 */
async function attachMissingProductImages(
  tenantId: string,
  overview: Awaited<ReturnType<typeof getInventoryOverview>>
) {
  const missing = overview.products
    .filter((product) => !product.imageUrl && product.asin && /^[A-Z0-9]{10}$/i.test(product.asin))
    .slice(0, 20);

  if (!missing.length) {
    return overview;
  }

  try {
    const [first] = await listAmazonConnectionsForTenant(tenantId);
    const connection = first ? await getAmazonConnectionForTenant(first.id, tenantId) : undefined;

    if (!connection) {
      return overview;
    }

    const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
    const asins = [...new Set(missing.map((product) => product.asin!.toUpperCase()))];
    const response = await searchCatalogItems({
      identifiers: asins,
      identifierType: "ASIN",
      refreshToken: connection.refreshToken,
      marketplaceId,
      limit: asins.length,
    });
    const imageByAsin = new Map(
      normalizeCatalogSearchResponse(response, marketplaceId)
        .filter((candidate) => Boolean(candidate.imageUrl))
        .map((candidate) => [candidate.asin.toUpperCase(), candidate.imageUrl!] as const)
    );
    const imageByProductId = new Map(
      missing.flatMap((product) => {
        const imageUrl = imageByAsin.get(product.asin!.toUpperCase());
        return imageUrl ? [[product.id, imageUrl] as const] : [];
      })
    );

    if (!imageByProductId.size) {
      return overview;
    }

    await saveInventoryProductImages(tenantId, imageByProductId);
    return {
      ...overview,
      products: overview.products.map((product) =>
        imageByProductId.has(product.id) ? { ...product, imageUrl: imageByProductId.get(product.id) } : product
      ),
    };
  } catch {
    return overview;
  }
}

inventoryRouter.post("/product-links", async (req, res, next) => {
  try {
    const input = z.object({
      title: z.string().max(500).optional(),
      upc: z.string().max(40).optional(),
      asin: z.string().trim().regex(/^[A-Za-z0-9]{10}$/),
      sku: z.string().max(200).optional(),
      imageUrl: z.string().url().max(2000).optional(),
    }).parse(req.body ?? {});
    await saveInventoryProductLink(requireTenantId(req), { ...input, asin: input.asin.toUpperCase() });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

inventoryRouter.post("/name-mappings/resolve", async (req, res, next) => {
  try {
    const names = z.array(z.string().max(500)).max(200).parse(req.body?.names ?? []);
    res.json({ mappings: await resolveInventoryNameMappings(requireTenantId(req), names) });
  } catch (error) {
    next(error);
  }
});

inventoryRouter.post("/asin-mappings/resolve", invoiceAsinResolutionRateLimit, async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const input = asinMappingResolutionSchema.parse(req.body);
    const upcs = Array.from(new Set(input.upcs
      .map(normalizeInvoiceUpc)
      .filter((value): value is string => Boolean(value))));

    if (!upcs.length) {
      res.status(400).json({ error: "Incluye al menos un UPC valido de 8 a 14 digitos." });
      return;
    }

    const savedMappings = await resolveInventoryAsinMappings(tenantId, upcs);
    const savedByUpc = new Map(savedMappings.map((mapping) => [mapping.upc, mapping]));
    const unresolvedUpcs = upcs.filter((upc) => !savedByUpc.has(upc));
    const catalogCandidates = new Map<string, Map<string, {
      asin: string;
      title?: string;
      imageUrl?: string;
    }>>();
    let connectionAvailable = false;

    if (unresolvedUpcs.length > 0 && input.connectionId) {
      const connection = await getAmazonConnectionForTenant(input.connectionId, tenantId);

      if (!connection) {
        res.status(404).json({ error: "No encontramos esa conexion de Amazon." });
        return;
      }

      assertAmazonSpApiConfig(connection.refreshToken);
      connectionAvailable = true;
      const marketplaceId = connection.marketplaceId || config.AMAZON_MARKETPLACE_ID;
      const accessToken = (await getLwaAccessToken(connection.refreshToken)).access_token;

      for (const identifiers of chunkValues(unresolvedUpcs, 20)) {
        const response = await searchCatalogItems({
          identifiers,
          identifierType: "UPC",
          refreshToken: connection.refreshToken,
          accessToken,
          marketplaceId,
          limit: 20
        });

        for (const candidate of normalizeCatalogSearchResponse(response, marketplaceId)) {
          for (const identifier of candidate.identifiers) {
            if (identifier.type.toUpperCase() !== "UPC") {
              continue;
            }

            const upc = normalizeInvoiceUpc(identifier.value);

            if (!upc || !unresolvedUpcs.includes(upc)) {
              continue;
            }

            const candidatesForUpc = catalogCandidates.get(upc) ?? new Map();
            candidatesForUpc.set(candidate.asin, {
              asin: candidate.asin,
              title: candidate.title,
              imageUrl: candidate.imageUrl
            });
            catalogCandidates.set(upc, candidatesForUpc);
          }
        }
      }
    }

    res.json({
      connectionAvailable,
      results: upcs.map((upc) => {
        const saved = savedByUpc.get(upc);

        if (saved) {
          return saved;
        }

        const candidates = Array.from(catalogCandidates.get(upc)?.values() ?? []);

        if (candidates.length === 1) {
          return { upc, ...candidates[0], source: "amazon_catalog" as const };
        }

        if (candidates.length > 1) {
          return { upc, source: "ambiguous" as const, candidates };
        }

        return { upc, source: "unresolved" as const };
      })
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Los UPCs enviados para vincular no son validos." });
      return;
    }

    next(error);
  }
});

inventoryRouter.get("/amazon-sales/:connectionId/sync-state", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const connectionId = String(req.params.connectionId ?? "").trim();
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "No encontramos esa conexion de Amazon." });
      return;
    }

    res.json({ sync: await getAmazonSalesSyncState(tenantId, connectionId) });
  } catch (error) {
    next(error);
  }
});

inventoryRouter.post("/amazon-sales/:connectionId/sync", amazonSalesSyncRateLimit, async (req, res, next) => {
  const connectionId = String(req.params.connectionId ?? "").trim();
  let tenantId: string | undefined;

  try {
    tenantId = requireTenantId(req);
    const connection = await getAmazonConnectionForTenant(connectionId, tenantId);

    if (!connection) {
      res.status(404).json({ error: "No encontramos esa conexion de Amazon." });
      return;
    }

    const input = amazonSalesSyncSchema.parse(req.body ?? {});
    const now = new Date();
    const from = input.from ? new Date(input.from) : new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const oldestAllowed = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000);

    if (Number.isNaN(from.getTime()) || from > now || from < oldestAllowed) {
      res.status(400).json({ error: "La fecha inicial de ventas debe estar dentro de los ultimos dos anos." });
      return;
    }

    assertAmazonSpApiConfig(connection.refreshToken);
    const result = await syncAmazonSalesForConnection({
      tenantId,
      connectionId,
      refreshToken: connection.refreshToken,
      marketplaceId: connection.marketplaceId,
      from
    });
    res.json({ connectionId, ...result });
  } catch (error) {
    if (error instanceof AmazonSalesSyncInProgressError) {
      res.status(409).json({ error: error.message });
      return;
    }

    if (error instanceof AmazonOrdersRequestError) {
      const authorizationRequired = error.status === 401 || error.status === 403;
      res.status(error.status === 429 ? 429 : authorizationRequired ? 403 : 502).json({
        error: error.status === 429
          ? "Amazon esta limitando la sincronizacion. Espera unos minutos e intenta de nuevo."
          : authorizationRequired
            ? "Amazon necesita que vuelvas a autorizar el acceso a ventas para esta conexion."
            : "Amazon no pudo cargar los pedidos en este momento. Intenta de nuevo en unos minutos.",
        code: authorizationRequired
          ? "amazon_orders_authorization_required"
          : "amazon_orders_sync_unavailable",
        reauthorize: authorizationRequired
      });
      return;
    }

    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "La fecha de sincronizacion no es valida." });
      return;
    }

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

inventoryRouter.post("/invoice-extractions", async (req, res, next) => {
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

    if (existing && (existing.status !== "pending_review" || existing.draft.invoiceNumber)) {
      res.json({ extraction: existing, reused: true });
      return;
    }

    const extracted = await extractInvoiceDocument({
      filename: safeFilename(file.originalname),
      mimeType,
      buffer: file.buffer
    });
    const extraction = existing
      ? await refreshPendingInvoiceExtraction(tenantId, existing.id, {
        sourceFilename: safeFilename(file.originalname),
        mimeType,
        sizeBytes: file.size,
        model: extracted.model,
        draft: extracted.draft
      })
      : await saveInvoiceExtraction(tenantId, {
        sourceFilename: safeFilename(file.originalname),
        mimeType,
        sizeBytes: file.size,
        documentSha256: extracted.documentSha256,
        model: extracted.model,
        draft: extracted.draft
      });

    res.status(existing ? 200 : 201).json({ extraction: extraction ?? existing, refreshed: Boolean(existing) });
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

inventoryRouter.post("/adjustments", async (req, res, next) => {
  try {
    const adjustment = await recordInventoryAdjustment(requireTenantId(req), adjustmentSchema.parse(req.body));
    res.status(201).json({ adjustment });
  } catch (error) {
    respondToInventoryError(error, res, next);
  }
});

inventoryRouter.delete("/invoices/:invoiceId", async (req, res, next) => {
  try {
    await deleteInventoryInvoice(requireTenantId(req), String(req.params.invoiceId ?? ""));
    res.status(204).end();
  } catch (error) {
    if (error instanceof InventoryInvoiceInUseError) {
      res.status(409).json({ error: error.message });
      return;
    }

    if (error instanceof InventoryInvoiceNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }

    next(error);
  }
});

inventoryRouter.get("/invoices/:invoiceId", async (req, res, next) => {
  try {
    const invoice = await getInventoryInvoice(requireTenantId(req), String(req.params.invoiceId ?? ""));

    if (!invoice) {
      res.status(404).json({ error: "Receipt not found" });
      return;
    }

    res.json({ invoice });
  } catch (error) {
    next(error);
  }
});

inventoryRouter.get("/invoices", async (req, res, next) => {
  try {
    res.json({ invoices: await listInventoryInvoices(requireTenantId(req)) });
  } catch (error) {
    next(error);
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

function normalizeInvoiceUpc(value: string) {
  const digits = value.replace(/[^0-9]/g, "");
  return /^\d{8,14}$/.test(digits) ? digits : undefined;
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

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
    res.status(error.statusCode).json({ error: error.message });
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
