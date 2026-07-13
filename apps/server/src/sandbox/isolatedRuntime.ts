import type { CapabilitySpec } from "@myday/schema";
import { capabilityKey } from "@myday/schema";
import { IVM_BOOTSTRAP, makeHostFetch, makeHostStore } from "./hostBridge";
import {
  type CapabilityRequest,
  type CapabilityResponse,
  DISPATCH_TIMEOUT_MS,
  type SandboxHostApi,
  type SandboxRuntime,
  withTimeout,
} from "./types";

interface RegisteredCapability {
  spec: CapabilitySpec;
  isolate: import("isolated-vm").Isolate;
  context: import("isolated-vm").Context;
}

/**
 * Preferred engine: one isolated-vm Isolate per capability. The only bridges
 * into the host are the `_hostFetch` / `_hostStore` References, which enforce
 * the domain allowlist, secret injection, and namespaced KV storage.
 */
export async function createIsolatedRuntime(
  host: SandboxHostApi,
): Promise<SandboxRuntime> {
  // Dynamic import: isolated-vm is a native optional dependency; if it failed
  // to build, this throws and the factory falls back to worker_threads.
  const ivm = (await import("isolated-vm")).default;

  const capabilities = new Map<string, RegisteredCapability>();

  return {
    engine: "isolated-vm",

    async register(spec: CapabilitySpec): Promise<void> {
      const key = capabilityKey(spec);
      const previous = capabilities.get(key);

      const isolate = new ivm.Isolate({ memoryLimit: 64 });
      const context = await isolate.createContext();
      const jail = context.global;
      await jail.set("_hostFetch", new ivm.Reference(makeHostFetch(spec, host)));
      await jail.set("_hostStore", new ivm.Reference(makeHostStore(spec, host)));
      await context.eval(IVM_BOOTSTRAP);

      for (const endpoint of spec.endpoints) {
        const routeKey = `${endpoint.method} ${endpoint.path}`;
        await context.eval(
          `__register(${JSON.stringify(routeKey)}, (${endpoint.handlerSource}));`,
        );
      }

      capabilities.set(key, { spec, isolate, context });
      previous?.isolate.dispose();
    },

    has(key: string): boolean {
      return capabilities.has(key);
    },

    async dispatch(key: string, req: CapabilityRequest): Promise<CapabilityResponse> {
      const entry = capabilities.get(key);
      if (!entry) throw new Error(`capability ${key} is not registered`);
      const routeKey = `${req.method} ${req.path}`;
      const resultJson = await withTimeout(
        entry.context.evalClosure(`return __dispatch($0, $1);`, [routeKey, JSON.stringify(req)], {
          result: { promise: true, copy: true },
          timeout: DISPATCH_TIMEOUT_MS,
        }) as Promise<string>,
        DISPATCH_TIMEOUT_MS,
        `capability ${key} ${routeKey}`,
      );
      return JSON.parse(resultJson) as CapabilityResponse;
    },

    async dispose(): Promise<void> {
      for (const { isolate } of capabilities.values()) isolate.dispose();
      capabilities.clear();
    },
  };
}
