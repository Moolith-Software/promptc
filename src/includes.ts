import { existsSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { error, type Diagnostic } from "./diagnostics.js";

/**
 * `@include(...)` composition, resolved before Twig sees the template.
 *
 *   @include("policies/refunds.md")                          whole file
 *   @include("policies/refunds.md#eligibility")              one section (heading slug)
 *   @include("policies/refunds.md#eligibility,exceptions")   several sections
 *   @include("policies/refunds.md#eligibility..exceptions")  a range of sections, inclusive
 *
 * Quotes are optional. Included markdown may itself contain @include and Twig;
 * JSON / YAML files are wrapped in fenced code blocks.
 */
export const INCLUDE_PATTERN = /@include\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)/g;

export interface IncludeOptions {
  /** Directory include paths resolve against, and that they may not escape. */
  root: string;
  /** Name of the including template, for diagnostics. */
  source?: string;
  /** Default 8. */
  maxDepth?: number;
}

export interface IncludeResult {
  text: string;
  diagnostics: Diagnostic[];
  /** Absolute paths of every file pulled in. */
  files: string[];
}

export function expandIncludes(text: string, options: IncludeOptions): IncludeResult {
  const diagnostics: Diagnostic[] = [];
  const files = new Set<string>();
  const root = safeRealpath(resolve(options.root));
  const maxDepth = options.maxDepth ?? 8;

  const expand = (input: string, stack: string[], source: string | undefined): string => {
    INCLUDE_PATTERN.lastIndex = 0;
    return input.replace(INCLUDE_PATTERN, (directive, dq, sq, bare, offset: number) => {
      const spec = String(dq ?? sq ?? bare).trim();
      const line = input.slice(0, offset).split("\n").length;
      const at = { source, line };

      const hashAt = spec.lastIndexOf("#");
      const rawPath = hashAt >= 0 ? spec.slice(0, hashAt) : spec;
      const fragment = hashAt >= 0 ? spec.slice(hashAt + 1).trim() : undefined;

      if (!rawPath) {
        diagnostics.push(error("INCLUDE_NOT_FOUND", `Empty include path in ${directive}`, at));
        return directive;
      }
      if (stack.length >= maxDepth) {
        diagnostics.push(error("INCLUDE_DEPTH", `Include nesting deeper than ${maxDepth} at ${directive}`, at));
        return directive;
      }

      const target = resolve(root, rawPath);
      if (isAbsolute(rawPath) || !isInside(root, target)) {
        diagnostics.push(error("INCLUDE_OUTSIDE_ROOT", `${rawPath} resolves outside the include root`, {
          ...at, hint: `Include paths are relative to ${root} and may not leave it.`,
        }));
        return directive;
      }
      if (!existsSync(target)) {
        diagnostics.push(error("INCLUDE_NOT_FOUND", `No file at ${rawPath}`, at));
        return directive;
      }
      const real = safeRealpath(target);
      if (!isInside(root, real)) {
        diagnostics.push(error("INCLUDE_OUTSIDE_ROOT", `${rawPath} is a link that points outside the include root`, at));
        return directive;
      }
      if (stack.includes(real)) {
        diagnostics.push(error("INCLUDE_CYCLE", `Include cycle: ${[...stack, real].map(p => relative(root, p)).join(" → ")}`, at));
        return directive;
      }

      files.add(real);
      const content = readFileSync(real, "utf-8");
      const ext = extname(real).toLowerCase();

      let body: string;
      if (fragment) {
        const section = extractMarkdownSections(content, fragment);
        if (section === undefined) {
          diagnostics.push(error("INCLUDE_FRAGMENT_NOT_FOUND", `No heading matching #${fragment} in ${rawPath}`, {
            ...at, hint: `Available: ${parseHeadings(content).map(h => `#${h.slug}`).join(", ") || "(no headings)"}`,
          }));
          return directive;
        }
        body = section;
      } else if (ext === ".json") {
        return "```json\n" + content.trim() + "\n```";
      } else if (ext === ".yaml" || ext === ".yml") {
        return "```yaml\n" + content.trim() + "\n```";
      } else {
        body = content.trim();
      }
      return expand(body, [...stack, real], relative(root, real));
    });
  };

  const text2 = expand(text, [], options.source);
  return { text: text2, diagnostics, files: [...files] };
}

// ---------------------------------------------------------------------------
// Markdown sections
// ---------------------------------------------------------------------------

interface Heading {
  idx: number;
  level: number;
  slug: string;
}

/** Heading slug: "Color & Contrast" → "color-contrast" (whitespace runs collapse to one hyphen). */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .replace(/\s+/g, "-");
}

export function parseHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  content.split("\n").forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    const m = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (m) headings.push({ idx, level: m[1].length, slug: slugifyHeading(m[2]) });
  });
  return headings;
}

function sectionEnd(headings: Heading[], hi: number, totalLines: number): number {
  const level = headings[hi].level;
  for (const h of headings.slice(hi + 1)) {
    if (h.level <= level) return h.idx;
  }
  return totalLines;
}

/** Returns the requested section(s), or undefined if any slug is missing. */
export function extractMarkdownSections(content: string, fragment: string): string | undefined {
  const lines = content.split("\n");
  const headings = parseHeadings(content);
  const find = (slug: string) => headings.findIndex(h => h.slug === slug.trim());
  const slice = (from: number, to: number) => lines.slice(from, to).join("\n").trimEnd();

  if (fragment.includes("..")) {
    const [a, b] = fragment.split("..", 2);
    const start = find(a);
    const end = find(b);
    if (start < 0 || end < 0 || end < start) return undefined;
    return slice(headings[start].idx, sectionEnd(headings, end, lines.length));
  }

  const parts: string[] = [];
  for (const slug of fragment.split(",")) {
    const hi = find(slug);
    if (hi < 0) return undefined;
    parts.push(slice(headings[hi].idx, sectionEnd(headings, hi, lines.length)));
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
