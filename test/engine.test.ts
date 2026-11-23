import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine, GuardrailError, type NamespaceDecl } from "../src/index.js";

const namespaces: Record<string, NamespaceDecl> = {
  company: { kind: "static", data: { name: "Acme", contact: { email: "help@example.com" }, rules: ["a", "b"] } },
  customer: {
    kind: "runtime",
    shape: { plan: "pro", seats: 3, invoices: [{ id: 1 }] },
  },
  account: {
    kind: "computed",
    rules: {
      isPaid: "customer.plan != 'free'",
      isTeam: "account.isPaid and customer.seats >= 10",
      invoiceCount: "customer.invoices|length",
      label: "'Plan: ' ~ customer.plan",
    },
  },
};

const liveCustomer = { plan: "pro", seats: 12, invoices: [{ id: 1 }, { id: 2 }] };
const codes = (diags: { code: string }[]) => diags.map(d => d.code);

test("renders variables, conditionals, loops and computed values", () => {
  const engine = createEngine({ namespaces });
  const out = engine.render(
    "{{ company.name }}|{% if account.isTeam %}team{% else %}solo{% endif %}|{{ account.invoiceCount }}|{{ account.label }}|{% for r in company.rules %}{{ r }}{% endfor %}",
    { data: { customer: liveCustomer } },
  );
  assert.equal(out, "Acme|team|2|Plan: pro|ab");
});

test("computed values keep their real types", () => {
  const engine = createEngine({ namespaces });
  const { values, diagnostics } = engine.evaluateComputed({ customer: liveCustomer });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(values.account, { isPaid: true, isTeam: true, invoiceCount: 2, label: "Plan: pro" });
});

test("computed values re-evaluate per render", () => {
  const engine = createEngine({ namespaces });
  const tpl = "{% if account.isTeam %}team{% else %}solo{% endif %}";
  assert.equal(engine.render(tpl, { data: { customer: liveCustomer } }), "team");
  assert.equal(engine.render(tpl, { data: { customer: { ...liveCustomer, seats: 2 } } }), "solo");
});

test("check: typos get did-you-mean hints", () => {
  const engine = createEngine({ namespaces });
  const r = engine.checkTemplate("{{ company.contact.emial }} {{ compny.name }} {{ account.isPiad }} {{ customer.seat }}");
  assert.equal(r.ok, false);
  const hints = r.diagnostics.map(d => d.hint);
  assert.ok(hints.includes("Did you mean company.contact.email?"));
  assert.ok(hints.includes("Did you mean company?"));
  assert.ok(hints.includes("Did you mean account.isPaid?"));
  assert.ok(hints.includes("Did you mean customer.seats?"));
});

test("check: runtime namespaces without a shape accept any key", () => {
  const engine = createEngine({ namespaces: { user: { kind: "runtime" } } });
  assert.equal(engine.checkTemplate("{{ user.anything.at.all }}").ok, true);
});

test("check: guarded references to missing keys are allowed", () => {
  const engine = createEngine({ namespaces });
  const r = engine.checkTemplate("{{ customer.notes|default('') }} {% if customer.extra is defined %}{{ customer.extra.x }}{% endif %}");
  assert.deepEqual(r.diagnostics, []);
});

test("check: syntax errors are reported, not thrown", () => {
  const engine = createEngine({ namespaces });
  const r = engine.checkTemplate("{% if company.name %}no end");
  assert.deepEqual(codes(r.diagnostics), ["TEMPLATE_SYNTAX"]);
});

test("check: unused computed rules are warnings", () => {
  const engine = createEngine({ namespaces });
  const r = engine.check({ a: "{{ account.isTeam }}" });
  assert.equal(r.ok, true);
  const unused = r.diagnostics.filter(d => d.code === "UNUSED_COMPUTED").map(d => d.path).sort();
  // isPaid is used by isTeam, so it is not reported
  assert.deepEqual(unused, ["account.invoiceCount", "account.label"]);
});

test("strict render refuses missing runtime data", () => {
  const engine = createEngine({ namespaces });
  assert.throws(
    () => engine.render("{{ customer.plan }}"),
    (err: unknown) => err instanceof GuardrailError && codes(err.diagnostics).includes("RUNTIME_NOT_PROVIDED"),
  );
});

test("strict render refuses keys missing from live data", () => {
  const engine = createEngine({ namespaces });
  assert.throws(
    () => engine.render("{{ customer.billing.cycle }}", { data: { customer: liveCustomer } }),
    (err: unknown) => err instanceof GuardrailError && codes(err.diagnostics).includes("VAR_MISSING_AT_RENDER"),
  );
});

test("strict render only checks branches that actually run", () => {
  const engine = createEngine({ namespaces: { c: { kind: "runtime" }, crm: { kind: "runtime" } } });
  const tpl = "{% if c.plan == 'enterprise' %}{{ c.manager }} {{ crm.notes }}{% else %}self-serve{% endif %}";
  // Untaken branch: neither c.manager nor the missing crm namespace matters.
  assert.equal(engine.render(tpl, { data: { c: { plan: "trial" } } }), "self-serve");
  // Taken branch: both are reported, together.
  assert.throws(
    () => engine.render(tpl, { data: { c: { plan: "enterprise" } } }),
    (err: unknown) =>
      err instanceof GuardrailError &&
      codes(err.diagnostics).sort().join() === "RUNTIME_NOT_PROVIDED,VAR_MISSING_AT_RENDER",
  );
});

test("strict render ignores loop bodies that never run", () => {
  const engine = createEngine({ namespaces: { c: { kind: "runtime" } } });
  assert.equal(engine.render("{% for i in c.items %}{{ c.header }}{% endfor %}done", { data: { c: { items: [] } } }), "done");
});

test("non-strict render prints blanks like plain Twig", () => {
  const engine = createEngine({ namespaces, strict: false });
  assert.equal(engine.render("[{{ customer.plan }}]"), "[]");
});

test("render rejects data for undeclared namespaces", () => {
  const engine = createEngine({ namespaces });
  assert.throws(
    () => engine.render("{{ company.name }}", { data: { surprise: {} } }),
    (err: unknown) => err instanceof GuardrailError && codes(err.diagnostics).includes("RUNTIME_UNDECLARED"),
  );
});

test("runtime load() is called on each render", () => {
  let n = 0;
  const engine = createEngine({ namespaces: { counter: { kind: "runtime", load: () => ({ n: ++n }) } } });
  assert.equal(engine.render("{{ counter.n }}"), "1");
  assert.equal(engine.render("{{ counter.n }}"), "2");
});

test("computed rule validation", () => {
  const engine = createEngine({
    namespaces: {
      data: { kind: "static", data: { x: 1 } },
      f: {
        kind: "computed",
        rules: {
          notString: true,
          forward: "f.later and true",
          later: "data.x == 1",
          badKey: "data.y == 1",
          syntax: "(data.x ==",
          prose: "This is prose",
          "bad-name": "true",
          self: "f.self",
        },
      },
    },
  });
  const byRule = (rule: string) => engine.configDiagnostics.filter(d => d.source === `computed:f.${rule}`).map(d => d.code);
  assert.deepEqual(byRule("notString"), ["COMPUTED_NOT_STRING"]);
  assert.deepEqual(byRule("forward"), ["COMPUTED_FORWARD_REF"]);
  assert.deepEqual(byRule("later"), []);
  assert.deepEqual(byRule("badKey"), ["VAR_UNRESOLVED"]);
  assert.deepEqual(byRule("syntax"), ["COMPUTED_SYNTAX"]);
  assert.ok(byRule("prose").every(c => c === "VAR_UNKNOWN_NAMESPACE") && byRule("prose").length > 0);
  assert.deepEqual(byRule("bad-name"), ["VAR_HYPHEN"]);
  assert.deepEqual(byRule("self"), ["COMPUTED_FORWARD_REF"]);
});

test("computed namespaces may use earlier computed namespaces, not later ones", () => {
  const engine = createEngine({
    namespaces: {
      a: { kind: "computed", rules: { one: "1", usesB: "b.two" } },
      b: { kind: "computed", rules: { two: "2", usesA: "a.one + 1" } },
    },
  });
  const codesFor = (src: string) => engine.configDiagnostics.filter(d => d.source === src).map(d => d.code);
  assert.deepEqual(codesFor("computed:a.usesB"), ["COMPUTED_FORWARD_REF"]);
  assert.deepEqual(codesFor("computed:b.usesA"), []);
  assert.equal(engine.evaluateComputed().values.b.usesA, 2);
});

test("hyphenated data keys warn, and bracket access still works", () => {
  const engine = createEngine({ namespaces: { t: { kind: "static", data: { "sign-in": "Sign in" } } } });
  assert.deepEqual(codes(engine.configDiagnostics), ["VAR_HYPHEN"]);
  assert.equal(engine.render("{{ t['sign-in'] }}"), "Sign in");
});

test("invalid namespace names are rejected", () => {
  const engine = createEngine({ namespaces: { loop: { kind: "static", data: {} }, "my-ns": { kind: "static", data: {} } } });
  assert.deepEqual(codes(engine.configDiagnostics), ["NAMESPACE_INVALID", "NAMESPACE_INVALID"]);
});

test("output is not HTML-escaped", () => {
  const engine = createEngine({ namespaces: { s: { kind: "static", data: { v: "<b>&\"" } } } });
  assert.equal(engine.render("{{ s.v }}"), "<b>&\"");
});
