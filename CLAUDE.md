# CLAUDE.md — "Add Features" Fully Generative Dashboard

## Project Overview

Experimental **Fully Generative UI** app. The client is a thin shell; **the majority of the app is served by the LLM as JSON** (and, when needed, as generated code). The user asks for ANY feature in natural language. The server-side LLM decides how to deliver it:

- **Tier 1 — Compose:** the feature can be built from existing components → LLM returns widget JSON. (fast path, most requests over time)
- **Tier 2 — New UI component:** the feature needs a component the client doesn't have (e.g. `Image`, `AudioPlayer`, `Overlay`) → LLM **generates the React component code**, the server stores + serves it as an ES module, the client **dynamically imports and registers it**, THEN returns the widget JSON that uses it.
- **Tier 3 — New server capability:** the feature needs backend logic (e.g. a Giphy proxy, an RSS fetcher, a music stream endpoint) → LLM **generates a server handler**, it is registered in a sandboxed runtime, THEN Tier 2/1 build the UI on top.

Everything generated is **cached and versioned**: the second user who asks for "a cat gif top-right" gets it instantly — no regeneration. The system's vocabulary grows itself.

**Why this is possible here:** this is a WEB app. Browsers can dynamically import JS at runtime. (A future native port would keep Tier 1 fully and restrict Tiers 2/3 — do not design against native constraints in v1.)

Core loop:

```
User request
  → Node.js orchestrator (LangGraph-style planner)
    → cache check (features / components / capabilities)
    → LLM plans: which tiers are needed?
      → [Tier 3] generate server handler → sandbox register
      → [Tier 2] generate component → validate/build → component registry (DB + CDN route)
      → [Tier 1] generate widget JSON → Zod validate
  → client hot-loads new components + renders JSON
```

**This is a proof of concept.** Prioritize the full generative loop working end-to-end. Auth, multi-tenancy, and hardening are explicitly deferred.

## Stack

- **Frontend:** React 18 + Vite + TypeScript. Thin shell: renderer engine + dynamic component loader. Plain CSS. Request bar is a 2-row textarea with **attachments** (images/screenshots/audio/files via picker, paste, or drag — images go to the LLM as vision input; files stored via Supabase storage) and **cancel** for in-flight requests (AbortController wired end-to-end; client close aborts the server-side generation).
- **Backend:** Node.js + Express + TypeScript. LLM orchestrator with a planner step.
- **Sandbox for generated server code:** `isolated-vm` (preferred) or worker threads with a strict capability API. Generated code NEVER runs in the main process.
- **Database:** Supabase (Postgres) — features, generated components, generated capabilities, widget data, logs.
- **LLM:** Claude API via `@anthropic-ai/sdk`. Model: `claude-sonnet-4-6`. API key ONLY in server `.env` (`ANTHROPIC_API_KEY`). Never exposed to client. Never accessible from sandboxed generated code.

## Repository Structure

```
/
├── CLAUDE.md
├── package.json                  # pnpm workspaces
├── apps/
│   ├── web/                      # Thin shell
│   │   └── src/
│   │       ├── registry/         # BUILT-IN primitives (the seed vocabulary)
│   │       ├── loader/           # dynamic import + runtime registration of generated components
│   │       ├── renderer/         # JSON → React tree engine
│   │       ├── api/
│   │       └── App.tsx
│   └── server/
│       └── src/
│           ├── orchestrator/     # planner: request → tier plan → generation pipeline
│           ├── llm/              # Claude client, per-tier system prompts, validators
│           ├── sandbox/          # isolated-vm runtime + capability API for Tier 3 handlers
│           ├── routes/
│           │   ├── features.ts   # request/serve features
│           │   ├── components.ts # serve generated component ES modules
│           │   ├── dyn/          # mounts Tier 3 generated endpoints under /api/dyn/*
│           │   └── data.ts       # widget_data CRUD
│           └── db/
└── packages/
    └── schema/                   # Zod schemas: WidgetDefinition, ComponentSpec, CapabilitySpec
```

## The Three Generation Tiers

### Tier 1 — Widget JSON (free-form composition)

```typescript
type WidgetDefinition = {
  id: string;
  name: string;
  description: string;
  version: number;
  root: UINode;                     // generic node tree (see below)
  presentation: {                   // position-aware, chrome is OPT-IN
    placement: "flow" | "pinned" | "background";
    anchor?: "top-left" | … | "bottom-right"; // 9 regions, pinned widgets
    order?: number;                 // position in the flow grid (0 = first)
    zIndex?: number;
    surface: "none" | "card";       // default "none" — the shell imposes NO chrome
    view?: string;                  // named view/tab this widget belongs to; omit = GLOBAL
    size?: { gridColumnSpan?; width?; height? };
  };
  requiresComponents: string[];     // e.g. ["Image@1"] — client loads these before render
  requiresCapabilities: string[];   // e.g. ["giphy-search@1"]
  dataSchema?: Record<string, DataField>;
};

// The generic content tree — media travels as native element nodes.
type UINode =
  | { kind: "text"; value: string | number | Binding }
  | { kind: "element"; tag: string;           // ANY allowlisted HTML/SVG tag (video, audio, img, svg…)
      attrs?: Record<string, ...|Binding>;    // src, controls, autoplay, loop, muted, poster…
      style?: Record<string, string|number|Binding>; // LLM-authored camelCase inline CSS
      action?: string; children?: UINode[] }
  | { kind: "component"; component: string; props?; children? }; // built-in or "Image@1"
```

**Bindings** (usable in text values, element attrs, style values, and component props):
`$data`/`$row`/`$form` (widget data + form values), `$count`/`$countWhere`/`$percentWhere`
(aggregates), `$global`/`$globalNot` (app-wide shared state → cross-widget wiring), and
`{$if: key, then, else}` — conditional literal keyed on a global ("!" prefix negates);
THE way to map state onto visuals (knob position, colors, labels). The shell exposes the
active view as the special truthy key `view:<name>` for active-tab highlighting.

**Actions** (on any element): `addRow`/`removeRow`/`toggleField` etc. for widget data,
`setView:<name>` (app-wide tab switch), `setGlobal:<key>=<value>` (shared state), and
`;`-separated chains — e.g. `"addRow;setView:home"` saves AND navigates.

- Element trees are sanitized on BOTH sides (`@myday/schema/sanitize`): strict at server
  validation (violations feed the LLM retry), strip at every client render, + a CSP backstop.
- LLM transport is STRUCTURED OUTPUT (`messages.parse` + `zodOutputFormat`) — flat wire
  schemas; the recursive tree rides as a `definitionJson` string (the structured-output
  grammar can't express recursion/open records), parsed + Zod-validated server-side with
  `jsonrepair` recovery. Prompt caching (`cache_control`) on the stable system block.
- The HTTP envelope is `RequestOutcome`, discriminated by `outcome`:
  `created` (artifact.kind "widget") | `declined` (userFacingReason) | `removed`.
- APP-SCOPE features are first-class: requests touching the whole app (global menus,
  backgrounds, tabs/pages) plan MULTIPLE widgets in one request (`widgetPlan` +
  `moreWidgetPlans`), re-home existing widgets via the plan's `viewAssignments`, and use
  views: `presentation.view` scopes a widget to a tab; widgets without `view` are global;
  the `setView:<name>` action (usable on any element) switches the app-wide active view
  (landing view = "home"). The dashboard (user_layouts) is separate from the feature
  cache (features): "Clear all" empties the layout only; cache hits re-surface widgets.
- Zod-validate ALWAYS. One retry with errors appended, then friendly failure.

### Tier 2 — Generated UI components

- LLM outputs a `ComponentSpec`: `{ id, name, version, propsSchema (zod-as-json), source }` where `source` is a single-file React component (TSX).
- Pipeline: LLM → esbuild transpile (fail = retry with errors) → store source + built JS in `generated_components` → served at `/api/components/:id.js`.
- Client `loader/` dynamically imports the module, registers it in the runtime registry, then rendering proceeds.
- Generated component constraints (enforced in the Tier 2 system prompt AND by a static check):
  - Single default-exported function component. React only — imports limited to `react` (mapped to the shell's copy via import map).
  - No direct `fetch` to the outside world — network only through the injected `useCapability(id)` hook, which routes to `/api/dyn/*`.
  - No access to cookies, localStorage, or globals beyond what the shell injects.
- Built-in seed primitives (`Card`, `Stack`, `Text`, `Input`, `Textarea`, `Button`, `List`, `Checkbox`, `Select`, `Counter`, `ProgressBar`, `Overlay`) exist so Tier 1 has a day-one vocabulary — but the registry is OPEN: Tier 2 grows it without redeploying the client.

### Tier 3 — Generated server capabilities

- LLM outputs a `CapabilitySpec`: `{ id, name, version, description, endpoints: [{ method, path, handlerSource }] }`.
- Handlers run inside `isolated-vm` with an injected capability API ONLY:
  - `capFetch(url, opts)` — outbound HTTP restricted to a per-capability domain allowlist stored in DB (e.g. `api.giphy.com`). Adding a domain is a logged event.
  - `capStore` — namespaced KV access (backed by a `capability_data` table). No raw SQL, no Supabase client.
  - NO access to: process env, filesystem, other capabilities' data, the Anthropic key.
- Registered endpoints mount under `/api/dyn/:capabilityId/*`.
- Third-party secrets (e.g. a Giphy key): stored in a `capability_secrets` table, injected as opaque values into `capFetch` headers by the HOST, never readable by generated code.

## Orchestrator (the brain)

- Planner prompt receives: user request + current component registry index + current capability index + cache candidates + a live dashboard INVENTORY (existing widgets with placement/view/keys).
- It outputs a plan: `{ cacheHit? , needsCapabilities[], needsComponents[], widgetPlan, moreWidgetPlans[], viewAssignments }`.
- **Parallel worker agents (Phase C):** complex/bundled requests are decomposed into independent pieces; each piece is built by its own worker agent (concurrency configurable, read at call time) with its own validate/retry loop — one failing piece never sinks the rest. The plan must SPELL OUT shared contracts (view names, global keys, mechanisms) so independent workers converge. Workers can also regenerate ONE existing widget in place (same id).
- **RECONCILE rule:** the planner reconciles against the inventory — reuse/re-home existing widgets via `viewAssignments` instead of planning duplicates.
- Prompts are **generic capability rules**, not a per-component catalog: rules describe what the tree/bindings/actions CAN do; component specifics come from the schemas + live registry index. A **no-invented-content rule** forbids fabricating media URLs or table data.
- Execute Tier 3 → Tier 2 → Tier 1 in order; each step validates before the next runs.
- Every step logged to `generation_log` (tier, tokens, pass/fail, retries). **Cache-hit rate is THE success metric of this project.**

## Caching & Reuse (the thesis)

- Normalized request similarity via `pg_trgm` against `features.description` (> 0.6 → serve cached, offer as instant).
- Components and capabilities are shared library items: generated once, reused by every future feature and every user.
- Versioned, never mutated in place: a change creates `@2`.

## Supabase Schema (v1)

```sql
features             (id, slug, name, description, definition jsonb, version, created_at)
generated_components (id, name, version, props_schema jsonb, source text, built_js text, created_at)
capabilities         (id, name, version, spec jsonb, handler_source text, domain_allowlist text[], created_at)
capability_secrets   (capability_id, key_name, value)          -- host-injected only
capability_data      (capability_id, user_id, k, v jsonb)
user_layouts         (id, user_id, feature_id, position, placement, created_at)
widget_data          (id, user_id, feature_id, row jsonb, created_at, updated_at)
generation_log       (id, request_text, tier, cache_hit bool, success bool, retries int, tokens int, created_at)
```

- v1 auth: hardcoded demo `user_id`. No RLS yet. Client talks ONLY to the Express API.

## Safety Rails (non-negotiable even in a POC)

1. Generated code never runs unsandboxed. Tier 2 runs in the browser page (inherently sandboxed from the server) with import restrictions; Tier 3 runs in `isolated-vm` only.
2. All LLM output validated (Zod / esbuild / static checks) before storage or execution.
3. Network egress from generated code only via allowlisted `capFetch`.
4. Secrets are host-injected, never LLM-visible, never in generated source.
5. A `review_required` flag on capabilities: v1 sets it to true and shows a one-click approve in a dev panel before a NEW capability goes live. (Composition and cached items need no approval.)
6. **Keyless Tier 3:** generated capabilities must be API-key-free — the generator is forbidden from producing handlers that need secrets in source (enforced by validation + tests).
7. **Media URL verification (SSRF-hardened):** every media URL in a Tier 1 tree is verified server-side before the widget is accepted — `dns.lookup` pre-check blocks private/internal addresses, fetches use `redirect: "manual"` so a public URL 302-ing to an internal address can't be used as a redirect oracle, and unverifiable/redirecting URLs are rejected back into the LLM retry loop.
8. **Upload hardening:** attachments are served with normalized MIME types and hardened against stored XSS / header injection.
9. Component-prop node trees are sanitized RECURSIVELY (element nodes can hide inside props).

## Dev Commands

```bash
pnpm install
pnpm dev            # web (:5173) + server (:3001)
pnpm typecheck
pnpm test           # vitest — schema + sandbox capability-API tests are mandatory (~100 tests)
```

## Deployment

- Deployed as a **single Render Web Service**: the server serves the built SPA + the API from one origin. Node pinned to 22; pnpm 11 uses `allowBuilds` to permit esbuild/isolated-vm postinstall builds.

## Docs

- `docs/llm-request-flow.md` — end-to-end LLM request orchestration, the 3-level caching story (Supabase / HTTP immutable / runtime registry), and reuse patterns with flow diagrams.

## Coding Conventions

- TypeScript strict everywhere. Shared types only from `packages/schema` (`z.infer`).
- Per-tier system prompts are generated from the Zod schemas + live registry index — never hand-maintained in parallel.
- Renderer is pure: `(definition, data, registry) → JSX`. Registry components receive data via props; network only via `useCapability`.
- Small conventional commits. New npm deps need a justification comment.

## Build Order (follow strictly)

1. `packages/schema` — Zod schemas for all three tiers.
2. Shell renderer + seed primitives rendering a hardcoded WidgetDefinition.
3. Server + Supabase + serve a hardcoded feature (still no LLM).
4. **Tier 1 live:** Claude generates widget JSON + validation + retry + cache. (Todo list demo ✅)
5. **Tier 2 live:** component generation → esbuild → dynamic import loader. (Cat gif demo: LLM creates `Image` + uses `Overlay`, `placement: "pinned"` ✅)
6. **Tier 3 live:** isolated-vm sandbox + capFetch allowlist + dev approval panel. (Giphy search capability ✅)
7. Full pipeline demo: "add background lo-fi music with controls" — exercises all three tiers (audio component + stream proxy capability + global pinned placement).
8. **Generative-UI rearchitecture ✅:** generic `UINode` handshake, `RequestOutcome`, position-aware placement, views/tabs, cross-widget state (`$global`/`$if`/intents), widget removal, graceful declines, "Clear all" (layout only, cache preserved).
9. **Phase C ✅:** parallel worker agents for bundled requests, action chains, media URL verification + SSRF hardening, rules-based prompts, Render deployment.

## Out of Scope (v1)

- Real auth, RLS, multi-tenant isolation.
- Native/React Native port (Tier 1 ports cleanly; Tiers 2–3 need a different strategy there — later problem).
- Automated security review of generated code (manual approve panel is the v1 stand-in).
- Streaming generation, widget editing UI, billing/rate limits.