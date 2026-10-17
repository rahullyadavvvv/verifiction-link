import test from "node:test";
import assert from "node:assert/strict";
import { compareCompanyNames } from "./company-match.js";
import { classifyEvidence, getOrCreateVerification } from "./verification.js";

const base = {
  finalUrl: "https://www.linkedin.com/company/acme/",
  title: "Acme | LinkedIn",
  bodyText: "Company profile",
  detectedName: "Acme",
  redirected: false,
};

test("matches company names conservatively", () => {
  assert.equal(compareCompanyNames("  ACME, Inc. ", "acme inc"), "MATCH");
  assert.equal(compareCompanyNames("Acme Group", "Acme Group International"), "POSSIBLE_MATCH");
  assert.equal(compareCompanyNames("Acme Group", "Unrelated Widgets"), "MISMATCH");
  assert.equal(compareCompanyNames("", "Acme"), "UNKNOWN");
});

test("recognizes verified and redirected company pages only with visible evidence", () => {
  assert.equal(classifyEvidence({ ...base, statusCode: 200 }).verificationStatus, "VERIFIED_ACCESSIBLE");
  assert.equal(classifyEvidence({ ...base, statusCode: 200, redirected: true }).verificationStatus, "REDIRECTED_VALID");
  assert.equal(classifyEvidence({ ...base, statusCode: 200, detectedName: "" }).verificationStatus, "MANUAL_REVIEW");
});

test("verifies other LinkedIn pages from browser evidence", () => {
  assert.equal(classifyEvidence({
    statusCode: 200,
    finalUrl: "https://www.linkedin.com/in/example-person/",
    title: "Example Person | LinkedIn",
    bodyText: "Profile details",
    detectedName: "Example Person",
    redirected: false,
  }).verificationStatus, "VERIFIED_ACCESSIBLE");
  assert.equal(classifyEvidence({
    statusCode: 200,
    finalUrl: "https://www.linkedin.com/in/example-person/",
    title: "",
    bodyText: "",
    detectedName: "",
    redirected: false,
  }).verificationStatus, "MANUAL_REVIEW");
});

test("distinguishes login, access, not-found, CAPTCHA, rate-limit, and network outcomes", () => {
  assert.equal(classifyEvidence({ ...base, statusCode: 200, finalUrl: "https://www.linkedin.com/login" }).verificationStatus, "LOGIN_REQUIRED");
  assert.equal(classifyEvidence({ ...base, statusCode: 403 }).verificationStatus, "ACCESS_RESTRICTED");
  assert.equal(classifyEvidence({ ...base, statusCode: 404 }).verificationStatus, "PAGE_NOT_FOUND");
  assert.equal(classifyEvidence({ ...base, statusCode: 200, bodyText: "Please verify you are human" }).verificationStatus, "CAPTCHA_REQUIRED");
  assert.equal(classifyEvidence({ ...base, statusCode: 429 }).verificationStatus, "RATE_LIMITED");
  assert.equal(classifyEvidence({ ...base, statusCode: null, navigationError: "Navigation timeout" }).verificationStatus, "NETWORK_ERROR");
});

test("shares one verification promise for duplicate normalized URLs", async () => {
  const cache = new Map<string, Promise<number>>();
  let calls = 0;
  const run = () => getOrCreateVerification(cache, "https://www.linkedin.com/company/acme/", async () => {
    calls += 1;
    return 42;
  });
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first, 42);
  assert.equal(second, 42);
  assert.equal(calls, 1);
});
