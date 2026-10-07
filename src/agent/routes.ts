import express from "express";
import multer, { MulterError } from "multer";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import {
  AgentUnavailableError,
  askAgent,
  clearAgentMessages,
  deleteAgentMemory,
  listAgentMemories,
  listAgentMessages,
  recordAgentNote,
  transcribeVoiceMessage,
  type AgentLocale
} from "./agent.js";
import { getAgentAction, setAgentActionStatus } from "./actions.js";
import { applyAgentAction } from "./tools.js";

export const agentRouter = express.Router();

const maxTextLength = 2000;
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 2 }
});

// Each message costs a model call; keep a person-sized pace per account.
const agentRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  legacyHeaders: false,
  standardHeaders: true,
  keyGenerator: (req) => req.scannerazTenantSession?.tenantId ?? "anonymous",
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many messages. Wait a moment.", code: "rate_limited" });
  }
});

const storefrontAsinSchema = {
  type: "object",
  additionalProperties: false,
  required: ["products", "complete", "note"],
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["asin", "title", "url"],
        properties: {
          asin: { type: "string" },
          title: { type: "string" },
          url: { type: "string" }
        }
      }
    },
    complete: { type: "boolean" },
    note: { type: "string" }
  }
} as const;

function responseText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  if (typeof record.output_text === "string") return record.output_text;
  const responseText = (record.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((item) => typeof item.text === "string" ? item.text : "")
    .join("")
    .trim();
  if (responseText) return responseText;
  return record.choices?.map((choice) => typeof choice.message?.content === "string" ? choice.message.content : "").join("").trim() ?? "";
}

function storefrontUrlFrom(value: unknown) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || !/(^|\.)amazon\.com$/i.test(url.hostname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function askStorefrontAsins(url: string) {
  if (!config.WARASOFT_AI_GATEWAY_URL || !config.WARASOFT_AI_GATEWAY_KEY) {
    throw new AgentUnavailableError("agent_unavailable");
  }

  const pageResponse = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; ScannerAz storefront reader/1.0)"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000)
  });
  const html = await pageResponse.text();
  if (!pageResponse.ok || !html) {
    throw new AgentUnavailableError("agent_unavailable");
  }
  const sourceAsins = [...new Set(html.match(/\b(?:B[A-Z0-9]{9}|[0-9]{10})\b/gi) ?? [])]
    .map((asin) => asin.toUpperCase())
    .slice(0, 500);
  const htmlSnapshot = html.slice(0, 120_000);

  const prompt = "Extract products from the supplied Amazon storefront HTML snapshot. Return only ASINs that appear literally in the supplied HTML or in the candidate list. Never invent ASINs, placeholder titles, or products from memory. Deduplicate ASINs. If the snapshot is incomplete or contains no product cards, set complete to false and explain why in note.";
  const userInput = `Storefront URL: ${url}\nCandidate ASINs extracted literally from HTML: ${JSON.stringify(sourceAsins)}\nHTML snapshot:\n${htmlSnapshot}`;
  const responseUrl = config.WARASOFT_AI_GATEWAY_URL.replace(/responses\/?$/, "chat/completions/");
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Warasoft-AI-Key": config.WARASOFT_AI_GATEWAY_KEY,
      ...(config.WARASOFT_AI_PROJECT ? { "X-Warasoft-Project": String(config.WARASOFT_AI_PROJECT) } : {})
    },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: config.WARASOFT_AI_AGENT_MODEL,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: userInput }
      ],
      max_tokens: 4_096,
      temperature: 0,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 240);
    console.warn(JSON.stringify({ event: "storefront_ai_failed", status: response.status, detail }));
    throw new AgentUnavailableError(response.status === 429 ? "agent_quota_exceeded" : "agent_unavailable");
  }

  const text = responseText(await response.json());
  if (!text) throw new AgentUnavailableError("agent_unavailable");
  const parsed = JSON.parse(text) as { products?: Array<{ asin?: string; title?: string; url?: string }>; complete?: boolean; note?: string };
  const sourceAsinSet = new Set(sourceAsins);
  const products = (parsed.products ?? [])
    .filter((item) => /^(?:B[A-Z0-9]{9}|[0-9]{10})$/.test(item.asin ?? ""))
    .filter((item) => sourceAsinSet.has((item.asin ?? "").toUpperCase()))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.asin === item.asin) === index)
    .slice(0, 100);
  return { url, products, complete: Boolean(parsed.complete), note: String(parsed.note ?? "") };
}

function requireTenantId(req: express.Request) {
  const tenantId = req.scannerazTenantSession?.tenantId;

  if (!tenantId) {
    throw new Error("Tenant session middleware is required for agent routes");
  }

  return tenantId;
}

function localeFrom(value: unknown): AgentLocale {
  return typeof value === "string" && value.toLowerCase().startsWith("en") ? "en" : "es";
}

function sendAgentError(res: express.Response, error: unknown, next: express.NextFunction) {
  if (error instanceof AgentUnavailableError) {
    res.status(error.code === "empty_transcript" ? 422 : 503).json({ error: error.code, code: error.code });
    return;
  }

  next(error);
}

agentRouter.get("/messages", async (req, res, next) => {
  try {
    res.setHeader("cache-control", "no-store");
    // Paged: ?limit=10&before=<createdAt of the oldest message shown>.
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 50);
    const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before))
      ? new Date(req.query.before).toISOString()
      : undefined;
    const messages = await listAgentMessages(requireTenantId(req), limit + 1, before);
    const hasMore = messages.length > limit;
    res.json({ messages: hasMore ? messages.slice(1) : messages, hasMore });
  } catch (error) {
    next(error);
  }
});

agentRouter.delete("/messages", async (req, res, next) => {
  try {
    await clearAgentMessages(requireTenantId(req));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

agentRouter.post("/storefront-asins", agentRateLimit, async (req, res, next) => {
  try {
    const url = storefrontUrlFrom(req.body?.url);
    if (!url) {
      res.status(400).json({ error: "A public Amazon storefront URL is required.", code: "invalid_storefront_url" });
      return;
    }
    res.setHeader("cache-control", "no-store");
    res.json(await askStorefrontAsins(url));
  } catch (error) {
    sendAgentError(res, error, next);
  }
});

// What the agent remembers about this account, so the user can review it.
agentRouter.get("/memories", async (req, res, next) => {
  try {
    res.setHeader("cache-control", "no-store");
    res.json({ memories: await listAgentMemories(requireTenantId(req)) });
  } catch (error) {
    next(error);
  }
});

agentRouter.delete("/memories/:memoryId", async (req, res, next) => {
  try {
    await deleteAgentMemory(requireTenantId(req), String(req.params.memoryId));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// The user confirms or cancels a change the agent proposed.
agentRouter.post("/actions/:actionId/:decision", async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const decision = req.params.decision;
    const action = await getAgentAction(tenantId, String(req.params.actionId));

    if (!action || (decision !== "confirm" && decision !== "cancel")) {
      res.status(404).json({ error: "Action not found", code: "action_not_found" });
      return;
    }

    if (action.status !== "pending") {
      res.status(409).json({ error: "Action already handled", code: "action_handled", status: action.status, result: action.result });
      return;
    }

    const english = localeFrom(req.body?.locale) === "en";

    if (decision === "cancel") {
      await setAgentActionStatus(action, "canceled");
      const note = await recordAgentNote(tenantId, english ? `Canceled: ${action.title} — ${action.detail}` : `Cancelado: ${action.title} — ${action.detail}`);
      res.json({ status: "canceled", note });
      return;
    }

    const outcome = await applyAgentAction({ tenantId, sessionToken: req.scannerazSessionToken ?? "" }, action) as
      { error?: unknown } | undefined;

    if (!outcome || outcome.error) {
      const result = String(outcome?.error ?? "Request failed").slice(0, 200);
      await setAgentActionStatus(action, "failed", result);
      const note = await recordAgentNote(tenantId, english ? `Could not apply: ${action.title} — ${result}` : `No se pudo aplicar: ${action.title} — ${result}`);
      res.status(502).json({ status: "failed", result, note });
      return;
    }

    await setAgentActionStatus(action, "confirmed");
    console.info(JSON.stringify({ event: "agent.action_applied", kind: action.kind }));
    const note = await recordAgentNote(tenantId, english ? `✅ Done: ${action.title} — ${action.detail}` : `✅ Hecho: ${action.title} — ${action.detail}`);
    res.json({ status: "confirmed", note });
  } catch (error) {
    next(error);
  }
});

agentRouter.post("/messages", agentRateLimit, async (req, res, next) => {
  try {
    const text = String(req.body?.text ?? "").trim().slice(0, maxTextLength);

    if (!text) {
      res.status(400).json({ error: "Message text is required.", code: "empty_message" });
      return;
    }

    const result = await askAgent({
      tenantId: requireTenantId(req),
      sessionToken: req.scannerazSessionToken ?? "",
      text,
      inputKind: "text",
      locale: localeFrom(req.body?.locale)
    });
    res.setHeader("cache-control", "no-store");
    res.json(result);
  } catch (error) {
    sendAgentError(res, error, next);
  }
});

// Voice message: transcribe the recording, then answer it like typed text.
agentRouter.post("/voice", agentRateLimit, (req, res, next) => {
  voiceUpload.single("audio")(req, res, async (uploadError: unknown) => {
    if (uploadError) {
      const tooLarge = uploadError instanceof MulterError && uploadError.code === "LIMIT_FILE_SIZE";
      res.status(tooLarge ? 413 : 400).json({ error: "Invalid audio upload.", code: tooLarge ? "audio_too_large" : "invalid_audio" });
      return;
    }

    try {
      const file = req.file;

      if (!file?.buffer.length) {
        res.status(400).json({ error: "Audio is required.", code: "invalid_audio" });
        return;
      }

      const locale = localeFrom(req.body?.locale);
      const transcript = await transcribeVoiceMessage(
        { buffer: file.buffer, filename: file.originalname || "voice.m4a", mimeType: file.mimetype },
        locale
      );
      const result = await askAgent({
        tenantId: requireTenantId(req),
        sessionToken: req.scannerazSessionToken ?? "",
        text: transcript.slice(0, maxTextLength),
        inputKind: "audio",
        locale
      });
      res.setHeader("cache-control", "no-store");
      res.json({ ...result, transcript });
    } catch (error) {
      sendAgentError(res, error, next);
    }
  });
});
