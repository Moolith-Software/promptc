export type Severity = "error" | "warning";

/**
 * Every problem the library can report has a stable code so callers can
 * filter, suppress, or assert on specific failures.
 */
export type DiagnosticCode =
  // Templates
  | "TEMPLATE_SYNTAX"          // Twig failed to parse the template
  | "VAR_UNKNOWN_NAMESPACE"    // {{ foo.bar }} where `foo` is not a declared namespace
  | "VAR_UNRESOLVED"           // {{ company.bogus }} where the key does not exist
  | "VAR_MISSING_AT_RENDER"    // reference passed static checks but the live data lacks it
  | "VAR_HYPHEN"               // data key with a hyphen: unreachable with dot notation
  // Namespaces
  | "NAMESPACE_INVALID"        // bad namespace name, duplicate, or reserved
  | "RUNTIME_UNDECLARED"       // render() got data for a namespace that is not declared runtime
  | "RUNTIME_NOT_PROVIDED"     // a required runtime namespace had no data at render time
  // Computed properties
  | "COMPUTED_NOT_STRING"      // a computed rule is not an expression string
  | "COMPUTED_SYNTAX"          // a computed expression does not parse
  | "COMPUTED_FORWARD_REF"     // a rule references a rule defined after it (or itself)
  | "COMPUTED_EVAL_ERROR"      // a computed expression threw during evaluation
  | "UNUSED_COMPUTED"          // a computed rule referenced by nothing
  // Includes
  | "INCLUDE_NOT_FOUND"
  | "INCLUDE_OUTSIDE_ROOT"
  | "INCLUDE_FRAGMENT_NOT_FOUND"
  | "INCLUDE_CYCLE"
  | "INCLUDE_DEPTH"
  // Loading
  | "CONFIG_INVALID";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  /** Template name or file the problem was found in. */
  source?: string;
  /** 1-based line in the (include-expanded) template, when known. */
  line?: number;
  /** The variable path involved, when relevant. */
  path?: string;
  /** A short suggestion for fixing it. */
  hint?: string;
}

export function error(code: DiagnosticCode, message: string, extra: Partial<Diagnostic> = {}): Diagnostic {
  return { code, severity: "error", message, ...extra };
}

export function warning(code: DiagnosticCode, message: string, extra: Partial<Diagnostic> = {}): Diagnostic {
  return { code, severity: "warning", message, ...extra };
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some(d => d.severity === "error");
}

/** Thrown by render() and friends when a guardrail check fails. */
export class GuardrailError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[], summary = "Prompt check failed") {
    super(`${summary}\n${formatDiagnostics(diagnostics)}`);
    this.name = "GuardrailError";
    this.diagnostics = diagnostics;
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.source ? `${d.source}${d.line ? `:${d.line}` : ""}` : "";
  const head = `${d.severity === "error" ? "error" : "warn "} ${d.code}${where ? ` ${where}` : ""}`;
  const body = `  ${d.message}`;
  const hint = d.hint ? `\n  hint: ${d.hint}` : "";
  return `${head}\n${body}${hint}`;
}

export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics.map(formatDiagnostic).join("\n");
}

/** 1-based line number for a character offset. */
export function lineAt(text: string, offset: number | undefined): number | undefined {
  if (offset === undefined || offset < 0) return undefined;
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
