import { describe, expect, it } from "vitest";
import { validateCapabilitySpec } from "./validators";

const base = {
  id: "demo-cap",
  name: "Demo",
  version: 1,
  description: "demo capability",
};

describe("validateCapabilitySpec — API-free enforcement", () => {
  it("accepts a keyless capability", async () => {
    const result = await validateCapabilitySpec({
      ...base,
      domainAllowlist: ["cataas.com"],
      endpoints: [
        {
          method: "GET",
          path: "/gif",
          handlerSource:
            "async (req, ctx) => { const r = await ctx.capFetch('https://cataas.com/cat?json=true'); return { status: 200, body: r.json() }; }",
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a {{secret:...}} placeholder (must be keyless)", async () => {
    const result = await validateCapabilitySpec({
      ...base,
      domainAllowlist: ["api.giphy.com"],
      endpoints: [
        {
          method: "GET",
          path: "/gif",
          handlerSource:
            "async (req, ctx) => { const r = await ctx.capFetch('https://api.giphy.com/v1/gifs/search?api_key={{secret:GIPHY_API_KEY}}'); return { status: 200, body: r.json() }; }",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/API-FREE/);
    }
  });

  it("rejects an Authorization header", async () => {
    const result = await validateCapabilitySpec({
      ...base,
      domainAllowlist: ["api.example.com"],
      endpoints: [
        {
          method: "GET",
          path: "/x",
          handlerSource:
            "async (req, ctx) => { await ctx.capFetch('https://api.example.com/x', { headers: { 'Authorization': 'Bearer abc' } }); return { status: 200, body: {} }; }",
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an api_key reference", async () => {
    const result = await validateCapabilitySpec({
      ...base,
      domainAllowlist: ["api.example.com"],
      endpoints: [
        {
          method: "GET",
          path: "/x",
          handlerSource:
            "async (req, ctx) => { const key = 'apikey'; await ctx.capFetch('https://api.example.com/x?apikey=' + key); return { status: 200, body: {} }; }",
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("still rejects sandbox escapes (require/process)", async () => {
    const result = await validateCapabilitySpec({
      ...base,
      domainAllowlist: [],
      endpoints: [
        {
          method: "GET",
          path: "/x",
          handlerSource: "async (req, ctx) => { require('fs'); return { status: 200, body: {} }; }",
        },
      ],
    });
    expect(result.ok).toBe(false);
  });
});
