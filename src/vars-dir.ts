import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { error, GuardrailError, type Diagnostic } from "./diagnostics.js";
import { PromptEngine, type EngineOptions, type NamespaceDecl } from "./engine.js";

/**
 * Loads namespaces from a folder of JSON files.
 *
 *   vars/
 *     manifest.json          { "static": ["company"], "runtime": ["user"], "computed": ["flags"] }
 *     company.json           static data
 *     user.mock.json         example shape for the runtime "user" namespace (optional)
 *     user.json              live runtime data, re-read on every render if present (optional)
 *     flags.json             computed rules: { "name": "<twig expression>" }
 *
 * Without a manifest, every *.json file (except *.mock.json) is a static namespace.
 */
export interface VarsManifest {
  static?: string[];
  runtime?: string[];
  computed?: string[];
}

const MANIFEST_KEYS = new Set(["static", "runtime", "computed", "$schema", "description"]);

export function loadVarsDir(dir: string): Record<string, NamespaceDecl> {
  const diagnostics: Diagnostic[] = [];
  const namespaces: Record<string, NamespaceDecl> = {};

  if (!existsSync(dir)) {
    throw new GuardrailError([error("CONFIG_INVALID", `Vars directory not found: ${dir}`)]);
  }

  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".json") || file.endsWith(".mock.json")) continue;
      const ns = file.slice(0, -".json".length);
      const data = readJson(join(dir, file), diagnostics);
      if (data !== undefined) namespaces[ns] = { kind: "static", data: data as Record<string, unknown> };
    }
    if (diagnostics.length) throw new GuardrailError(diagnostics, `Failed to load ${dir}`);
    return namespaces;
  }

  const manifest = readJson(manifestPath, diagnostics) as VarsManifest | undefined;
  if (!manifest) throw new GuardrailError(diagnostics, `Failed to load ${dir}`);

  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.has(key)) {
      diagnostics.push(error("CONFIG_INVALID", `manifest.json has unknown key "${key}"`, {
        source: manifestPath, hint: `Allowed: static, runtime, computed`,
      }));
    }
  }

  const seen = new Map<string, string>();
  const claim = (ns: string, bucket: string): boolean => {
    const prev = seen.get(ns);
    if (prev) {
      diagnostics.push(error("NAMESPACE_INVALID", `"${ns}" is listed under both "${prev}" and "${bucket}"`, { source: manifestPath }));
      return false;
    }
    seen.set(ns, bucket);
    return true;
  };

  for (const ns of manifest.static ?? []) {
    if (!claim(ns, "static")) continue;
    const file = join(dir, `${ns}.json`);
    if (!existsSync(file)) {
      diagnostics.push(error("CONFIG_INVALID", `Static namespace "${ns}" has no file ${ns}.json`, { source: manifestPath }));
      continue;
    }
    const data = readJson(file, diagnostics);
    if (data !== undefined) namespaces[ns] = { kind: "static", data: data as Record<string, unknown> };
  }

  for (const ns of manifest.runtime ?? []) {
    if (!claim(ns, "runtime")) continue;
    const mockFile = join(dir, `${ns}.mock.json`);
    const dataFile = join(dir, `${ns}.json`);
    const shape = existsSync(mockFile) ? readJson(mockFile, diagnostics) : undefined;
    namespaces[ns] = {
      kind: "runtime",
      ...(shape !== undefined ? { shape } : {}),
      // Re-read on every render so data written mid-workflow is picked up.
      load: () => (existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, "utf-8")) : undefined),
    };
  }

  for (const ns of manifest.computed ?? []) {
    if (!claim(ns, "computed")) continue;
    const file = join(dir, `${ns}.json`);
    if (!existsSync(file)) {
      diagnostics.push(error("CONFIG_INVALID", `Computed namespace "${ns}" has no file ${ns}.json`, { source: manifestPath }));
      continue;
    }
    const rules = readJson(file, diagnostics);
    if (rules !== undefined) namespaces[ns] = { kind: "computed", rules: rules as Record<string, unknown> };
  }

  if (diagnostics.length) throw new GuardrailError(diagnostics, `Failed to load ${dir}`);
  return namespaces;
}

/** loadVarsDir() + new PromptEngine(). Extra namespaces are merged on top. */
export function createEngineFromDir(dir: string, options: Partial<EngineOptions> = {}): PromptEngine {
  return new PromptEngine({
    ...options,
    namespaces: { ...loadVarsDir(dir), ...(options.namespaces ?? {}) },
  });
}

function readJson(path: string, diagnostics: Diagnostic[]): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    diagnostics.push(error("CONFIG_INVALID", `Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`, { source: path }));
    return undefined;
  }
}
