import express from "express";
import multer, { MulterError } from "multer";
import rateLimit from "express-rate-limit";
import {
  AgentUnavailableError,
  askAgent,
  clearAgentMessages,
  listAgentMessages,
  transcribeVoiceMessage,
  type AgentLocale
} from "./agent.js";

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
    res.json({ messages: await listAgentMessages(requireTenantId(req)) });
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

agentRouter.post("/messages", agentRateLimit, async (req, res, next) => {
  try {
    const text = String(req.body?.text ?? "").trim().slice(0, maxTextLength);

    if (!text) {
      res.status(400).json({ error: "Message text is required.", code: "empty_message" });
      return;
    }

    const result = await askAgent({
      tenantId: requireTenantId(req),
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
