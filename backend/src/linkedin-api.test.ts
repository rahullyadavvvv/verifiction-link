import test from "node:test";
import assert from "node:assert/strict";
import { verifyCompanyWithLinkedInApi } from "./linkedin-api.js";

test("looks up a company vanity name through LinkedIn's official API", async () => {
  let requestedUrl = "";
  let headers: HeadersInit | undefined;
  const result = await verifyCompanyWithLinkedInApi(
    "https://www.linkedin.com/company/acme/",
    "acme",
    "test-access-token",
    "202609",
    async (input, init) => {
      requestedUrl = String(input);
      headers = init?.headers;
      return new Response(JSON.stringify({
        elements: [{ vanityName: "acme", localizedName: "Acme Incorporated", id: 123 }],
      }), { status: 200 });
    },
  );

  assert.equal(new URL(requestedUrl).origin, "https://api.linkedin.com");
  assert.equal(new URL(requestedUrl).pathname, "/rest/organizations");
  assert.equal(new URL(requestedUrl).searchParams.get("vanityName"), "acme");
  assert.deepEqual(headers, {
    Authorization: "Bearer test-access-token",
    "X-Restli-Protocol-Version": "2.0.0",
    "Linkedin-Version": "202609",
    Accept: "application/json",
  });
  assert.equal(result.verificationMethod, "OFFICIAL_API");
  assert.equal(result.verificationStatus, "VERIFIED_ACCESSIBLE");
  assert.equal(result.detectedCompanyName, "Acme Incorporated");
});

test("looks up numeric company identifiers and maps LinkedIn API access errors", async () => {
  let numericUrl = "";
  const numericResult = await verifyCompanyWithLinkedInApi(
    "https://www.linkedin.com/company/123/",
    "123",
    "test-access-token",
    "202609",
    async (input) => {
      numericUrl = String(input);
      return new Response(JSON.stringify({ results: { "123": { id: 123, localizedName: "Acme" } } }), { status: 200 });
    },
  );
  assert.equal(new URL(numericUrl).pathname, "/rest/organizationsLookup");
  assert.equal(new URL(numericUrl).searchParams.get("ids"), "List(123)");
  assert.equal(numericResult.detectedCompanyName, "Acme");

  const restricted = await verifyCompanyWithLinkedInApi(
    "https://www.linkedin.com/company/acme/",
    "acme",
    "test-access-token",
    "202609",
    async () => new Response(null, { status: 403 }),
  );
  assert.equal(restricted.verificationStatus, "ACCESS_RESTRICTED");
  assert.equal(restricted.httpStatus, 403);
});

test("reports an empty organization lookup as not found", async () => {
  const result = await verifyCompanyWithLinkedInApi(
    "https://www.linkedin.com/company/missing/",
    "missing",
    "test-access-token",
    "202609",
    async () => new Response(JSON.stringify({ elements: [] }), { status: 200 }),
  );
  assert.equal(result.verificationStatus, "PAGE_NOT_FOUND");
});
