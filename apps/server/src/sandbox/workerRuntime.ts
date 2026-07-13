import type { CapabilitySpec } from "@myday/schema";
import { capabilityKey } from "@myday/schema";
import { Worker } from "node:worker_threads";
import {
  type HostFetchFn,
  type HostStoreFn,
  makeHostFetch,
  makeHostStore,
} from "./hostBridge";
import {
  type CapabilityRequest,
  type CapabilityResponse,
  DISPATCH_TIMEOUT_MS,
  type SandboxHostApi,
  type SandboxRuntime,
  withTimeout,
} from "./types";

/**
 * Fallback engine when isolated-vm is unavailable (native build failed):
 * handlers run in a worker thread with a strict message-passing capability
 * API. Weaker isolation than isolated-vm — documented tradeoff per CLAUDE.md
 * ("isolated-vm (preferred) or worker threads with a strict capability API").
 */

const WORKER_SOURCE = String.raw`
"use strict";
const { parentPort } = require("node:worker_threads");
const handlerMaps = new Map(); // capKey -> Map(routeKey -> handler)
const pendingHostCalls = new Map();
let hostCallSeq = 0;

function hostCall(kind, capKey, args) {
  return new Promise((resolve, reject) => {
    const id = ++hostCallSeq;
    pendingHostCalls.set(id, { resolve, reject });
    parentPort.postMessage({ type: "hostcall", id, kind, capKey, args });
  });
}

function makeCtx(capKey) {
  const capFetch = async (url, opts) => {
    const raw = await hostCall("fetch", capKey, [
      String(url),
      opts ? JSON.stringify(opts) : "",
    ]);
    return {
      status: raw.status,
      headers: raw.headers,
      body: raw.body,
      text: () => raw.body,
      json: () => JSON.parse(raw.body),
    };
  };
  const store = async (op, k, v) => {
    const out = await hostCall("store", capKey, [
      op,
      String(k ?? ""),
      v === undefined ? "" : JSON.stringify(v),
    ]);
    return out ? JSON.parse(out) : null;
  };
  const capStore = {
    get: (k) => store("get", k),
    set: (k, v) => store("set", k, v),
    delete: (k) => store("delete", k),
    list: () => store("list", ""),
  };
  return { capFetch, capStore };
}

parentPort.on("message", async (msg) => {
  if (msg.type === "hostresult") {
    const pending = pendingHostCalls.get(msg.id);
    if (pending) {
      pendingHostCalls.delete(msg.id);
      if (msg.ok) pending.resolve(msg.value);
      else pending.reject(new Error(msg.error));
    }
    return;
  }

  if (msg.type === "register") {
    try {
      const routes = new Map();
      // Defense in depth: build each handler inside a Function whose parameters
      // SHADOW the dangerous ambient names to undefined, so even a handler that
      // slipped past the host-side static checks (llm/validators.ts) cannot
      // reach require/process/module/globalThis from its lexical scope. Egress
      // is still gated by the capFetch domain allowlist. (isolated-vm is the
      // stronger, preferred engine; this is the worker fallback.)
      // NB: "eval"/"arguments" are illegal binding names under "use strict",
      // so they are denied by the host-side static validator, not shadowed here.
      const SHADOWED = [
        "require", "module", "exports", "process", "global", "globalThis",
        "__dirname", "__filename", "Function", "WebAssembly", "parentPort",
      ];
      for (const endpoint of msg.endpoints) {
        const factory = new Function(
          ...SHADOWED,
          '"use strict"; return (' + endpoint.handlerSource + ");",
        );
        const handler = factory(...SHADOWED.map(() => undefined));
        if (typeof handler !== "function") throw new Error("handler is not a function");
        routes.set(endpoint.method + " " + endpoint.path, handler);
      }
      handlerMaps.set(msg.capKey, routes);
      parentPort.postMessage({ type: "result", id: msg.id, ok: true, value: null });
    } catch (err) {
      parentPort.postMessage({
        type: "result",
        id: msg.id,
        ok: false,
        error: String((err && err.message) || err),
      });
    }
    return;
  }

  if (msg.type === "dispatch") {
    const respond = (value) =>
      parentPort.postMessage({ type: "result", id: msg.id, ok: true, value });
    try {
      const routes = handlerMaps.get(msg.capKey);
      const handler = routes && routes.get(msg.req.method + " " + msg.req.path);
      if (!handler) {
        respond({
          status: 404,
          body: { error: "no handler for " + msg.req.method + " " + msg.req.path },
        });
        return;
      }
      const res = await handler(msg.req, makeCtx(msg.capKey));
      respond({
        status: (res && res.status) || 200,
        body: res && "body" in res ? res.body : null,
      });
    } catch (err) {
      respond({ status: 500, body: { error: String((err && err.message) || err) } });
    }
  }
});
`;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export function createWorkerRuntime(host: SandboxHostApi): SandboxRuntime {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  worker.unref();

  const bridges = new Map<string, { fetch: HostFetchFn; store: HostStoreFn }>();
  const pending = new Map<number, Pending>();
  let seq = 0;

  worker.on(
    "message",
    async (msg: {
      type: string;
      id: number;
      kind?: string;
      capKey?: string;
      args?: string[];
      ok?: boolean;
      value?: unknown;
      error?: string;
    }) => {
      if (msg.type === "result") {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error ?? "sandbox worker error"));
        return;
      }
      if (msg.type === "hostcall") {
        const bridge = bridges.get(msg.capKey ?? "");
        try {
          if (!bridge) throw new Error(`capability ${msg.capKey} is not registered`);
          const [a0 = "", a1 = "", a2 = ""] = msg.args ?? [];
          const value =
            msg.kind === "fetch"
              ? await bridge.fetch(a0, a1)
              : await bridge.store(a0, a1, a2);
          worker.postMessage({ type: "hostresult", id: msg.id, ok: true, value });
        } catch (err) {
          worker.postMessage({
            type: "hostresult",
            id: msg.id,
            ok: false,
            error: String((err as Error)?.message ?? err),
          });
        }
      }
    },
  );

  function call(message: Record<string, unknown>, label: string): Promise<unknown> {
    const id = ++seq;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...message, id });
    });
    return withTimeout(promise, DISPATCH_TIMEOUT_MS, label);
  }

  return {
    engine: "worker",

    async register(spec: CapabilitySpec): Promise<void> {
      const key = capabilityKey(spec);
      bridges.set(key, {
        fetch: makeHostFetch(spec, host),
        store: makeHostStore(spec, host),
      });
      await call(
        { type: "register", capKey: key, endpoints: spec.endpoints },
        `register ${key}`,
      );
    },

    has(key: string): boolean {
      return bridges.has(key);
    },

    async dispatch(key: string, req: CapabilityRequest): Promise<CapabilityResponse> {
      if (!bridges.has(key)) throw new Error(`capability ${key} is not registered`);
      const value = await call(
        { type: "dispatch", capKey: key, req },
        `capability ${key} ${req.method} ${req.path}`,
      );
      return value as CapabilityResponse;
    },

    async dispose(): Promise<void> {
      bridges.clear();
      await worker.terminate();
    },
  };
}
