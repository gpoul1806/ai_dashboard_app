# How a Feature Request Becomes a Widget — and Gets Reused

How the server turns a natural-language request into UI, where every generated
artifact is saved, and why a second similar request costs zero LLM calls.

Key source files:

| Step | File |
|---|---|
| Orchestrator (the whole flow) | `apps/server/src/orchestrator/index.ts` — `handleRequest()` |
| LLM validation + esbuild | `apps/server/src/llm/validators.ts` |
| Storage (Supabase / in-memory) | `apps/server/src/db/index.ts` |
| Component serving | `apps/server/src/routes/components.ts` |
| Client dynamic loader | `apps/web/src/loader/index.ts` |

---

## 1. The big picture

```
                        ┌──────────────────────────┐
                        │  User: "add a cat gif    │
                        │  in the top-right"       │
                        └────────────┬─────────────┘
                                     │ POST /api/features/request
                                     ▼
                     ┌───────────────────────────────┐
                     │        ORCHESTRATOR           │
                     │  loads: component registry,   │
                     │  capability index, current    │
                     │  dashboard, image attachments │
                     └────────────┬──────────────────┘
                                  ▼
                     ┌───────────────────────────────┐
              ┌──────│  CACHE CHECK (pg_trgm)        │
              │ HIT  │  findSimilarFeatures(text, 5) │
              │      │  similarity ≥ threshold?      │
              │      └────────────┬──────────────────┘
              │                   │ MISS
              │                   ▼
              │      ┌───────────────────────────────┐
              │      │  PLANNER (LLM call #1)        │
              │      │  sees: registry index + cache │
              │      │  candidates + live dashboard  │
              │      │  outputs: intent, feasibility,│
              │      │  needsCapabilities[],         │
              │      │  needsComponents[],           │
              │      │  widgetPlan(s), updatePlans   │
              │      └────────────┬──────────────────┘
              │                   │ (remove intent → delete widgets & stop)
              │                   │ (infeasible → graceful decline & stop)
              │                   │ (planner-spotted cacheHit → serve cached)
              │                   ▼
              │      ┌───────────────────────────────┐
              │      │  TIER 3 — server capabilities │  only if
              │      │  generate handler → store,    │  needsCapabilities
              │      │  await human approval         │  is non-empty
              │      └────────────┬──────────────────┘
              │                   ▼
              │      ┌───────────────────────────────┐
              │      │  TIER 2 — new UI components   │  only if
              │      │  generate TSX → esbuild →     │  needsComponents
              │      │  save source + built JS       │  is non-empty
              │      └────────────┬──────────────────┘
              │                   ▼
              │      ┌───────────────────────────────┐
              │      │  TIER 1 — widget JSON         │  always
              │      │  parallel worker agents, one  │
              │      │  per widgetPlan; Zod-validate │
              │      │  + sanitize; save feature     │
              │      └────────────┬──────────────────┘
              │                   ▼
              │      ┌───────────────────────────────┐
              └─────▶│  RESPONSE to client           │
                     │  { outcome, feature JSON,     │
                     │    requiresComponents[] }     │
                     └────────────┬──────────────────┘
                                  ▼
                     ┌───────────────────────────────┐
                     │  CLIENT SHELL                 │
                     │  ensureComponents() imports   │
                     │  any missing generated JS,    │
                     │  registers it, renders JSON   │
                     └───────────────────────────────┘
```

---

## 2. Step by step

### Step 0 — Request arrives

- Client `POST`s the raw text (plus optional attachments) to the server.
- Orchestrator loads context: **all generated components**, **all
  capabilities**, and the **current dashboard** (`db.listComponents()`,
  `db.listCapabilities()`, `db.listFeatures()`).
- Management-looking requests ("remove the todo list") **skip the cache** so a
  cached widget can't short-circuit a deletion.

### Step 1 — Cache check (no LLM yet)

- `findSimilarFeatures(requestText, 5)` runs trigram similarity (`pg_trgm` in
  Supabase, an in-process equivalent in the dev store) against the
  `features.description` column.
- **Similarity ≥ threshold → instant hit**: the cached feature is re-attached
  to the dashboard (`addToLayout`) and returned. Zero LLM calls, zero
  generation. This path is the project's success metric.
- Below threshold, the top 5 candidates are still handed to the planner — it
  may recognize one as a match the trigram score missed (`plan.cacheHit`).

### Step 2 — Planner (first LLM call)

- One structured-output call. Its system prompt is built from the **live
  registry indexes**, so the model knows exactly which components and
  capabilities already exist and never regenerates them.
- It outputs a `Plan`:
  - `intent` — create / update / remove
  - `feasible` + `declineReason` — impossible asks decline gracefully
  - `cacheHit` — a candidate feature id to serve as-is
  - `needsCapabilities[]` — Tier 3 work, only for genuinely missing backend
  - `needsComponents[]` — Tier 2 work, only for genuinely missing UI pieces
  - `widgetPlan` + `moreWidgetPlans[]` — one per widget to build (Tier 1)
  - `updatePlans[]`, `viewAssignments[]` — in-place edits / re-homing

### Step 3 — Tier 3: new server capability (only when needed)

```
LLM generates CapabilitySpec ──▶ validate ──▶ capabilities table
    (handler source, domain          │        approved = false
     allowlist, endpoints)           │        review_required = true
                                     ▼
                          human clicks approve in dev panel
                                     ▼
                          registered in isolated-vm sandbox
                          mounted at /api/dyn/<key>/*
```

- Stored but **not live** until a human approves (safety rail #5).
- Never regenerated: future features just reference `giphy-search@1`.

### Step 4 — Tier 2: new UI component (only when needed)

```
 ┌─────────────────────┐   ┌──────────────────────┐   ┌─────────────────────────┐
 │ LLM call per needed │   │ VALIDATE + BUILD     │   │ SAVE (insertComponent)  │
 │ component:          │──▶│ • static checks      │──▶│ generated_components:   │
 │ ComponentSpec       │   │   (imports, exports) │   │   id      "Image@1"     │
 │ { id, name, version,│   │ • esbuild transform  │   │   source  (TSX)         │
 │   propsSchema,      │   │   TSX → JS = builtJs │   │   built_js (compiled)   │
 │   source (TSX) }    │   │ • fail → retry with  │   │   props_schema (JSON)   │
 └─────────────────────┘   │   errors appended    │   │   immutable, versioned  │
                           └──────────────────────┘   └─────────────────────────┘
```

- Nothing is stored unless it compiles and passes the static checks.
- The row is **immutable**: a change later means a new row `Image@2`, never an
  edit. That's what makes the aggressive HTTP caching in step 7 safe.

### Step 5 — Tier 1: widget JSON (always)

- Every `widgetPlan` is built by an **independent worker agent** (parallel,
  bounded concurrency). One failing piece lands in `failedPieces` instead of
  killing the batch.
- Each worker's output is parsed (`jsonrepair` recovery), **Zod-validated**,
  and **sanitized** (allowlisted tags/attrs). One retry with the validation
  errors appended, then a friendly decline.
- The finished `WidgetDefinition` lists its dependencies explicitly:
  `requiresComponents: ["Image@1"]`, `requiresCapabilities: ["giphy-search@1"]`.
- Saved via `insertFeature()` → `features` table (the cache) **and** attached
  to the dashboard via a `user_layouts` row.

### Step 6 — What "saved" means (the three stores)

```
 SUPABASE (or in-memory dev store)
 ┌───────────────────────────────────────────────────────────────┐
 │ features               ← THE request cache (widget JSON +     │
 │                          description used for similarity)     │
 │ generated_components   ← component library (TSX + built JS)   │
 │ capabilities           ← backend library (handler + allowlist)│
 │ user_layouts           ← what's ON the dashboard right now    │
 │ generation_log         ← tier, tokens, retries, cache_hit     │
 └───────────────────────────────────────────────────────────────┘
```

- Dashboard membership (`user_layouts`) is **separate** from the cache
  (`features`): "Clear all" empties the layout only; the cache survives and
  keeps serving hits.

### Step 7 — Client renders (and its own two cache layers)

```
 response.requiresComponents = ["Image@1"]
              │
              ▼
 ensureComponents(["Image@1"])                 apps/web/src/loader/index.ts
   ├─ already in runtime registry? ──▶ skip    (session cache #1)
   ├─ already being fetched?       ──▶ await   (inflight dedupe)
   └─ else: import("/api/components/Image@1.js")
              │
              ▼
 server route sends built_js with
 Cache-Control: public, max-age=31536000, immutable
              │                                (browser HTTP cache #2 —
              ▼                                 safe because rows never mutate)
 registry.register("Image@1", mod.default)
              │
              ▼
 renderer walks the widget JSON → React tree
```

---

## 3. Reuse: the second, similar request

```
 User A: "put a cat gif top-right"          User B (later): "add a cat gif
                                             in the top right corner"
 ─────────────────────────────────          ──────────────────────────────
 cache MISS                                 trigram similarity vs cached
 planner + tier2 (Image@1 built)            feature descriptions ≥ threshold
 + tier1 (widget JSON built)                        │
 feature saved to `features`                        ▼
                                            CACHE HIT — addToLayout()
 LLM calls: planner + per-tier              LLM calls: ZERO
 generated: component + widget              generated: NOTHING
                                            client loads Image@1.js from
                                            its own browser cache
```

Reuse happens at **three independent levels**, so even a *partial* match pays
off:

- **Feature level** — near-identical request → the whole cached widget JSON is
  served instantly (trigram hit before the planner, or planner `cacheHit`).
- **Component level** — a *different* feature that needs an image ("show my
  dog's photo") gets a planner whose prompt already lists `Image@1`; it plans
  `needsComponents: []` and Tier 2 is skipped entirely.
- **Capability level** — any future feature needing Giphy reuses
  `giphy-search@1`'s sandboxed endpoint; no new backend generation, no new
  approval.

The vocabulary only ever grows: every generated component and capability is a
permanent, versioned library item shared by all users and all future features.
