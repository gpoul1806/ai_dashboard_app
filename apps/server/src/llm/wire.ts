import { z } from "zod";

/**
 * Wire schemas for structured output. The Anthropic structured-output grammar
 * supports neither recursive schemas nor open records (additionalProperties
 * must be false), so each wire shape is FLAT with every field required; the
 * recursive/record-bearing parts (the UINode tree, propsSchema) travel as
 * JSON-encoded string fields that the server parses and Zod-validates with
 * the retry loop.
 */

export const PlanWireSchema = z.object({
  intent: z
    .enum(["create", "remove"])
    .describe('"remove" only when the user asks to delete existing widgets'),
  removeFeatureIds: z
    .array(z.string())
    .describe('ids of dashboard widgets to delete; [] unless intent is "remove"'),
  feasible: z.boolean(),
  declineReason: z
    .string()
    .describe("user-facing reason when feasible is false; \"\" otherwise"),
  cacheHit: z
    .string()
    .nullable()
    .describe("id of a cached feature that satisfies the request, else null"),
  needsCapabilities: z.array(z.object({ id: z.string(), description: z.string() })),
  needsComponents: z.array(z.object({ id: z.string(), description: z.string() })),
  widgetPlan: z.string().describe("one-paragraph spec for the Tier 1 composer"),
  moreWidgetPlans: z
    .array(z.string())
    .describe(
      "additional widgets for the SAME request, one paragraph each (e.g. per-tab content widgets); [] when one widget suffices",
    ),
  viewAssignments: z
    .array(z.object({ featureId: z.string(), view: z.string() }))
    .describe(
      'existing dashboard widgets to move onto a named view/tab, e.g. [{"featureId":"x","view":"home"}]; [] when not using views',
    ),
  updatePlans: z
    .array(z.object({ featureId: z.string(), instruction: z.string() }))
    .describe(
      "existing widgets to MODIFY (behavior/look/cross-widget wiring); each instruction fully describes the change; [] when nothing is modified",
    ),
});
export type PlanWire = z.infer<typeof PlanWireSchema>;

export const Tier1WireSchema = z.object({
  definitionJson: z
    .string()
    .describe(
      "The complete WidgetDefinition object, JSON-encoded as a string " +
        "(JSON.stringify of an object matching the WidgetDefinition JSON Schema " +
        "in the system prompt). No markdown, no comments — pure JSON text.",
    ),
});
export type Tier1Wire = z.infer<typeof Tier1WireSchema>;

export const Tier2WireSchema = z.object({
  id: z.string().describe("PascalCase component id, e.g. Image"),
  name: z.string(),
  version: z.number().int(),
  description: z.string(),
  propsSchemaJson: z
    .string()
    .describe('the component props JSON Schema, JSON-encoded as a string; "{}" if none'),
  source: z.string().describe("the full single-file TSX source"),
});
export type Tier2Wire = z.infer<typeof Tier2WireSchema>;

export const Tier3WireSchema = z.object({
  id: z.string().describe("kebab-case capability id, e.g. cat-gif"),
  name: z.string(),
  version: z.number().int(),
  description: z.string(),
  domainAllowlist: z.array(z.string()),
  endpoints: z.array(
    z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string().describe('relative path starting with "/"'),
      handlerSource: z
        .string()
        .describe("async arrow function EXPRESSION: async (req, ctx) => ({ status, body })"),
    }),
  ),
});
export type Tier3Wire = z.infer<typeof Tier3WireSchema>;
