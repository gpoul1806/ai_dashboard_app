import type { CapabilitySpec } from "@myday/schema";
import { capabilityKey } from "@myday/schema";
import type { SandboxHostApi } from "./types";

/**
 * Host-side implementations of the capability API, shared by both sandbox
 * engines. Both take string-only args and return JSON-safe values so they can
 * cross any isolation boundary.
 */

const SECRET_PATTERN = /\{\{secret:([A-Za-z0-9_]+)\}\}/g;

export interface HostFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type HostFetchFn = (url: string, optsJson: string) => Promise<HostFetchResult>;
export type HostStoreFn = (op: string, k: string, vJson: string) => Promise<string>;

export function makeHostFetch(spec: CapabilitySpec, host: SandboxHostApi): HostFetchFn {
  const key = capabilityKey(spec);
  return async (url: string, optsJson: string): Promise<HostFetchResult> => {
    const secrets = await host.getSecrets(key);
    const substitute = (value: string) =>
      value.replace(SECRET_PATTERN, (_m, name: string) => {
        const secret = secrets[name];
        if (secret === undefined) {
          throw new Error(`capFetch: secret "${name}" is not configured for ${key}`);
        }
        return secret;
      });

    const finalUrl = substitute(String(url));
    const parsed = new URL(finalUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`capFetch: protocol ${parsed.protocol} not allowed`);
    }
    const allowed = spec.domainAllowlist.some(
      (d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`),
    );
    if (!allowed) {
      host.log("capFetch.blocked", { capability: key, hostname: parsed.hostname });
      throw new Error(
        `capFetch: domain "${parsed.hostname}" is not in the allowlist for ${key}`,
      );
    }

    const opts = optsJson ? (JSON.parse(optsJson) as Record<string, unknown>) : {};
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      (opts.headers as Record<string, unknown>) ?? {},
    )) {
      headers[name] = substitute(String(value));
    }
    const rawBody = opts.body;
    const body =
      rawBody == null
        ? undefined
        : typeof rawBody === "string"
          ? rawBody
          : JSON.stringify(rawBody);

    // Egress is a logged event (never the substituted URL/headers).
    host.log("capFetch", {
      capability: key,
      url: `${parsed.origin}${parsed.pathname}`,
      method: String(opts.method ?? "GET"),
    });

    const res = await host.fetchImpl(parsed.toString(), {
      method: String(opts.method ?? "GET"),
      headers,
      body,
    });
    const text = await res.text();
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    return { status: res.status, headers: resHeaders, body: text };
  };
}

export function makeHostStore(spec: CapabilitySpec, host: SandboxHostApi): HostStoreFn {
  const key = capabilityKey(spec);
  return async (op: string, k: string, vJson: string): Promise<string> => {
    switch (op) {
      case "get": {
        const value = await host.store.get(key, k);
        return value == null ? "" : JSON.stringify(value);
      }
      case "set": {
        await host.store.set(key, k, vJson ? JSON.parse(vJson) : null);
        return "";
      }
      case "delete": {
        await host.store.delete(key, k);
        return "";
      }
      case "list": {
        const entries = await host.store.list(key);
        return JSON.stringify(entries);
      }
      default:
        throw new Error(`capStore: unknown op "${op}"`);
    }
  };
}

/**
 * The in-sandbox bootstrap for the isolated-vm engine. `_hostFetch` and
 * `_hostStore` are ivm References injected by the host.
 */
export const IVM_BOOTSTRAP = `
"use strict";
const __handlers = {};
globalThis.__register = (routeKey, handler) => { __handlers[routeKey] = handler; };

globalThis.capFetch = async (url, opts) => {
  const raw = await _hostFetch.apply(
    undefined,
    [String(url), opts ? JSON.stringify(opts) : ""],
    { result: { promise: true, copy: true } },
  );
  return {
    status: raw.status,
    headers: raw.headers,
    body: raw.body,
    text: () => raw.body,
    json: () => JSON.parse(raw.body),
  };
};

const __store = async (op, k, v) => {
  const out = await _hostStore.apply(
    undefined,
    [op, String(k ?? ""), v === undefined ? "" : JSON.stringify(v)],
    { result: { promise: true, copy: true } },
  );
  return out ? JSON.parse(out) : null;
};
globalThis.capStore = {
  get: (k) => __store("get", k),
  set: (k, v) => __store("set", k, v),
  delete: (k) => __store("delete", k),
  list: () => __store("list", ""),
};

globalThis.__dispatch = async (routeKey, reqJson) => {
  const handler = __handlers[routeKey];
  if (!handler) {
    return JSON.stringify({ status: 404, body: { error: "no handler for " + routeKey } });
  }
  const req = JSON.parse(reqJson);
  try {
    const res = await handler(req, { capFetch: globalThis.capFetch, capStore: globalThis.capStore });
    return JSON.stringify({
      status: (res && res.status) || 200,
      body: res && "body" in res ? res.body : null,
    });
  } catch (err) {
    return JSON.stringify({
      status: 500,
      body: { error: String((err && err.message) || err) },
    });
  }
};
`;
