import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "./passwords.js";

test("hashPassword creates a password-specific scrypt record", async () => {
  const password = "a long password for ScannerAz";
  const encoded = await hashPassword(password);

  assert.match(encoded, /^scrypt\$/);
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword("a different password", encoded), false);
});

test("hashPassword rejects passwords that do not meet the minimum length", async () => {
  await assert.rejects(() => hashPassword("short"), /between 12 and 128/);
});
