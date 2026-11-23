import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createEngineFromDir, loadVarsDir, GuardrailError } from "../src/index.js";

const example = resolve("examples/support-agent");

test("loads the example manifest into the right namespace kinds", () => {
  const ns = loadVarsDir(join(example, "vars"));
  assert.equal(ns.company.kind, "static");
  assert.equal(ns.customer.kind, "runtime");
  assert.equal(ns.ticket.kind, "runtime");
  assert.equal(ns.status.kind, "computed");
});

test("example prompt checks clean and renders with runtime data", () => {
  const engine = createEngineFromDir(join(example, "vars"), { includeRoot: example });
  const tpl = join(example, "prompts/support.md");
  const check = engine.check({ [tpl]: readFileSync(tpl, "utf-8") });
  assert.deepEqual(check.diagnostics, []);
  const read = (f: string) => JSON.parse(readFileSync(join(example, f), "utf-8"));
  const out = engine.renderFile(tpl, { data: { customer: read("runtime/customer.json"), ticket: read("runtime/ticket.json") } });
  assert.match(out, /Priya's free trial ends in 2 days/);   // trialEndingSoon branch
  assert.doesNotMatch(out, /Enterprise plan/);
  assert.doesNotMatch(out, /## Escalation/);
  assert.match(out, /## How to request/);                    // include range
  assert.doesNotMatch(out, /## Exceptions/);
});

test("runtime data file is re-read on every render", () => {
  const dir = mkdtempSync(join(tmpdir(), "pg-vars-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ runtime: ["job"] }));
    const engine = createEngineFromDir(dir);
    assert.throws(() => engine.render("{{ job.status }}"), GuardrailError);
    writeFileSync(join(dir, "job.json"), JSON.stringify({ status: "done" }));
    assert.equal(engine.render("{{ job.status }}"), "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no manifest: every json file is static, mocks ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "pg-vars-"));
  try {
    writeFileSync(join(dir, "a.json"), "{}");
    writeFileSync(join(dir, "b.mock.json"), "{}");
    assert.deepEqual(Object.keys(loadVarsDir(dir)), ["a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bad manifests fail loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "pg-vars-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ static: ["x"], runtime: ["x"], compile: [] }));
    writeFileSync(join(dir, "x.json"), "{}");
    assert.throws(() => loadVarsDir(dir), (err: unknown) =>
      err instanceof GuardrailError &&
      err.diagnostics.some(d => d.code === "NAMESPACE_INVALID") &&
      err.diagnostics.some(d => d.code === "CONFIG_INVALID"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI exit codes", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf-8" });
  const vars = join(example, "vars");
  assert.equal(run("check", join(example, "prompts"), "--vars", vars).status, 0);
  assert.equal(run("render", join(example, "prompts/support.md"), "--vars", vars).status, 1);
  assert.equal(run("render", join(example, "prompts/support.md"), "--vars", vars, "--data", `customer=${join(example, "runtime/customer.json")}`, "--data", `ticket=${join(example, "runtime/ticket.json")}`).status, 0);
  assert.equal(run("check").status, 2);
  assert.equal(run("bogus", "--vars", vars).status, 2);
});
