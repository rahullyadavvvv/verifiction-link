export const VERIFICATION_STATUSES = [
  "VERIFIED_ACCESSIBLE",
  "REDIRECTED_VALID",
  "INVALID_URL_FORMAT",
  "PAGE_NOT_FOUND",
  "LOGIN_REQUIRED",
  "ACCESS_RESTRICTED",
  "RATE_LIMITED",
  "NETWORK_ERROR",
  "CAPTCHA_REQUIRED",
  "MANUAL_REVIEW",
  "MISSING_URL",
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export type CompanyMatchStatus = "MATCH" | "POSSIBLE_MATCH" | "MISMATCH" | "UNKNOWN";
export type AiReviewStatus = "COMPLETED" | "UNAVAILABLE" | "NOT_NEEDED";
export type JobStatus = "queued" | "running" | "paused" | "completed" | "cancelled" | "failed";
export type VerificationMethod = "OFFICIAL_API" | "BROWSER" | "NOT_CHECKED";

export interface UploadData {
  id: string;
  fileName: string;
  headers: string[];
  rows: string[][];
  sheetName: string;
}

export interface VerificationResult {
  rowNumber: number;
  originalData: string[];
  normalizedUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  verificationStatus: VerificationStatus;
  verificationMethod: VerificationMethod;
  companyMatchStatus: CompanyMatchStatus;
  aiReviewStatus: AiReviewStatus;
  aiMatchReason: string;
  aiModel: string;
  detectedCompanyName: string;
  redirectDetected: boolean;
  verificationTimestamp: string;
  retryCount: number;
  errorDetails: string;
  manualReviewRequired: boolean;
}

export interface VerificationJob {
  id: string;
  fileName: string;
  headers: string[];
  rows: string[][];
  urlColumn: number;
  companyColumn: number | null;
  concurrency: number;
  batchSize: number;
  status: JobStatus;
  results: Array<VerificationResult | null>;
  pendingRows: number[];
  currentRow: number | null;
  createdAt: string;
  updatedAt: string;
  error: string;
}
