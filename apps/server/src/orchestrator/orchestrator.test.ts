import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Full pipeline test with a MOCKED Claude client — exercises planner → Tier 3
 * (generate + hold for approval) → Tier 2 (esbuild) → Tier 1 (compose +
 * validate), plus the feature cache, without a real API key.
 */

// Queue of canned LLM responses, consumed FIFO per generateText call.
const responses: string[] = [];
vi.mock("../llm/client", () => ({
  llmAvailable: () => true,
  generateText: vi.fn(async () => {
    const text = responses.shift();
    if (text === undefined) throw new Error("no mock LLM response queued");
    return { text, tokens: 42 };
  }),
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

describe("Orchestrator — Tier 1 composition", () => {
  it("plans and composes a widget from built-in primitives", async () => {
    responses.push(
      JSON.stringify({ widgetPlan: "a card with a greeting" }),
      JSON.stringify({
        id: "greeting",
        name: "Greeting",
        description: "a greeting card",
        version: 1,
        root: { type: "Card", props: { title: "Hi" }, children: [{ type: "Text", props: { text: "hello" } }] },
      }),
    );

    const result = await orchestrator.handleRequest("show me a greeting card");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.cached).toBe(false);
    expect(result.feature.name).toBe("Greeting");
    expect(result.feature.definition.root.type).toBe("Card");

    const features = await db.listFeatures();
    expect(features).toHaveLength(1);
  });

  it("retries Tier 1 once with errors when the first widget is invalid", async () => {
    responses.push(
      JSON.stringify({ widgetPlan: "a card" }),
      // invalid: unknown component type
      JSON.stringify({
        id: "x",
        name: "X",
        description: "x",
        version: 1,
        root: { type: "Nonexistent" },
      }),
      // corrected
      JSON.stringify({
        id: "x",
        name: "X",
        description: "x widget",
        version: 1,
        root: { type: "Text", props: { text: "ok" } },
      }),
    );

    const result = await orchestrator.handleRequest("make an x");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.feature.definition.root.type).toBe("Text");
  });

  it("declines an infeasible request with the planner's reason (no widget built)", async () => {
    responses.push(
      JSON.stringify({
        feasible: false,
        declineReason:
          "That needs access to your private Gmail account, which requires an API key and login this app can't use. Try asking for a plain notes or todo widget instead.",
      }),
    );

    const result = await orchestrator.handleRequest("show my gmail inbox");
    expect(result.status).toBe("declined");
    if (result.status !== "declined") return;
    expect(result.reason).toContain("Gmail");
    // Nothing was built.
    expect(await db.listFeatures()).toHaveLength(0);
    expect(await db.listComponents()).toHaveLength(0);
  });
});

describe("Orchestrator — feature cache", () => {
  it("serves a similar prior feature from cache without calling the LLM", async () => {
    responses.push(
      JSON.stringify({ widgetPlan: "todo list" }),
      JSON.stringify({
        id: "todo",
        name: "Todo",
        description: "a todo list to track my daily tasks",
        version: 1,
        root: { type: "Card", props: { title: "Todo" } },
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

describe("Orchestrator — Tier 3 + Tier 2 + Tier 1", () => {
  it("generates a capability (held for approval), a component, then composes", async () => {
    responses.push(
      // plan
      JSON.stringify({
        widgetPlan: "an image widget showing a random cat gif, pinned top-right",
        needsCapabilities: [{ id: "cat-gif", description: "return a random cat gif url" }],
        needsComponents: [{ id: "Image", description: "renders an image from a src prop" }],
      }),
      // tier 3 capability
      JSON.stringify({
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
      }),
      // tier 2 component
      JSON.stringify({
        id: "Image",
        name: "Image",
        version: 1,
        description: "renders an image from a src prop",
        propsSchema: { type: "object", properties: { src: { type: "string" } } },
        source:
          "import React from 'react';\nexport default function Image({ src }: { src?: string }) {\n  return <img src={src} alt=\"\" style={{ maxWidth: '100%' }} />;\n}\n",
      }),
      // tier 1 widget
      JSON.stringify({
        id: "cat-gif-widget",
        name: "Cat Gif",
        description: "a random cat gif pinned top-right",
        version: 1,
        placement: "pinned",
        requiresComponents: ["Image@1"],
        requiresCapabilities: ["cat-gif@1"],
        root: {
          type: "Overlay",
          props: { position: "top-right" },
          children: [{ type: "Image@1", props: { src: "https://cataas.test/cat.gif" } }],
        },
      }),
    );

    const result = await orchestrator.handleRequest("a cat gif top-right");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.feature.definition.placement).toBe("pinned");
    expect(result.pendingApprovals).toEqual(["cat-gif@1"]);

    // Component was built + stored.
    const components = await db.listComponents();
    expect(components.map((c) => c.key)).toContain("Image@1");
    // esbuild transpiled the TSX to an ES module with a default export; the
    // automatic JSX runtime emits jsx() calls (shimmed by the client import
    // map to the shell's React), so assert the transpile produced valid JS.
    expect(components[0].builtJs).toMatch(/jsx|createElement/);
    expect(components[0].builtJs).toContain("default");

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
