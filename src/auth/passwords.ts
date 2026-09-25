import crypto from "node:crypto";

const passwordKeyLength = 64;
const passwordSaltLength = 16;
const passwordPrefix = "scrypt";

export function validatePassword(password: string) {
  if (password.length < 12 || password.length > 128) {
    throw new Error("Password must contain between 12 and 128 characters");
  }
}

export async function hashPassword(password: string) {
  validatePassword(password);
  const salt = crypto.randomBytes(passwordSaltLength);
  const derivedKey = await deriveKey(password, salt);

  return `${passwordPrefix}$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

export async function verifyPassword(password: string, encodedPassword: string) {
  const [prefix, saltValue, keyValue, ...extra] = encodedPassword.split("$");

  if (prefix !== passwordPrefix || !saltValue || !keyValue || extra.length > 0) {
    return false;
  }

  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expectedKey = Buffer.from(keyValue, "base64url");
    const actualKey = await deriveKey(password, salt);

    return (
      expectedKey.length === actualKey.length &&
      crypto.timingSafeEqual(expectedKey, actualKey)
    );
  } catch {
    return false;
  }
}

function deriveKey(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, passwordKeyLength, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });
}
