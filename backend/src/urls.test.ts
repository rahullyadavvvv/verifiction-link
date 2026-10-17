import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicDestination, isCompanyPageUrl, parseLinkedInCompanyUrl, parseLinkedInUrl } from "./urls.js";

test("normalizes supported company URLs and removes tracking parameters", () => {
  assert.deepEqual(parseLinkedInCompanyUrl("https://linkedin.com/company/acme?trk=profile"), {
    normalizedUrl: "https://www.linkedin.com/company/acme/",
    companyIdentifier: "acme",
  });
  assert.equal(parseLinkedInCompanyUrl("https://www.linkedin.com/company/12345/")?.normalizedUrl, "https://www.linkedin.com/company/12345/");
  assert.equal(isCompanyPageUrl("https://www.linkedin.com/company/acme/"), true);
});

test("rejects malformed, non-HTTPS, and unsupported LinkedIn URLs", () => {
  for (const value of [
    "not a URL",
    "https://linkedin.com/in/person",
    "https://evil.example/company/acme",
    "https://user:pass@linkedin.com/company/acme",
    "https://linkedin.com/company/acme/extra",
  ]) assert.equal(parseLinkedInCompanyUrl(value), null, value);
  assert.equal(parseLinkedInCompanyUrl("http://www.linkedin.com/company/acme")?.normalizedUrl, "https://www.linkedin.com/company/acme/");
});

test("accepts other HTTPS LinkedIn pages for browser verification", () => {
  assert.deepEqual(parseLinkedInUrl("https://www.linkedin.com/in/example-person/"), {
    normalizedUrl: "https://www.linkedin.com/in/example-person/",
  });
  assert.deepEqual(parseLinkedInUrl("https://linkedin.com/posts/example?trk=public_profile"), {
    normalizedUrl: "https://www.linkedin.com/posts/example?trk=public_profile",
  });
  assert.equal(parseLinkedInUrl("https://de.linkedin.com/in/example/")?.normalizedUrl, "https://www.linkedin.com/in/example/");
  assert.equal(parseLinkedInUrl("www.linkedin.com/company/acme")?.normalizedUrl, "https://www.linkedin.com/company/acme/");
  assert.equal(parseLinkedInUrl("https://in.linkedin.com/in/example/")?.normalizedUrl, "https://www.linkedin.com/in/example/");
  assert.equal(parseLinkedInUrl("http://linkedin.com/company/acme")?.normalizedUrl, "https://www.linkedin.com/company/acme/");
  assert.equal(parseLinkedInUrl("ftp://linkedin.com/company/acme"), null);
  assert.equal(parseLinkedInUrl("https://linkedin.com:444/company/acme"), null);
  assert.equal(parseLinkedInUrl("https://linkedin.com/")?.normalizedUrl, "https://www.linkedin.com/");
  assert.equal(parseLinkedInUrl("https://www.linkedin.com/company/acme")?.companyIdentifier, "acme");
});

test("blocks private, loopback, and mixed public/private DNS destinations", async () => {
  await assert.rejects(assertPublicDestination("https://127.0.0.1", async () => ["127.0.0.1"]));
  await assert.rejects(assertPublicDestination("https://example.com", async () => ["93.184.216.34", "10.0.0.2"]));
  await assert.rejects(assertPublicDestination("https://localhost", async () => ["127.0.0.1"]));
  const url = await assertPublicDestination("https://example.com", async () => ["93.184.216.34"]);
  assert.equal(url.hostname, "example.com");
});
