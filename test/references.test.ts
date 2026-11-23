import { test } from "node:test";
import assert from "node:assert/strict";
import { extractReferences, extractPaths } from "../src/index.js";

const paths = (src: string) => extractPaths(src).sort();
const guarded = (src: string) =>
  Object.fromEntries(extractReferences(src).map(r => [r.path, r.guarded]));

test("captures dotted paths in output and logic tags", () => {
  assert.deepEqual(paths("{{ a.b.c }} {% if d.e %}{{ f }}{% endif %}"), ["a.b.c", "d.e", "f"]);
});

test("filters, functions and string literals are not variables", () => {
  assert.deepEqual(paths("{{ name|upper }} {{ range(1, n)|join(', ') }} {{ 'x.y' ~ z }}"), ["n", "name", "z"]);
});

test("loop variables, loop.*, set and setcapture locals are excluded", () => {
  const src = `{% for k, v in items %}{{ v.title }}{{ loop.index }}{{ k }}{% endfor %}
{% set total = cart.total %}{{ total }}
{% set note %}hi {{ user.name }}{% endset %}{{ note }}`;
  assert.deepEqual(paths(src), ["cart.total", "items", "user.name"]);
});

test("object literal keys are not variables, values are", () => {
  assert.deepEqual(paths("{{ {k: v.w, 'q': 1}|json_encode }}"), ["v.w"]);
});

test("bracket string keys fold into the path; dynamic keys are scanned", () => {
  assert.deepEqual(paths("{{ labels['sign-in'] }}"), ["labels.sign-in"]);
  assert.deepEqual(paths("{{ a[b.c].d }}"), ["a", "b.c"]);
});

test("macro parameters are local", () => {
  assert.deepEqual(paths("{% macro m(p) %}{{ p.x }}{{ g }}{% endmacro %}"), ["g"]);
});

test("is defined, |default, ?? and ?: mark a reference as guarded", () => {
  const g = guarded("{{ a is defined }} {{ b|default('x') }} {{ c ?? 'y' }} {{ d ?: e }} {{ f }}");
  assert.equal(g.a, true);
  assert.equal(g.b, true);
  assert.equal(g.c, true);
  assert.equal(g.d, true);
  assert.equal(g.e, false);
  assert.equal(g.f, false);
});

test("{% if x is defined %} guards x.* inside the branch only", () => {
  const refs = extractReferences(`{% if user.profile is defined %}{{ user.profile.bio }}{% endif %}
{{ user.profile.age }}`);
  const bio = refs.find(r => r.path === "user.profile.bio")!;
  const age = refs.find(r => r.path === "user.profile.age")!;
  assert.equal(bio.guarded, true);
  assert.equal(age.guarded, false);
});

test("is not defined does not guard the branch", () => {
  const refs = extractReferences("{% if x is not defined %}{{ x.y }}{% endif %}");
  assert.equal(refs.find(r => r.path === "x.y")!.guarded, false);
});

test("reports line numbers", () => {
  const refs = extractReferences("line one\n\n{{ a.b }}");
  assert.equal(refs[0].line, 3);
});

test("throws on invalid syntax", () => {
  assert.throws(() => extractReferences("{% if a %}unterminated"));
});
