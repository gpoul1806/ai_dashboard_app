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

const ACTION_STEP_RE =
  /^(addRow|deleteRow|clearForm|toggleRow:.+|setView:[a-z0-9-]+|toggleGlobal:[a-z0-9-]+|setGlobal:[a-z0-9-]+=.*)$/;

/** Actions may chain steps with ";" — every step must be valid. */
function isValidAction(action: string): boolean {
  const steps = action.split(";").map((s) => s.trim()).filter(Boolean);
  return steps.length > 0 && steps.every((s) => ACTION_STEP_RE.test(s));
}

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
    } else if (n.kind === "element" && n.action && !isValidAction(n.action)) {
      errors.push(
        `root: element action "${n.action}" is invalid (steps: addRow | deleteRow | clearForm | toggleRow:<field> | setView:<view> | toggleGlobal:<key> | setGlobal:<key>=<value>, chained with ";")`,
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

/* ------------------------------------------------------------------ */
/* Media URL verification                                              */
/* ------------------------------------------------------------------ */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MEDIA_TAGS = new Set(["video", "audio", "source"]);

/** Private/reserved address check — the LLM authors media URLs, so the
 *  verifier must never be usable as an SSRF probe into internal networks. */
function isPrivateAddress(addr: string): boolean {
  const v = addr.toLowerCase();
  if (isIP(v) === 6 || v.includes(":")) {
    // IPv4-mapped IPv6 → check the embedded IPv4.
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      v === "::" ||
      v === "::1" ||
      v.startsWith("fc") ||
      v.startsWith("fd") || // fc00::/7 unique-local
      v.startsWith("fe8") ||
      v.startsWith("fe9") ||
      v.startsWith("fea") ||
      v.startsWith("feb") // fe80::/10 link-local
    );
  }
  const octets = v.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true; // unparseable → treat as unsafe
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  );
}

/** True only for http(s) URLs whose host resolves exclusively to public IPs.
 *  (dns.lookup pre-check + manual-redirect fetches — POC-level SSRF guard.) */
async function isSafePublicUrl(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !isPrivateAddress(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/** Collects external video/audio URLs (src + poster) from a tree. */
function collectMediaUrls(root: UINode): string[] {
  const urls: string[] = [];
  walkNodes(root, (n) => {
    if (n.kind !== "element" || !MEDIA_TAGS.has(n.tag.toLowerCase())) return;
    for (const key of ["src", "poster"]) {
      const v = n.attrs?.[key];
      if (typeof v === "string" && /^https?:\/\//i.test(v)) urls.push(v);
    }
  });
  return [...new Set(urls)];
}

/**
 * Models invent media URLs that don't exist (or reference YouTube/Vimeo page
 * URLs that can never play in a <video> tag) — the widget then renders a dead
 * player. Verify each external video/audio URL actually resolves to media;
 * failures feed the LLM retry with the exact reason.
 */
async function verifyMediaUrls(root: UINode): Promise<string[]> {
  if (process.env.SKIP_MEDIA_URL_CHECK) return [];
  const errors: string[] = [];
  await Promise.all(
    collectMediaUrls(root).map(async (url) => {
      if (/youtube\.com|youtu\.be|vimeo\.com/i.test(url)) {
        errors.push(
          `media URL "${url}": YouTube/Vimeo page URLs cannot play inside a <video> tag — use a DIRECT media file URL (.mp4/.webm/.mp3)`,
        );
        return;
      }
      if (!(await isSafePublicUrl(url))) {
        errors.push(
          `media URL "${url}" is not allowed — media must live on a public http(s) host`,
        );
        return;
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        // redirect "manual": a public URL 302-ing to an internal address would
        // bypass the host check — require direct links to the final file.
        let res = await fetch(url, {
          method: "HEAD",
          redirect: "manual",
          signal: controller.signal,
        });
        if (res.status === 405 || res.status === 501) {
          // Some hosts reject HEAD — probe with a 1-byte range GET instead.
          res = await fetch(url, {
            method: "GET",
            headers: { Range: "bytes=0-0" },
            redirect: "manual",
            signal: controller.signal,
          });
        }
        clearTimeout(timer);
        if (res.status >= 300 && res.status < 400) {
          errors.push(
            `media URL "${url}" redirects — link the FINAL media file URL directly`,
          );
          return;
        }
        if (!res.ok) {
          // Coarse message on purpose: never echo upstream status codes (an
          // LLM-authored URL must not turn this into a scanning oracle).
          errors.push(
            `media URL "${url}" is not reachable — use a real, directly playable public media file URL`,
          );
          return;
        }
        const type = (res.headers.get("content-type") ?? "").toLowerCase();
        if (type && !/^(video|audio|image|application\/octet-stream)/.test(type)) {
          errors.push(
            `media URL "${url}" does not serve a media file — link the media FILE itself, not a web page`,
          );
        }
      } catch {
        errors.push(
          `media URL "${url}" could not be verified — use a reliable public media file URL`,
        );
      }
    }),
  );
  return errors;
}

/** Tier-1 wire adapter: definitionJson (string) → parsed + validated definition. */
export async function validateTier1Wire(
  wire: Tier1Wire,
  generatedComponentKeys: Set<string>,
): Promise<Validated<WidgetDefinition>> {
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
  const result = validateWidgetDefinition(raw, generatedComponentKeys);
  if (!result.ok) return result;
  const mediaErrors = await verifyMediaUrls(result.value.root);
  if (mediaErrors.length > 0) return { ok: false, errors: mediaErrors };
  return result;
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
