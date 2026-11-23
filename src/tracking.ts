/**
 * Records which variable paths a render actually tried to read but couldn't
 * find. Because it observes the real render, only the branches and loop
 * iterations that execute are counted: a variable used only inside an
 * `{% if %}` branch that isn't taken is never reported.
 *
 * twig.js probes keys with `in` before reading them (and also tries
 * PHP-style `getX`/`isX` methods and `then`), so both the `has` and `get`
 * traps record misses. The caller filters misses against the template's own
 * references, which discards those internal probes.
 */
export function trackMissingReads(context: Record<string, unknown>): {
  context: Record<string, unknown>;
  misses: Set<string>;
} {
  const misses = new Set<string>();

  const wrap = <T>(value: T, path: string): T => {
    if (value === null || typeof value !== "object") return value;
    return new Proxy(value as object, {
      has(target, key) {
        const present = Reflect.has(target, key);
        if (!present && typeof key === "string") misses.add(join(path, key));
        return present;
      },
      get(target, key, receiver) {
        const result = Reflect.get(target, key, receiver);
        if (typeof key !== "string") return result;
        if (!Reflect.has(target, key)) {
          misses.add(join(path, key));
          return result;
        }
        return wrap(result, join(path, key));
      },
    }) as T;
  };

  return { context: wrap(context, ""), misses };
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}
