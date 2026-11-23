export {
  PromptEngine,
  createEngine,
  type EngineOptions,
  type NamespaceDecl,
  type StaticNamespace,
  type RuntimeNamespace,
  type ComputedNamespace,
  type TemplateInput,
  type CheckOptions,
  type CheckResult,
  type RenderOptions,
  type ComputedResult,
} from "./engine.js";
export { loadVarsDir, createEngineFromDir, type VarsManifest } from "./vars-dir.js";
export { extractReferences, extractPaths, type Reference } from "./references.js";
export { expandIncludes, extractMarkdownSections, slugifyHeading, type IncludeOptions, type IncludeResult } from "./includes.js";
export { evaluateExpression, TemplateSyntaxError } from "./twig.js";
export {
  GuardrailError,
  formatDiagnostic,
  formatDiagnostics,
  hasErrors,
  type Diagnostic,
  type DiagnosticCode,
  type Severity,
} from "./diagnostics.js";
