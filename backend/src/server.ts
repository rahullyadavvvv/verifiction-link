import "dotenv/config";
import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { parseSpreadsheet } from "./excel.js";
import {
  cancelJob,
  closeBrowser,
  createJob,
  exportJob,
  getJob,
  initializeJobs,
  jobSummary,
  pauseJob,
  recheckRows,
  resumeJob,
  startJob,
} from "./jobs.js";
import { VERIFICATION_STATUSES, type UploadData, type VerificationResult } from "./types.js";
import { parseLinkedInUrl } from "./urls.js";
import { getOllamaStatus } from "./ollama.js";
import { getLinkedInApiStatus } from "./linkedin-api.js";

export const app = express();
const uploads = new Map<string, { data: UploadData; createdAt: number }>();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_request, file, callback) => {
    if ([".xlsx", ".xls"].includes(path.extname(file.originalname).toLowerCase())) callback(null, true);
    else callback(new Error("Upload an .xlsx or .xls spreadsheet."));
  },
});

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || config.frontendOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
}));
app.use(express.json({ limit: "1mb" }));
app.use((request, response, next) => {
  const started = Date.now();
  response.on("finish", () => {
    console.info(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      method: request.method,
      path: request.path,
      status: response.statusCode,
      durationMs: Date.now() - started,
    }));
  });
  next();
});

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function findJob(request: Request, response: Response) {
  const parameter = request.params.jobId;
  const job = getJob(Array.isArray(parameter) ? parameter[0] : parameter);
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return null;
  }
  return job;
}

function serializeResult(result: VerificationResult | null, index: number) {
  return result ? { ...result, rowIndex: index } : null;
}

app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
app.get("/api/ai/status", asyncRoute(async (_request, response) => {
  response.json(await getOllamaStatus());
}));
app.get("/api/linkedin/status", (_request, response) => {
  response.json(getLinkedInApiStatus());
});

app.post("/api/uploads/preview", upload.single("file"), (request, response, next) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: "Select an .xlsx or .xls file." });
      return;
    }
    const parsed = parseSpreadsheet(request.file.buffer, request.file.originalname, config.maxRows);
    const id = randomUUID();
    const uploadData: UploadData = {
      id,
      fileName: path.basename(request.file.originalname).replace(/[^\w.\- ()]/g, "_"),
      ...parsed,
    };
    const now = Date.now();
    for (const [uploadId, pending] of uploads) {
      if (now - pending.createdAt > 60 * 60 * 1000) uploads.delete(uploadId);
    }
    uploads.set(id, { data: uploadData, createdAt: now });

    const normalizedHeaders = parsed.headers.map((header) => header.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
    const urlColumn = normalizedHeaders.findIndex((header) => header.includes("linkedin") && header.includes("url"));
    const companyColumn = normalizedHeaders.findIndex((header) => header === "company name" || header === "company");
    const nonEmptyUrlCount = parsed.rows.reduce((total, row) => total + (row[urlColumn]?.trim() ? 1 : 0), 0);
    const validUrlCount = parsed.rows.reduce((total, row) =>
      total + (row[urlColumn] && parseLinkedInUrl(row[urlColumn]) ? 1 : 0), 0);
    response.status(201).json({
      uploadId: id,
      fileName: uploadData.fileName,
      sheetName: parsed.sheetName,
      headers: parsed.headers,
      rows: parsed.rows.slice(0, 10),
      totalRows: parsed.rows.length,
      detectedUrlColumn: urlColumn >= 0 ? urlColumn : null,
      detectedCompanyColumn: companyColumn >= 0 ? companyColumn : null,
      nonEmptyUrlCount,
      validUrlCount,
    });
  } catch (error) {
    next(error);
  }
});

const createJobSchema = z.object({
  uploadId: z.string().uuid(),
  urlColumn: z.number().int().nonnegative(),
  companyColumn: z.number().int().nonnegative().nullable(),
  concurrency: z.number().int().min(1).max(8).default(2),
  batchSize: z.number().int().min(1).max(200).default(25),
});

app.post("/api/jobs", asyncRoute(async (request, response) => {
  const input = createJobSchema.safeParse(request.body);
  if (!input.success) {
    response.status(400).json({ error: "Invalid job settings.", details: input.error.flatten() });
    return;
  }
  const uploadEntry = uploads.get(input.data.uploadId);
  if (!uploadEntry || Date.now() - uploadEntry.createdAt > 60 * 60 * 1000) {
    uploads.delete(input.data.uploadId);
    response.status(404).json({ error: "Upload preview expired. Upload the spreadsheet again." });
    return;
  }
  const uploadData = uploadEntry.data;
  if (input.data.urlColumn >= uploadData.headers.length ||
      (input.data.companyColumn !== null && input.data.companyColumn >= uploadData.headers.length)) {
    response.status(400).json({ error: "The selected column is outside the worksheet." });
    return;
  }
  const job = createJob(uploadData, input.data);
  uploads.delete(uploadData.id);
  await startJob(job);
  response.status(201).json({ jobId: job.id, status: job.status });
}));

app.get("/api/jobs/:jobId", (request, response) => {
  const job = findJob(request, response);
  if (!job) return;
  const completed = job.results.filter((result) => result !== null).length;
  const currentIndex = job.currentRow;
  response.json({
    jobId: job.id,
    fileName: job.fileName,
    urlColumn: job.urlColumn,
    companyColumn: job.companyColumn,
    status: job.status,
    totalRows: job.rows.length,
    completedRows: completed,
    progress: job.rows.length ? completed / job.rows.length : 1,
    currentRow: currentIndex === null ? null : {
      rowNumber: currentIndex + 2,
      companyName: job.companyColumn === null ? "" : job.rows[currentIndex]?.[job.companyColumn] ?? "",
      url: job.rows[currentIndex]?.[job.urlColumn] ?? "",
    },
    elapsedSeconds: Math.max(0, Math.floor((Date.now() - new Date(job.createdAt).getTime()) / 1000)),
    summary: jobSummary(job),
    error: job.error,
  });
});

app.get("/api/jobs/:jobId/results", (request, response) => {
  const job = findJob(request, response);
  if (!job) return;
  const offset = Number(request.query.offset ?? 0);
  const limit = Number(request.query.limit ?? 50);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    response.status(400).json({ error: "Use an offset of 0 or greater and a limit from 1 to 200." });
    return;
  }
  const search = typeof request.query.search === "string" ? request.query.search.trim().toLowerCase() : "";
  const status = typeof request.query.status === "string" ? request.query.status : "";
  const match = typeof request.query.match === "string" ? request.query.match : "";
  if (status && !VERIFICATION_STATUSES.includes(status as (typeof VERIFICATION_STATUSES)[number])) {
    response.status(400).json({ error: "Unknown verification status filter." });
    return;
  }
  if (match && !["MATCH", "POSSIBLE_MATCH", "MISMATCH", "UNKNOWN"].includes(match)) {
    response.status(400).json({ error: "Unknown company match filter." });
    return;
  }
  const filtered = job.results.map((result, index) => ({ result, index })).filter(({ result, index }) => {
    if (status && result?.verificationStatus !== status) return false;
    if (match && result?.companyMatchStatus !== match) return false;
    if (!search) return true;
    const values = [
      ...job.rows[index],
      result?.normalizedUrl,
      result?.finalUrl,
      result?.verificationStatus,
      result?.companyMatchStatus,
      result?.detectedCompanyName,
      result?.errorDetails,
    ].join(" ").toLowerCase();
    return values.includes(search);
  });
  const rows = filtered.slice(offset, offset + limit).map(({ result, index }) => serializeResult(result, index));
  response.json({ offset, totalRows: filtered.length, jobTotalRows: job.rows.length, rows });
});

app.post("/api/jobs/:jobId/pause", asyncRoute(async (request, response) => {
  const job = findJob(request, response);
  if (!job) return;
  try {
    await pauseJob(job);
    response.json({ status: job.status });
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : "Unable to pause job." });
  }
}));

app.post("/api/jobs/:jobId/resume", asyncRoute(async (request, response) => {
  const job = findJob(request, response);
  if (!job) return;
  try {
    await resumeJob(job);
    response.json({ status: job.status });
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : "Unable to resume job." });
  }
}));

app.post("/api/jobs/:jobId/cancel", asyncRoute(async (request, response) => {
  const job = findJob(request, response);
  if (!job) return;
  try {
    await cancelJob(job);
    response.json({ status: job.status });
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : "Unable to cancel job." });
  }
}));

app.post("/api/jobs/:jobId/recheck", asyncRoute(async (request, response) => {
  const job = findJob(request, response);
  if (!job) return;
  const input = z.object({ rowIndexes: z.array(z.number().int()).min(1).max(200) }).safeParse(request.body);
  if (!input.success) {
    response.status(400).json({ error: "Provide one or more rowIndexes (0-based).", details: input.error.flatten() });
    return;
  }
  try {
    await recheckRows(job, input.data.rowIndexes);
    response.json({ status: job.status });
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : "Unable to recheck selected rows." });
  }
}));

app.get("/api/jobs/:jobId/export", asyncRoute(async (request, response) => {
  const job = findJob(request, response);
  if (!job) return;
  const outputPath = path.join(config.dataDir, `export-${job.id}.xlsx`);
  await exportJob(job, outputPath);
  response.download(outputPath, `${path.parse(job.fileName).name}-verified.xlsx`);
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  const isUploadError = error instanceof multer.MulterError;
  const status = isUploadError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    message: "Request failed",
    error: message,
  }));
  response.status(status).json({ error: message });
});

if (process.env.NODE_ENV !== "test") {
  await initializeJobs();
  const server = app.listen(config.port, () => {
    console.info(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", message: `API listening on port ${config.port}` }));
  });

  async function shutdown() {
    server.close();
    await closeBrowser();
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
