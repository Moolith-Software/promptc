import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, expandIncludes, extractMarkdownSections, slugifyHeading } from "../src/index.js";

let root: string;
let outside: string;

const guide = `# Policy

Intro.

## Eligibility

Refunds within 14 days.

### Annual plans

30 days, pro-rated.

## How to request

Email {{ company.email }}.

## Exceptions

Ask a lead.
`;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pg-inc-"));
  outside = mkdtempSync(join(tmpdir(), "pg-out-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/guide.md"), guide);
  writeFileSync(join(root, "docs/data.json"), '{ "a": 1 }\n');
  writeFileSync(join(root, "docs/a.md"), 'A then @include("docs/b.md")');
  writeFileSync(join(root, "docs/b.md"), 'B then @include("docs/a.md")');
  writeFileSync(join(root, "docs/nested.md"), 'Nested: @include("docs/guide.md#exceptions")');
  writeFileSync(join(outside, "secret.md"), "secret");
  symlinkSync(join(outside, "secret.md"), join(root, "docs/link.md"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("slugify lowercases, drops punctuation, collapses whitespace to one hyphen", () => {
  assert.equal(slugifyHeading("Color & Contrast"), "color-contrast");
  assert.equal(slugifyHeading("  Getting Started "), "getting-started");
});

test("single section includes its subsections and stops at the next sibling", () => {
  const s = extractMarkdownSections(guide, "eligibility")!;
  assert.match(s, /^## Eligibility/);
  assert.match(s, /### Annual plans/);
  assert.doesNotMatch(s, /## How to request/);
});

test("comma list and range fragments", () => {
  const list = extractMarkdownSections(guide, "eligibility,exceptions")!;
  assert.match(list, /Refunds within 14 days/);
  assert.match(list, /Ask a lead/);
  assert.doesNotMatch(list, /Email/);
  const range = extractMarkdownSections(guide, "eligibility..how-to-request")!;
  assert.match(range, /Refunds within 14 days[\s\S]*Email/);
  assert.doesNotMatch(range, /Ask a lead/);
  assert.equal(extractMarkdownSections(guide, "how-to-request..eligibility"), undefined);
});

test("quoted and bare directive forms, JSON fenced", () => {
  const r = expandIncludes(`@include("docs/guide.md#how-to-request") | @include(docs/data.json)`, { root });
  assert.deepEqual(r.diagnostics, []);
  assert.match(r.text, /## How to request/);
  assert.match(r.text, /```json\n\{ "a": 1 \}\n```/);
});

test("nested includes expand", () => {
  const r = expandIncludes(`@include("docs/nested.md")`, { root });
  assert.match(r.text, /Nested: ## Exceptions/);
});

test("errors: missing file, missing fragment, cycle, escape, symlink escape", () => {
  const code = (src: string) => expandIncludes(src, { root }).diagnostics.map(d => d.code);
  assert.deepEqual(code(`@include("docs/nope.md")`), ["INCLUDE_NOT_FOUND"]);
  assert.deepEqual(code(`@include("docs/guide.md#exception")`), ["INCLUDE_FRAGMENT_NOT_FOUND"]);
  assert.deepEqual(code(`@include("docs/a.md")`), ["INCLUDE_CYCLE"]);
  assert.deepEqual(code(`@include("../etc/passwd")`), ["INCLUDE_OUTSIDE_ROOT"]);
  assert.deepEqual(code(`@include("/etc/passwd")`), ["INCLUDE_OUTSIDE_ROOT"]);
  assert.deepEqual(code(`@include("docs/link.md")`), ["INCLUDE_OUTSIDE_ROOT"]);
});

test("included content is checked and rendered with Twig", () => {
  const engine = createEngine({ includeRoot: root, namespaces: { company: { kind: "static", data: { email: "help@example.com" } } } });
  assert.match(engine.render(`@include("docs/guide.md#how-to-request")`), /Email help@example\.com\./);
  const bad = createEngine({ includeRoot: root, namespaces: { company: { kind: "static", data: {} } } });
  assert.equal(bad.checkTemplate(`@include("docs/guide.md#how-to-request")`).ok, false);
});
