import type { WidgetDefinition } from "@myday/schema";
import type { Db } from "./db";

/**
 * A hardcoded Tier-1 feature seeded on boot (build-order step 3: serve a
 * feature with no LLM). It uses only built-in primitives + the binding/action
 * vocabulary, so the shell renderer is exercised end-to-end without any
 * generation. Also gives the demo a working todo widget immediately.
 */
const SEED_TODO: WidgetDefinition = {
  id: "seed-todo",
  name: "Todo List",
  description: "a simple todo list to track tasks for the day",
  version: 1,
  requiresComponents: [],
  requiresCapabilities: [],
  placement: "flow",
  dataSchema: {
    title: { type: "string", label: "Task" },
    done: { type: "boolean", default: false },
  },
  root: {
    type: "Card",
    props: { title: "Todo List" },
    children: [
      {
        type: "Stack",
        props: { direction: "row", gap: 8 },
        children: [
          { type: "Input", props: { name: "title", placeholder: "Add a task…" } },
          { type: "Button", props: { label: "Add", action: "addRow" } },
        ],
      },
      {
        type: "ProgressBar",
        props: { value: { $percentWhere: "done" }, label: "done" },
      },
      {
        type: "List",
        props: {
          items: { $data: "rows" },
          empty: "No tasks yet — add one above.",
          itemTemplate: {
            type: "Stack",
            props: { direction: "row", gap: 8 },
            children: [
              {
                type: "Checkbox",
                props: { checked: { $row: "done" }, action: "toggleRow:done" },
              },
              { type: "Text", props: { text: { $row: "title" } } },
              { type: "Button", props: { label: "✕", action: "deleteRow", variant: "muted" } },
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
