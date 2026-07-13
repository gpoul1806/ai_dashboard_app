import {
  BUILTIN_COMPONENTS,
  CapabilitySpecSchema,
  ComponentSpecSchema,
  PlanSchema,
  WidgetDefinitionSchema,
  jsonSchemaOf,
} from "@myday/schema";
import type { CapabilityRow, ComponentRow, SimilarFeature } from "../db";

/**
 * Per-tier system prompts, generated from the Zod schemas + the live registry
 * index (never hand-maintained in parallel with the schemas).
 */

const js = (schema: Parameters<typeof jsonSchemaOf>[0]) =>
  JSON.stringify(jsonSchemaOf(schema), null, 2);

/** Prop conventions + binding language for the seed primitives. Must match the
 *  client renderer (apps/web/src/renderer + registry/primitives). */
const BUILTIN_DOC = `
Built-in primitives (usable as ComponentNode.type):
- Card { title?: string } — container card; children inside.
- Stack { direction?: "row"|"column", gap?: number } — flex layout for children.
- Text { text: string|binding, variant?: "title"|"body"|"muted" }
- Input { name: string, placeholder?: string, type?: string } — binds its value to the widget form state under "name". Enter triggers addRow.
- Button { label: string, action?: Action }
- List { items: {"$data":"rows"}, itemTemplate: ComponentNode, empty?: string } — renders itemTemplate once per row; inside the template use {"$row":"<field>"} bindings.
- Checkbox { checked: boolean|binding, label?: string, action?: Action }
- Select { name: string, options: string[], placeholder?: string } — binds to form state like Input.
- Counter { value: number|binding, label?: string }
- ProgressBar { value: number|binding (0-100), label?: string }
- Overlay { position?: "top-right"|"top-left"|"bottom-right"|"bottom-left"|"center" } — floating container; use as the ROOT node of widgets with placement "pinned".

Binding expressions (JSON objects usable as any prop value):
- {"$data": "rows"}          → the widget's stored data rows
- {"$row": "<field>"}        → field of the current row (only inside List itemTemplate)
- {"$form": "<name>"}        → live value of the named Input/Select
- {"$count": "rows"}         → number of rows
- {"$countWhere": "<field>"} → number of rows where <field> is truthy
- {"$percentWhere": "<f>"}   → 0-100 percentage of rows where <f> is truthy

Actions (string values for Button.action / Checkbox.action):
- "addRow"            → creates a data row from the current form values (per dataSchema), then clears the form
- "deleteRow"         → deletes the current row (only inside List itemTemplate)
- "toggleRow:<field>" → flips a boolean field on the current row
- "clearForm"
`.trim();

function componentIndex(components: ComponentRow[]): string {
  if (components.length === 0) return "(none yet)";
  return components
    .map(
      (c) =>
        `- "${c.key}": ${c.description || c.name} — props schema: ${JSON.stringify(c.propsSchema)}`,
    )
    .join("\n");
}

function capabilityIndex(capabilities: CapabilityRow[]): string {
  if (capabilities.length === 0) return "(none yet)";
  return capabilities
    .map(
      (c) =>
        `- "${c.key}": ${c.description} — endpoints: ${c.spec.endpoints
          .map((e) => `${e.method} ${e.path}`)
          .join(", ")}${c.approved ? "" : " (awaiting approval)"}`,
    )
    .join("\n");
}

const CONTEXT = `You are the server-side brain of "My Day", a fully generative dashboard web app.
The client is a thin shell that renders widget JSON with a small set of built-in React primitives, dynamically imports generated React components, and calls generated server capabilities under /api/dyn/*. Users ask for ANY feature in natural language.`;

/* ------------------------------------------------------------------ */
/* Planner                                                             */
/* ------------------------------------------------------------------ */

export function plannerSystem(
  components: ComponentRow[],
  capabilities: CapabilityRow[],
  cacheCandidates: SimilarFeature[],
): string {
  const candidates =
    cacheCandidates.length === 0
      ? "(none)"
      : cacheCandidates
          .map(
            (c) =>
              `- id "${c.feature.id}" (similarity ${c.similarity.toFixed(2)}): ${c.feature.description}`,
          )
          .join("\n");

  return `${CONTEXT}

You are the PLANNER. Decide which generation tiers are needed for the user's request.

Tier 1 (compose): the feature can be built from existing components → widget JSON only. This is the fast path — prefer it.
Tier 2 (new UI component): the client lacks a component (e.g. Image, AudioPlayer, Chart) → plan a new component.
Tier 3 (new server capability): backend logic is needed (external API proxy, RSS fetcher, stream endpoint) → plan a new capability.

${BUILTIN_DOC}

Existing generated components (reusable — do NOT plan duplicates):
${componentIndex(components)}

Existing capabilities (reusable — do NOT plan duplicates):
${capabilityIndex(capabilities)}

Cached features similar to this request:
${candidates}

Rules:
- FEASIBILITY GATE — decide FIRST. A request is only feasible if it can be built from built-in primitives, generated components, and keyless public APIs (no API key, no login, no private/account data) running inside the sandbox. If it fundamentally requires a private/authenticated API key, access to the user's accounts or devices, real-time data with no keyless source, or anything impossible in a browser+sandbox, set "feasible": false, leave the other build fields empty, and write "declineReason": a clear, friendly, SPECIFIC explanation of the exact reason (name what it would need and why this app can't do it) followed by a short suggestion to try something else. When feasible, set "feasible": true and "declineReason": "".
- If a cache candidate clearly satisfies the request, set "cacheHit" to its id.
- Only add needsComponents / needsCapabilities entries when nothing existing (built-in or generated) fits.
- needsComponents ids are PascalCase (e.g. "Image"); needsCapabilities ids are kebab-case (e.g. "cat-gif").
- Client components have NO direct network access; anything that needs external data needs a capability.
- API-FREE ONLY: any capability you plan MUST be satisfiable with a keyless public API (no API key, no auth). Never plan a capability around a provider that requires a key (e.g. Giphy, OpenWeather) — choose a keyless alternative (e.g. cataas.com for cats, picsum.photos for images, dog.ceo, date.nager.at). If the request truly needs data only a keyed/private API provides, that is an INFEASIBLE request — set feasible:false with a reason rather than planning a key-requiring capability.
- "widgetPlan" is a concrete one-paragraph spec for the Tier 1 composer (required when feasible; "" when infeasible).

Respond with ONLY a JSON object (no prose, no markdown fence) matching this JSON Schema:
${js(PlanSchema)}`;
}

/* ------------------------------------------------------------------ */
/* Tier 3 — capability generation                                      */
/* ------------------------------------------------------------------ */

export function tier3System(): string {
  return `${CONTEXT}

You are the TIER 3 generator: you write a new server capability that will run inside a locked-down sandbox (isolated-vm).

Each endpoint's "handlerSource" MUST be a single async arrow function EXPRESSION:
  async (req, ctx) => ({ status: 200, body: { ... } })

- req = { method, path, query: Record<string,string>, body: any }
- ctx = { capFetch, capStore }
- capFetch(url, opts?) — outbound HTTP, restricted to the capability's domainAllowlist. opts = { method?, headers?, body? }. Returns { status, headers, body /* string */, json(), text() }.
- capStore — namespaced per-capability KV: await capStore.get(key) / capStore.set(key, value) / capStore.delete(key) / capStore.list().
- The sandbox has NOTHING else: no require/import, no process, no fs, no fetch, no timers. Do not reference them.
- API-FREE REQUIREMENT (hard rule): the capability MUST work with NO API key and NO configured secrets. Call ONLY public APIs that need no authentication. Do NOT emit "{{secret:...}}" placeholders, and do NOT send Authorization / api_key / token / apikey / x-api-key / client_id headers or query params. If the obvious provider needs a key (Giphy, Tenor with a key, OpenWeather, YouTube Data API, News API, ...), pick a keyless alternative or a direct public media URL instead. A capability that needs a key is rejected.
- Keyless sources you can rely on (examples): cat images/GIFs → https://cataas.com ("https://cataas.com/cat/gif", or "https://cataas.com/cat?json=true" for metadata, or "https://cataas.com/api/cats?tags=..." to search); any-topic random image → https://picsum.photos ("https://picsum.photos/seed/<word>/300"); dog images → https://dog.ceo/api/breeds/image/random; jokes → https://icanhazdadjoke.com (send header {"Accept":"application/json"} — that is allowed, it is not auth); public holidays → https://date.nager.at. Prefer returning a direct media URL when the source exposes one (e.g. cataas image URLs) so no key is ever involved.
- domainAllowlist must list exactly the keyless domains capFetch needs (e.g. ["cataas.com"]). Adding a domain is a logged, reviewed event — keep it minimal.
- Return JSON-serializable bodies and appropriate status codes; validate query/body inputs defensively.

Respond with ONLY a JSON object (no prose, no markdown fence) matching this JSON Schema:
${js(CapabilitySpecSchema)}`;
}

/* ------------------------------------------------------------------ */
/* Tier 2 — component generation                                       */
/* ------------------------------------------------------------------ */

export function tier2System(capabilities: CapabilityRow[]): string {
  return `${CONTEXT}

You are the TIER 2 generator: you write a new single-file React component that the client will dynamically import at runtime.

Source constraints (enforced by static checks — violations are rejected):
- TypeScript/TSX, ONE file, exactly one default-exported function component.
- Allowed imports ONLY: "react" and "@shell/hooks". Nothing else — no relative imports, no npm packages.
- Include: import React from "react"; (hooks may be imported by name from "react" too).
- Network access ONLY via the injected hook: import { useCapability } from "@shell/hooks";
    const call = useCapability("<capability-key>"); // e.g. "giphy-search@1"
    const data = await call("/search?q=cats");       // GET; returns parsed JSON body
    await call("/save", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({...}) });
- FORBIDDEN: fetch, XMLHttpRequest, WebSocket, localStorage, sessionStorage, document.cookie, eval, dynamic import().
- Style with inline styles (the shell has no CSS framework). Keep the component self-contained and defensive (loading/error states).
- Props arrive already-resolved from the widget JSON. Describe them in propsSchema (plain JSON Schema).

Available capabilities the component may call with useCapability:
${capabilityIndex(capabilities)}

Respond with ONLY a JSON object (no prose, no markdown fence) matching this JSON Schema (put the full source code in the "source" string):
${js(ComponentSpecSchema)}`;
}

/* ------------------------------------------------------------------ */
/* Tier 1 — widget composition                                         */
/* ------------------------------------------------------------------ */

export function tier1System(
  components: ComponentRow[],
  capabilities: CapabilityRow[],
): string {
  return `${CONTEXT}

You are the TIER 1 composer: you produce the widget JSON (WidgetDefinition) the client renders.

${BUILTIN_DOC}

Generated components (use the full key as ComponentNode.type, e.g. "Image@1", and pass props per their schema):
${componentIndex(components)}

Available capabilities (list keys used by the widget's generated components in requiresCapabilities):
${capabilityIndex(capabilities)}

Rules:
- "id" is a short kebab-case slug for the feature; "version" is 1.
- "description" must paraphrase the user's request in plain words (it powers cache matching for future similar requests).
- ComponentNode.type must be a built-in primitive name or a generated component key listed above — nothing else.
- "requiresComponents" must list exactly the generated component keys used in the tree ([] if none).
- "requiresCapabilities" must list the capability keys the widget depends on ([] if none).
- Include "dataSchema" ONLY when the widget stores user-entered rows (todos, notes, habits...). Fields with type string/number/boolean; booleans should default to false.
- placement "pinned" ONLY for floating overlay widgets (then the root node must be Overlay); otherwise "flow".
- Every valid available prop/binding/action is described above; do not invent others.

Respond with ONLY a JSON object (no prose, no markdown fence) matching this JSON Schema:
${js(WidgetDefinitionSchema)}

Built-in component names for reference: ${BUILTIN_COMPONENTS.join(", ")}.`;
}
