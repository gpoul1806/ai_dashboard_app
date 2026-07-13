import type { Db } from "../db";
import { config } from "../config";
import { createIsolatedRuntime } from "./isolatedRuntime";
import { createWorkerRuntime } from "./workerRuntime";
import type { SandboxHostApi, SandboxRuntime } from "./types";

export type {
  CapabilityRequest,
  CapabilityResponse,
  SandboxHostApi,
  SandboxRuntime,
} from "./types";

/** Wires the sandbox capability API to the database + real fetch. */
export function makeHostApi(db: Db, fetchImpl: typeof fetch = fetch): SandboxHostApi {
  const userId = config.demoUserId;
  return {
    fetchImpl,
    getSecrets: (capKey) => db.getCapabilitySecrets(capKey),
    store: {
      get: (capKey, k) => db.capStoreGet(capKey, userId, k),
      set: (capKey, k, v) => db.capStoreSet(capKey, userId, k, v),
      delete: (capKey, k) => db.capStoreDelete(capKey, userId, k),
      list: (capKey) => db.capStoreList(capKey, userId),
    },
    log: (event, detail) => console.log(`[sandbox] ${event}`, detail),
  };
}

export async function createSandbox(
  host: SandboxHostApi,
  engine: "auto" | "worker" = config.sandboxEngine,
): Promise<SandboxRuntime> {
  if (engine !== "worker") {
    try {
      const runtime = await createIsolatedRuntime(host);
      console.log("[sandbox] engine: isolated-vm");
      return runtime;
    } catch (err) {
      console.warn(
        `[sandbox] isolated-vm unavailable (${(err as Error).message}) — falling back to worker_threads`,
      );
    }
  }
  console.log("[sandbox] engine: worker_threads");
  return createWorkerRuntime(host);
}
