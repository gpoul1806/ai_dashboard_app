import { describe, expect, it } from "vitest";
import {
  CapabilitySpecSchema,
  ComponentSpecSchema,
  PlanSchema,
  WidgetDefinitionSchema,
  capabilityKey,
  componentKey,
  jsonSchemaOf,
} from "./index";

describe("WidgetDefinitionSchema", () => {
  const valid = {
    id: "todo",
    name: "Todo List",
    description: "a todo list",
    version: 1,
    root: {
      type: "Card",
      props: { title: "Todos" },
      children: [{ type: "Text", props: { text: "hi" } }],
    },
  };

  it("accepts a valid definition and applies defaults", () => {
    const parsed = WidgetDefinitionSchema.parse(valid);
    expect(parsed.requiresComponents).toEqual([]);
    expect(parsed.requiresCapabilities).toEqual([]);
    expect(parsed.placement).toBe("flow");
  });

  it("accepts nested recursive component trees", () => {
    const deep = {
      ...valid,
      root: {
        type: "Stack",
        children: [{ type: "Stack", children: [{ type: "Text", props: { text: "x" } }] }],
      },
    };
    expect(() => WidgetDefinitionSchema.parse(deep)).not.toThrow();
  });

  it("rejects a definition without a root", () => {
    const { root: _root, ...rest } = valid;
    expect(WidgetDefinitionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an invalid placement", () => {
    expect(
      WidgetDefinitionSchema.safeParse({ ...valid, placement: "sidebar" }).success,
    ).toBe(false);
  });
});

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

describe("jsonSchemaOf", () => {
  it("converts the recursive WidgetDefinition schema without throwing", () => {
    const js = jsonSchemaOf(WidgetDefinitionSchema) as Record<string, unknown>;
    expect(js).toBeTruthy();
    expect(JSON.stringify(js)).toContain("root");
  });
});
