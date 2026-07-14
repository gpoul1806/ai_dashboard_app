import type { WidgetDefinition } from "@myday/schema";
import type { Db } from "./db";

/**
 * A hardcoded Tier-1 feature seeded on boot (build-order step 3: serve a
 * feature with no LLM). Authored in the v2 free-form node language: styled
 * element nodes own the look, built-in components carry form state, rows and
 * actions — exercising the whole renderer without any generation.
 */
const SEED_TODO: WidgetDefinition = {
  id: "seed-todo",
  name: "Todo List",
  description: "a simple todo list to track tasks for the day",
  version: 1,
  requiresComponents: [],
  requiresCapabilities: [],
  presentation: { placement: "flow", surface: "none" },
  dataSchema: {
    title: { type: "string", label: "Task" },
    done: { type: "boolean", default: false },
  },
  root: {
    kind: "element",
    tag: "section",
    style: {
      background: "linear-gradient(160deg, #1d2733, #141b24)",
      color: "#e8eef5",
      borderRadius: "16px",
      padding: "18px 20px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      fontFamily: "Georgia, serif",
    },
    children: [
      {
        kind: "element",
        tag: "h2",
        style: { margin: "0", fontSize: "1.15rem", letterSpacing: "0.02em" },
        children: [{ kind: "text", value: "Today's tasks" }],
      },
      {
        kind: "element",
        tag: "div",
        style: { display: "flex", gap: "8px" },
        children: [
          {
            kind: "component",
            component: "Input",
            props: {
              name: "title",
              placeholder: "Add a task…",
              style: {
                flex: 1,
                background: "#0e141b",
                color: "#e8eef5",
                border: "1px solid #2c3a49",
                borderRadius: "8px",
                padding: "8px 10px",
              },
            },
          },
          {
            kind: "component",
            component: "Button",
            props: {
              label: "Add",
              action: "addRow",
              style: {
                background: "#f0a35e",
                color: "#1d2733",
                border: "none",
                borderRadius: "8px",
                padding: "8px 14px",
                fontWeight: 700,
                cursor: "pointer",
              },
            },
          },
        ],
      },
      {
        kind: "element",
        tag: "div",
        style: { fontSize: "0.8rem", opacity: 0.7 },
        children: [
          { kind: "text", value: { $countWhere: "done" } },
          { kind: "text", value: " of " },
          { kind: "text", value: { $count: "rows" } },
          { kind: "text", value: " done" },
        ],
      },
      {
        kind: "component",
        component: "List",
        props: {
          items: { $data: "rows" },
          empty: "No tasks yet — add one above.",
          itemTemplate: {
            kind: "element",
            tag: "div",
            style: { display: "flex", alignItems: "center", gap: "10px", padding: "4px 0" },
            children: [
              {
                kind: "component",
                component: "Checkbox",
                props: { checked: { $row: "done" }, action: "toggleRow:done" },
              },
              {
                kind: "element",
                tag: "span",
                style: { flex: 1 },
                children: [{ kind: "text", value: { $row: "title" } }],
              },
              {
                kind: "element",
                tag: "span",
                action: "deleteRow",
                style: { cursor: "pointer", opacity: 0.6 },
                children: [{ kind: "text", value: "✕" }],
              },
            ],
          },
        },
      },
    ],
  },
};

export async function seedDemoFeature(db: Db): Promise<void> {
  const existing = await db.getFeature(SEED_TODO.id);
  if (existing) return;
  await db.insertFeature({
    id: SEED_TODO.id,
    slug: SEED_TODO.id,
    name: SEED_TODO.name,
    description: SEED_TODO.description,
    definition: SEED_TODO,
    version: SEED_TODO.version,
  });
  console.log("[seed] inserted hardcoded 'Todo List' feature");
}
