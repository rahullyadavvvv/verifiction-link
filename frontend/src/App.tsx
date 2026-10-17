import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Clock3,
  FileSpreadsheet,
  Filter,
  LoaderCircle,
  Search,
  ShieldCheck,
  Square,
  UploadCloud,
  X,
} from "lucide-react";

type Preview = {
  uploadId: string;
  fileName: string;
  sheetName: string;
  headers: string[];
  rows: string[][];
  totalRows: number;
  detectedUrlColumn: number | null;
  detectedCompanyColumn: number | null;
  nonEmptyUrlCount: number;
  validUrlCount: number;
};

type Result = {
  rowIndex: number;
  rowNumber: number;
  originalData: string[];
  normalizedUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  verificationStatus: string;
  companyMatchStatus: string;
  aiReviewStatus: "COMPLETED" | "UNAVAILABLE" | "NOT_NEEDED";
  aiMatchReason: string;
  aiModel: string;
  detectedCompanyName: string;
  redirectDetected: boolean;
  verificationTimestamp: string;
  retryCount: number;
  errorDetails: string;
  verificationMethod: "OFFICIAL_API" | "BROWSER" | "NOT_CHECKED";
  manualReviewRequired: boolean;
};

type Job = {
  jobId: string;
  fileName: string;
  urlColumn: number;
  companyColumn: number | null;
  status: string;
  totalRows: number;
  completedRows: number;
  progress: number;
  elapsedSeconds: number;
  currentRow: { rowNumber: number; companyName: string; url: string } | null;
  summary: {
    counts: Record<string, number>;
    companyMismatches: number;
    successRate: number;
    classificationRate: number;
  };
  error: string;
};

type AiStatus = {
  available: boolean;
  model: string;
  models: string[];
  message: string;
};

type LinkedInApiStatus = {
  configured: boolean;
  apiVersion: string;
  message: string;
};

const statuses = [
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
];

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, init);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `Request failed (${response.status}).` }));
    throw new Error(error.error ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function statusClass(status: string): string {
  if (["VERIFIED_ACCESSIBLE", "REDIRECTED_VALID"].includes(status)) return "status-green";
  if (["LOGIN_REQUIRED", "ACCESS_RESTRICTED", "POSSIBLE_MATCH", "MANUAL_REVIEW"].includes(status)) return "status-yellow";
  if (["PAGE_NOT_FOUND", "INVALID_URL_FORMAT", "MISMATCH"].includes(status)) return "status-red";
  if (status === "MISSING_URL") return "status-gray";
  return "status-orange";
}

function prettyStatus(status: string): string {
  return status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function App() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [results, setResults] = useState<Array<Result | null>>([]);
  const [urlColumn, setUrlColumn] = useState<number | "">("");
  const [companyColumn, setCompanyColumn] = useState<number | "">("");
  const [concurrency, setConcurrency] = useState(2);
  const [batchSize, setBatchSize] = useState(25);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [matchFilter, setMatchFilter] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [linkedInApiStatus, setLinkedInApiStatus] = useState<LinkedInApiStatus | null>(null);

  const refreshAiStatus = useCallback(async () => {
    try {
      setAiStatus(await request<AiStatus>("/api/ai/status"));
    } catch (caught) {
      setAiStatus({
        available: false,
        model: "qwen2.5:3b",
        models: [],
        message: caught instanceof Error ? caught.message : "Unable to check local AI status.",
      });
    }
  }, []);

  useEffect(() => {
    void refreshAiStatus();
    const timer = window.setInterval(() => void refreshAiStatus(), 10000);
    return () => window.clearInterval(timer);
  }, [refreshAiStatus]);

  useEffect(() => {
    request<LinkedInApiStatus>("/api/linkedin/status")
      .then(setLinkedInApiStatus)
      .catch(() => setLinkedInApiStatus(null));
  }, []);

  useEffect(() => {
    const savedJobId = window.localStorage.getItem("linkedin-verifier-job");
    if (!savedJobId) return;
    request<Job>(`/api/jobs/${savedJobId}`)
      .then(setJob)
      .catch(() => window.localStorage.removeItem("linkedin-verifier-job"));
  }, []);

  const refreshJob = useCallback(async (jobId: string) => {
    try {
      const updated = await request<Job>(`/api/jobs/${jobId}`);
      setJob(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to refresh job status.");
    }
  }, []);

  useEffect(() => {
    if (!job || !["running", "queued"].includes(job.status)) return;
    const timer = window.setInterval(() => void refreshJob(job.jobId), 1200);
    return () => window.clearInterval(timer);
  }, [job?.jobId, job?.status, refreshJob]);

  useEffect(() => {
    if (!job) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      offset: String(page * 50),
      limit: "50",
      search,
      status: statusFilter,
      match: matchFilter,
    });
    request<{ rows: Array<Result | null>; totalRows: number }>(`/api/jobs/${job.jobId}/results?${params}`, { signal: controller.signal })
      .then((data) => {
        setResults(data.rows);
        setFilteredTotal(data.totalRows);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to load results.");
      });
    return () => controller.abort();
  }, [job?.jobId, job?.completedRows, page, search, statusFilter, matchFilter]);

  const processFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError("");
    setJob(null);
    setPreview(null);
    setPage(0);
    setSelected([]);
    try {
      const body = new FormData();
      body.append("file", file);
      const data = await request<Preview>("/api/uploads/preview", { method: "POST", body });
      setPreview(data);
      setUrlColumn(data.detectedUrlColumn ?? "");
      setCompanyColumn(data.detectedCompanyColumn ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to read the spreadsheet.");
    } finally {
      setBusy(false);
    }
  };

  const createJob = async () => {
    if (!preview || urlColumn === "") return;
    setBusy(true);
    setError("");
    try {
      const data = await request<{ jobId: string }>("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId: preview.uploadId,
          urlColumn,
          companyColumn: companyColumn === "" ? null : companyColumn,
          concurrency,
          batchSize,
        }),
      });
      window.localStorage.setItem("linkedin-verifier-job", data.jobId);
      setPreview(null);
      await refreshJob(data.jobId);
      setPage(0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to start the verification job.");
    } finally {
      setBusy(false);
    }
  };

  const controlJob = async (action: "pause" | "resume" | "cancel") => {
    if (!job) return;
    setError("");
    try {
      await request(`/api/jobs/${job.jobId}/${action}`, { method: "POST" });
      await refreshJob(job.jobId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Unable to ${action} the job.`);
    }
  };

  const recheckSelected = async () => {
    if (!job || !selected.length) return;
    setError("");
    try {
      await request(`/api/jobs/${job.jobId}/recheck`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowIndexes: selected }),
      });
      setSelected([]);
      setPage(0);
      await refreshJob(job.jobId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to recheck selected rows.");
    }
  };

  const exportResults = () => {
    if (job) window.location.assign(`${API_BASE_URL}/api/jobs/${job.jobId}/export`);
  };

  const startNewUpload = () => {
    window.localStorage.removeItem("linkedin-verifier-job");
    setJob(null);
    setPreview(null);
    setResults([]);
    setSelected([]);
    setError("");
  };

  const toggleSelected = (rowIndex: number) => {
    setSelected((current) => current.includes(rowIndex)
      ? current.filter((index) => index !== rowIndex)
      : [...current, rowIndex]);
  };

  const pageCount = Math.max(1, Math.ceil(filteredTotal / 50));
  const cards = useMemo(() => {
    const counts = job?.summary.counts ?? {};
    return [
      { label: "Verified accessible", value: counts.VERIFIED_ACCESSIBLE ?? 0, color: "green" },
      { label: "Redirected valid", value: counts.REDIRECTED_VALID ?? 0, color: "green" },
      { label: "Invalid URL format", value: counts.INVALID_URL_FORMAT ?? 0, color: "red" },
      { label: "Page not found", value: counts.PAGE_NOT_FOUND ?? 0, color: "red" },
      { label: "Login required", value: counts.LOGIN_REQUIRED ?? 0, color: "yellow" },
      { label: "Access restricted", value: counts.ACCESS_RESTRICTED ?? 0, color: "yellow" },
      { label: "Rate limited", value: counts.RATE_LIMITED ?? 0, color: "orange" },
      { label: "Network error", value: counts.NETWORK_ERROR ?? 0, color: "orange" },
      { label: "CAPTCHA required", value: counts.CAPTCHA_REQUIRED ?? 0, color: "orange" },
      { label: "Manual review", value: counts.MANUAL_REVIEW ?? 0, color: "yellow" },
      { label: "Missing URLs", value: counts.MISSING_URL ?? 0, color: "gray" },
      { label: "Company mismatches", value: job?.summary.companyMismatches ?? 0, color: "red" },
      { label: "Verified success rate", value: `${((job?.summary.successRate ?? 0) * 100).toFixed(1)}%`, color: "blue", note: "of rows with a URL" },
    ];
  }, [job?.summary]);

  return (
    <main className="min-h-screen px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="brand-mark"><ShieldCheck size={25} /></div>
            <div>
              <p className="eyebrow">LINKEDIN DATA QUALITY</p>
              <h1>LinkedIn URL verifier</h1>
              <p className="subheading">Open each LinkedIn link and check the page safely from your spreadsheet.</p>
            </div>
          </div>
          <div className={`privacy-pill ${aiStatus?.available ? "ai-ready" : "ai-offline"}`} title={aiStatus?.message ?? "Checking local AI"}>
            <span /> Local AI {aiStatus?.available ? "ready" : "not connected"}
          </div>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={18} /><span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error"><X size={17} /></button>
          </div>
        )}

        {!job && (
          <section className="panel mb-7">
            <div className="section-heading">
              <div><span className="step">01</span><h2>Upload your spreadsheet</h2></div>
              <span className="quiet">.xlsx or .xls · up to 15 MB · 10,000 rows</span>
            </div>
            <label
              className={`dropzone ${dragging ? "dropzone-active" : ""} ${busy ? "dropzone-disabled" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void processFile(event.dataTransfer.files[0]);
              }}
            >
              <input
                type="file"
                accept=".xlsx,.xls"
                className="sr-only"
                disabled={busy}
                onChange={(event) => void processFile(event.target.files?.[0])}
              />
              <div className="upload-icon">{busy ? <LoaderCircle className="animate-spin" /> : <UploadCloud />}</div>
              <strong>{busy ? "Reading spreadsheet…" : "Drop your Excel file here"}</strong>
              <span>or <em>browse files</em> from your computer</span>
            </label>
            <p className="privacy-note"><ShieldCheck size={14} /> Your workbook stays local; only selected LinkedIn URLs are requested for verification.</p>
            {aiStatus && (
              <div className={`ai-notice ${aiStatus.available ? "ai-notice-ready" : "ai-notice-warning"}`}>
                <strong>{aiStatus.message}</strong>
                {!aiStatus.available && <span>Install Ollama, run <code>ollama pull {aiStatus.model}</code>, then refresh this page. If Ollama is offline during a job, the browser check still runs and company matching falls back to conservative rules.</span>}
              </div>
            )}
            {linkedInApiStatus && (
              <div className={`ai-notice ${linkedInApiStatus.configured ? "ai-notice-ready" : "ai-notice-warning"}`}>
                <strong>{linkedInApiStatus.message}</strong>
                <span>
                  {linkedInApiStatus.configured
                    ? "Company URLs will use the official API. Other LinkedIn URL types use browser evidence."
                    : "Without API credentials, LinkedIn pages use browser checks; configure an authorized API token to verify company pages through LinkedIn's API."}
                </span>
              </div>
            )}
          </section>
        )}

        {preview && !job && (
          <section className="panel mb-7">
            <div className="section-heading">
              <div><span className="step">02</span><h2>Review columns & preview</h2></div>
              <span className="file-label"><FileSpreadsheet size={16} />{preview.fileName}</span>
            </div>
            <div className="preview-stats">
              <div><b>{preview.totalRows.toLocaleString()}</b><span>Total rows</span></div>
              <div><b>{preview.nonEmptyUrlCount.toLocaleString()}</b><span>Non-empty URLs</span></div>
              <div><b>{preview.validUrlCount.toLocaleString()}</b><span>Valid LinkedIn URLs</span></div>
              <div><b>{preview.sheetName}</b><span>Worksheet</span></div>
            </div>
            <div className="mapping-grid">
              <label>LinkedIn URL column
                <select value={urlColumn} onChange={(event) => setUrlColumn(event.target.value === "" ? "" : Number(event.target.value))}>
                  <option value="">Choose a column…</option>
                  {preview.headers.map((header, index) => <option value={index} key={`${index}-${header}`}>{header}</option>)}
                </select>
              </label>
              <label>Company name column <span className="optional">(optional)</span>
                <select value={companyColumn} onChange={(event) => setCompanyColumn(event.target.value === "" ? "" : Number(event.target.value))}>
                  <option value="">No company name</option>
                  {preview.headers.map((header, index) => <option value={index} key={`${index}-${header}`}>{header}</option>)}
                </select>
              </label>
              <label>Concurrent pages
                <select value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>
                  {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value} {value === 1 ? "page" : "pages"}</option>)}
                </select>
              </label>
              <label>Batch size
                <select value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))}>
                  {[10, 25, 50, 100].map((value) => <option key={value} value={value}>{value} rows</option>)}
                </select>
              </label>
            </div>
            <div className="table-scroll preview-table">
              <table>
                <thead><tr>{preview.headers.map((header, index) => <th key={`${index}-${header}`}>{header}</th>)}</tr></thead>
                <tbody>{preview.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>{preview.headers.map((_, colIndex) => <td key={colIndex}>{row[colIndex]}</td>)}</tr>
                ))}</tbody>
              </table>
              {preview.totalRows > preview.rows.length && <p className="quiet table-footnote">Showing the first {preview.rows.length} rows.</p>}
            </div>
            <div className="panel-actions">
              <button className="button-secondary" onClick={() => setPreview(null)}>Cancel</button>
              <button className="button-primary" disabled={urlColumn === "" || busy} onClick={() => void createJob()}>
                <ShieldCheck size={17} /> Start verification
              </button>
            </div>
          </section>
        )}

        {job && (
          <>
            <section className="panel job-panel mb-7">
              <div className="job-topline">
                <div className="job-file"><span className="file-icon"><FileSpreadsheet size={20} /></span><div><strong>{job.fileName}</strong><small>{job.status === "completed" ? "Verification complete" : prettyStatus(job.status)}</small></div></div>
                <div className="job-actions">
                  {job.status === "running" && <button className="button-secondary" onClick={() => void controlJob("pause")}><CirclePause size={17} />Pause</button>}
                  {job.status === "paused" && <button className="button-primary compact" onClick={() => void controlJob("resume")}><CirclePlay size={17} />Resume</button>}
                  {["running", "paused", "queued"].includes(job.status) && <button className="button-danger" onClick={() => void controlJob("cancel")}><Square size={14} />Cancel</button>}
                  {["completed", "cancelled", "failed"].includes(job.status) && <button className="button-primary compact" onClick={exportResults}><ArrowDownToLine size={17} />Export Excel</button>}
                  {["completed", "cancelled", "failed"].includes(job.status) && <button className="button-secondary" onClick={startNewUpload}>New spreadsheet</button>}
                </div>
              </div>
              <div className="progress-meta">
                <span><b>{job.completedRows.toLocaleString()}</b> of {job.totalRows.toLocaleString()} rows</span>
                <span>{Math.round(job.progress * 100)}% <i /> <Clock3 size={14} /> {formatDuration(job.elapsedSeconds)}</span>
              </div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${job.progress * 100}%` }} /></div>
              {job.currentRow && job.status === "running" && (
                <div className="current-row"><LoaderCircle size={15} className="animate-spin" /><span>Checking row {job.currentRow.rowNumber}{job.currentRow.companyName ? ` · ${job.currentRow.companyName}` : ""}</span></div>
              )}
              {job.error && <p className="job-message"><AlertCircle size={15} />{job.error}</p>}
            </section>

            <section className="summary-grid mb-7">
              {cards.map((card) => (
                <div className={`summary-card card-${card.color}`} key={card.label}>
                  <span>{card.label}</span><strong>{typeof card.value === "number" ? card.value.toLocaleString() : card.value}</strong>
                  {"note" in card && <small>{card.note}</small>}
                </div>
              ))}
            </section>

            <section className="panel results-panel">
              <div className="results-heading">
                <div><h2>Verification results</h2><p>{filteredTotal.toLocaleString()} matching rows · {job.summary.companyMismatches} company name mismatches</p></div>
                <div className="results-tools">
                  <button className="button-secondary small-button" disabled={!selected.length || !["completed", "paused", "cancelled", "failed"].includes(job.status)} onClick={() => void recheckSelected()}>
                    <CheckCircle2 size={16} /> Recheck selected {selected.length ? `(${selected.length})` : ""}
                  </button>
                  {["completed", "cancelled", "failed"].includes(job.status) && <button className="button-secondary small-button" onClick={exportResults}><ArrowDownToLine size={16} />Export</button>}
                </div>
              </div>
              <div className="filters">
                <label className="search-field"><Search size={16} /><input placeholder="Search company, URL, or error…" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></label>
                <label className="filter-select"><Filter size={15} /><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(0); }}><option value="">All statuses</option>{statuses.map((status) => <option key={status} value={status}>{prettyStatus(status)}</option>)}</select></label>
                <label className="filter-select"><select value={matchFilter} onChange={(event) => { setMatchFilter(event.target.value); setPage(0); }}><option value="">All company matches</option>{["MATCH", "POSSIBLE_MATCH", "MISMATCH", "UNKNOWN"].map((match) => <option key={match} value={match}>{prettyStatus(match)}</option>)}</select></label>
              </div>
              <div className="table-scroll results-table">
                <table>
                  <thead><tr><th className="check-cell"><input type="checkbox" aria-label="Select all visible rows" checked={results.filter(Boolean).length > 0 && results.filter(Boolean).every((row) => selected.includes(row!.rowIndex))} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, ...results.filter(Boolean).map((row) => row!.rowIndex)])] : selected.filter((index) => !results.some((row) => row?.rowIndex === index)))} /></th><th>Company</th><th>LinkedIn URL</th><th>Verification</th><th>Method</th><th>Company match (AI)</th><th>AI review</th><th>Detected name</th></tr></thead>
                  <tbody>
                    {results.map((result, index) => {
                      if (!result) return <tr key={`pending-${index}`}><td /><td>Row {page * 50 + index + 2}</td><td /><td><span className="badge status-gray">Pending</span></td><td /><td /><td /><td /></tr>;
                      const companyName = result.originalData[job.companyColumn ?? -1] ?? "";
                      return (
                        <tr key={result.rowIndex}>
                          <td className="check-cell"><input type="checkbox" aria-label={`Select row ${result.rowNumber}`} checked={selected.includes(result.rowIndex)} onChange={() => toggleSelected(result.rowIndex)} /></td>
                          <td className="company-cell"><span>{companyName || `Row ${result.rowNumber}`}</span><small>Row {result.rowNumber}</small></td>
                          <td className="url-cell">{result.finalUrl || result.normalizedUrl || result.originalData[job.urlColumn] || <span className="quiet">—</span>}{result.finalUrl && <a href={result.finalUrl} target="_blank" rel="noreferrer" aria-label="Open final LinkedIn URL">↗</a>}</td>
                          <td><span className={`badge ${statusClass(result.verificationStatus)}`}>{prettyStatus(result.verificationStatus)}</span>{result.errorDetails && <small className="error-detail">{result.errorDetails}</small>}</td>
                          <td>{prettyStatus(result.verificationMethod)}</td>
                          <td><span className={`badge ${statusClass(result.companyMatchStatus)}`}>{prettyStatus(result.companyMatchStatus)}</span></td>
                          <td><span className={`badge ${result.aiReviewStatus === "COMPLETED" ? "status-green" : result.aiReviewStatus === "UNAVAILABLE" ? "status-orange" : "status-gray"}`}>{prettyStatus(result.aiReviewStatus)}</span>{result.aiMatchReason && <small className="error-detail">{result.aiMatchReason}{result.aiModel ? ` · ${result.aiModel}` : ""}</small>}</td>
                          <td>{result.detectedCompanyName || <span className="quiet">—</span>}</td>
                        </tr>
                      );
                    })}
                    {!results.length && <tr><td colSpan={8} className="empty-cell">No results match these filters.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="table-footer"><span>Page {page + 1} of {pageCount}</span><div><button disabled={page === 0} onClick={() => setPage((value) => value - 1)} aria-label="Previous page"><ChevronLeft size={17} /></button><button disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)} aria-label="Next page"><ChevronRight size={17} /></button></div></div>
              <div className="legend"><strong>Status colors</strong><span><i className="legend-dot green" /> Verified</span><span><i className="legend-dot yellow" /> Login or review</span><span><i className="legend-dot red" /> Invalid or mismatch</span><span><i className="legend-dot orange" /> Network or blocked</span><span><i className="legend-dot gray" /> Missing</span></div>
            </section>
            <footer className="page-footnote">LinkedIn may limit anonymous access. Authentication walls, restrictions, and challenges are reported without attempting to bypass them.</footer>
          </>
        )}

        {!job && !preview && <div className="intro-note"><Check size={16} /> Opens each HTTPS LinkedIn URL to verify its page; never signs in or bypasses access controls.</div>}
      </div>
    </main>
  );
}
