import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  error,
  warning,
  hasErrors,
  GuardrailError,
  type Diagnostic,
} from "./diagnostics.js";
import { expandIncludes } from "./includes.js";
import { extractReferences, type Reference } from "./references.js";
import {
  compile,
  compileExpression,
  evaluateCompiledExpression,
  renderCompiled,
  TemplateSyntaxError,
  type CompiledTemplate,
} from "./twig.js";
import { closest, existingPrefix, getPath, hasPath, hyphenatedPaths, IDENTIFIER, isPlainObject } from "./paths.js";
import { trackMissingReads } from "./tracking.js";

// ---------------------------------------------------------------------------
// Namespace declarations
// ---------------------------------------------------------------------------

/** Data known up front: config, product facts, reusable copy. Fully key-checked. */
export interface StaticNamespace {
  kind: "static";
  data: Record<string, unknown>;
}

/**
 * Data that only exists at render time: user input, a model's earlier output,
 * a DB row. Supply it per render via `render(..., { data })` or a `load()`.
 */
export interface RuntimeNamespace {
  kind: "runtime";
  /**
   * A representative example (a "mock") used to key-check templates before
   * real data exists. Without one, any key under this namespace is accepted
   * statically and only checked at render time.
   */
  shape?: unknown;
  /** Called on every render when no explicit data is passed. Return undefined if not available yet. */
  load?: () => unknown;
}

/**
 * Light computed properties: each key maps to a Twig expression, evaluated in
 * order at render time. A rule may use rules defined above it.
 *
 *   { "isTrial":         "customer.plan == 'trial'",
 *     "trialEndingSoon": "status.isTrial and customer.trialDaysLeft <= 3" }
 */
export interface ComputedNamespace {
  kind: "computed";
  rules: Record<string, unknown>;
}

export type NamespaceDecl = StaticNamespace | RuntimeNamespace | ComputedNamespace;

export interface EngineOptions {
  namespaces: Record<string, NamespaceDecl>;
  /** Directory @include paths resolve against (and may not leave). Default: process.cwd(). */
  includeRoot?: string;
  /** Refuse to render when an unguarded reference is missing. Default true. */
  strict?: boolean;
  /** Maximum @include nesting. Default 8. */
  maxIncludeDepth?: number;
}

export interface TemplateInput {
  name: string;
  source: string;
}

export interface CheckOptions {
  /** Warn about computed rules no template or rule uses. Default true. */
  reportUnused?: boolean;
}

export interface CheckResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** References found per template name (after include expansion). */
  references: Record<string, Reference[]>;
}

export interface RenderOptions {
  /** Template name for diagnostics. */
  name?: string;
  /** Runtime namespace data for this render; overrides each namespace's load(). */
  data?: Record<string, unknown>;
  /** Override the engine's strict setting for this call. */
  strict?: boolean;
}

export interface ComputedResult {
  values: Record<string, Record<string, unknown>>;
  diagnostics: Diagnostic[];
}

/** Names that would collide with Twig syntax or built-ins. */
const RESERVED = new Set([
  "_context", "_self", "_charset", "_key", "loop",
  "true", "false", "null", "none", "not", "and", "or", "in", "is", "b-and", "b-or", "b-xor",
]);

interface CompiledRule {
  name: string;
  expr: string;
  template?: CompiledTemplate;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class PromptEngine {
  readonly namespaces: Readonly<Record<string, NamespaceDecl>>;
  readonly includeRoot: string;
  readonly strict: boolean;
  readonly maxIncludeDepth: number;

  /** Problems with the declarations themselves (bad names, broken computed rules, ...). */
  readonly configDiagnostics: Diagnostic[];

  private readonly computedRules = new Map<string, CompiledRule[]>();
  /** Which computed flags are used by other computed flags: "ns.flag". */
  private readonly computedInternalUses = new Set<string>();

  constructor(options: EngineOptions) {
    this.namespaces = { ...options.namespaces };
    this.includeRoot = resolve(options.includeRoot ?? process.cwd());
    this.strict = options.strict ?? true;
    this.maxIncludeDepth = options.maxIncludeDepth ?? 8;
    this.configDiagnostics = this.validateDeclarations();
  }

  // -------------------------------------------------------------------------
  // Static checking
  // -------------------------------------------------------------------------

  /**
   * Checks one or more templates without rendering them: syntax, includes,
   * and every variable reference against the declared namespaces.
   */
  check(templates: TemplateInput[] | Record<string, string>, options: CheckOptions = {}): CheckResult {
    const list = Array.isArray(templates)
      ? templates
      : Object.entries(templates).map(([name, source]) => ({ name, source }));

    const diagnostics: Diagnostic[] = [...this.configDiagnostics];
    const references: Record<string, Reference[]> = {};
    const usedComputed = new Set<string>(this.computedInternalUses);

    for (const { name, source } of list) {
      const prepared = this.prepare(source, name);
      diagnostics.push(...prepared.diagnostics);

      let refs: Reference[];
      try {
        refs = extractReferences(prepared.text);
      } catch (err) {
        diagnostics.push(error("TEMPLATE_SYNTAX", messageOf(err), { source: name }));
        continue;
      }
      references[name] = refs;

      for (const ref of refs) {
        const decl = this.namespaces[ref.segments[0]];
        if (decl?.kind === "computed" && ref.segments[1]) usedComputed.add(`${ref.segments[0]}.${ref.segments[1]}`);
        diagnostics.push(...this.checkReference(ref, name));
      }
    }

    if (options.reportUnused ?? true) {
      for (const [ns, rules] of this.computedRules) {
        for (const rule of rules) {
          if (!usedComputed.has(`${ns}.${rule.name}`)) {
            diagnostics.push(warning("UNUSED_COMPUTED", `Computed rule ${ns}.${rule.name} is not used by any checked template or rule`, {
              source: `computed:${ns}`, path: `${ns}.${rule.name}`,
            }));
          }
        }
      }
    }

    return { ok: !hasErrors(diagnostics), diagnostics, references };
  }

  /** check() for a single template string. */
  checkTemplate(source: string, name = "template"): CheckResult {
    return this.check([{ name, source }], { reportUnused: false });
  }

  /** Expands @include directives. */
  prepare(source: string, name?: string): { text: string; diagnostics: Diagnostic[]; files: string[] } {
    return expandIncludes(source, { root: this.includeRoot, source: name, maxDepth: this.maxIncludeDepth });
  }

  // -------------------------------------------------------------------------
  // Computed properties
  // -------------------------------------------------------------------------

  /** Evaluates every computed namespace against the current static + runtime data. */
  evaluateComputed(data: Record<string, unknown> = {}): ComputedResult {
    const base = this.baseContext(data);
    return this.evaluateComputedFrom(base);
  }

  /** The full render context: static + runtime + computed. Handy for debugging. */
  context(data: Record<string, unknown> = {}): { context: Record<string, unknown>; diagnostics: Diagnostic[] } {
    const base = this.baseContext(data);
    const computed = this.evaluateComputedFrom(base);
    return { context: { ...base, ...computed.values }, diagnostics: computed.diagnostics };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Renders a template. In strict mode (the default) it refuses — throwing a
   * GuardrailError — rather than silently printing blanks for missing data.
   */
  render(source: string, options: RenderOptions = {}): string {
    const name = options.name ?? "template";
    const strict = options.strict ?? this.strict;
    const data = options.data ?? {};

    const problems: Diagnostic[] = [...this.configDiagnostics.filter(d => d.severity === "error")];
    for (const ns of Object.keys(data)) {
      if (this.namespaces[ns]?.kind !== "runtime") {
        problems.push(error("RUNTIME_UNDECLARED", `render() received data for "${ns}", which is not a declared runtime namespace`, {
          source: name, hint: `Declare it: namespaces.${ns} = { kind: "runtime" }`,
        }));
      }
    }

    const prepared = this.prepare(source, name);
    problems.push(...prepared.diagnostics);

    let template: CompiledTemplate;
    let refs: Reference[] = [];
    try {
      template = compile(prepared.text);
      if (strict) refs = extractReferences(prepared.text);
    } catch (err) {
      problems.push(error("TEMPLATE_SYNTAX", messageOf(err), { source: name }));
      throw new GuardrailError(problems, `Cannot render ${name}`);
    }

    if (hasErrors(problems)) throw new GuardrailError(problems.filter(d => d.severity === "error"), `Cannot render ${name}`);

    const { context } = this.context(data);
    if (!strict) return renderCompiled(template, context);

    // Strict: render against a tracking proxy, then fail if any unguarded
    // reference in a branch that actually ran was missing.
    const tracked = trackMissingReads(context);
    const output = renderCompiled(template, tracked.context);
    const unguarded = refs.filter(r => !r.guarded);
    const reported = new Set<string>();
    for (const miss of tracked.misses) {
      const hits = unguarded.filter(r => r.path === miss || r.path.startsWith(`${miss}.`));
      for (const ref of hits) {
        if (reported.has(ref.path)) continue;
        reported.add(ref.path);
        problems.push(...this.describeMissingAtRender(ref, context, name));
      }
    }
    if (hasErrors(problems)) throw new GuardrailError(problems.filter(d => d.severity === "error"), `Cannot render ${name}`);
    return output;
  }

  renderFile(path: string, options: RenderOptions = {}): string {
    const source = readFileSync(path, "utf-8");
    return this.render(source, { name: path, ...options });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private baseContext(data: Record<string, unknown>): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    for (const [ns, decl] of Object.entries(this.namespaces)) {
      if (decl.kind === "static") {
        ctx[ns] = decl.data;
      } else if (decl.kind === "runtime") {
        const value = ns in data ? data[ns] : decl.load?.();
        if (value !== undefined) ctx[ns] = value;
      }
    }
    return ctx;
  }

  private evaluateComputedFrom(base: Record<string, unknown>): ComputedResult {
    const values: Record<string, Record<string, unknown>> = {};
    const diagnostics: Diagnostic[] = [];
    for (const [ns, rules] of this.computedRules) {
      const partial: Record<string, unknown> = {};
      values[ns] = partial;
      for (const rule of rules) {
        if (!rule.template) {
          partial[rule.name] = undefined;
          continue;
        }
        try {
          partial[rule.name] = evaluateCompiledExpression(rule.template, { ...base, ...values });
        } catch (err) {
          partial[rule.name] = undefined;
          diagnostics.push(warning("COMPUTED_EVAL_ERROR", `${ns}.${rule.name} failed to evaluate: ${messageOf(err)}`, {
            source: `computed:${ns}`, path: `${ns}.${rule.name}`,
          }));
        }
      }
    }
    return { values, diagnostics };
  }

  /** Static check of one reference against declarations. */
  private checkReference(ref: Reference, source: string, computedScope?: { ns: string; available: Set<string> }): Diagnostic[] {
    const [root, ...rest] = ref.segments;
    const at = { source, line: ref.line, path: ref.path };
    const decl = this.namespaces[root];

    if (!decl) {
      const suggestion = closest(root, Object.keys(this.namespaces));
      const hint = computedScope
        ? `If this is meant as literal text, quote it inside the expression: "'...'"`
        : suggestion
          ? `Did you mean ${suggestion}?`
          : `Declared namespaces: ${Object.keys(this.namespaces).join(", ") || "(none)"}`;
      const make = ref.guarded ? warning : error;
      return [make("VAR_UNKNOWN_NAMESPACE", `"${root}" is not a declared namespace (in ${ref.path})`, { ...at, hint })];
    }
    if (ref.guarded || rest.length === 0) return [];

    if (decl.kind === "static") return this.checkAgainst(decl.data, ref, at, "VAR_UNRESOLVED");
    if (decl.kind === "runtime") {
      return decl.shape === undefined ? [] : this.checkAgainst(decl.shape, ref, at, "VAR_UNRESOLVED", " (checked against its shape/mock)");
    }

    // computed
    const flag = rest[0];
    const rules = this.computedRules.get(root) ?? [];
    if (computedScope) {
      if (!computedScope.available.has(`${root}.${flag}`)) {
        const defined = rules.some(r => r.name === flag);
        return [error("COMPUTED_FORWARD_REF", defined
          ? `${ref.path} is defined after the rule that uses it (or is the rule itself)`
          : `${ref.path} is not a computed rule`, {
          ...at, hint: defined ? "Move the referenced rule above this one." : undefined,
        })];
      }
      return [];
    }
    if (!rules.some(r => r.name === flag)) {
      const suggestion = closest(flag, rules.map(r => r.name));
      return [error("VAR_UNRESOLVED", `${root} has no computed rule "${flag}"`, {
        ...at, hint: suggestion ? `Did you mean ${root}.${suggestion}?` : undefined,
      })];
    }
    return [];
  }

  private checkAgainst(
    data: unknown,
    ref: Reference,
    at: Partial<Diagnostic>,
    code: "VAR_UNRESOLVED",
    suffix = "",
  ): Diagnostic[] {
    const [root, ...rest] = ref.segments;
    if (hasPath(data, rest)) return [];
    const prefix = existingPrefix(data, rest);
    const parent = getPath(data, prefix);
    const missing = rest[prefix.length];
    const siblings = isPlainObject(parent) ? Object.keys(parent) : [];
    const suggestion = closest(missing, siblings);
    const base = [root, ...prefix].join(".");
    return [error(code, `${ref.path} does not exist${suffix}: ${base} has no key "${missing}"`, {
      ...at,
      hint: suggestion
        ? `Did you mean ${base}.${suggestion}?`
        : siblings.length
          ? `${base} has: ${siblings.slice(0, 12).join(", ")}${siblings.length > 12 ? ", ..." : ""}`
          : undefined,
    })];
  }

  /** Explains an unguarded reference that a strict render found missing. */
  private describeMissingAtRender(ref: Reference, context: Record<string, unknown>, source: string): Diagnostic[] {
    const [root] = ref.segments;
    const at = { source, line: ref.line, path: ref.path };
    const decl = this.namespaces[root];
    if (!decl) {
      return [error("VAR_UNKNOWN_NAMESPACE", `"${root}" is not a declared namespace (in ${ref.path})`, at)];
    }
    if (decl.kind === "runtime" && !(root in context)) {
      return [error("RUNTIME_NOT_PROVIDED", `No data was provided for runtime namespace "${root}" (needed by ${ref.path})`, {
        ...at, hint: `Pass render(..., { data: { ${root}: ... } }), or guard it with {% if ${root} is defined %}`,
      })];
    }
    if (decl.kind === "computed") return this.checkReference(ref, source);
    const found = this.checkAgainst(context[root], ref, at, "VAR_UNRESOLVED");
    return found.map(d => ({
      ...d,
      code: "VAR_MISSING_AT_RENDER" as const,
      hint: `${d.hint ? `${d.hint}. ` : ""}If it's optional, guard it with "is defined" or |default(...)`,
    }));
  }

  private validateDeclarations(): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const available = new Set<string>();

    for (const [ns, decl] of Object.entries(this.namespaces)) {
      const src = `namespace:${ns}`;
      if (!IDENTIFIER.test(ns) || RESERVED.has(ns)) {
        diagnostics.push(error("NAMESPACE_INVALID", `"${ns}" cannot be used as a namespace name`, {
          source: src, hint: "Use a plain identifier (letters, digits, underscore) that is not a Twig keyword.",
        }));
        continue;
      }
      if (!decl || !["static", "runtime", "computed"].includes((decl as NamespaceDecl).kind)) {
        diagnostics.push(error("NAMESPACE_INVALID", `Namespace "${ns}" needs kind "static", "runtime", or "computed"`, { source: src }));
        continue;
      }

      if (decl.kind === "static" || (decl.kind === "runtime" && decl.shape !== undefined)) {
        const data = decl.kind === "static" ? decl.data : decl.shape;
        for (const p of hyphenatedPaths(data)) {
          diagnostics.push(warning("VAR_HYPHEN", `${ns}.${p} has a hyphen, so {{ ${ns}.${p} }} parses as subtraction`, {
            source: src, path: `${ns}.${p}`,
            hint: "Rename the key to camelCase/snake_case, or read it with bracket syntax: ns['key-name'].",
          }));
        }
      }

      if (decl.kind === "computed") {
        if (!isPlainObject(decl.rules)) {
          diagnostics.push(error("COMPUTED_NOT_STRING", `Computed namespace "${ns}" must map rule names to expression strings`, { source: src }));
          this.computedRules.set(ns, []);
          continue;
        }
        const compiled: CompiledRule[] = [];
        this.computedRules.set(ns, compiled);
        // Pre-register names so forward references are reported as forward, not unknown.
        const names = Object.keys(decl.rules);
        for (const [name, expr] of Object.entries(decl.rules)) {
          const ruleSrc = `computed:${ns}.${name}`;
          const rule: CompiledRule = { name, expr: String(expr) };
          compiled.push(rule);

          if (!IDENTIFIER.test(name)) {
            diagnostics.push(error("VAR_HYPHEN", `Computed rule name "${name}" is not reachable with dot notation`, {
              source: ruleSrc, hint: "Use camelCase or snake_case.",
            }));
          }
          if (typeof expr !== "string") {
            diagnostics.push(error("COMPUTED_NOT_STRING", `${ns}.${name} must be a Twig expression string, got ${JSON.stringify(expr)}`, {
              source: ruleSrc,
              hint: typeof expr === "boolean" || typeof expr === "number"
                ? `A fixed value belongs in a static namespace. As an expression: "${String(expr)}".`
                : undefined,
            }));
            available.add(`${ns}.${name}`);
            continue;
          }

          try {
            rule.template = compileExpression(expr);
          } catch (err) {
            diagnostics.push(error("COMPUTED_SYNTAX", `${ns}.${name}: ${err instanceof TemplateSyntaxError ? err.message : messageOf(err)}`, {
              source: ruleSrc,
            }));
            available.add(`${ns}.${name}`);
            continue;
          }

          let refs: Reference[] = [];
          try {
            refs = extractReferences(`{{ (${expr}) }}`);
          } catch { /* already reported as COMPUTED_SYNTAX */ }

          for (const ref of refs) {
            const target = this.namespaces[ref.segments[0]];
            if (target?.kind === "computed") {
              if (ref.segments[1]) this.computedInternalUses.add(`${ref.segments[0]}.${ref.segments[1]}`);
              // A computed namespace declared later hasn't been registered yet.
              if (!this.computedRules.has(ref.segments[0]) || (ref.segments[0] === ns && !available.has(`${ns}.${ref.segments[1]}`))) {
                const defined = ref.segments[0] === ns ? names.includes(ref.segments[1] ?? "") : true;
                diagnostics.push(error("COMPUTED_FORWARD_REF", defined
                  ? `${ns}.${name} uses ${ref.path}, which is defined after it`
                  : `${ns}.${name} uses ${ref.path}, which is not a computed rule`, {
                  source: ruleSrc, path: ref.path,
                  hint: defined ? "Rules evaluate top to bottom; move the referenced rule (or namespace) above this one." : undefined,
                }));
                continue;
              }
            }
            diagnostics.push(...this.checkReference(ref, ruleSrc, { ns, available }));
          }
          available.add(`${ns}.${name}`);
        }
      }
    }
    return diagnostics;
  }
}

export function createEngine(options: EngineOptions): PromptEngine {
  return new PromptEngine(options);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
