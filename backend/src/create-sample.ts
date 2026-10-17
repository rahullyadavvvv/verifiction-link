import path from "node:path";
import fs from "node:fs/promises";
import ExcelJS from "exceljs";

const workbook = new ExcelJS.Workbook();
workbook.creator = "LinkedIn Company URL Verifier";
const sheet = workbook.addWorksheet("Companies");
sheet.addRow(["Company Name", "Staffing Company Name", "Industry", "Website URL", "LinkedIn Company URL", "Email ID"]);
sheet.addRows([
  ["Example Technology", "Northstar Staffing", "Software", "https://example.com", "https://www.linkedin.com/company/example-technology/", "info@example.com"],
  ["Sample Manufacturing", "", "Manufacturing", "", "https://linkedin.com/company/sample-manufacturing?trk=sample", ""],
  ["Fictional Services Group", "", "Consulting", "", "not-a-linkedin-url", ""],
  ["Empty URL Example", "", "Retail", "", "", ""],
]);
sheet.getRow(1).font = { bold: true };
const headers = ["Company Name", "Staffing Company Name", "Industry", "Website URL", "LinkedIn Company URL", "Email ID"];
sheet.columns = headers.map((header) => ({
  header,
  width: Math.min(Math.max(header.length + 4, 18), 34),
}));

const outputPath = path.resolve("..", "samples", "company-links-sample.xlsx");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await workbook.xlsx.writeFile(outputPath);
console.info(`Created ${outputPath}`);
