import type { CompanyMatchStatus } from "./types.js";

export function compareCompanyNames(expected: string, actual: string): CompanyMatchStatus {
  const normalize = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  const left = normalize(expected);
  const right = normalize(actual);
  if (!left || !right) return "UNKNOWN";
  if (left === right) return "MATCH";

  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const tokenSimilarity = union ? intersection / union : 0;
  const smallerTokenSet = leftTokens.size <= rightTokens.size ? leftTokens : rightTokens;
  const largerTokenSet = leftTokens.size <= rightTokens.size ? rightTokens : leftTokens;
  const completeTokenSubset = [...smallerTokenSet].every((token) => largerTokenSet.has(token));
  if (completeTokenSubset || tokenSimilarity >= 0.75) return "POSSIBLE_MATCH";
  return "MISMATCH";
}
