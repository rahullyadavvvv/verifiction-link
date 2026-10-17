# LinkedIn Company URL Verifier

A local React dashboard and Express/Playwright worker that opens and checks HTTPS LinkedIn URLs from `.xlsx` and `.xls` spreadsheets, records cautious verification and (for company pages) company-name-match outcomes, and exports a formatted `.xlsx` report.

## Requirements

- Node.js 20 or newer and npm
- Chromium installed for Playwright
- [Ollama](https://ollama.com/download) for local AI company-name review

## Setup and run

From the project root:

```powershell
winget install Ollama.Ollama
npm install
Copy-Item .env.example backend\.env
npx playwright install chromium
ollama pull qwen2.5:3b
npm run dev
```

If Ollama is not already running after installation, start it in a separate terminal with `ollama serve`. Its local API listens on `http://127.0.0.1:11434` by default. The dashboard runs at `http://localhost:5173`; the API runs at `http://localhost:3001`. The dashboard displays the model connection status. For a production build, run `npm run build`, then start the API with `npm run start --workspace backend` and serve the built `frontend/dist` directory with a static web server that proxies `/api` to port 3001.

Environment values are optional; defaults are documented in `.env.example`. `OLLAMA_MODEL` selects an already-downloaded local model; `OLLAMA_URL` is restricted to loopback hosts so workbook evidence cannot be forwarded to a remote model by configuration. `DATA_DIR` stores job state and generated reports locally. Completed row data is checkpointed incrementally, so a paused or interrupted job can be resumed in the dashboard after restarting the API. Job data and generated files older than `FILE_RETENTION_DAYS` are removed at API startup.

For official API checks of company URLs, create a LinkedIn Developer application and obtain authorized 3-legged OAuth access for the Organization Lookup API. Store the access token in `backend/.env` as `LINKEDIN_API_ACCESS_TOKEN` and set `LINKEDIN_API_VERSION` to a currently supported `YYYYMM` API version. Never paste the token into chat, the workbook, or source files. The app uses the official vanity-name/organization-ID lookup endpoints for company URLs and marks each result `OFFICIAL_API`; other LinkedIn URL types continue using the browser verifier. LinkedIn's API access and organization permissions depend on the application/member's approval. Without a configured token, company checks use browser verification.

## Workflow

1. Upload an `.xlsx` or `.xls` workbook. The first worksheet is used; its first row is treated as headers. The workbook is held in memory only for the preview, expires after one hour, and is not modified.
2. Confirm or choose the LinkedIn URL and company-name columns. The preview reports total rows, non-empty URLs, and supported HTTPS LinkedIn URLs. Company-name comparisons apply to company-page links.
3. Set concurrency (default 2) and batch size, then start the job. Empty URLs are recorded as `MISSING_URL`; invalid formats are not navigated.
4. The Playwright bot opens each supported LinkedIn URL in a browser and checks the response, final URL, and visible page evidence; it does not accept HTTPS format alone as proof. When the company name and company-page heading are available, the local Ollama model also compares the name with visible page evidence; URL accessibility status remains based on browser evidence, not AI output.
5. Follow progress, pause/resume/cancel, search and filter results, recheck selected rows, and export the report.

The sample workbook can be generated with `npm run sample`; it is written to `samples/company-links-sample.xlsx`.

## API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/ai/status` | Local Ollama connection and configured model status |
| `GET` | `/api/linkedin/status` | Whether official LinkedIn API credentials are configured |
| `POST` | `/api/uploads/preview` | Multipart upload (`file`); returns preview and detected column mappings |
| `POST` | `/api/jobs` | Create a job with `uploadId`, `urlColumn`, optional `companyColumn`, `concurrency`, and `batchSize` |
| `GET` | `/api/jobs/:jobId` | Job status, progress, current row, and summary |
| `GET` | `/api/jobs/:jobId/results?offset=0&limit=50` | Paginated results; optional `search`, `status`, and `match` filters |
| `POST` | `/api/jobs/:jobId/pause` | Pause after in-flight row checks finish |
| `POST` | `/api/jobs/:jobId/resume` | Resume rows that have not completed |
| `POST` | `/api/jobs/:jobId/cancel` | Stop taking new rows; an active navigation may finish |
| `POST` | `/api/jobs/:jobId/recheck` | Recheck selected zero-based `rowIndexes` |
| `GET` | `/api/jobs/:jobId/export` | Download a formatted Excel report |

The API rejects uploads over the configured size/row limits, accepts only `.xlsx` and `.xls` signatures, and validates all job and pagination inputs. Result exports include the source columns and all added verification fields, including whether a row was checked via `OFFICIAL_API`, `BROWSER`, or not checked. User-controlled strings that could be interpreted as spreadsheet formulas are escaped.

## Verification statuses

| Status | Meaning |
| --- | --- |
| `VERIFIED_ACCESSIBLE` | A LinkedIn URL was opened and returned a page with visible evidence |
| `REDIRECTED_VALID` | The URL redirected and ended at a LinkedIn page with visible evidence |
| `INVALID_URL_FORMAT` | Not a supported HTTPS LinkedIn URL |
| `PAGE_NOT_FOUND` | LinkedIn returned a not-found response or clear not-found page evidence |
| `LOGIN_REQUIRED` | LinkedIn redirected to login/authwall or required authentication |
| `ACCESS_RESTRICTED` | Access was restricted or an unsafe navigation was blocked |
| `RATE_LIMITED` | LinkedIn rate-limited the request; the job pauses automatically |
| `NETWORK_ERROR` | Transient navigation/network/server failure after configured retries |
| `CAPTCHA_REQUIRED` | LinkedIn presented a CAPTCHA or browser challenge |
| `MANUAL_REVIEW` | Available evidence was inconclusive |
| `MISSING_URL` | The spreadsheet URL cell was empty |

Company matching is reported separately: `MATCH`, `POSSIBLE_MATCH`, `MISMATCH`, or `UNKNOWN`. The local Ollama model compares the spreadsheet name, detected page heading, title, and a short visible-text excerpt; if Ollama is unavailable, conservative token matching is used and marked `UNAVAILABLE`. The model does not determine URL validity or accessibility. URL success rate counts `VERIFIED_ACCESSIBLE` and `REDIRECTED_VALID` among rows with non-empty URLs. The report separately includes the URL-classification percentage and AI review/fallback counts.

## Safety and limitations

- Browser verification uses Playwright directly for bounded bulk processing. It never signs in, stores LinkedIn browser credentials/cookies, bypasses CAPTCHAs, hides automation, or rotates identities. If configured, company-page checks use LinkedIn's official Organization Lookup API with the supplied authorized access token. LinkedIn may require API permissions or limit access; such outcomes are reported as restricted rather than treated as evidence that a page is missing.
- HTTPS URLs on `linkedin.com` and `www.linkedin.com` are accepted as inputs, including company, profile, post, school, and other LinkedIn pages. Browser routing permits LinkedIn/LinkedIn CDN resources, rejects other navigation destinations, resolves destinations, and blocks private, loopback, local, and otherwise non-public IP addresses.
- The workbook is not uploaded to an external service. Browser checks make requests to LinkedIn; when configured, company lookup requests are made to `api.linkedin.com` with the access token kept server-side. Only the expected company name and short LinkedIn-page evidence are sent to the loopback Ollama process; neither is sent to a cloud AI service. Other spreadsheet columns are not submitted. The sample links are illustrative and are not integration-test targets.
- `MISSING_URL` rows are created at job start and retained in the report. Rechecking is explicit; completed rows are otherwise not repeated. A recheck of one row does not automatically recheck other rows sharing its URL.
- A browser/network failure cannot always distinguish a deleted page from LinkedIn-side access policy; inconclusive evidence remains `MANUAL_REVIEW` or a restriction status rather than being guessed as nonexistent.
- The success rate is not an assertion about the completeness of LinkedIn's public data. HTTPS format or HTTP 200 alone is never accepted as proof of a valid page; visible evidence is required.

## Playwright MCP

The backend does not depend on an MCP client or server: MCP tools are not exposed to the backend process in this workspace, and bulk jobs need a bounded Node.js worker. The official Playwright MCP server is optional for interactive exploration/debugging in a compatible MCP client. Its current standard stdio configuration is:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

See the [official Playwright MCP documentation](https://github.com/microsoft/playwright-mcp) for client-specific setup. Configure it in the MCP client separately; this application does not automatically discover, launch, or call that server.

## Tests

```powershell
npm test
npm run build
```

Tests use deterministic URL, evidence-classification, local Ollama request/response, SSRF-guard, name-matching, and Excel export fixtures, plus an API integration test for upload-to-download. Live LinkedIn checks are intentionally not part of the test suite.
