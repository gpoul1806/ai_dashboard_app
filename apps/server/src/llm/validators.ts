import {
  BUILTIN_COMPONENTS,
  CapabilitySpecSchema,
  type CapabilitySpec,
  ComponentSpecSchema,
  type ComponentSpec,
  PlanSchema,
  type Plan,
  type UINode,
  WidgetDefinitionSchema,
  type WidgetDefinition,
  sanitizeTree,
} from "@myday/schema";
// esbuild: transpiles/validates generated TSX before storage — never executed here.
import { transform } from "esbuild";
// jsonrepair: the widget tree travels as a JSON-encoded string inside the
// structured output (the grammar can't express recursion), and models slip on
// deep quote-escaping — repair recovers those before burning the LLM retry.
import { jsonrepair } from "jsonrepair";
import type { Tier1Wire, Tier2Wire } from "./wire";

/**
 * ALL LLM output is validated (Zod / sanitizer / esbuild / static checks)
 * before storage or execution. Failures return readable error lists that are
 * appended to the retry prompt. JSON syntax itself is grammar-guaranteed by
 * structured outputs — except the definitionJson string field, parsed here.
 */

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

function zodErrors(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] {
  return error.issues.map(
    (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
  );
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

export function validatePlan(raw: unknown): Validated<Plan> {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  const plan = parsed.data;
  if (!plan.feasible) {
    // Includes "couldn't find a widget to remove" — a decline, not a build.
    if (!plan.declineReason.trim()) {
      return {
        ok: false,
        errors: ["declineReason: required (explain the exact reason) when feasible is false"],
      };
    }
  } else if (plan.intent === "remove") {
    if (plan.removeFeatureIds.length === 0) {
      return {
        ok: false,
        errors: [
          'removeFeatureIds: required when intent is "remove" and feasible is true (or set feasible:false with a declineReason if nothing matched)',
        ],
      };
    }
  } else if (
    !plan.widgetPlan.trim() &&
    plan.moreWidgetPlans.every((p) => !p.trim()) &&
    plan.updatePlans.length === 0
  ) {
    return {
      ok: false,
      errors: [
        "widgetPlan: required when feasible is true (or provide updatePlans when modifying existing widgets)",
      ],
    };
  }
  return { ok: true, value: plan };
}

/* ------------------------------------------------------------------ */
/* Tier 1 — WidgetDefinition                                           */
/* ------------------------------------------------------------------ */

const ACTION_RE =
  /^(addRow|deleteRow|clearForm|toggleRow:.+|setView:[a-z0-9-]+|toggleGlobal:[a-z0-9-]+|setGlobal:[a-z0-9-]+=.*)$/;

/** Walks a UINode tree collecting component names, action strings, and
 *  itemTemplate subtrees (a UINode carried in component props). */
function walkNodes(node: UINode, visit: (n: UINode) => void): void {
  visit(node);
  if (node.kind === "text") return;
  for (const child of node.children ?? []) walkNodes(child, visit);
  if (node.kind === "component") {
    const template = node.props?.itemTemplate as UINode | undefined;
    if (template && typeof template === "object" && typeof template.kind === "string") {
      walkNodes(template, visit);
    }
  }
}

export function validateWidgetDefinition(
  raw: unknown,
  generatedComponentKeys: Set<string>,
): Validated<WidgetDefinition> {
  const parsed = WidgetDefinitionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };

  const def = parsed.data;
  const errors: string[] = [];
  const builtins = new Set<string>(BUILTIN_COMPONENTS);
  const usedGenerated = new Set<string>();

  walkNodes(def.root, (n) => {
    if (n.kind === "component") {
      if (builtins.has(n.component)) return;
      if (generatedComponentKeys.has(n.component)) {
        usedGenerated.add(n.component);
        return;
      }
      errors.push(
        `root: component "${n.component}" is neither a built-in nor an existing generated component key`,
      );
    } else if (n.kind === "element" && n.action && !ACTION_RE.test(n.action)) {
      errors.push(
        `root: element action "${n.action}" is invalid (addRow | deleteRow | clearForm | toggleRow:<field> | setView:<view>)`,
      );
    }
  });

  // Security gate: strict sanitation — any disallowed tag/attr/URL/style is a
  // validation error fed back to the LLM retry, never stored.
  const { violations } = sanitizeTree(def.root, "strict");
  errors.push(...violations);

  if (errors.length > 0) return { ok: false, errors };

  // Normalize: requiresComponents is exactly the generated keys used.
  def.requiresComponents = [...usedGenerated].sort();
  return { ok: true, value: def };
}

/** Tier-1 wire adapter: definitionJson (string) → parsed + validated definition. */
export function validateTier1Wire(
  wire: Tier1Wire,
  generatedComponentKeys: Set<string>,
): Validated<WidgetDefinition> {
  let raw: unknown;
  try {
    raw = JSON.parse(wire.definitionJson);
  } catch (err) {
    // Escaping slips deep inside the string are the common failure — attempt a
    // lenient repair before spending the LLM retry. The repaired tree still
    // passes full Zod + strict sanitation below, so nothing unsafe gets in.
    try {
      raw = JSON.parse(jsonrepair(wire.definitionJson));
      console.warn("[tier1] definitionJson needed jsonrepair — recovered");
    } catch {
      return {
        ok: false,
        errors: [`definitionJson: invalid JSON — ${(err as Error).message}`],
      };
    }
  }
  return validateWidgetDefinition(raw, generatedComponentKeys);
}

/* ------------------------------------------------------------------ */
/* Tier 2 — ComponentSpec                                              */
/* ------------------------------------------------------------------ */

const ALLOWED_IMPORTS = new Set(["react", "@shell/hooks"]);
const COMPONENT_FORBIDDEN: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, "direct fetch() is forbidden — use useCapability from @shell/hooks"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest is forbidden"],
  [/\bWebSocket\b/, "WebSocket is forbidden"],
  [/\blocalStorage\b/, "localStorage is forbidden"],
  [/\bsessionStorage\b/, "sessionStorage is forbidden"],
  [/document\s*\.\s*cookie/, "cookie access is forbidden"],
  [/\beval\s*\(/, "eval is forbidden"],
  [/\bimport\s*\(/, "dynamic import() is forbidden"],
  [/\bprocess\s*\./, "process access is forbidden"],
];

export async function validateComponentSpec(
  raw: unknown,
): Promise<Validated<ComponentSpec & { builtJs: string }>> {
  const parsed = ComponentSpecSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };

  const spec = parsed.data;
  const errors: string[] = [];
  const source = spec.source;

  const importRe = /import\s+(?:[^'"]*?from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(importRe)) {
    if (!ALLOWED_IMPORTS.has(match[1])) {
      errors.push(`source: import "${match[1]}" is not allowed (only react, @shell/hooks)`);
    }
  }
  if (!/export\s+default\s/.test(source)) {
    errors.push("source: must have a default export (the component function)");
  }
  for (const [pattern, message] of COMPONENT_FORBIDDEN) {
    if (pattern.test(source)) errors.push(`source: ${message}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  try {
    const result = await transform(source, {
      loader: "tsx",
      format: "esm",
      jsx: "automatic",
      jsxImportSource: "react",
      target: "es2020",
    });
    return { ok: true, value: { ...spec, builtJs: result.code } };
  } catch (err) {
    const messages =
      (err as { errors?: Array<{ text: string; location?: { line: number } }> }).errors?.map(
        (e) => `source (build): line ${e.location?.line ?? "?"}: ${e.text}`,
      ) ?? [`source (build): ${(err as Error).message}`];
    return { ok: false, errors: messages };
  }
}

/** Tier-2 wire adapter: propsSchemaJson (string) → parsed spec, then full validation. */
export async function validateTier2Wire(
  wire: Tier2Wire,
): Promise<Validated<ComponentSpec & { builtJs: string }>> {
  let propsSchema: unknown = {};
  if (wire.propsSchemaJson.trim() && wire.propsSchemaJson.trim() !== "{}") {
    try {
      propsSchema = JSON.parse(wire.propsSchemaJson);
    } catch (err) {
      return {
        ok: false,
        errors: [`propsSchemaJson: invalid JSON — ${(err as Error).message}`],
      };
    }
  }
  return validateComponentSpec({
    id: wire.id,
    name: wire.name,
    version: wire.version,
    description: wire.description,
    propsSchema,
    source: wire.source,
  });
}

/* ------------------------------------------------------------------ */
/* Tier 3 — CapabilitySpec                                             */
/* ------------------------------------------------------------------ */

const HANDLER_FORBIDDEN: Array<[RegExp, string]> = [
  [/\brequire\s*\(/, "require is not available in the sandbox"],
  [/\bimport[\s(]/, "import is not available in the sandbox"],
  [/\bprocess\s*[.[]/, "process access is forbidden"],
  [/\bglobalThis\s*[.[]/, "globalThis access is forbidden"],
  [/\beval\s*\(/, "eval is forbidden"],
  [/new\s+Function/, "Function constructor is forbidden"],
  [/\bfetch\s*\(/, "bare fetch is not available — use ctx.capFetch"],
  // API-FREE enforcement: capabilities must work with no key and no secrets.
  // A key-requiring capability is dead-on-arrival (no secret is configured),
  // so reject it here — the error is appended to the retry prompt, steering
  // the model to a keyless public API instead.
  [
    /\{\{\s*secret\s*:/i,
    "API-FREE required: remove the {{secret:...}} placeholder and use a keyless public API (e.g. cataas.com, picsum.photos, dog.ceo) that needs no key",
  ],
  [
    /\b(api[_-]?key|apikey|access[_-]?token|client[_-]?secret)\b/i,
    "API-FREE required: this capability references an API key/token — switch to a keyless public API that needs no authentication",
  ],
  [
    /["']authorization["']\s*:/i,
    "API-FREE required: do not send an Authorization header — use a keyless public API",
  ],
  [
    /\bsk-[A-Za-z0-9-]{10,}/,
    "looks like an embedded API key — API-FREE required: use a keyless public API",
  ],
];

export async function validateCapabilitySpec(
  raw: unknown,
): Promise<Validated<CapabilitySpec>> {
  const parsed = CapabilitySpecSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };

  const spec = parsed.data;
  const errors: string[] = [];

  for (const endpoint of spec.endpoints) {
    const label = `${endpoint.method} ${endpoint.path}`;
    const src = endpoint.handlerSource;
    if (!/^\s*async\b/.test(src)) {
      errors.push(`${label}: handlerSource must be an async function expression`);
    }
    for (const [pattern, message] of HANDLER_FORBIDDEN) {
      if (pattern.test(src)) errors.push(`${label}: ${message}`);
    }
    try {
      // Syntax check only — the source is never executed here.
      await transform(`const __h = (${src});`, { loader: "ts", target: "es2020" });
    } catch (err) {
      const messages = (err as { errors?: Array<{ text: string }> }).errors ?? [];
      errors.push(
        `${label}: syntax error — ${messages.map((e) => e.text).join("; ") || (err as Error).message}`,
      );
    }
  }

  const usesFetch = spec.endpoints.some((e) => /capFetch\s*\(/.test(e.handlerSource));
  if (usesFetch && spec.domainAllowlist.length === 0) {
    errors.push("domainAllowlist: must list the domains capFetch needs");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: spec };
}
