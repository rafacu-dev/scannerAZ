import crypto from "node:crypto";

const passwordKeyLength = 64;
const passwordSaltLength = 16;
const passwordPrefix = "scrypt";

export function validatePassword(password: string, accountEmail?: string) {
  if (password.length < 12 || password.length > 128) {
    throw new Error("Password must contain between 12 and 128 characters");
  }

  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    throw new Error("Password must contain uppercase and lowercase letters");
  }

  if (!/\d/.test(password)) {
    throw new Error("Password must contain a number");
  }

  if (!/[^A-Za-z0-9\s]/.test(password)) {
    throw new Error("Password must contain a special character");
  }

  const localPart = accountEmail?.trim().toLowerCase().split("@", 1)[0];

  if (localPart && localPart.length >= 3 && password.toLowerCase().includes(localPart)) {
    throw new Error("Password must not contain part of the account name");
  }
}

export async function hashPassword(password: string, accountEmail?: string) {
  validatePassword(password, accountEmail);
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
