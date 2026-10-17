import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { config } from "./config.js";
import { countResults, createExport } from "./excel.js";
import { parseLinkedInUrl } from "./urls.js";
import { compareCompanyNames } from "./company-match.js";
import { reviewCompanyMatch } from "./ollama.js";
import { verifyCompanyWithLinkedInApi } from "./linkedin-api.js";
import { getOrCreateVerification, verifyLinkedInUrl, type BrowserVerificationOutcome, type VerificationOutcome } from "./verification.js";
import type { UploadData, VerificationJob, VerificationResult } from "./types.js";

const jobs = new Map<string, VerificationJob>();
const saveChains = new WeakMap<VerificationJob, Promise<void>>();
const runners = new WeakMap<VerificationJob, Promise<void>>();
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  browserPromise ??= chromium.launch({ headless: true });
  return browserPromise;
}

function jobPath(jobId: string): string {
  return path.join(config.dataDir, `job-${jobId}.json`);
}

async function persistJob(job: VerificationJob): Promise<void> {
  const previous = saveChains.get(job) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await fs.mkdir(config.dataDir, { recursive: true });
    const target = jobPath(job.id);
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(job), "utf8");
    await fs.rename(temporary, target);
  });
  saveChains.set(job, next);
  await next;
}

export async function initializeJobs(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const now = Date.now();
  const retentionMs = config.retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of await fs.readdir(config.dataDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(config.dataDir, entry.name);
    if (entry.name.startsWith("export-") && Date.now() - (await fs.stat(filePath)).mtimeMs > retentionMs) {
      await fs.rm(filePath, { force: true });
      continue;
    }
    if (!/^job-[0-9a-f-]+\.json$/i.test(entry.name)) continue;
    try {
      const job = JSON.parse(await fs.readFile(filePath, "utf8")) as VerificationJob;
      job.results = job.results.map((result) => result ? {
        ...result,
        verificationMethod: result.verificationMethod ?? "BROWSER",
        aiReviewStatus: result.aiReviewStatus ?? "NOT_NEEDED",
        aiMatchReason: result.aiMatchReason ?? "",
        aiModel: result.aiModel ?? "",
      } : null);
      if (now - new Date(job.updatedAt).getTime() > retentionMs) {
        await fs.rm(filePath, { force: true });
        continue;
      }
      if (job.status === "running" || job.status === "queued") {
        job.status = "paused";
        job.currentRow = null;
        job.updatedAt = new Date().toISOString();
        await persistJob(job);
      }
      jobs.set(job.id, job);
    } catch (error) {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: "Unable to load persisted job", file: entry.name, error: String(error) }));
    }
  }
}

export function getJob(jobId: string): VerificationJob | undefined {
  return jobs.get(jobId);
}

function createResult(job: VerificationJob, rowIndex: number, outcome: VerificationOutcome): VerificationResult {
  const row = job.rows[rowIndex];
  return {
    rowNumber: rowIndex + 2,
    originalData: row,
    ...outcome,
    verificationTimestamp: new Date().toISOString(),
    manualReviewRequired: outcome.verificationStatus === "MANUAL_REVIEW" ||
      outcome.companyMatchStatus === "POSSIBLE_MATCH" || outcome.companyMatchStatus === "MISMATCH",
  };
}

export function createJob(
  upload: UploadData,
  options: { urlColumn: number; companyColumn: number | null; concurrency: number; batchSize: number },
): VerificationJob {
  const job: VerificationJob = {
    id: randomUUID(),
    fileName: upload.fileName,
    headers: upload.headers,
    rows: upload.rows,
    urlColumn: options.urlColumn,
    companyColumn: options.companyColumn,
    concurrency: options.concurrency,
    batchSize: options.batchSize,
    status: "queued",
    results: new Array(upload.rows.length).fill(null),
    pendingRows: [],
    currentRow: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: "",
  };

  upload.rows.forEach((row, index) => {
    const rawUrl = row[job.urlColumn]?.trim() ?? "";
    if (!rawUrl) {
      job.results[index] = createResult(job, index, {
        normalizedUrl: "",
        finalUrl: "",
        httpStatus: null,
        verificationStatus: "MISSING_URL",
        verificationMethod: "NOT_CHECKED",
        detectedCompanyName: "",
        companyMatchStatus: "UNKNOWN",
        aiReviewStatus: "NOT_NEEDED",
        aiMatchReason: "",
        aiModel: "",
        redirectDetected: false,
        errorDetails: "",
        retryCount: 0,
      });
    } else {
      job.pendingRows.push(index);
    }
  });
  jobs.set(job.id, job);
  return job;
}

async function verifyRow(
  job: VerificationJob,
  rowIndex: number,
  outcomeCache: Map<string, Promise<BrowserVerificationOutcome>>,
): Promise<void> {
  const rawUrl = job.rows[rowIndex][job.urlColumn] ?? "";
  const parsed = parseLinkedInUrl(rawUrl);
  if (!parsed) {
    job.results[rowIndex] = createResult(job, rowIndex, {
      normalizedUrl: "",
      finalUrl: "",
      httpStatus: null,
      verificationStatus: "INVALID_URL_FORMAT",
      verificationMethod: "NOT_CHECKED",
      detectedCompanyName: "",
      companyMatchStatus: "UNKNOWN",
      aiReviewStatus: "NOT_NEEDED",
      aiMatchReason: "",
      aiModel: "",
      redirectDetected: false,
      errorDetails: "Expected an HTTPS LinkedIn URL.",
      retryCount: 0,
    });
    return;
  }

  const browserOutcome = await getOrCreateVerification(outcomeCache, parsed.normalizedUrl, async () => {
    let result: BrowserVerificationOutcome;
    let attempts = 0;
    while (true) {
      result = parsed.companyIdentifier && config.linkedInApiAccessToken
        ? await verifyCompanyWithLinkedInApi(
          parsed.normalizedUrl,
          parsed.companyIdentifier,
          config.linkedInApiAccessToken,
          config.linkedInApiVersion,
        )
        : await verifyLinkedInUrl(await getBrowser(), rawUrl, config.navigationTimeoutMs);
      if (result.verificationStatus !== "NETWORK_ERROR" || attempts >= config.maxRetries) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempts)));
      attempts += 1;
    }
    result.retryCount = attempts;
    return result;
  });
  const expectedName = parsed.companyIdentifier && job.companyColumn !== null
    ? job.rows[rowIndex][job.companyColumn] ?? ""
    : "";
  const match = expectedName.trim() && browserOutcome.detectedCompanyName
    ? await reviewCompanyMatch({
      expectedName,
      detectedName: browserOutcome.detectedCompanyName,
      pageTitle: browserOutcome.pageTitle,
      pageEvidence: browserOutcome.pageEvidence,
    })
    : {
      status: compareCompanyNames(expectedName, browserOutcome.detectedCompanyName),
      reviewStatus: "NOT_NEEDED" as const,
      reason: "",
    };
  const { pageTitle: _pageTitle, pageEvidence: _pageEvidence, ...baseOutcome } = browserOutcome;
  const outcome: VerificationOutcome = {
    ...baseOutcome,
    companyMatchStatus: match.status,
    aiReviewStatus: match.reviewStatus,
    aiMatchReason: match.reason,
    aiModel: match.reviewStatus === "NOT_NEEDED" ? "" : config.ollamaModel,
  };
  job.results[rowIndex] = createResult(job, rowIndex, outcome);
}

async function processJob(job: VerificationJob): Promise<void> {
  try {
    job.status = "running";
    job.currentRow = null;
    job.updatedAt = new Date().toISOString();
    await persistJob(job);

    const queue = [...job.pendingRows];
    const outcomeCache = new Map<string, Promise<BrowserVerificationOutcome>>();
    let cursor = 0;
    const worker = async () => {
      let batchCount = 0;
      while (job.status === "running") {
        const rowIndex = queue[cursor];
        if (rowIndex === undefined) return;
        cursor += 1;
        job.currentRow = rowIndex;
        await verifyRow(job, rowIndex, outcomeCache);
        job.pendingRows = job.pendingRows.filter((index) => index !== rowIndex);
        job.updatedAt = new Date().toISOString();
        await persistJob(job);
        if (job.results[rowIndex]?.verificationStatus === "RATE_LIMITED" && job.status === "running") {
          job.status = "paused";
          job.error = "Processing paused because LinkedIn rate-limited a request.";
          job.updatedAt = new Date().toISOString();
          await persistJob(job);
        }
        batchCount += 1;
        if (batchCount >= job.batchSize) {
          batchCount = 0;
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    };

    await Promise.all(Array.from({ length: job.concurrency }, worker));
    job.currentRow = null;
    if (job.status === "running") job.status = "completed";
    job.updatedAt = new Date().toISOString();
    await persistJob(job);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "Unexpected job failure.";
    job.currentRow = null;
    job.updatedAt = new Date().toISOString();
    await persistJob(job);
    console.error(JSON.stringify({ timestamp: job.updatedAt, level: "error", message: "Verification job failed", jobId: job.id, error: job.error }));
  }
}

export async function startJob(job: VerificationJob): Promise<void> {
  await persistJob(job);
  const previous = runners.get(job);
  if (previous) await previous;
  if (job.status !== "queued") return;
  const runner = processJob(job);
  runners.set(job, runner);
  void runner.finally(() => {
    if (runners.get(job) === runner) runners.delete(job);
  }).catch((error) => {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: "Job runner terminated unexpectedly", jobId: job.id, error: String(error) }));
  });
}

export async function pauseJob(job: VerificationJob): Promise<void> {
  if (job.status !== "running") throw new Error("Only a running job can be paused.");
  job.status = "paused";
  job.updatedAt = new Date().toISOString();
  await persistJob(job);
}

export async function resumeJob(job: VerificationJob): Promise<void> {
  if (job.status !== "paused") throw new Error("Only a paused job can be resumed.");
  job.status = "queued";
  job.error = "";
  job.updatedAt = new Date().toISOString();
  await startJob(job);
}

export async function cancelJob(job: VerificationJob): Promise<void> {
  if (!["running", "paused", "queued"].includes(job.status)) throw new Error("This job can no longer be cancelled.");
  job.status = "cancelled";
  job.currentRow = null;
  job.updatedAt = new Date().toISOString();
  await persistJob(job);
}

export async function recheckRows(job: VerificationJob, rowIndexes: number[]): Promise<void> {
  if (!["completed", "paused", "cancelled", "failed"].includes(job.status)) {
    throw new Error("Pause or finish the job before rechecking rows.");
  }
  const unique = [...new Set(rowIndexes)];
  if (!unique.length || unique.some((index) => !Number.isInteger(index) || index < 0 || index >= job.rows.length)) {
    throw new Error("Select one or more valid result rows to recheck.");
  }
  for (const index of unique) {
    job.results[index] = null;
    if ((job.rows[index][job.urlColumn] ?? "").trim()) job.pendingRows.push(index);
    else {
      job.results[index] = createResult(job, index, {
        normalizedUrl: "",
        finalUrl: "",
        httpStatus: null,
        verificationStatus: "MISSING_URL",
        verificationMethod: "NOT_CHECKED",
        detectedCompanyName: "",
        companyMatchStatus: "UNKNOWN",
        aiReviewStatus: "NOT_NEEDED",
        aiMatchReason: "",
        aiModel: "",
        redirectDetected: false,
        errorDetails: "",
        retryCount: 0,
      });
    }
  }
  job.pendingRows = [...new Set(job.pendingRows)];
  job.status = "queued";
  job.error = "";
  await startJob(job);
}

export async function exportJob(job: VerificationJob, outputPath: string): Promise<void> {
  const results = job.rows.map((row, index) => job.results[index] ?? {
    rowNumber: index + 2,
    originalData: row,
    normalizedUrl: "",
    finalUrl: "",
    httpStatus: null,
    verificationStatus: "MANUAL_REVIEW" as const,
    verificationMethod: "NOT_CHECKED" as const,
    companyMatchStatus: "UNKNOWN" as const,
    aiReviewStatus: "NOT_NEEDED" as const,
    aiMatchReason: "",
    aiModel: "",
    detectedCompanyName: "",
    redirectDetected: false,
    verificationTimestamp: "",
    retryCount: 0,
    errorDetails: "This row was not processed before the job stopped.",
    manualReviewRequired: true,
  });
  await createExport(outputPath, job.headers, results);
}

export function jobSummary(job: VerificationJob) {
  const results = job.results.filter((result): result is VerificationResult => result !== null);
  const counts = countResults(results);
  const nonEmpty = job.rows.filter((row) => (row[job.urlColumn] ?? "").trim().length > 0).length;
  const classified = results.filter((result) =>
    result.verificationStatus !== "MISSING_URL" && !["MANUAL_REVIEW", "NETWORK_ERROR"].includes(result.verificationStatus),
  ).length;
  const successCount = (counts.VERIFIED_ACCESSIBLE ?? 0) + (counts.REDIRECTED_VALID ?? 0);
  return {
    counts,
    companyMismatches: results.filter((result) => result.companyMatchStatus === "MISMATCH").length,
    successRate: nonEmpty ? successCount / nonEmpty : 0,
    classificationRate: nonEmpty ? classified / nonEmpty : 0,
  };
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  await browser?.close();
}
