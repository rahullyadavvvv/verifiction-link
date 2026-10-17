import test from "node:test";
import assert from "node:assert/strict";
import { getOllamaStatus, reviewCompanyMatch } from "./ollama.js";

test("reports a local Ollama model as available", async () => {
  let requestedUrl = "";
  const status = await getOllamaStatus(async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ models: [{ name: "qwen2.5:3b" }] }), { status: 200 });
  });
  assert.equal(new URL(requestedUrl).hostname, "127.0.0.1");
  assert.equal(status.available, true);
  assert.equal(status.model, "qwen2.5:3b");
});

test("uses local AI evidence and validates the structured company-match response", async () => {
  const review = await reviewCompanyMatch({
    expectedName: "Acme Incorporated",
    detectedName: "Acme Inc.",
    pageTitle: "Acme Inc. | LinkedIn",
    pageEvidence: "Software company",
  }, async (input, init) => {
    assert.equal(new URL(String(input)).hostname, "127.0.0.1");
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const evidence = JSON.parse(body.messages[1].content) as Record<string, string>;
    assert.equal(evidence.expectedCompanyName, "Acme Incorporated");
    assert.equal(evidence.visiblePageEvidence, "Software company");
    return new Response(JSON.stringify({
      message: { content: JSON.stringify({ status: "MATCH", reason: "The company names are equivalent." }) },
    }), { status: 200 });
  });
  assert.deepEqual(review, {
    status: "MATCH",
    reviewStatus: "COMPLETED",
    reason: "The company names are equivalent.",
  });
});

test("falls back to conservative local name matching when Ollama is unavailable", async () => {
  const review = await reviewCompanyMatch({
    expectedName: "Acme Ltd",
    detectedName: "Acme Ltd",
    pageTitle: "",
    pageEvidence: "",
  }, async () => {
    throw new Error("Connection refused");
  });
  assert.equal(review.status, "MATCH");
  assert.equal(review.reviewStatus, "UNAVAILABLE");
  assert.match(review.reason, /conservative name matching/);
});
