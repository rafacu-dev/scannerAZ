import crypto from "node:crypto";
import { config } from "../config.js";

function getKey() {
  if (!config.ENCRYPTION_KEY) {
    throw new Error("Missing ENCRYPTION_KEY");
  }

  return crypto.createHash("sha256").update(config.ENCRYPTION_KEY).digest();
}

export function encryptSecret(plainText: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

export function decryptSecret(value: string) {
  const [version, iv, authTag, encrypted] = value.split(".");

  if (version !== "v1" || !iv || !authTag || !encrypted) {
    throw new Error("Unsupported encrypted secret format");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(authTag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final()
  ]).toString("utf8");
}
