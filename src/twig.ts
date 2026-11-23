import twig from "twig";

/**
 * Thin wrapper over twig.js. Everything that touches the twig.js runtime goes
 * through here so the rest of the library never depends on its globals.
 */

export interface CompiledTemplate {
  render(context: Record<string, unknown>): string;
  tokens: unknown[];
}

export class TemplateSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateSyntaxError";
  }
}

export function compile(source: string): CompiledTemplate {
  try {
    // autoescape stays off: prompts are plain text, not HTML.
    return twig.twig({ data: source, rethrow: true, autoescape: false, allowInlineIncludes: false });
  } catch (err) {
    throw new TemplateSyntaxError(cleanTwigMessage(err));
  }
}

export function renderCompiled(template: CompiledTemplate, context: Record<string, unknown>): string {
  return template.render(context);
}

// ---------------------------------------------------------------------------
// Typed expression evaluation
// ---------------------------------------------------------------------------
//
// twig.js only exposes string rendering. To get a real value (boolean, number,
// array, object) out of an expression we pipe it through a private filter that
// stashes the value and prints nothing. Rendering is synchronous, so a single
// module-level slot is safe.

const CAPTURE_FILTER = "__promptcCapture";
let captured: unknown;
let captureRegistered = false;

function ensureCaptureFilter(): void {
  if (captureRegistered) return;
  twig.extendFilter(CAPTURE_FILTER, (value: unknown) => {
    captured = value;
    return "";
  });
  captureRegistered = true;
}

/** Wraps a bare Twig expression in a template that captures its value. */
export function expressionTemplate(expr: string): string {
  return `{{ (${expr})|${CAPTURE_FILTER} }}`;
}

export function compileExpression(expr: string): CompiledTemplate {
  ensureCaptureFilter();
  return compile(expressionTemplate(expr));
}

export function evaluateCompiledExpression(template: CompiledTemplate, context: Record<string, unknown>): unknown {
  ensureCaptureFilter();
  captured = undefined;
  template.render(context);
  const value = captured;
  captured = undefined;
  return value;
}

export function evaluateExpression(expr: string, context: Record<string, unknown>): unknown {
  return evaluateCompiledExpression(compileExpression(expr), context);
}

function cleanTwigMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // twig.js sometimes reports "A OR B" for the same failure; keep the first.
  return raw.split(" OR ")[0].replace(/^TwigException:\s*/, "").trim();
}
