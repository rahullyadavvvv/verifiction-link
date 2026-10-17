import fs from "node:fs/promises";
import path from "node:path";
import XLSX from "@e965/xlsx";
import ExcelJS from "exceljs";
import type { VerificationResult } from "./types.js";

export interface ParsedSpreadsheet {
  headers: string[];
  rows: string[][];
  sheetName: string;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function parseSpreadsheet(buffer: Buffer, fileName: string, maxRows: number): ParsedSpreadsheet {
  const extension = path.extname(fileName).toLowerCase();
  const isXlsx = extension === ".xlsx" && buffer.subarray(0, 2).toString() === "PK";
  const isXls = extension === ".xls" && buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  if (!isXlsx && !isXls) throw new Error("The file must be a valid .xlsx or .xls workbook.");

  const workbook = XLSX.read(buffer, { type: "buffer", cellFormula: false, cellHTML: false, cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The workbook does not contain a worksheet.");
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false, blankrows: true });
  if (matrix.length < 1) throw new Error("The worksheet is empty.");
  if (matrix.length - 1 > maxRows) throw new Error(`The worksheet exceeds the ${maxRows.toLocaleString()} row limit.`);

  const headers = (matrix[0] ?? []).map((value, index) => cellText(value).trim() || `Column ${index + 1}`);
  if (!headers.length) throw new Error("The worksheet does not contain a header row.");
  const rows = matrix.slice(1).map((row) =>
    headers.map((_, index) => cellText(row[index])),
  );
  return { headers, rows, sheetName };
}

function safeSpreadsheetValue(value: string): string {
  return /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function resultRow(result: VerificationResult, headers: string[]): unknown[] {
  return [
    ...headers.map((_, index) => safeSpreadsheetValue(result.originalData[index] ?? "")),
    result.normalizedUrl,
    result.finalUrl,
    result.httpStatus ?? "",
    result.verificationStatus,
    result.verificationMethod,
    result.companyMatchStatus,
    result.aiReviewStatus,
    safeSpreadsheetValue(result.aiModel),
    safeSpreadsheetValue(result.aiMatchReason),
    safeSpreadsheetValue(result.detectedCompanyName),
    result.redirectDetected ? "Yes" : "No",
    result.verificationTimestamp,
    result.retryCount,
    safeSpreadsheetValue(result.errorDetails),
    result.manualReviewRequired ? "Yes" : "No",
  ];
}

export async function createExport(
  filePath: string,
  headers: string[],
  results: VerificationResult[],
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "LinkedIn Company URL Verifier";
  workbook.created = new Date();

  const resultSheet = workbook.addWorksheet("Results");
  const extraHeaders = [
    "Normalized LinkedIn URL",
    "Final LinkedIn URL",
    "HTTP Status Code",
    "Verification Status",
    "Verification Method",
    "Company Match Status",
    "AI Review Status",
    "AI Model",
    "AI Match Reason",
    "Detected LinkedIn Page Name",
    "Redirect Detected",
    "Verification Timestamp",
    "Retry Count",
    "Error Details",
    "Manual Review Required",
  ];
  resultSheet.addRow([...headers.map(safeSpreadsheetValue), ...extraHeaders]);
  for (const result of results) {
    resultSheet.addRow(resultRow(result, headers));
  }
  resultSheet.views = [{ state: "frozen", ySplit: 1 }];
  resultSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length + extraHeaders.length } };
  resultSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  resultSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF173B63" } };
  resultSheet.columns = [...headers, ...extraHeaders].map((header) => ({
    header: safeSpreadsheetValue(header),
    width: Math.min(Math.max(header.length + 3, 14), 42),
  }));

  const statusColumn = headers.length + extraHeaders.indexOf("Verification Status") + 1;
  const matchColumn = headers.length + extraHeaders.indexOf("Company Match Status") + 1;
  const lastColumn = resultSheet.columnCount;
  const lastRow = Math.max(2, resultSheet.rowCount);
  const range = `A2:${resultSheet.getColumn(lastColumn).letter}${lastRow}`;
  const statusLetter = resultSheet.getColumn(statusColumn).letter;
  const matchLetter = resultSheet.getColumn(matchColumn).letter;
  const rules = [
    { formula: [`OR($${statusLetter}2="PAGE_NOT_FOUND",$${statusLetter}2="INVALID_URL_FORMAT",$${matchLetter}2="MISMATCH")`], color: "FFFFC7CE" },
    { formula: [`OR($${statusLetter}2="LOGIN_REQUIRED",$${statusLetter}2="ACCESS_RESTRICTED",$${statusLetter}2="MANUAL_REVIEW",$${matchLetter}2="POSSIBLE_MATCH")`], color: "FFFFEB9C" },
    { formula: [`OR($${statusLetter}2="RATE_LIMITED",$${statusLetter}2="CAPTCHA_REQUIRED",$${statusLetter}2="NETWORK_ERROR")`], color: "FFF4B183" },
    { formula: [`$${statusLetter}2="MISSING_URL"`], color: "FFD9E1F2" },
    { formula: [`OR($${statusLetter}2="VERIFIED_ACCESSIBLE",$${statusLetter}2="REDIRECTED_VALID")`], color: "FFC6EFCE" },
  ];
  for (const rule of rules) {
    resultSheet.addConditionalFormatting({
      ref: range,
      rules: [{
        type: "expression",
        formulae: rule.formula,
        priority: rules.indexOf(rule) + 1,
        style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: rule.color } } },
      }],
    });
  }

  const counts = countResults(results);
  const totalNonEmpty = results.filter((result) => result.verificationStatus !== "MISSING_URL").length;
  const conclusiveExisting = (counts.VERIFIED_ACCESSIBLE ?? 0) + (counts.REDIRECTED_VALID ?? 0);
  const classified = results.filter((result) =>
    result.verificationStatus !== "MISSING_URL" && !["MANUAL_REVIEW", "NETWORK_ERROR"].includes(result.verificationStatus),
  ).length;
  const summary = workbook.addWorksheet("Summary");
  summary.addRows([
    ["Metric", "Value"],
    ["Total rows", results.length],
    ["Verified accessible pages", counts.VERIFIED_ACCESSIBLE],
    ["Valid redirected pages", counts.REDIRECTED_VALID],
    ["Confirmed not-found pages", counts.PAGE_NOT_FOUND],
    ["Invalid URL formats", counts.INVALID_URL_FORMAT],
    ["Login-required pages", counts.LOGIN_REQUIRED],
    ["Restricted or inconclusive pages", counts.ACCESS_RESTRICTED + counts.MANUAL_REVIEW + counts.CAPTCHA_REQUIRED + counts.RATE_LIMITED + counts.NETWORK_ERROR],
    ["Company name mismatches", results.filter((result) => result.companyMatchStatus === "MISMATCH").length],
    ["AI reviews completed", results.filter((result) => result.aiReviewStatus === "COMPLETED").length],
    ["AI fallback matches", results.filter((result) => result.aiReviewStatus === "UNAVAILABLE").length],
    ["Missing URLs", counts.MISSING_URL],
    ["Conclusive existing pages / non-empty URLs", `${totalNonEmpty ? ((conclusiveExisting / totalNonEmpty) * 100).toFixed(1) : "0.0"}%`],
    ["URLs successfully classified", `${totalNonEmpty ? ((classified / totalNonEmpty) * 100).toFixed(1) : "0.0"}%`],
  ]);
  summary.getRow(1).font = { bold: true };
  summary.columns = [{ width: 48 }, { width: 24 }];

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await workbook.xlsx.writeFile(filePath);
}

export function countResults(results: VerificationResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.verificationStatus] = (counts[result.verificationStatus] ?? 0) + 1;
  return counts;
}
