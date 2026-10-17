import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export interface ParsedLinkedInUrl {
  normalizedUrl: string;
  companyIdentifier?: string;
}

export function parseLinkedInUrl(value: string): ParsedLinkedInUrl | null {
  if (!value.trim()) return null;

  try {
    const trimmed = value.trim();
    const inputHost = trimmed.replace(/^https?:\/\//i, "").match(/^((?:[a-z0-9-]+\.)*linkedin\.com)(?=[:/?#]|$)/i)?.[1];
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
      ? trimmed
      : inputHost ? `https://${trimmed}` : trimmed;
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!isLinkedInHost(host) || url.username || url.password || url.port) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.protocol = "https:";

    const companyMatch = url.pathname.match(/^\/company\/([^/?#]+)\/?$/i);
    const identifier = companyMatch ? decodeURIComponent(companyMatch[1]) : undefined;
    if (identifier !== undefined && (!identifier || /[\\/]/.test(identifier))) return null;
    url.hash = "";

    return {
      normalizedUrl: identifier
        ? `https://www.linkedin.com/company/${encodeURIComponent(identifier)}/`
        : `https://www.linkedin.com${url.pathname}${url.search}`,
      ...(identifier ? { companyIdentifier: identifier } : {}),
    };
  } catch {
    return null;
  }
}

export function parseLinkedInCompanyUrl(value: string): ParsedLinkedInUrl | null {
  const parsed = parseLinkedInUrl(value);
  return parsed?.companyIdentifier ? parsed : null;
}

function isPublicIp(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isIP(host)) return !isPublicIp(host);
  return false;
}

export function isLinkedInHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

export async function assertPublicDestination(
  value: string,
  resolve: (hostname: string) => Promise<string[]> = async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address),
): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || isBlockedHostname(url.hostname)) {
    throw new Error("Unsafe destination blocked");
  }

  const addresses = isIP(url.hostname) ? [url.hostname] : await resolve(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address))) {
    throw new Error("Destination resolves to a non-public address");
  }
  return url;
}

export function isCompanyPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && isLinkedInHost(url.hostname) && /^\/company\/[^/?#]+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function isLinkedInPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && isLinkedInHost(url.hostname);
  } catch {
    return false;
  }
}
