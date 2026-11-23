#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatDiagnostics, GuardrailError, hasErrors, type Diagnostic } from "./diagnostics.js";
import { PromptEngine } from "./engine.js";
import { extractReferences } from "./references.js";
import { loadVarsDir } from "./vars-dir.js";

const USAGE = `promptc — deterministic prompt templates

Usage:
  promptc check <file|dir>... --vars <dir> [options]
  promptc render <file> --vars <dir> [--data ns=file.json]... [options]
  promptc computed --vars <dir> [--data ns=file.json]...
  promptc refs <file>

Options:
  --vars <dir>            Folder of namespace JSON files (with optional manifest.json)
  --include-root <dir>    Base folder for @include paths (default: parent of --vars, else cwd)
  --data <ns=file.json>   Runtime data for a namespace (repeatable)
  --out <file>            render: write output to a file instead of stdout
  --no-strict             render: allow missing references to print as empty
  --no-unused             check: skip the unused-computed-rule warning
  --warnings-as-errors    check: exit 1 on warnings too
  --json                  Machine-readable output
  -h, --help              Show this help

Exit codes: 0 ok · 1 check/render failed · 2 usage or config error
Template files for check: .md .txt .twig .prompt .tpl (directories are scanned recursively)`;

const TEMPLATE_EXTENSIONS = [".md", ".txt", ".twig", ".prompt", ".tpl"];

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        vars: { type: "string" },
        "include-root": { type: "string" },
        data: { type: "string", multiple: true },
        out: { type: "string" },
        "no-strict": { type: "boolean" },
        "no-unused": { type: "boolean" },
        "warnings-as-errors": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    return usageError(err instanceof Error ? err.message : String(err));
  }

  const { values: opts, positionals } = parsed;
  const [command, ...args] = positionals;
  if (opts.help || !command) {
    console.log(USAGE);
    return command || opts.help ? 0 : 2;
  }

  if (command === "refs") {
    if (args.length !== 1) return usageError("refs takes exactly one file");
    const refs = extractReferences(readFileSync(args[0], "utf-8"));
    if (opts.json) console.log(JSON.stringify(refs, null, 2));
    else for (const r of refs) console.log(`${r.line ?? "?"}\t${r.path}${r.guarded ? "\t(guarded)" : ""}`);
    return 0;
  }

  if (!["check", "render", "computed"].includes(command)) return usageError(`Unknown command "${command}"`);

  let engine: PromptEngine;
  let data: Record<string, unknown>;
  try {
    if (!opts.vars) return usageError("--vars <dir> is required");
    const varsDir = resolve(opts.vars);
    const includeRoot = opts["include-root"] ? resolve(opts["include-root"]) : dirname(varsDir);
    engine = new PromptEngine({
      namespaces: loadVarsDir(varsDir),
      includeRoot,
      strict: !opts["no-strict"],
    });
    data = parseData(opts.data ?? []);
  } catch (err) {
    return configError(err, !!opts.json);
  }

  if (command === "check") {
    if (args.length === 0) return usageError("check needs at least one template file or directory");
    const files = args.flatMap(collectTemplates);
    if (files.length === 0) return usageError(`No template files found (looked for ${TEMPLATE_EXTENSIONS.join(" ")})`);
    const result = engine.check(
      files.map(f => ({ name: f, source: readFileSync(f, "utf-8") })),
      { reportUnused: !opts["no-unused"] },
    );
    const failed = !result.ok || (!!opts["warnings-as-errors"] && result.diagnostics.length > 0);
    if (opts.json) {
      console.log(JSON.stringify({ ok: !failed, files, diagnostics: result.diagnostics }, null, 2));
    } else {
      if (result.diagnostics.length) console.error(formatDiagnostics(result.diagnostics));
      console.error(summary(files.length, result.diagnostics));
    }
    return failed ? 1 : 0;
  }

  if (command === "computed") {
    const result = engine.evaluateComputed(data);
    if (result.diagnostics.length && !opts.json) console.error(formatDiagnostics(result.diagnostics));
    console.log(JSON.stringify(opts.json ? result : result.values, null, 2));
    return 0;
  }

  // render
  if (args.length !== 1) return usageError("render takes exactly one template file");
  try {
    const output = engine.renderFile(args[0], { data });
    if (opts.out) writeFileSync(opts.out, output);
    else process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    return 0;
  } catch (err) {
    if (err instanceof GuardrailError) {
      if (opts.json) console.log(JSON.stringify({ ok: false, diagnostics: err.diagnostics }, null, 2));
      else console.error(err.message);
      return 1;
    }
    throw err;
  }
}

function parseData(entries: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`--data expects ns=file.json, got "${entry}"`);
    const ns = entry.slice(0, eq);
    const file = entry.slice(eq + 1);
    try {
      data[ns] = JSON.parse(readFileSync(file, "utf-8"));
    } catch (err) {
      throw new Error(`--data ${ns}: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return data;
}

function collectTemplates(target: string): string[] {
  if (!existsSync(target)) throw new Error(`No such file or directory: ${target}`);
  if (statSync(target).isFile()) return [target];
  const out: string[] = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const p = join(target, entry.name);
    if (entry.isDirectory()) out.push(...collectTemplates(p));
    else if (TEMPLATE_EXTENSIONS.some(ext => entry.name.endsWith(ext))) out.push(p);
  }
  return out.sort();
}

function summary(fileCount: number, diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter(d => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const status = hasErrors(diagnostics) ? "✗" : "✓";
  return `${status} ${fileCount} template${fileCount === 1 ? "" : "s"} checked · ${errors} error${errors === 1 ? "" : "s"} · ${warnings} warning${warnings === 1 ? "" : "s"}`;
}

function usageError(message: string): number {
  console.error(`error: ${message}\n\nRun with --help for usage.`);
  return 2;
}

function configError(err: unknown, json: boolean): number {
  if (err instanceof GuardrailError) {
    if (json) console.log(JSON.stringify({ ok: false, diagnostics: err.diagnostics }, null, 2));
    else console.error(err.message);
  } else {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return 2;
}

process.exitCode = main(process.argv.slice(2));
