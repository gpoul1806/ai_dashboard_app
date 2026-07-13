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
/* Tier 1 — WidgetDefinition (composition)                             */
/* ------------------------------------------------------------------ */

export const DataFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  label: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type DataField = z.infer<typeof DataFieldSchema>;

export type ComponentNode = {
  /** A built-in primitive name OR a generated component key like "Image@1". */
  type: string;
  props?: Record<string, unknown>;
  children?: ComponentNode[];
};

export const ComponentNodeSchema: z.ZodType<ComponentNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    children: z.array(ComponentNodeSchema).optional(),
  }),
);

export const WidgetDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive(),
  root: ComponentNodeSchema,
  /** Generated component keys the client must load before render, e.g. ["Image@1"]. */
  requiresComponents: z.array(z.string()).default([]),
  /** Capability keys the widget calls through /api/dyn, e.g. ["giphy-search@1"]. */
  requiresCapabilities: z.array(z.string()).default([]),
  dataSchema: z.record(z.string(), DataFieldSchema).optional(),
  /** pinned widgets render in the Overlay slot of the shell. */
  placement: z.enum(["flow", "pinned"]).default("flow"),
});
export type WidgetDefinition = z.infer<typeof WidgetDefinitionSchema>;

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
/* Orchestrator plan                                                   */
/* ------------------------------------------------------------------ */

export const PlanSchema = z.object({
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
});
export type Plan = z.infer<typeof PlanSchema>;

/* ------------------------------------------------------------------ */
/* JSON Schema derivation (for LLM prompts)                            */
/* ------------------------------------------------------------------ */

export function jsonSchemaOf(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: "input" });
}
