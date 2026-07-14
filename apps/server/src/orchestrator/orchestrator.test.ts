import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Full pipeline test with a MOCKED Claude client — exercises planner → Tier 3
 * (generate + hold for approval) → Tier 2 (esbuild) → Tier 1 (compose +
 * validate), plus the feature cache, without a real API key.
 *
 * The real client uses structured outputs (generateObject); the mock queues
 * wire-shaped objects FIFO.
 */

const responses: unknown[] = [];
vi.mock("../llm/client", () => ({
  llmAvailable: () => true,
  generateObject: vi.fn(async (opts: { signal?: AbortSignal }) => {
    if (opts?.signal?.aborted) {
      const err = new Error("Request was aborted");
      err.name = "AbortError";
      throw err;
    }
    const value = responses.shift();
    if (value === undefined) throw new Error("no mock LLM response queued");
    return { value, tokens: 42 };
  }),
  explainFailure: vi.fn(async (_req: string, err: string) => `explained: ${err}`),
}));

import { createMemoryDb, type Db } from "../db";
import { createSandbox, makeHostApi, type SandboxRuntime } from "../sandbox";
import { Orchestrator } from "./index";

let db: Db;
let sandbox: SandboxRuntime;
let orchestrator: Orchestrator;

beforeEach(async () => {
  responses.length = 0;
  db = createMemoryDb();
  sandbox = await createSandbox(makeHostApi(db), "worker");
  orchestrator = new Orchestrator(db, sandbox);
});

afterEach(async () => {
  await sandbox.dispose();
});

/** Wraps a WidgetDefinition into the Tier-1 wire shape (definitionJson string). */
const tier1Wire = (def: unknown) => ({ definitionJson: JSON.stringify(def) });

describe("Orchestrator — Tier 1 composition", () => {
  it("plans and composes a free-form widget", async () => {
    responses.push(
      { widgetPlan: "a dark greeting card" },
      tier1Wire({
        id: "greeting",
        name: "Greeting",
        description: "a greeting card",
        version: 1,
        presentation: { placement: "flow", surface: "none" },
        root: {
          kind: "element",
          tag: "section",
          style: { background: "#101418", color: "#fff", borderRadius: "14px" },
          children: [{ kind: "text", value: "hello" }],
        },
      }),
    );

    const result = await orchestrator.handleRequest("show me a greeting card");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.cached).toBe(false);
    expect(result.feature.name).toBe("Greeting");
    expect(result.feature.definition.root.kind).toBe("element");

    const features = await db.listFeatures();
    expect(features).toHaveLength(1);
  });

  it("retries Tier 1 once with errors when the first widget is invalid", async () => {
    responses.push(
      { widgetPlan: "a card" },
      // invalid: unknown component name
      tier1Wire({
        id: "x",
        name: "X",
        description: "x",
        version: 1,
        root: { kind: "component", component: "Nonexistent" },
      }),
      // corrected
      tier1Wire({
        id: "x",
        name: "X",
        description: "x widget",
        version: 1,
        root: { kind: "text", value: "ok" },
      }),
    );

    const result = await orchestrator.handleRequest("make an x");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.feature.definition.root.kind).toBe("text");
  });

  it("retries once when definitionJson is malformed JSON, then succeeds", async () => {
    responses.push(
      { widgetPlan: "a card" },
      { definitionJson: "{ not valid json" },
      tier1Wire({
        id: "y",
        name: "Y",
        description: "y widget",
        version: 1,
        root: { kind: "text", value: "ok" },
      }),
    );

    const result = await orchestrator.handleRequest("make a y");
    expect(result.status).toBe("ok");
  });

  it("rejects XSS vectors at validation (strict sanitize) and uses the retry", async () => {
    responses.push(
      { widgetPlan: "a card" },
      tier1Wire({
        id: "z",
        name: "Z",
        description: "z",
        version: 1,
        root: {
          kind: "element",
          tag: "img",
          attrs: { src: "/x.png", onerror: "alert(1)" },
        },
      }),
      tier1Wire({
        id: "z",
        name: "Z",
        description: "z widget",
        version: 1,
        root: { kind: "element", tag: "img", attrs: { src: "/x.png" } },
      }),
    );

    const result = await orchestrator.handleRequest("make a z");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const root = result.feature.definition.root;
    expect(root.kind).toBe("element");
    if (root.kind !== "element") return;
    expect(root.attrs && "onerror" in root.attrs).toBeFalsy();
  });

  it("propagates cancellation (aborted signal) instead of building or declining", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(orchestrator.handleRequest("build me anything", [], ac.signal)).rejects.toThrow();
    expect(await db.listFeatures()).toHaveLength(0);
    expect(await db.listComponents()).toHaveLength(0);
  });

  it("removes an existing widget instead of building an acknowledgement", async () => {
    responses.push(
      { widgetPlan: "a card" },
      tier1Wire({
        id: "note",
        name: "Note",
        description: "a sticky note",
        version: 1,
        root: { kind: "text", value: "note" },
      }),
    );
    const built = await orchestrator.handleRequest("a sticky note");
    expect(built.status).toBe("ok");
    if (built.status !== "ok") return;
    const featureId = built.feature.id;
    expect(await db.listFeatures()).toHaveLength(1);

    responses.push({ intent: "remove", removeFeatureIds: [featureId] });
    const removed = await orchestrator.handleRequest("remove the sticky note");
    expect(removed.status).toBe("removed");
    if (removed.status !== "removed") return;
    expect(removed.removed.map((r) => r.name)).toEqual(["Note"]);
    expect(await db.listFeatures()).toHaveLength(0);
  });

  it("declines a removal when no widget matches", async () => {
    responses.push({
      intent: "remove",
      removeFeatureIds: [],
      feasible: false,
      declineReason: "There's no weather widget on your dashboard to remove.",
    });
    const res = await orchestrator.handleRequest("remove the weather widget");
    expect(res.status).toBe("declined");
    if (res.status !== "declined") return;
    expect(res.reason).toContain("weather");
  });

  it("declines an infeasible request with the planner's reason (no widget built)", async () => {
    responses.push({
      feasible: false,
      declineReason:
        "That needs access to your private Gmail account, which requires an API key and login this app can't use. Try asking for a plain notes or todo widget instead.",
    });

    const result = await orchestrator.handleRequest("show my gmail inbox");
    expect(result.status).toBe("declined");
    if (result.status !== "declined") return;
    expect(result.reason).toContain("Gmail");
    expect(await db.listFeatures()).toHaveLength(0);
    expect(await db.listComponents()).toHaveLength(0);
  });
});

describe("Orchestrator — feature cache", () => {
  it("serves a similar prior feature from cache without calling the LLM", async () => {
    responses.push(
      { widgetPlan: "todo list" },
      tier1Wire({
        id: "todo",
        name: "Todo",
        description: "a todo list to track my daily tasks",
        version: 1,
        root: { kind: "text", value: "todo" },
      }),
    );
    await orchestrator.handleRequest("a todo list to track my daily tasks");

    // No new responses queued: a cache hit must not hit the LLM.
    const cached = await orchestrator.handleRequest("a todo list to track my daily tasks");
    expect(cached.status).toBe("ok");
    if (cached.status !== "ok") return;
    expect(cached.cached).toBe(true);
    expect(cached.feature.name).toBe("Todo");
  });
});

describe("Orchestrator — clear all keeps the cache", () => {
  it("clears the dashboard but re-surfaces the cached feature on a similar ask (no LLM)", async () => {
    responses.push(
      { widgetPlan: "todo list" },
      tier1Wire({
        id: "todo",
        name: "Todo",
        description: "a todo list to track my daily tasks",
        version: 1,
        root: { kind: "text", value: "todo" },
      }),
    );
    await orchestrator.handleRequest("a todo list to track my daily tasks");
    expect(await db.listFeatures()).toHaveLength(1);

    // Clear all: dashboard empties, the feature cache does not.
    expect(await db.clearLayout()).toBe(1);
    expect(await db.listFeatures()).toHaveLength(0);
    expect(await db.findSimilarFeatures("a todo list to track my daily tasks", 5)).not.toHaveLength(0);

    // No responses queued: a similar request must be a pure cache hit that
    // puts the widget back on the dashboard.
    const again = await orchestrator.handleRequest("a todo list to track my daily tasks");
    expect(again.status).toBe("ok");
    if (again.status !== "ok") return;
    expect(again.cached).toBe(true);
    expect(await db.listFeatures()).toHaveLength(1);
  });
});

describe("Orchestrator — app-scope (views) plans", () => {
  it("builds menu + per-tab widgets and moves the existing widget onto a view", async () => {
    // An existing table on the dashboard.
    responses.push(
      { widgetPlan: "a table" },
      tier1Wire({
        id: "registry",
        name: "Registry",
        description: "a personnel table",
        version: 1,
        root: { kind: "text", value: "table" },
      }),
    );
    const built = await orchestrator.handleRequest("a personnel table");
    if (built.status !== "ok") throw new Error("setup failed");
    const tableId = built.feature.id;

    // "Global tab menu": menu (no view) + about widget + contact widget, and
    // the existing table is assigned to the "home" view.
    responses.push(
      {
        widgetPlan: "a pinned global tab menu, no view, items setView home/about/contact",
        moreWidgetPlans: ["a cat picture widget on view about", "a contact form on view contact"],
        viewAssignments: [{ featureId: tableId, view: "home" }],
      },
      tier1Wire({
        id: "tab-menu",
        name: "Tab Menu",
        description: "global tab menu",
        version: 1,
        presentation: { placement: "pinned", anchor: "top-right" },
        root: {
          kind: "element",
          tag: "nav",
          children: [
            { kind: "element", tag: "span", action: "setView:home", children: [{ kind: "text", value: "Home" }] },
            { kind: "element", tag: "span", action: "setView:about", children: [{ kind: "text", value: "About" }] },
            { kind: "element", tag: "span", action: "setView:contact", children: [{ kind: "text", value: "Contact" }] },
          ],
        },
      }),
      tier1Wire({
        id: "about-cat",
        name: "About Cat",
        description: "a cat picture",
        version: 1,
        presentation: { placement: "flow", view: "about" },
        root: { kind: "element", tag: "img", attrs: { src: "https://cataas.com/cat" } },
      }),
      tier1Wire({
        id: "contact-form",
        name: "Contact Form",
        description: "a contact form",
        version: 1,
        presentation: { placement: "flow", view: "contact" },
        root: { kind: "component", component: "Input", props: { name: "email" } },
      }),
    );

    const result = await orchestrator.handleRequest(
      "add a global menu with tabs: home shows the table, about a cat, contact a form",
    );
    expect(result.status).toBe("ok");

    const all = await db.listFeatures();
    expect(all).toHaveLength(4);
    const byName = Object.fromEntries(all.map((f) => [f.name, f]));
    // The menu is global (no view); tab content is view-scoped.
    expect(byName["Tab Menu"].definition.presentation?.view).toBeUndefined();
    expect(byName["About Cat"].definition.presentation?.view).toBe("about");
    expect(byName["Contact Form"].definition.presentation?.view).toBe("contact");
    // The pre-existing table was re-homed onto the "home" view.
    expect(byName["Registry"].definition.presentation?.view).toBe("home");
  });

  it("modifies existing widgets in place via updatePlans (cross-widget wiring)", async () => {
    // Two independent widgets: an input and a switch.
    responses.push(
      { widgetPlan: "an input" },
      tier1Wire({
        id: "field",
        name: "Field",
        description: "an input field",
        version: 1,
        root: { kind: "component", component: "Input", props: { name: "text" } },
      }),
      { widgetPlan: "a switch" },
      tier1Wire({
        id: "switch",
        name: "Switch",
        description: "an on/off switch",
        version: 1,
        root: { kind: "component", component: "Checkbox", props: { checked: false } },
      }),
    );
    const a = await orchestrator.handleRequest("an input field");
    const b = await orchestrator.handleRequest("an on off switch");
    if (a.status !== "ok" || b.status !== "ok") throw new Error("setup failed");

    // Third request: wire them — planner returns ONLY updatePlans.
    responses.push(
      {
        widgetPlan: "",
        updatePlans: [
          { featureId: a.feature.id, instruction: "disable input when input-enabled off" },
          { featureId: b.feature.id, instruction: "toggle global input-enabled" },
        ],
      },
      tier1Wire({
        id: "field",
        name: "Field",
        description: "an input field",
        version: 1,
        root: {
          kind: "component",
          component: "Input",
          props: { name: "text", disabled: { $globalNot: "input-enabled" } },
        },
      }),
      tier1Wire({
        id: "switch",
        name: "Switch",
        description: "an on/off switch",
        version: 1,
        root: {
          kind: "component",
          component: "Checkbox",
          props: { checked: { $global: "input-enabled" }, action: "toggleGlobal:input-enabled" },
        },
      }),
    );
    const wired = await orchestrator.handleRequest("when the switch is off disable the input");
    expect(wired.status).toBe("ok");

    // Same widgets (same ids), definitions rewritten in place — no new widgets.
    const all = await db.listFeatures();
    expect(all).toHaveLength(2);
    const field = await db.getFeature(a.feature.id);
    const sw = await db.getFeature(b.feature.id);
    expect(JSON.stringify(field?.definition.root)).toContain("$globalNot");
    expect(JSON.stringify(sw?.definition.root)).toContain("toggleGlobal:input-enabled");
    expect(field?.definition.version).toBe(2);
  });

  it("rejects invalid setView action names", async () => {
    responses.push(
      { widgetPlan: "menu" },
      tier1Wire({
        id: "m",
        name: "M",
        description: "m",
        version: 1,
        root: { kind: "element", tag: "div", action: "setView:NOT VALID" },
      }),
      tier1Wire({
        id: "m",
        name: "M",
        description: "m widget",
        version: 1,
        root: { kind: "element", tag: "div", action: "setView:ok-view" },
      }),
    );
    const result = await orchestrator.handleRequest("a menu");
    expect(result.status).toBe("ok");
  });
});

describe("Orchestrator — Tier 3 + Tier 2 + Tier 1", () => {
  it("generates a capability (held for approval), a component, then composes", async () => {
    responses.push(
      // plan
      {
        widgetPlan: "an image widget showing a random cat gif, pinned top-right",
        needsCapabilities: [{ id: "cat-gif", description: "return a random cat gif url" }],
        needsComponents: [{ id: "Image", description: "renders an image from a src prop" }],
      },
      // tier 3 capability (wire ≈ spec)
      {
        id: "cat-gif",
        name: "Cat Gif",
        version: 1,
        description: "returns a random cat gif url",
        domainAllowlist: ["api.thecatapi.com"],
        endpoints: [
          {
            method: "GET",
            path: "/random",
            handlerSource:
              "async (req, ctx) => ({ status: 200, body: { url: 'https://cataas.test/cat.gif' } })",
          },
        ],
      },
      // tier 2 component (wire carries propsSchemaJson)
      {
        id: "Image",
        name: "Image",
        version: 1,
        description: "renders an image from a src prop",
        propsSchemaJson: JSON.stringify({
          type: "object",
          properties: { src: { type: "string" } },
        }),
        source:
          "import React from 'react';\nexport default function Image({ src }: { src?: string }) {\n  return <img src={src} alt=\"\" style={{ maxWidth: '100%' }} />;\n}\n",
      },
      // tier 1 widget
      tier1Wire({
        id: "cat-gif-widget",
        name: "Cat Gif",
        description: "a random cat gif pinned top-right",
        version: 1,
        presentation: { placement: "pinned", anchor: "top-right", size: { width: "260px" } },
        requiresComponents: ["Image@1"],
        requiresCapabilities: ["cat-gif@1"],
        root: {
          kind: "element",
          tag: "div",
          style: { borderRadius: "12px", overflow: "hidden" },
          children: [
            {
              kind: "component",
              component: "Image@1",
              props: { src: "https://cataas.test/cat.gif" },
            },
          ],
        },
      }),
    );

    const result = await orchestrator.handleRequest("a cat gif top-right");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.feature.definition.presentation.placement).toBe("pinned");
    expect(result.feature.definition.presentation.anchor).toBe("top-right");
    expect(result.pendingApprovals).toEqual(["cat-gif@1"]);

    // Component was built + stored.
    const components = await db.listComponents();
    expect(components.map((c) => c.key)).toContain("Image@1");
    expect(components[0].builtJs).toMatch(/jsx|createElement/);
    expect(components[0].builtJs).toContain("default");
    expect(components[0].propsSchema).toMatchObject({ type: "object" });

    // NEW capability is stored but NOT yet approved/registered (safety rail #5).
    const caps = await db.listCapabilities();
    expect(caps[0].approved).toBe(false);
    expect(sandbox.has("cat-gif@1")).toBe(false);

    // After approval it becomes reachable.
    await db.setCapabilityApproved("cat-gif@1", true);
    await sandbox.register(caps[0].spec);
    const res = await sandbox.dispatch("cat-gif@1", {
      method: "GET",
      path: "/random",
      query: {},
      body: null,
    });
    expect(res).toEqual({ status: 200, body: { url: "https://cataas.test/cat.gif" } });
  });
});
