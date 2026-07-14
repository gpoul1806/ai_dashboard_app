import { describe, expect, it } from "vitest";
import {
  CapabilitySpecSchema,
  ComponentSpecSchema,
  PlanSchema,
  RequestOutcomeSchema,
  UINodeSchema,
  WidgetDefinitionSchema,
  capabilityKey,
  componentKey,
  jsonSchemaOf,
  sanitizeTree,
  type UINode,
} from "./index";

/* ------------------------------------------------------------------ */
/* Canary: recursive discriminated union → JSON Schema                 */
/* ------------------------------------------------------------------ */

describe("jsonSchemaOf (canary — run first)", () => {
  it("converts the recursive WidgetDefinition schema without throwing", () => {
    const js = jsonSchemaOf(WidgetDefinitionSchema) as Record<string, unknown>;
    expect(js).toBeTruthy();
    expect(JSON.stringify(js)).toContain("root");
    expect(JSON.stringify(js)).toContain("element");
  });
});

/* ------------------------------------------------------------------ */
/* UINode                                                              */
/* ------------------------------------------------------------------ */

describe("UINodeSchema", () => {
  it("parses a text node with a literal and a binding", () => {
    expect(UINodeSchema.parse({ kind: "text", value: "hello" })).toBeTruthy();
    expect(UINodeSchema.parse({ kind: "text", value: { $count: "rows" } })).toBeTruthy();
  });

  it("parses $if bindings in text, attrs, and style values", () => {
    const node = UINodeSchema.parse({
      kind: "element",
      tag: "div",
      action: "toggleGlobal:power-on",
      style: {
        background: { $if: "power-on", then: "#7c5cff", else: "#3a3a44" },
        transform: { $if: "!power-on", then: "translateX(0px)", else: "translateX(26px)" },
      },
      children: [
        { kind: "text", value: { $if: "power-on", then: "ON", else: "OFF" } },
      ],
    });
    expect(node.kind).toBe("element");
  });

  it("parses an element node with attrs, style, action and children", () => {
    const node = UINodeSchema.parse({
      kind: "element",
      tag: "div",
      style: { backgroundColor: "#111", padding: 16 },
      action: "addRow",
      children: [
        { kind: "text", value: "click me" },
        { kind: "element", tag: "video", attrs: { src: "/uploads/a.mp4", controls: true } },
      ],
    });
    expect(node.kind).toBe("element");
  });

  it("parses a component node with props and children", () => {
    const node = UINodeSchema.parse({
      kind: "component",
      component: "List",
      props: { items: { $data: "rows" }, itemTemplate: { kind: "text", value: { $row: "title" } } },
    });
    expect(node.kind).toBe("component");
  });

  it("rejects an unknown kind", () => {
    expect(UINodeSchema.safeParse({ kind: "widget", tag: "div" }).success).toBe(false);
  });

  it("rejects an element without a tag", () => {
    expect(UINodeSchema.safeParse({ kind: "element" }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* WidgetDefinition v2                                                 */
/* ------------------------------------------------------------------ */

describe("WidgetDefinitionSchema", () => {
  const valid = {
    id: "todo",
    name: "Todo List",
    description: "a todo list",
    version: 1,
    root: {
      kind: "element",
      tag: "section",
      style: { background: "linear-gradient(#222, #444)", borderRadius: "16px" },
      children: [{ kind: "text", value: "hi" }],
    },
  };

  it("accepts a valid definition and applies presentation defaults", () => {
    const parsed = WidgetDefinitionSchema.parse(valid);
    expect(parsed.requiresComponents).toEqual([]);
    expect(parsed.presentation.placement).toBe("flow");
    expect(parsed.presentation.surface).toBe("none");
  });

  it("accepts pinned presentation with anchor, zIndex and size", () => {
    const parsed = WidgetDefinitionSchema.parse({
      ...valid,
      presentation: {
        placement: "pinned",
        anchor: "bottom-right",
        zIndex: 30,
        size: { width: "280px" },
      },
    });
    expect(parsed.presentation.anchor).toBe("bottom-right");
  });

  it("accepts flow ordering", () => {
    const parsed = WidgetDefinitionSchema.parse({
      ...valid,
      presentation: { placement: "flow", order: 0, size: { gridColumnSpan: 2 } },
    });
    expect(parsed.presentation.order).toBe(0);
  });

  it("rejects an invalid anchor", () => {
    expect(
      WidgetDefinitionSchema.safeParse({
        ...valid,
        presentation: { placement: "pinned", anchor: "everywhere" },
      }).success,
    ).toBe(false);
  });

  it("rejects a definition without a root", () => {
    const { root: _root, ...rest } = valid;
    expect(WidgetDefinitionSchema.safeParse(rest).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* RequestOutcome envelope                                             */
/* ------------------------------------------------------------------ */

describe("RequestOutcomeSchema", () => {
  const feature = {
    id: "f1",
    slug: "f1",
    name: "F1",
    description: "d",
    version: 1,
    definition: {
      id: "f1",
      name: "F1",
      description: "d",
      version: 1,
      root: { kind: "text", value: "x" },
    },
    createdAt: new Date(0).toISOString(),
  };

  it("parses the created arm (failedPieces defaults to [])", () => {
    const out = RequestOutcomeSchema.parse({
      outcome: "created",
      artifact: { kind: "widget", feature },
      servedFromCache: false,
      pendingCapabilityApprovals: [],
    });
    expect(out.outcome).toBe("created");
    if (out.outcome === "created") expect(out.failedPieces).toEqual([]);
  });

  it("parses the created arm with reported failedPieces", () => {
    const out = RequestOutcomeSchema.parse({
      outcome: "created",
      artifact: { kind: "widget", feature },
      servedFromCache: false,
      pendingCapabilityApprovals: [],
      failedPieces: [{ plan: "a video widget", reason: "tier1 failed after retry" }],
    });
    if (out.outcome === "created") expect(out.failedPieces).toHaveLength(1);
  });

  it("parses the declined arm", () => {
    const out = RequestOutcomeSchema.parse({
      outcome: "declined",
      userFacingReason: "needs a private API key",
    });
    expect(out.outcome).toBe("declined");
  });

  it("parses the removed arm", () => {
    const out = RequestOutcomeSchema.parse({
      outcome: "removed",
      removedWidgets: [{ id: "f1", name: "F1" }],
    });
    expect(out.outcome).toBe("removed");
  });

  it("rejects an unknown outcome", () => {
    expect(RequestOutcomeSchema.safeParse({ outcome: "maybe" }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Sanitizer                                                           */
/* ------------------------------------------------------------------ */

describe("sanitizeTree", () => {
  const el = (tag: string, extra: Partial<Extract<UINode, { kind: "element" }>> = {}): UINode => ({
    kind: "element",
    tag,
    ...extra,
  });

  it("passes a clean media tree untouched", () => {
    const tree = el("video", {
      attrs: { src: "https://example.com/a.mp4", controls: true, loop: true, muted: true },
      style: { width: "100%", borderRadius: "12px" },
    });
    const { violations } = sanitizeTree(tree, "strict");
    expect(violations).toEqual([]);
  });

  it("passes an svg subset", () => {
    const tree = el("svg", {
      attrs: { viewBox: "0 0 100 100" },
      children: [el("circle", { attrs: { cx: "50", cy: "50", r: "40", fill: "#f80" } })],
    });
    expect(sanitizeTree(tree, "strict").violations).toEqual([]);
  });

  // OWASP-style XSS vectors — every one must be rejected in strict mode
  const vectors: Array<[string, UINode]> = [
    ["script tag", el("script")],
    ["iframe tag", el("iframe")],
    ["object tag", el("object")],
    ["embed tag", el("embed")],
    ["form tag", el("form")],
    ["input tag", el("input")],
    ["foreignObject", el("foreignObject")],
    ["svg use", el("use")],
    ["onclick attr", el("div", { attrs: { onclick: "alert(1)" } })],
    ["onerror attr", el("img", { attrs: { src: "/x.png", onerror: "alert(1)" } })],
    ["javascript: url", el("a", { attrs: { href: "javascript:alert(1)" } })],
    ["vbscript: url", el("a", { attrs: { href: "vbscript:x" } })],
    ["data:text/html url", el("a", { attrs: { href: "data:text/html,<script>x</script>" } })],
    ["protocol-relative url", el("img", { attrs: { src: "//evil.com/x.png" } })],
    ["srcdoc attr", el("div", { attrs: { srcdoc: "<script>x</script>" } })],
    ["formaction attr", el("a", { attrs: { formaction: "https://x" } })],
    ["string style attr", el("div", { attrs: { style: "background:url(javascript:x)" } })],
    ["class attr", el("div", { attrs: { class: "ui-card" } })],
    ["expression() style", el("div", { style: { width: "expression(alert(1))" } })],
    ["unsafe url() style", el("div", { style: { background: "url(javascript:alert(1))" } })],
    [
      "unsafe url() inside $if branch",
      el("div", {
        style: { background: { $if: "x", then: "url(javascript:alert(1))", else: "#fff" } },
      }),
    ],
    ["xlink:href attr", el("a", { attrs: { "xlink:href": "javascript:x" } })],
  ];

  for (const [name, tree] of vectors) {
    it(`strict rejects: ${name}`, () => {
      expect(sanitizeTree(tree, "strict").violations.length).toBeGreaterThan(0);
    });
  }

  it("strip mode removes offending parts and downgrades bad tags to div", () => {
    const tree = el("iframe", {
      attrs: { src: "https://ok.example.com", onload: "alert(1)" },
      style: { width: "expression(alert(1))", color: "red" },
      children: [el("div", { children: [{ kind: "text", value: "inner" }] })],
    });
    const { node } = sanitizeTree(tree, "strip");
    if (node.kind !== "element") throw new Error("expected element");
    expect(node.tag).toBe("div");
    expect(node.attrs && "onload" in node.attrs).toBeFalsy();
    expect(node.style).toEqual({ color: "red" });
    expect(node.children).toHaveLength(1);
  });

  it("strip mode leaves clean trees semantically intact", () => {
    const tree = el("div", {
      style: { display: "flex", gap: 8 },
      children: [
        { kind: "component", component: "Button", props: { label: "Add", action: "addRow" } },
        { kind: "text", value: { $count: "rows" } },
      ],
    });
    const { node, violations } = sanitizeTree(tree, "strip");
    expect(violations).toEqual([]);
    expect(node).toMatchObject({ kind: "element", tag: "div" });
  });

  it("sanitizes nested children of component nodes", () => {
    const tree: UINode = {
      kind: "component",
      component: "Card",
      children: [el("script")],
    };
    expect(sanitizeTree(tree, "strict").violations.length).toBeGreaterThan(0);
  });

  it("sanitizes node trees inside component props (itemTemplate bypass)", () => {
    const tree: UINode = {
      kind: "component",
      component: "List",
      props: {
        items: { $data: "rows" },
        itemTemplate: {
          kind: "element",
          tag: "img",
          attrs: { src: "/x.png", onerror: "alert(1)" },
        },
      },
    };
    // strict: reported as a violation
    expect(sanitizeTree(tree, "strict").violations.join(" ")).toMatch(/onerror/);
    // strip: removed from the returned tree
    const { node } = sanitizeTree(tree, "strip");
    expect(JSON.stringify(node)).not.toContain("onerror");
  });

  it("strips script tags hidden inside itemTemplate", () => {
    const tree: UINode = {
      kind: "component",
      component: "List",
      props: { itemTemplate: { kind: "element", tag: "script" } },
    };
    expect(sanitizeTree(tree, "strict").violations.length).toBeGreaterThan(0);
    const { node } = sanitizeTree(tree, "strip");
    expect(JSON.stringify(node)).not.toContain('"tag":"script"');
  });
});

/* ------------------------------------------------------------------ */
/* Unchanged tiers                                                     */
/* ------------------------------------------------------------------ */

describe("ComponentSpecSchema", () => {
  const valid = {
    id: "Image",
    name: "Image",
    version: 1,
    source: "import React from 'react';\nexport default function Image(){return null}",
  };

  it("accepts a valid spec and derives its key", () => {
    const parsed = ComponentSpecSchema.parse(valid);
    expect(componentKey(parsed)).toBe("Image@1");
  });

  it("rejects non-PascalCase ids", () => {
    expect(ComponentSpecSchema.safeParse({ ...valid, id: "image" }).success).toBe(false);
  });

  it("rejects empty source", () => {
    expect(ComponentSpecSchema.safeParse({ ...valid, source: "" }).success).toBe(false);
  });
});

describe("CapabilitySpecSchema", () => {
  const valid = {
    id: "giphy-search",
    name: "Giphy Search",
    version: 1,
    description: "search gifs",
    domainAllowlist: ["api.giphy.com"],
    endpoints: [
      {
        method: "GET",
        path: "/search",
        handlerSource: "async (req, ctx) => ({ status: 200, body: {} })",
      },
    ],
  };

  it("accepts a valid spec and derives its key", () => {
    const parsed = CapabilitySpecSchema.parse(valid);
    expect(capabilityKey(parsed)).toBe("giphy-search@1");
  });

  it("rejects non-kebab-case ids", () => {
    expect(CapabilitySpecSchema.safeParse({ ...valid, id: "GiphySearch" }).success).toBe(
      false,
    );
  });

  it("rejects an empty endpoint list", () => {
    expect(CapabilitySpecSchema.safeParse({ ...valid, endpoints: [] }).success).toBe(false);
  });

  it("rejects endpoint paths without a leading slash", () => {
    const bad = {
      ...valid,
      endpoints: [{ ...valid.endpoints[0], path: "search" }],
    };
    expect(CapabilitySpecSchema.safeParse(bad).success).toBe(false);
  });
});

describe("PlanSchema", () => {
  it("applies defaults", () => {
    const plan = PlanSchema.parse({ widgetPlan: "a todo list widget" });
    expect(plan.cacheHit).toBeNull();
    expect(plan.needsCapabilities).toEqual([]);
    expect(plan.needsComponents).toEqual([]);
  });
});
