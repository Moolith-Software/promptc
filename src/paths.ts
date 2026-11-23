/** Helpers for dotted paths over plain JSON-like data. */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when every segment exists (the final value may be null/undefined). */
export function hasPath(obj: unknown, segments: string[]): boolean {
  let current: unknown = obj;
  for (const part of segments) {
    if (current === null || current === undefined || typeof current !== "object") return false;
    if (!(part in (current as object))) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

export function getPath(obj: unknown, segments: string[]): unknown {
  let current: unknown = obj;
  for (const part of segments) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Longest prefix of `segments` that exists in `obj`. Used to explain where a
 * path breaks: company.contact.emial → ["company", "contact"].
 */
export function existingPrefix(obj: unknown, segments: string[]): string[] {
  const out: string[] = [];
  let current: unknown = obj;
  for (const part of segments) {
    if (current === null || current === undefined || typeof current !== "object") break;
    if (!(part in (current as object))) break;
    out.push(part);
    current = (current as Record<string, unknown>)[part];
  }
  return out;
}

/** Every dotted key path whose last segment contains a hyphen. */
export function hyphenatedPaths(obj: unknown, prefix = "", out: string[] = []): string[] {
  if (!isPlainObject(obj)) return out;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (key.includes("-")) out.push(path);
    hyphenatedPaths(value, path, out);
  }
  return out;
}

/** Closest candidate by edit distance, if it is plausibly a typo. */
export function closest(target: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = levenshtein(target.toLowerCase(), c.toLowerCase());
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  const threshold = Math.max(2, Math.floor(target.length / 3));
  return best !== undefined && bestScore <= threshold ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
