import {
  BUILTIN_COMPONENTS,
  CapabilitySpecSchema,
  type CapabilitySpec,
  type ComponentNode,
  ComponentSpecSchema,
  type ComponentSpec,
  PlanSchema,
  type Plan,
  WidgetDefinitionSchema,
  type WidgetDefinition,
} from "@myday/schema";
// esbuild: transpiles/validates generated TSX before storage — never executed here.
import { transform } from "esbuild";

/**
 * ALL LLM output is validated (Zod / esbuild / static checks) before storage
 * or execution. Failures return readable error lists that are appended to the
 * retry prompt.
 */

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/* ------------------------------------------------------------------ */
/* JSON extraction                                                     */
/* ------------------------------------------------------------------ */

/** Extracts the first balanced JSON object from LLM text (tolerates fences/prose). */
export function extractJson(text: string): Validated<unknown> {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return { ok: false, errors: ["no JSON object found in response"] };

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);
        try {
          return { ok: true, value: JSON.parse(candidate) };
        } catch (err) {
          return { ok: false, errors: [`invalid JSON: ${(err as Error).message}`] };
        }
      }
    }
  }
  return { ok: false, errors: ["unterminated JSON object in response"] };
}

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
    if (!plan.declineReason.trim()) {
      return {
        ok: false,
        errors: ["declineReason: required (explain the exact reason) when feasible is false"],
      };
    }
  } else if (!plan.widgetPlan.trim()) {
    return { ok: false, errors: ["widgetPlan: required when feasible is true"] };
  }
  return { ok: true, value: plan };
}

/* ------------------------------------------------------------------ */
/* Tier 1 — WidgetDefinition                                           */
/* ------------------------------------------------------------------ */

function collectNodeTypes(node: ComponentNode, out: Set<string>): void {
  out.add(node.type);
  for (const child of node.children ?? []) collectNodeTypes(child, out);
  // itemTemplate is a nested ComponentNode carried in props.
  const template = node.props?.itemTemplate as ComponentNode | undefined;
  if (template && typeof template === "object" && typeof template.type === "string") {
    collectNodeTypes(template, out);
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
  const used = new Set<string>();
  collectNodeTypes(def.root, used);

  const usedGenerated: string[] = [];
  for (const type of used) {
    if (builtins.has(type)) continue;
    if (generatedComponentKeys.has(type)) {
      usedGenerated.push(type);
      continue;
    }
    errors.push(
      `root: node type "${type}" is neither a built-in primitive nor an existing generated component key`,
    );
  }

  if (def.placement === "pinned" && def.root.type !== "Overlay") {
    errors.push(`placement: pinned widgets must use an Overlay root node`);
  }

  if (errors.length > 0) return { ok: false, errors };

  // Normalize: requiresComponents is exactly the generated keys used.
  def.requiresComponents = usedGenerated.sort();
  return { ok: true, value: def };
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
