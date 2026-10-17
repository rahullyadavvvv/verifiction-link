import path from "node:path";

const integer = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

export const config = {
  port: integer(process.env.PORT, 3001, 1, 65535),
  frontendOrigins: (process.env.FRONTEND_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  maxUploadBytes: integer(process.env.MAX_UPLOAD_MB, 15, 1, 100) * 1024 * 1024,
  maxRows: integer(process.env.MAX_ROWS, 10000, 1, 100000),
  retentionDays: integer(process.env.FILE_RETENTION_DAYS, 7, 1, 365),
  navigationTimeoutMs: integer(process.env.NAVIGATION_TIMEOUT_MS, 20000, 1000, 120000),
  maxRetries: integer(process.env.MAX_RETRIES, 2, 0, 5),
  ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "qwen2.5:3b",
  linkedInApiAccessToken: process.env.LINKEDIN_API_ACCESS_TOKEN?.trim() ?? "",
  linkedInApiVersion: /^\d{6}$/.test(process.env.LINKEDIN_API_VERSION ?? "")
    ? process.env.LINKEDIN_API_VERSION!
    : "202609",
};
