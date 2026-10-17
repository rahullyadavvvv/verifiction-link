import { config } from "./config.js";
import type { VerificationMethod, VerificationStatus } from "./types.js";

export interface LinkedInApiOutcome {
  normalizedUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  verificationStatus: VerificationStatus;
  verificationMethod: VerificationMethod;
  detectedCompanyName: string;
  redirectDetected: boolean;
  errorDetails: string;
  retryCount: number;
  pageTitle: string;
  pageEvidence: string;
}

interface Organization {
  vanityName?: unknown;
  localizedName?: unknown;
  name?: {
    localized?: Record<string, unknown>;
    preferredLocale?: { language?: string; country?: string };
  };
  id?: unknown;
}

function readName(organization: Organization): string {
  if (typeof organization.localizedName === "string") return organization.localizedName.trim();
  const localized = organization.name?.localized;
  const preferredLocale = organization.name?.preferredLocale;
  const localeKey = preferredLocale?.language && preferredLocale.country
    ? `${preferredLocale.language}_${preferredLocale.country}`
    : "";
  const name = (localeKey && localized?.[localeKey]) ?? Object.values(localized ?? {})[0];
  return typeof name === "string" ? name.trim() : "";
}

export function getLinkedInApiStatus() {
  const configured = Boolean(config.linkedInApiAccessToken);
  return {
    configured,
    apiVersion: config.linkedInApiVersion,
    message: configured
      ? `Official LinkedIn Organization Lookup API is configured (version ${config.linkedInApiVersion}).`
      : "Official LinkedIn API is not configured. Add an authorized access token in backend/.env to verify company pages through the API.",
  };
}

export async function verifyCompanyWithLinkedInApi(
  normalizedUrl: string,
  vanityName: string,
  accessToken = config.linkedInApiAccessToken,
  apiVersion = config.linkedInApiVersion,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkedInApiOutcome> {
  const base: LinkedInApiOutcome = {
    normalizedUrl,
    finalUrl: normalizedUrl,
    httpStatus: null,
    verificationStatus: "NETWORK_ERROR",
    verificationMethod: "OFFICIAL_API",
    detectedCompanyName: "",
    redirectDetected: false,
    errorDetails: "",
    retryCount: 0,
    pageTitle: "",
    pageEvidence: "",
  };
  if (!accessToken) {
    return {
      ...base,
      verificationStatus: "ACCESS_RESTRICTED",
      errorDetails: "Official LinkedIn API access is not configured.",
    };
  }

  const numericId = /^\d+$/.test(vanityName);
  const endpoint = new URL(numericId
    ? "https://api.linkedin.com/rest/organizationsLookup"
    : "https://api.linkedin.com/rest/organizations");
  if (numericId) {
    endpoint.searchParams.set("ids", `List(${vanityName})`);
  } else {
    endpoint.searchParams.set("q", "vanityName");
    endpoint.searchParams.set("vanityName", vanityName);
  }
  try {
    const response = await fetchImpl(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0",
        "Linkedin-Version": apiVersion,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(config.navigationTimeoutMs),
    });
    const responseBase = { ...base, httpStatus: response.status };
    if (response.status === 401) {
      return { ...responseBase, verificationStatus: "ACCESS_RESTRICTED", errorDetails: "LinkedIn rejected the API access token; refresh or reauthorize it." };
    }
    if (response.status === 403) {
      return { ...responseBase, verificationStatus: "ACCESS_RESTRICTED", errorDetails: "LinkedIn API access is not authorized for this organization or permission." };
    }
    if (response.status === 429) {
      return { ...responseBase, verificationStatus: "RATE_LIMITED", errorDetails: "LinkedIn API rate limit reached; the job will pause." };
    }
    if (response.status === 404) {
      return { ...responseBase, verificationStatus: "PAGE_NOT_FOUND", errorDetails: "LinkedIn API did not find this organization." };
    }
    if (!response.ok) {
      return {
        ...responseBase,
        verificationStatus: response.status >= 500 ? "NETWORK_ERROR" : "MANUAL_REVIEW",
        errorDetails: `LinkedIn Organization Lookup API returned HTTP ${response.status}.`,
      };
    }

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") {
      return { ...responseBase, verificationStatus: "MANUAL_REVIEW", errorDetails: "LinkedIn API returned an unexpected organization response." };
    }
    const data = payload as { elements?: unknown; results?: Record<string, Organization> };
    const organization = numericId
      ? data.results?.[vanityName]
      : Array.isArray(data.elements)
        ? (data.elements as Organization[]).find((item) =>
          typeof item.vanityName === "string" && item.vanityName.toLowerCase() === vanityName.toLowerCase(),
        )
        : undefined;
    if (!organization) {
      return { ...responseBase, verificationStatus: "PAGE_NOT_FOUND", errorDetails: "LinkedIn API returned no organization matching this vanity name." };
    }
    const detectedCompanyName = readName(organization);
    if (!detectedCompanyName) {
      return { ...responseBase, verificationStatus: "MANUAL_REVIEW", errorDetails: "LinkedIn API found the organization but did not return a display name." };
    }
    const pageTitle = `${detectedCompanyName} | LinkedIn`;
    return {
      ...responseBase,
      verificationStatus: "VERIFIED_ACCESSIBLE",
      detectedCompanyName,
      pageTitle,
      pageEvidence: JSON.stringify({
        vanityName: organization.vanityName,
        id: organization.id,
        localizedName: detectedCompanyName,
      }),
    };
  } catch (error) {
    return {
      ...base,
      errorDetails: error instanceof Error && error.name === "TimeoutError"
        ? "LinkedIn Organization Lookup API request timed out."
        : "Unable to reach the LinkedIn Organization Lookup API.",
    };
  }
}
