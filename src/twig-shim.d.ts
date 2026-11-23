// Minimal surface of twig.js that this library uses. The community @types/twig
// package lags behind twig.js 3.x and doesn't describe the token tree.
declare module "twig" {
  interface TwigTemplate {
    render(context?: Record<string, unknown>): string;
    tokens: unknown[];
  }
  interface TwigParams {
    data: string;
    id?: string;
    rethrow?: boolean;
    autoescape?: boolean;
    strict_variables?: boolean;
    allowInlineIncludes?: boolean;
  }
  interface TwigExports {
    twig(params: TwigParams): TwigTemplate;
    extendFilter(name: string, fn: (value: unknown, params?: unknown[]) => unknown): void;
    extendFunction(name: string, fn: (...args: unknown[]) => unknown): void;
    extendTest(name: string, fn: (value: unknown, ...args: unknown[]) => boolean): void;
    cache(enabled: boolean): void;
  }
  const twig: TwigExports;
  export default twig;
}
