import React from "react";

/**
 * The capability hook injected into generated components. It is the ONLY
 * network path generated UI code has — requests go to the server's sandboxed
 * dynamic endpoints under /api/dyn/*.
 */
export function useCapability(capabilityKey: string) {
  return React.useCallback(
    async (path: string, init?: RequestInit): Promise<unknown> => {
      const res = await fetch(
        `/api/dyn/${encodeURIComponent(capabilityKey)}${path}`,
        init,
      );
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (!res.ok) {
        throw new Error(
          `capability ${capabilityKey} ${path} failed (${res.status}): ${
            typeof body === "string" ? body : JSON.stringify(body)
          }`,
        );
      }
      return body;
    },
    [capabilityKey],
  );
}

/**
 * Exposes the shell's React instance + injected hooks to the import-map shims
 * (/react-shim.js, /shell-hooks.js) that generated ES modules import from.
 * Must run before any generated component is dynamically imported.
 */
export function installShellGlobals(): void {
  (window as unknown as Record<string, unknown>).__SHELL_REACT__ = React;
  (window as unknown as Record<string, unknown>).__SHELL_HOOKS__ = {
    useCapability,
  };
}
