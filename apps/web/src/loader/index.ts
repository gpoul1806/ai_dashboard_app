import { registry } from "../registry";

/**
 * Dynamic component loader: fetches generated ES modules from the server and
 * registers their default export in the runtime registry. Deduplicates
 * concurrent loads per key.
 */

const inflight = new Map<string, Promise<void>>();

async function loadOne(key: string): Promise<void> {
  const url = `/api/components/${encodeURIComponent(key)}.js`;
  const mod = await import(/* @vite-ignore */ url);
  if (typeof mod.default !== "function") {
    throw new Error(`Generated component module "${key}" has no default export`);
  }
  registry.register(key, mod.default);
}

export async function ensureComponents(keys: string[]): Promise<void> {
  await Promise.all(
    keys.map(async (key) => {
      if (registry.has(key)) return;
      let p = inflight.get(key);
      if (!p) {
        p = loadOne(key).catch((err) => {
          inflight.delete(key);
          throw err;
        });
        inflight.set(key, p);
      }
      await p;
    }),
  );
}
