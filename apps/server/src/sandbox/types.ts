import type { CapabilitySpec } from "@myday/schema";

export interface CapabilityRequest {
  method: string;
  /** Path relative to the capability mount, e.g. "/search". */
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface CapabilityResponse {
  status: number;
  body: unknown;
}

/**
 * Everything the host grants sandboxed handlers. Generated code NEVER sees
 * process env, the filesystem, other capabilities' data, or the Anthropic key.
 */
export interface SandboxHostApi {
  /** Outbound HTTP implementation (injectable for tests). */
  fetchImpl: typeof fetch;
  /** Third-party secrets, host-injected into capFetch requests only. */
  getSecrets(capabilityKey: string): Promise<Record<string, string>>;
  store: {
    get(capabilityKey: string, k: string): Promise<unknown>;
    set(capabilityKey: string, k: string, v: unknown): Promise<void>;
    delete(capabilityKey: string, k: string): Promise<void>;
    list(capabilityKey: string): Promise<Array<{ k: string; v: unknown }>>;
  };
  log(event: string, detail: Record<string, unknown>): void;
}

export interface SandboxRuntime {
  readonly engine: "isolated-vm" | "worker";
  register(spec: CapabilitySpec): Promise<void>;
  has(key: string): boolean;
  dispatch(key: string, req: CapabilityRequest): Promise<CapabilityResponse>;
  dispose(): Promise<void>;
}

export const DISPATCH_TIMEOUT_MS = 15_000;

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
