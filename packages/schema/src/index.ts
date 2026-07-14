import { z } from "zod";

/**
 * Shared Zod schemas for the three generation tiers.
 * These are the single source of truth: server-side validators AND the
 * per-tier LLM system prompts are derived from them (via z.toJSONSchema),
 * never hand-maintained in parallel.
 */

/* ------------------------------------------------------------------ */
/* Seed vocabulary                                                     */
/* ------------------------------------------------------------------ */

/** Built-in primitives the thin client ships with (day-one vocabulary). */
export const BUILTIN_COMPONENTS = [
  "Card",
  "Stack",
  "Text",
  "Input",
  "Button",
  "List",
  "Checkbox",
  "Select",
  "Counter",
  "ProgressBar",
  "Overlay",
] as const;

export type BuiltinComponent = (typeof BUILTIN_COMPONENTS)[number];

/* ------------------------------------------------------------------ */
/* Bindings — reactive value expressions usable anywhere in a tree     */
/* ------------------------------------------------------------------ */

export const BindingSchema = z.union([
  /** The widget's data rows (value must be "rows"). */
  z.object({ $data: z.literal("rows") }),
  /** Field of the current row (inside a List itemTemplate). */
  z.object({ $row: z.string() }),
  /** Current value of the named Input/Select. */
  z.object({ $form: z.string() }),
  /** Number of rows (value must be "rows"). */
  z.object({ $count: z.literal("rows") }),
  /** Number of rows where <field> is truthy. */
  z.object({ $countWhere: z.string() }),
  /** 0-100 percentage of rows where <field> is truthy. */
  z.object({ $percentWhere: z.string() }),
  /** Value of an app-wide shared state key (cross-widget wiring). */
  z.object({ $global: z.string() }),
  /** Negated truthiness of an app-wide key — e.g. disabled when a switch is off. */
  z.object({ $globalNot: z.string() }),
  /**
   * Conditional literal: picks `then` when the app-wide key is truthy, else
   * `else`. Prefix the key with "!" to negate. Works in text values, element
   * attrs, style values, and component props — THE way to map state onto
   * visuals (knob position, colors, labels) instead of showing raw values.
   */
  z.object({
    $if: z.string(),
    then: z.union([z.string(), z.number(), z.boolean()]),
    else: z.union([z.string(), z.number(), z.boolean()]),
  }),
]);
export type Binding = z.infer<typeof BindingSchema>;

const BindableSchema = z.union([z.string(), z.number(), z.boolean(), BindingSchema]);
export type Bindable = z.infer<typeof BindableSchema>;

/* ------------------------------------------------------------------ */
/* Tier 1 — WidgetDefinition (free-form generative UI)                 */
/* ------------------------------------------------------------------ */

export const DataFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  label: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type DataField = z.infer<typeof DataFieldSchema>;

/**
 * The generic content tree. A node is one of three kinds:
 *  - "text"      → a text leaf (literal or bound value)
 *  - "element"   → any allowlisted HTML/SVG tag with LLM-authored inline style
 *                  (media travels here too: video/audio/img/svg/canvas…)
 *  - "component" → a seed primitive or generated "Image@1"-style component
 */
export type UINode =
  | { kind: "text"; value: string | number | Binding }
  | {
      kind: "element";
      /** Allowlisted HTML/SVG tag — enforced by sanitizeTree, not the schema. */
      tag: string;
      /** Descriptive attributes: src, controls, autoplay, loop, muted, poster, alt, href… */
      attrs?: Record<string, string | number | boolean | Binding>;
      /** camelCase inline CSS authored by the LLM; values may be $if bindings
       *  so visuals react to state (e.g. a sliding switch knob). */
      style?: Record<string, string | number | Binding>;
      /** Action to run on click: "addRow" | "deleteRow" | "toggleRow:<field>" | "clearForm". */
      action?: string;
      children?: UINode[];
    }
  | {
      kind: "component";
      /** Seed primitive name OR generated component key like "Image@1". */
      component: string;
      props?: Record<string, unknown>;
      children?: UINode[];
    };

export const UINodeSchema: z.ZodType<UINode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), value: BindableSchema }),
    z.object({
      kind: z.literal("element"),
      tag: z.string().min(1),
      attrs: z.record(z.string(), BindableSchema).optional(),
      style: z.record(z.string(), z.union([z.string(), z.number(), BindingSchema])).optional(),
      action: z.string().optional(),
      children: z.array(UINodeSchema).optional(),
    }),
    z.object({
      kind: z.literal("component"),
      component: z.string().min(1),
      props: z.record(z.string(), z.unknown()).optional(),
      children: z.array(UINodeSchema).optional(),
    }),
  ]),
) as z.ZodType<UINode>;

/** The nine anchor regions for pinned (app-global floating) widgets. */
export const ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export const PresentationSchema = z.object({
  /**
   * flow → an item in the dashboard grid; pinned → floats above the whole app
   * (app-global, anchored); background → full-viewport layer behind the app.
   */
  placement: z.enum(["flow", "pinned", "background"]).default("flow"),
  /** Screen anchor for pinned widgets. Default top-right. */
  anchor: z.enum(ANCHORS).optional(),
  /** Position within the flow grid (0 = first). Omit to append. */
  order: z.number().int().optional(),
  /** Stacking among pinned widgets. */
  zIndex: z.number().int().optional(),
  /** Chrome is opt-in: "none" renders bare; "card" adds one neutral surface. */
  surface: z.enum(["none", "card"]).default("none"),
  /**
   * Named view (tab/page) this widget belongs to — it renders only while that
   * view is active (switched via the "setView:<name>" action). Omit to show
   * the widget in EVERY view (menus, backgrounds). The landing view is "home".
   */
  view: z.string().regex(/^[a-z0-9-]+$/, "kebab-case view name").optional(),
  size: z
    .object({
      /** Columns a flow widget spans in the dashboard grid (1-4). */
      gridColumnSpan: z.number().int().min(1).max(4).optional(),
      /** CSS length for pinned widgets, e.g. "320px" or "20vw". */
      width: z.string().optional(),
      height: z.string().optional(),
    })
    .optional(),
});
export type Presentation = z.infer<typeof PresentationSchema>;

export const WidgetDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive(),
  root: UINodeSchema,
  presentation: PresentationSchema.default({ placement: "flow", surface: "none" }),
  /** Generated component keys the client must load before render, e.g. ["Image@1"]. */
  requiresComponents: z.array(z.string()).default([]),
  /** Capability keys the widget calls through /api/dyn, e.g. ["giphy-search@1"]. */
  requiresCapabilities: z.array(z.string()).default([]),
  dataSchema: z.record(z.string(), DataFieldSchema).optional(),
});
export type WidgetDefinition = z.infer<typeof WidgetDefinitionSchema>;

/* ------------------------------------------------------------------ */
/* HTTP contract — feature record + request outcome envelope           */
/* ------------------------------------------------------------------ */

export const FeatureRecordSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.number(),
  definition: WidgetDefinitionSchema,
  createdAt: z.string(),
});
export type FeatureRecord = z.infer<typeof FeatureRecordSchema>;

/**
 * The generic envelope every /api/features/request response uses,
 * discriminated by `outcome`. `artifact.kind` is the extension point for
 * future non-widget artifacts (notification, page, sound…).
 */
export const RequestOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("created"),
    artifact: z.object({
      kind: z.literal("widget"),
      feature: FeatureRecordSchema,
    }),
    servedFromCache: z.boolean(),
    pendingCapabilityApprovals: z.array(z.string()),
  }),
  z.object({
    outcome: z.literal("declined"),
    userFacingReason: z.string(),
  }),
  z.object({
    outcome: z.literal("removed"),
    removedWidgets: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
]);
export type RequestOutcome = z.infer<typeof RequestOutcomeSchema>;

/* ------------------------------------------------------------------ */
/* Tier 2 — ComponentSpec (generated UI component)                     */
/* ------------------------------------------------------------------ */

export const ComponentSpecSchema = z.object({
  /** PascalCase registry id, e.g. "Image". The full registry key is `${id}@${version}`. */
  id: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase identifier"),
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().default(""),
  /** Props schema expressed as plain JSON Schema (zod-as-json). */
  propsSchema: z.record(z.string(), z.unknown()).default({}),
  /** Single-file React component source (TSX), default-exported function component. */
  source: z.string().min(1),
});
export type ComponentSpec = z.infer<typeof ComponentSpecSchema>;

export function componentKey(spec: Pick<ComponentSpec, "id" | "version">): string {
  return `${spec.id}@${spec.version}`;
}

/* ------------------------------------------------------------------ */
/* Tier 3 — CapabilitySpec (generated server capability)               */
/* ------------------------------------------------------------------ */

export const CapabilityEndpointSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /** Path relative to /api/dyn/<capability-key>, e.g. "/search". */
  path: z.string().regex(/^\//, "must start with /"),
  /**
   * Async arrow function EXPRESSION: `async (req, ctx) => ({ status, body })`.
   * Runs sandboxed; ctx exposes only capFetch + capStore.
   */
  handlerSource: z.string().min(1),
});
export type CapabilityEndpoint = z.infer<typeof CapabilityEndpointSchema>;

export const CapabilitySpecSchema = z.object({
  /** kebab-case id, e.g. "giphy-search". Full key is `${id}@${version}`. */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "kebab-case identifier"),
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().min(1),
  /** Domains capFetch may reach, e.g. ["api.giphy.com"]. Adding one is a logged event. */
  domainAllowlist: z.array(z.string()).default([]),
  endpoints: z.array(CapabilityEndpointSchema).min(1),
});
export type CapabilitySpec = z.infer<typeof CapabilitySpecSchema>;

export function capabilityKey(spec: Pick<CapabilitySpec, "id" | "version">): string {
  return `${spec.id}@${spec.version}`;
}

/* ------------------------------------------------------------------ */
/* Attachments (files/images/audio dropped into the request bar)        */
/* ------------------------------------------------------------------ */

export const AttachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  /** Same-origin URL the shell/generated components can use as src/href. */
  url: z.string().min(1),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export function attachmentKind(mimeType: string): "image" | "audio" | "video" | "file" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

/* ------------------------------------------------------------------ */
/* Orchestrator plan                                                   */
/* ------------------------------------------------------------------ */

export const PlanSchema = z.object({
  /**
   * "create" → build/serve a widget (the default). "remove" → the user asked
   * to delete existing widget(s) from the dashboard; no widget is generated,
   * the matched features are removed instead.
   */
  intent: z.enum(["create", "remove"]).default("create"),
  /** When intent is "remove", the ids of existing features to delete. */
  removeFeatureIds: z.array(z.string()).default([]),
  /**
   * Whether the request can be fulfilled here (keyless public APIs + built-ins,
   * inside the sandbox). false → the pipeline stops and the user is shown the
   * decline reason instead of a widget.
   */
  feasible: z.boolean().default(true),
  /**
   * When feasible is false, a clear, friendly, user-facing explanation of the
   * exact reason (e.g. needs a private API key / account access / impossible in
   * this environment) plus a nudge to try something else. Empty when feasible.
   */
  declineReason: z.string().default(""),
  /** Feature id of an existing cached feature that satisfies the request, else null. */
  cacheHit: z.string().nullable().default(null),
  /** New server capabilities that must be generated (Tier 3). */
  needsCapabilities: z
    .array(z.object({ id: z.string(), description: z.string() }))
    .default([]),
  /** New UI components that must be generated (Tier 2). */
  needsComponents: z
    .array(z.object({ id: z.string(), description: z.string() }))
    .default([]),
  /** One-paragraph spec of the widget Tier 1 should compose (may be empty when infeasible). */
  widgetPlan: z.string().default(""),
  /**
   * Additional widgets to compose in the same request (one paragraph each) —
   * used when one ask genuinely needs several widgets, e.g. a tab menu plus
   * one content widget per tab.
   */
  moreWidgetPlans: z.array(z.string()).default([]),
  /**
   * Existing dashboard widgets to (re)assign to a named view, e.g. putting the
   * current table on the "home" tab when a tab menu is created.
   */
  viewAssignments: z
    .array(z.object({ featureId: z.string(), view: z.string() }))
    .default([]),
  /**
   * Existing widgets to MODIFY (behavior, look, or cross-widget wiring). Each
   * instruction fully describes the change; Tier 1 regenerates the definition
   * in place (same feature id).
   */
  updatePlans: z
    .array(z.object({ featureId: z.string(), instruction: z.string() }))
    .default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

/* ------------------------------------------------------------------ */
/* JSON Schema derivation (for LLM prompts)                            */
/* ------------------------------------------------------------------ */

export function jsonSchemaOf(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: "input" });
}

export * from "./sanitize";
