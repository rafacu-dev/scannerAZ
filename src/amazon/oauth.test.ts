import assert from "node:assert/strict";
import test from "node:test";

process.env.APP_BASE_URL = "https://scanneraz.warasoft.com";
process.env.AMAZON_REGION = "na";
process.env.AMAZON_SP_API_APP_ID = "amzn1.sellerapps.app.scanneraz-test";
process.env.ENCRYPTION_KEY = "e".repeat(32);
process.env.SESSION_SECRET = "s".repeat(32);

const {
  createAmazonWebsiteLoginRequest,
  decodeAmazonWebsiteLoginRequest,
  encodeAmazonWebsiteLoginRequest
} = await import("./oauth.js");

test("accepts only the registered Amazon confirmation callback", () => {
  const request = createAmazonWebsiteLoginRequest({
    amazonCallbackUri:
      "https://sellercentral.amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.scanneraz-test",
    amazonState: "amazon-state"
  });

  assert.equal(request.amazonState, "amazon-state");
  assert.equal(
    request.amazonCallbackUri,
    "https://sellercentral.amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.scanneraz-test"
  );

  assert.throws(
    () =>
      createAmazonWebsiteLoginRequest({
        amazonCallbackUri: "https://example.com/redirect",
        amazonState: "amazon-state"
      }),
    /Invalid Amazon callback URI/
  );
});

test("encrypts and verifies the website authorization handoff", () => {
  const request = createAmazonWebsiteLoginRequest({
    amazonCallbackUri:
      "https://sellercentral.amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.scanneraz-test",
    amazonState: "amazon-state"
  });
  const encoded = encodeAmazonWebsiteLoginRequest(request);
  const decoded = decodeAmazonWebsiteLoginRequest(encoded);

  assert.equal(decoded.amazonState, request.amazonState);
  assert.equal(decoded.amazonCallbackUri, request.amazonCallbackUri);
  assert.throws(() => decodeAmazonWebsiteLoginRequest(`${encoded}tampered`));
});
