import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import XLSX from "@e965/xlsx";
import { createExport, parseSpreadsheet } from "./excel.js";
import type { VerificationResult } from "./types.js";

test("parses Excel headers and rows while preserving empty cells", () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Upload");
  sheet.addRows([
    ["Company Name", "LinkedIn Company URL"],
    ["Acme", "https://linkedin.com/company/acme"],
    ["", ""],
    ["No URL", ""],
  ]);
  return workbook.xlsx.writeBuffer().then((buffer) => {
    const parsed = parseSpreadsheet(Buffer.from(buffer), "input.xlsx", 100);
    assert.deepEqual(parsed.headers, ["Company Name", "LinkedIn Company URL"]);
    assert.deepEqual(parsed.rows, [["Acme", "https://linkedin.com/company/acme"], ["", ""], ["No URL", ""]]);
  });
});

test("accepts legacy .xls workbooks", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["Company Name", "LinkedIn URL"], ["Acme", ""]]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Companies");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xls" }) as Buffer;
  const parsed = parseSpreadsheet(buffer, "legacy.xls", 100);
  assert.deepEqual(parsed.rows, [["Acme", ""]]);
});

test("exports original columns, safe text, and summary calculations", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "linkedin-verifier-"));
  try {
    const outputPath = path.join(temporaryDirectory, "results.xlsx");
    const result: VerificationResult = {
      rowNumber: 2,
      originalData: ["=1+1", "https://www.linkedin.com/company/acme/"],
      normalizedUrl: "https://www.linkedin.com/company/acme/",
      finalUrl: "https://www.linkedin.com/company/acme/",
      httpStatus: 200,
      verificationStatus: "VERIFIED_ACCESSIBLE",
      verificationMethod: "OFFICIAL_API",
      companyMatchStatus: "MATCH",
      aiReviewStatus: "COMPLETED",
      aiMatchReason: "Same company",
      aiModel: "qwen2.5:3b",
      detectedCompanyName: "Acme",
      redirectDetected: false,
      verificationTimestamp: new Date().toISOString(),
      retryCount: 0,
      errorDetails: "",
      manualReviewRequired: false,
    };
    await createExport(outputPath, ["=Name", "URL"], [result]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const results = workbook.getWorksheet("Results")!;
    assert.equal(results.getRow(1).getCell(1).value, "'=Name");
    assert.equal(results.getRow(2).getCell(1).value, "'=1+1");
    assert.equal(results.getRow(2).getCell(2).value, result.originalData[1]);
    assert.equal(results.getRow(2).getCell(6).value, "VERIFIED_ACCESSIBLE");
    assert.equal(results.getRow(1).getCell(6).value, "Verification Status");
    assert.equal(results.getRow(2).getCell(7).value, "OFFICIAL_API");
    assert.equal(results.getRow(2).getCell(9).value, "COMPLETED");
    const summary = workbook.getWorksheet("Summary")!;
    assert.equal(summary.getRow(13).getCell(2).value, "100.0%");
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
