import type { Browser, Page, Route } from "playwright";
import { assertPublicDestination, isCompanyPageUrl, isLinkedInHost, isLinkedInPageUrl, parseLinkedInUrl } from "./urls.js";
import type { AiReviewStatus, CompanyMatchStatus, VerificationMethod, VerificationStatus } from "./types.js";

export interface VerificationOutcome {
  normalizedUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  verificationStatus: VerificationStatus;
  verificationMethod: VerificationMethod;
  detectedCompanyName: string;
  companyMatchStatus: CompanyMatchStatus;
  aiReviewStatus: AiReviewStatus;
  aiMatchReason: string;
  aiModel: string;
  redirectDetected: boolean;
  errorDetails: string;
  retryCount: number;
}

export interface BrowserVerificationOutcome extends Omit<VerificationOutcome, "companyMatchStatus" | "aiReviewStatus" | "aiMatchReason" | "aiModel"> {
  pageTitle: string;
  pageEvidence: string;
}

export function getOrCreateVerification<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  verify: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const result = verify();
  cache.set(key, result);
  return result;
}

export function classifyEvidence(input: {
  statusCode: number | null;
  finalUrl: string;
  title: string;
  bodyText: string;
  detectedName: string;
  redirected: boolean;
  blockedReason?: string;
  navigationError?: string;
}): Pick<VerificationOutcome, "verificationStatus" | "errorDetails"> {
  const text = `${input.title}\n${input.bodyText}`.toLowerCase();
  if (/captcha|verify you are human|security challenge/.test(text)) {
    return { verificationStatus: "CAPTCHA_REQUIRED", errorDetails: "LinkedIn presented a browser verification challenge." };
  }
  if (input.statusCode === 429 || /too many requests|rate limit/.test(text)) {
    return { verificationStatus: "RATE_LIMITED", errorDetails: "LinkedIn temporarily limited requests." };
  }
  if (/\/(login|authwall)(\/|$)/i.test(new URL(input.finalUrl).pathname) || input.statusCode === 401) {
    return { verificationStatus: "LOGIN_REQUIRED", errorDetails: "LinkedIn requires authentication to inspect this page." };
  }
  if (input.statusCode === 403 || input.statusCode === 451) {
    return { verificationStatus: "ACCESS_RESTRICTED", errorDetails: `LinkedIn restricted access (HTTP ${input.statusCode}).` };
  }
  if (input.statusCode === 404 || /page not found|this page doesn.t exist|couldn.t find this page/.test(text)) {
    return { verificationStatus: "PAGE_NOT_FOUND", errorDetails: "LinkedIn indicated that the page was not found." };
  }
  if (input.blockedReason) {
    return { verificationStatus: "ACCESS_RESTRICTED", errorDetails: input.blockedReason };
  }
  if (input.navigationError) {
    return { verificationStatus: "NETWORK_ERROR", errorDetails: input.navigationError };
  }
  if (input.statusCode === null) {
    return { verificationStatus: "MANUAL_REVIEW", errorDetails: "No HTTP response was available to verify the page." };
  }
  if (input.statusCode >= 500) {
    return { verificationStatus: "NETWORK_ERROR", errorDetails: `LinkedIn returned HTTP ${input.statusCode}.` };
  }
  if (input.statusCode >= 400) {
    return { verificationStatus: "MANUAL_REVIEW", errorDetails: `LinkedIn returned HTTP ${input.statusCode}; page validity could not be confirmed.` };
  }
  if (isLinkedInPageUrl(input.finalUrl) &&
      (isCompanyPageUrl(input.finalUrl)
        ? Boolean(input.detectedName)
        : Boolean(input.detectedName || (input.title && input.bodyText.trim().length >= 120)))) {
    return {
      verificationStatus: input.redirected ? "REDIRECTED_VALID" : "VERIFIED_ACCESSIBLE",
      errorDetails: "",
    };
  }
  return { verificationStatus: "MANUAL_REVIEW", errorDetails: "The response did not provide sufficient evidence of a LinkedIn page." };
}

function isAllowedResourceHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return isLinkedInHost(host) || host === "licdn.com" || host.endsWith(".licdn.com");
}

async function configureSafeRouting(page: Page, blocked: { reason: string }): Promise<void> {
  await page.route("**/*", async (route: Route) => {
    const requestUrl = route.request().url();
    try {
      const destination = await assertPublicDestination(requestUrl);
      const host = destination.hostname.toLowerCase();
      if (!isAllowedResourceHost(host)) {
        if (route.request().isNavigationRequest()) blocked.reason = "An unsafe redirect outside LinkedIn was blocked.";
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    } catch (error) {
      if (route.request().isNavigationRequest() && error instanceof Error &&
          /Unsafe destination blocked|non-public address/i.test(error.message)) {
        blocked.reason = error.message;
      }
      await route.abort("blockedbyclient");
    }
  });
}

async function visibleText(page: Page): Promise<string> {
  try {
    return (await page.locator("body").innerText({ timeout: 3000 })).slice(0, 12000);
  } catch {
    return "";
  }
}

export async function verifyLinkedInUrl(
  browser: Browser,
  rawUrl: string,
  timeoutMs: number,
): Promise<BrowserVerificationOutcome> {
  const parsed = parseLinkedInUrl(rawUrl);
  if (!parsed) {
    return {
      normalizedUrl: "",
      finalUrl: "",
      httpStatus: null,
      verificationStatus: "INVALID_URL_FORMAT",
      verificationMethod: "NOT_CHECKED",
      detectedCompanyName: "",
      redirectDetected: false,
      errorDetails: "Expected an HTTPS LinkedIn URL.",
      retryCount: 0,
      pageTitle: "",
      pageEvidence: "",
    };
  }

  const context = await browser.newContext({ serviceWorkers: "block" });
  const blocked = { reason: "" };
  let responseStatus: number | null = null;
  let navigationError = "";
  let detectedName = "";
  let title = "";
  let bodyText = "";
  let finalUrl = parsed.normalizedUrl;

  try {
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(timeoutMs);
    page.setDefaultTimeout(timeoutMs);
    await configureSafeRouting(page, blocked);
    try {
      const response = await page.goto(parsed.normalizedUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      responseStatus = response?.status() ?? null;
      finalUrl = page.url() || parsed.normalizedUrl;
      await page.waitForTimeout(500);
      title = await page.title().catch(() => "");
      bodyText = await visibleText(page);
      detectedName = await page.locator("main h1, h1").first().innerText({ timeout: 2000 }).catch(() => "");
      detectedName = detectedName.trim().slice(0, 250);
    } catch (error) {
      navigationError = error instanceof Error ? error.message.slice(0, 500) : "Navigation failed.";
      finalUrl = page.url() || parsed.normalizedUrl;
    }
  } finally {
    await context.close();
  }

  const evidence = classifyEvidence({
    statusCode: responseStatus,
    finalUrl,
    title,
    bodyText,
    detectedName,
    redirected: finalUrl !== parsed.normalizedUrl,
    blockedReason: blocked.reason,
    navigationError,
  });
  return {
    normalizedUrl: parsed.normalizedUrl,
    finalUrl,
    httpStatus: responseStatus,
    verificationStatus: evidence.verificationStatus,
    verificationMethod: "BROWSER",
    detectedCompanyName: detectedName,
    redirectDetected: finalUrl !== parsed.normalizedUrl,
    errorDetails: evidence.errorDetails,
    retryCount: 0,
    pageTitle: title,
    pageEvidence: bodyText,
  };
}
