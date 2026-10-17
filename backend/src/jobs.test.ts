import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { cancelJob, createJob, recheckRows, resumeJob, pauseJob } from "./jobs.js";
import type { UploadData } from "./types.js";

function upload(rows: string[][]): UploadData {
  return {
    id: randomUUID(),
    fileName: "control-test.xlsx",
    headers: ["Company Name", "LinkedIn URL"],
    rows,
    sheetName: "Test",
  };
}

async function waitForCompletion(job: ReturnType<typeof createJob>) {
  for (let attempt = 0; attempt < 100 && job.status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.status, "completed");
}

test("records missing and invalid rows and supports pause, resume, and explicit recheck", async () => {
  const job = createJob(upload([["Bad URL", "not-a-linkedin-url"], ["Empty URL", ""]]), {
    urlColumn: 1,
    companyColumn: 0,
    concurrency: 2,
    batchSize: 10,
  });
  const persistedPath = path.join(config.dataDir, `job-${job.id}.json`);
  try {
    assert.equal(job.results[1]?.verificationStatus, "MISSING_URL");
    job.status = "running";
    await pauseJob(job);
    assert.equal(job.status, "paused");
    await resumeJob(job);
    await waitForCompletion(job);
    assert.equal(job.results[0]?.verificationStatus, "INVALID_URL_FORMAT");

    await recheckRows(job, [0]);
    await waitForCompletion(job);
    assert.equal(job.results[0]?.verificationStatus, "INVALID_URL_FORMAT");
    assert.equal(job.results[1]?.verificationStatus, "MISSING_URL");
    await assert.rejects(cancelJob(job));
  } finally {
    await fs.rm(persistedPath, { force: true });
    await fs.rm(`${persistedPath}.tmp`, { force: true });
  }
});

test("cancels a queued job without starting browser work", async () => {
  const job = createJob(upload([["Acme", "not-a-linkedin-url"]]), {
    urlColumn: 1,
    companyColumn: 0,
    concurrency: 2,
    batchSize: 25,
  });
  const persistedPath = path.join(config.dataDir, `job-${job.id}.json`);
  try {
    await cancelJob(job);
    assert.equal(job.status, "cancelled");
  } finally {
    await fs.rm(persistedPath, { force: true });
    await fs.rm(`${persistedPath}.tmp`, { force: true });
  }
});
