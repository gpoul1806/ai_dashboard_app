import { describe, expect, it } from "vitest";
import {
  validateCapabilitySpec,
  validatePlan,
  validateTier1Wire,
  validateWidgetDefinition,
} from "./validators";

const NO_GENERATED = new Set<string>();

describe("validatePlan — cacheHit needs no build plan", () => {
  it("accepts a feasible plan that only sets cacheHit (empty widgetPlan)", () => {
    const result = validatePlan({
      intent: "create",
      feasible: true,
      cacheHit: "seed-todo",
      widgetPlan: "",
    });
    expect(result.ok).toBe(true);
  });

  it("still rejects a feasible create plan with no cacheHit and no plan", () => {
    const result = validatePlan({ intent: "create", feasible: true, widgetPlan: "" });
    expect(result.ok).toBe(false);
  });
});

describe("validateWidgetDefinition — free-form trees", () => {
  const def = (root: unknown) => ({
    id: "w",
    name: "W",
    description: "w",
    version: 1,
    root,
  });

  it("accepts a styled element tree with media", () => {
    const result = validateWidgetDefinition(
      def({
        kind: "element",
        tag: "section",
        style: { background: "#111", color: "#fff" },
        children: [
          { kind: "element", tag: "audio", attrs: { src: "/uploads/a.mp3", controls: true } },
        ],
      }),
      NO_GENERATED,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects event-handler attributes (strict sanitize)", () => {
    const result = validateWidgetDefinition(
      def({ kind: "element", tag: "img", attrs: { src: "/x.png", onerror: "alert(1)" } }),
      NO_GENERATED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/onerror/);
  });

  it("rejects disallowed tags", () => {
    const result = validateWidgetDefinition(
      def({ kind: "element", tag: "iframe" }),
      NO_GENERATED,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects unknown component names but accepts registered generated keys", () => {
    const bad = validateWidgetDefinition(
      def({ kind: "component", component: "Mystery" }),
      NO_GENERATED,
    );
    expect(bad.ok).toBe(false);

    const good = validateWidgetDefinition(
      def({ kind: "component", component: "Image@1" }),
      new Set(["Image@1"]),
    );
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value.requiresComponents).toEqual(["Image@1"]);
  });

  it("rejects invalid action strings on elements", () => {
    const result = validateWidgetDefinition(
      def({ kind: "element", tag: "div", action: "dropTables" }),
      NO_GENERATED,
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a chained action and rejects a chain with an invalid step", () => {
    const good = validateWidgetDefinition(
      def({ kind: "element", tag: "div", action: "addRow;setView:home" }),
      NO_GENERATED,
    );
    expect(good.ok).toBe(true);

    const bad = validateWidgetDefinition(
      def({ kind: "element", tag: "div", action: "addRow;dropTables" }),
      NO_GENERATED,
    );
    expect(bad.ok).toBe(false);
  });
});

describe("validateWidgetDefinition — capability-data rule (no invented fetch mechanisms)", () => {
  const def = (root: unknown, extra: Record<string, unknown> = {}) => ({
    id: "w",
    name: "W",
    description: "w",
    version: 1,
    root,
    ...extra,
  });

  it("rejects a capability endpoint wired via an invented attr (data-fetch)", () => {
    const result = validateWidgetDefinition(
      def({
        kind: "element",
        tag: "div",
        attrs: { "data-fetch": "/api/dyn/greek-nameday-today@1/nameday" },
      }),
      NO_GENERATED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/useCapability/);
  });

  it("still allows /api/dyn/ URLs in real URL attrs (the browser does that fetch)", () => {
    const result = validateWidgetDefinition(
      def(
        {
          kind: "element",
          tag: "img",
          attrs: { src: "/api/dyn/random-car-image@1/image" },
        },
        { requiresCapabilities: ["random-car-image@1"] },
      ),
      NO_GENERATED,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects requiresCapabilities when nothing in the tree can consume a capability", () => {
    const result = validateWidgetDefinition(
      def(
        {
          kind: "element",
          tag: "div",
          children: [{ kind: "text", value: "Namedays today" }],
        },
        { requiresCapabilities: ["greek-nameday-today@1"] },
      ),
      NO_GENERATED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/requiresCapabilities/);
  });

  it("accepts requiresCapabilities consumed by a generated component", () => {
    const result = validateWidgetDefinition(
      def(
        { kind: "component", component: "NamedayList@1" },
        { requiresCapabilities: ["greek-nameday-today@1"] },
      ),
      new Set(["NamedayList@1"]),
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateTier1Wire — definitionJson transport", () => {
  it("still fails (with readable retry errors) when the JSON is garbage", async () => {
    // jsonrepair may coerce fragments into *some* JSON, but the result then
    // fails Zod validation — either way the errors ride the retry loop.
    const result = await validateTier1Wire({ definitionJson: "{ nope" }, NO_GENERATED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("repairs recoverable escaping slips instead of burning the retry", async () => {
    const good = {
      id: "w",
      name: "W",
      description: "w",
      version: 1,
      root: { kind: "text", value: "hi" },
    };
    // A trailing comma — invalid JSON.parse, trivially repairable.
    const broken = JSON.stringify(good).slice(0, -1) + ",}";
    const result = await validateTier1Wire({ definitionJson: broken }, NO_GENERATED);
    expect(result.ok).toBe(true);
  });

  it("parses and validates a definition riding as a JSON string", async () => {
    const result = await validateTier1Wire(
      {
        definitionJson: JSON.stringify({
          id: "w",
          name: "W",
          description: "w",
          version: 1,
          presentation: { placement: "pinned", anchor: "bottom-right" },
          root: { kind: "text", value: "hi" },
        }),
      },
      NO_GENERATED,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.presentation.anchor).toBe("bottom-right");
  });

  it("blocks SSRF targets: private/internal hosts in media URLs never get probed", async () => {
    delete process.env.SKIP_MEDIA_URL_CHECK;
    for (const src of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:3001/api/features",
      "http://10.0.0.5/x.mp4",
      "http://localhost:5432/x.mp4",
      "http://[::1]/x.mp4",
    ]) {
      const result = await validateTier1Wire(
        {
          definitionJson: JSON.stringify({
            id: "v",
            name: "V",
            description: "v",
            version: 1,
            root: { kind: "element", tag: "video", attrs: { src, controls: true } },
          }),
        },
        NO_GENERATED,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toMatch(/not allowed/);
    }
  });

  it("rejects YouTube/watch-page URLs in <video> src (cannot play in a video tag)", async () => {
    delete process.env.SKIP_MEDIA_URL_CHECK;
    const result = await validateTier1Wire(
      {
        definitionJson: JSON.stringify({
          id: "v",
          name: "V",
          description: "v",
          version: 1,
          root: {
            kind: "element",
            tag: "video",
            attrs: { src: "https://www.youtube.com/watch?v=abc123", controls: true },
          },
        }),
      },
      NO_GENERATED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/YouTube/);
  });
});

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
