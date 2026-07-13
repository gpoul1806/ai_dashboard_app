import type React from "react";
import { useSyncExternalStore } from "react";
import { primitives } from "./primitives";

/**
 * Open runtime registry: seeded with the built-in primitives, extended at
 * runtime by the loader with generated components (keyed "Name@version").
 */

type Entry = React.ComponentType<Record<string, unknown>>;

const map = new Map<string, Entry>(Object.entries(primitives));
let version = 0;
const listeners = new Set<() => void>();

export const registry = {
  get(type: string): Entry | undefined {
    return map.get(type);
  },
  has(type: string): boolean {
    return map.has(type);
  },
  register(key: string, component: Entry): void {
    map.set(key, component);
    version++;
    for (const l of listeners) l();
  },
  keys(): string[] {
    return [...map.keys()];
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getVersion(): number {
    return version;
  },
};

/** Re-renders subscribers whenever a generated component is registered. */
export function useRegistry(): typeof registry {
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  return registry;
}
