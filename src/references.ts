import { compile } from "./twig.js";
import { lineAt } from "./diagnostics.js";

/**
 * A variable path a template reads, e.g. `customer.billing.plan`.
 */
export interface Reference {
  /** Dotted path, e.g. "company.contact.email". Bracket string keys are folded in: a['b-c'] → "a.b-c". */
  path: string;
  segments: string[];
  /**
   * True when the template already tolerates the value being absent:
   * `x is defined`, `x|default(...)`, `x ?? y`, or anything inside
   * `{% if x is defined %} ... {% endif %}`.
   */
  guarded: boolean;
  /** 1-based line within the template source, when known. */
  line?: number;
}

/** Names twig provides itself or that are never user data. */
const BUILTIN_ROOTS = new Set(["_context", "_self", "_charset", "_key", "loop"]);

// twig.js token type names
const T = {
  variable: "Twig.expression.type.variable",
  period: "Twig.expression.type.key.period",
  brackets: "Twig.expression.type.key.brackets",
  string: "Twig.expression.type.string",
  number: "Twig.expression.type.number",
  test: "Twig.expression.type.test",
  filter: "Twig.expression.type.filter",
  binary: "Twig.expression.type.operator.binary",
} as const;

const L = {
  if: "Twig.logic.type.if",
  elseif: "Twig.logic.type.elseif",
  for: "Twig.logic.type.for",
  set: "Twig.logic.type.set",
  setcapture: "Twig.logic.type.setcapture",
  macro: "Twig.logic.type.macro",
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tok = any;

interface WalkContext {
  /** Names introduced by the template itself ({% set %}, loop vars, macro params). */
  locals: Set<string>;
  /** Path prefixes proven present by an enclosing `{% if x is defined %}`. */
  guards: string[];
  /** Character offset of the enclosing tag, for line numbers. */
  offset?: number;
}

interface Operand {
  ref?: Reference;
}

/**
 * Extracts every variable path a Twig template reads, using twig.js's own
 * parser rather than regexes. Filters, functions, string literals, object
 * keys, loop variables and `{% set %}` locals are all handled correctly.
 *
 * Throws TemplateSyntaxError if the template does not parse.
 */
export function extractReferences(source: string): Reference[] {
  const template = compile(source);
  const out: Reference[] = [];
  walkTokens(template.tokens as Tok[], { locals: new Set(), guards: [] }, out, source);
  return dedupe(out);
}

/** Convenience: just the unique dotted paths. */
export function extractPaths(source: string): string[] {
  return [...new Set(extractReferences(source).map(r => r.path))];
}

function walkTokens(tokens: Tok[] | undefined, ctx: WalkContext, out: Reference[], source: string): void {
  if (!Array.isArray(tokens)) return;
  for (const tok of tokens) {
    if (!tok || typeof tok !== "object") continue;
    if (tok.type === "output") {
      processStack(tok.stack, { ...ctx, offset: tok.position?.start ?? ctx.offset }, out, source);
    } else if (tok.type === "logic" && tok.token) {
      const offset = tok.position?.open?.start ?? tok.position?.start ?? ctx.offset;
      walkLogic(tok.token, { ...ctx, offset }, out, source);
    }
  }
}

function walkLogic(t: Tok, ctx: WalkContext, out: Reference[], source: string): void {
  switch (t.type) {
    case L.if:
    case L.elseif: {
      const proven = processStack(t.stack, ctx, out, source);
      walkTokens(t.output, { ...ctx, guards: [...ctx.guards, ...proven] }, out, source);
      return;
    }
    case L.for: {
      processStack(t.expression, ctx, out, source);
      const locals = new Set(ctx.locals);
      if (t.keyVar) locals.add(t.keyVar);
      if (t.valueVar) locals.add(t.valueVar);
      const inner = { ...ctx, locals };
      if (t.conditional) processStack(t.conditional, inner, out, source);
      walkTokens(t.output, inner, out, source);
      return;
    }
    case L.set: {
      processStack(t.expression, ctx, out, source);
      // {% set %} leaks into the rest of the template, so mutate the shared set.
      for (const key of String(t.key ?? "").split(",")) {
        if (key.trim()) ctx.locals.add(key.trim());
      }
      return;
    }
    case L.setcapture: {
      walkTokens(t.output, ctx, out, source);
      if (t.key) ctx.locals.add(t.key);
      return;
    }
    case L.macro: {
      const locals = new Set<string>([...(t.parameters ?? [])]);
      walkTokens(t.output, { ...ctx, locals, guards: [] }, out, source);
      return;
    }
    default: {
      // else / with / apply / spaceless / verbatim / anything newer:
      // scan whatever expressions and bodies the tag carries.
      if (Array.isArray(t.stack)) processStack(t.stack, ctx, out, source);
      if (Array.isArray(t.expression)) processStack(t.expression, ctx, out, source);
      walkTokens(t.output, ctx, out, source);
    }
  }
}

/**
 * Walks one postfix expression stack. Returns the paths this expression proves
 * are defined (for `{% if x is defined %}` branch guarding).
 */
function processStack(stack: Tok[] | undefined, ctx: WalkContext, out: Reference[], source: string): string[] {
  const proven: string[] = [];
  if (!Array.isArray(stack)) return proven;
  const operands: Operand[] = [];
  const line = lineAt(source, ctx.offset);

  let i = 0;
  while (i < stack.length) {
    const tok = stack[i];

    if (tok?.type === T.variable) {
      const segments: string[] = [String(tok.value)];
      let j = i + 1;
      for (; j < stack.length; j++) {
        const next = stack[j];
        if (next?.type === T.period && typeof next.key === "string") {
          segments.push(next.key);
        } else if (next?.type === T.brackets && isLiteralKey(next.stack)) {
          segments.push(String(next.stack[0].value));
        } else {
          break;
        }
      }

      const root = segments[0];
      const isLocal = ctx.locals.has(root) || BUILTIN_ROOTS.has(root);
      const path = segments.join(".");
      const after = stack[j];

      const testsDefined = after?.type === T.test && after.filter === "defined";
      const hasDefault = after?.type === T.filter && after.value === "default";
      const branchGuarded = ctx.guards.some(g => path === g || path.startsWith(`${g}.`));

      let ref: Reference | undefined;
      if (!isLocal) {
        ref = {
          path,
          segments,
          guarded: testsDefined || hasDefault || branchGuarded,
          ...(line !== undefined ? { line } : {}),
        };
        out.push(ref);
        if (testsDefined && after.modifier !== "not") proven.push(path);
      }
      operands.push({ ref });

      // Dynamic bracket keys (a[b.c]) still read b.c — scan their inner stacks.
      for (let k = i + 1; k < j; k++) {
        if (stack[k]?.type === T.brackets && !isLiteralKey(stack[k].stack)) {
          processStack(stack[k].stack, ctx, out, source);
        }
      }
      i = j;
      continue;
    }

    // Nested sub-stacks: function/filter arguments, (sub)expressions, dynamic keys.
    if (Array.isArray(tok?.params)) processStack(tok.params, ctx, out, source);
    if (tok?.type === T.brackets && Array.isArray(tok.stack)) processStack(tok.stack, ctx, out, source);

    // `a ?? b` / `a ?: b`: the left operand is optional by construction.
    if (tok?.type === T.binary && (tok.value === "??" || tok.value === "?:") && operands.length >= 2) {
      const left = operands[operands.length - 2];
      if (left.ref) left.ref.guarded = true;
    }

    if (tok?.type === T.string || tok?.type === T.number || tok?.type === T.binary) {
      operands.push({});
    }
    i++;
  }
  return proven;
}

function isLiteralKey(stack: Tok[] | undefined): boolean {
  return Array.isArray(stack) && stack.length === 1 && (stack[0]?.type === T.string || stack[0]?.type === T.number);
}

/** One entry per path+line; a path counts as guarded only if every use is guarded. */
function dedupe(refs: Reference[]): Reference[] {
  const byKey = new Map<string, Reference>();
  for (const r of refs) {
    const key = `${r.path}@${r.line ?? ""}`;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { ...r });
    else prev.guarded = prev.guarded && r.guarded;
  }
  return [...byKey.values()];
}
