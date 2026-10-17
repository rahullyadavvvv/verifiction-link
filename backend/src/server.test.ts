import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { config } from "./config.js";

process.env.NODE_ENV = "test";
const { app } = await import("./server.js");

test("upload preview, job processing, result pagination, and report download work end to end", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Companies").addRows([
    ["Company Name", "LinkedIn Company URL"],
    ["Invalid example", "not-a-linkedin-url"],
    ["Missing example", ""],
  ]);
  const buffer = await workbook.xlsx.writeBuffer();
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  let jobId = "";

  try {
  const allowedOriginResponse = await fetch(`${origin}/api/health`, {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(allowedOriginResponse.headers.get("access-control-allow-origin"), "http://localhost:5173");
  const blockedOriginResponse = await fetch(`${origin}/api/health`, {
    headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(blockedOriginResponse.headers.get("access-control-allow-origin"), null);

    const aiStatusResponse = await fetch(`${origin}/api/ai/status`);
    assert.equal(aiStatusResponse.status, 200);
    const aiStatus = await aiStatusResponse.json() as { available: boolean; model: string };
    assert.equal(typeof aiStatus.available, "boolean");
    assert.equal(aiStatus.model, "qwen2.5:3b");
    const linkedInStatusResponse = await fetch(`${origin}/api/linkedin/status`);
    assert.equal(linkedInStatusResponse.status, 200);
    const linkedInStatus = await linkedInStatusResponse.json() as { configured: boolean; apiVersion: string };
    assert.equal(typeof linkedInStatus.configured, "boolean");
    assert.equal(linkedInStatus.apiVersion, "202609");

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "test.xlsx");
    const uploadResponse = await fetch(`${origin}/api/uploads/preview`, { method: "POST", body: form });
    assert.equal(uploadResponse.status, 201);
    const preview = await uploadResponse.json() as {
      uploadId: string;
      totalRows: number;
      validUrlCount: number;
      detectedUrlColumn: number | null;
    };
    assert.equal(preview.totalRows, 2);
    assert.equal(preview.validUrlCount, 0);
    assert.equal(preview.detectedUrlColumn, 1);

    const createResponse = await fetch(`${origin}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: preview.uploadId, urlColumn: 1, companyColumn: 0, concurrency: 2, batchSize: 10 }),
    });
    assert.equal(createResponse.status, 201);
    jobId = (await createResponse.json() as { jobId: string }).jobId;

    let job: { status: string; completedRows: number } | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const response = await fetch(`${origin}/api/jobs/${jobId}`);
      job = await response.json() as { status: string; completedRows: number };
      if (job.status === "completed") break;
    }
    assert.equal(job?.status, "completed");
    assert.equal(job?.completedRows, 2);

    const resultsResponse = await fetch(`${origin}/api/jobs/${jobId}/results?offset=0&limit=10`);
    const resultPage = await resultsResponse.json() as { rows: Array<{ verificationStatus: string }>; totalRows: number };
    assert.equal(resultPage.totalRows, 2);
    assert.deepEqual(resultPage.rows.map((row) => row.verificationStatus), ["INVALID_URL_FORMAT", "MISSING_URL"]);

    const exportResponse = await fetch(`${origin}/api/jobs/${jobId}/export`);
    assert.equal(exportResponse.status, 200);
    const exportBuffer = Buffer.from(await exportResponse.arrayBuffer());
    assert.equal(exportBuffer.subarray(0, 2).toString(), "PK");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (jobId) {
      await fs.rm(path.join(config.dataDir, `job-${jobId}.json`), { force: true });
      await fs.rm(path.join(config.dataDir, `job-${jobId}.json.tmp`), { force: true });
      await fs.rm(path.join(config.dataDir, `export-${jobId}.xlsx`), { force: true });
    }
  }
});
