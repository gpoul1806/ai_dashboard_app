# Add Features — Fully Generative Dashboard

Experimental **Fully Generative UI** app. The client is a thin shell; the
majority of the app is served by the LLM as JSON — and, when a request needs
vocabulary that doesn't exist yet, as **generated code**. You ask for any
feature in natural language ("add a pomodoro timer", "put a cat gif top-right",
"make tabs for Home/About/Contact"); the server-side orchestrator decides how
to deliver it, caches and versions everything it generates, and grows its own
vocabulary over time.

```
User request ──▶ cache check ──▶ planner (LLM) ──▶ Tier 3 ▶ Tier 2 ▶ Tier 1
                     │ hit                                              │
                     └────────────▶ instant, zero LLM calls ◀── saved ──┘
```

The full request lifecycle — with diagrams of how components are generated,
built, stored, served, and reused — is documented in
[`docs/llm-request-flow.md`](docs/llm-request-flow.md).

## The three tiers

- **Tier 1 — Compose.** The feature can be built from existing components →
  the LLM returns widget JSON (a generic `UINode` tree), Zod-validated and
  sanitized. The fast path, and most requests over time.
- **Tier 2 — New UI component.** The feature needs a component the client
  doesn't have → the LLM generates a single-file React component, the server
  transpiles it with esbuild (fail = retry with errors), stores source + built
  JS, and serves it as an immutable ES module at `/api/components/<Key>.js`.
  The client dynamically imports and registers it, then rendering proceeds.
- **Tier 3 — New server capability.** The feature needs backend logic (an API
  proxy, a fetcher) → the LLM generates a handler that runs **only** in a
  sandbox (`isolated-vm`, falling back to `worker_threads`) with a strict
  capability API: `capFetch` (per-capability domain allowlist) and `capStore`
  (namespaced KV). New capabilities are stored but stay dark until approved in
  the dev panel.

## Why caching is the thesis

Everything generated is cached and versioned; **cache-hit rate is the success
metric**. Reuse happens at three independent levels:

- **Feature** — a similar request (trigram similarity over cached feature
  descriptions, `pg_trgm`) serves the whole cached widget instantly.
- **Component** — the planner's prompt lists every existing component, so a
  new feature that needs an image reuses `Image@1` instead of regenerating it.
- **Capability** — sandboxed endpoints like `giphy-search@1` are permanent
  library items shared by all future features.

Artifacts are immutable: a change creates `Image@2`, never an edit — which is
what makes `Cache-Control: immutable` on served component modules safe.

## What it does today

- Free-form generative widgets: timers, tables, media (video/audio/img travel
  as sanitized native element nodes), pinned/background/flow placement across
  nine anchor regions.
- App-scope requests: one request can plan multiple widgets, create views/tabs
  (`setView` actions), and re-home existing widgets onto views.
- Cross-widget state: globals, bindings, `$if` conditionals, and intents let
  one widget's switch disable another widget's input.
- In-place widget updates and real removal (not fake acknowledgements).
- Attachments: paste/drag images, stored server-side, visible to the planner
  and component generator as vision input.
- Parallel worker agents build multi-widget plans concurrently; one failing
  piece never kills the batch.
- Request cancel (AbortController end-to-end) and "Clear all" that empties the
  dashboard without touching the feature cache.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite + TypeScript — renderer engine + dynamic loader, plain CSS |
| Backend | Node.js + Express + TypeScript — planner + per-tier generation pipeline |
| LLM | Claude via `@anthropic-ai/sdk`, structured outputs + prompt caching |
| Sandbox | `isolated-vm` (or `worker_threads`) with an injected capability API |
| Database | Supabase (Postgres) — or a zero-config in-memory dev store |
| Schemas | Zod in `packages/schema`, single source of truth for all tiers |

## Layout

```
packages/schema     Zod schemas for all three tiers (single source of truth)
apps/web            Thin shell: renderer engine + loader + seed primitives
  src/registry/       built-in primitives (the seed vocabulary)
  src/loader/         dynamic import + runtime registration of generated components
  src/renderer/       JSON → React tree engine
apps/server         Express orchestrator + LLM + sandbox + db + routes
  src/orchestrator/   planner: request → tier plan → generation pipeline
  src/llm/            Claude client, per-tier system prompts, validators
  src/sandbox/        isolated-vm / worker runtime + capability API
  src/routes/         features, components (ES modules), /api/dyn/*, data
  src/db/             Supabase + in-memory store, schema.sql
docs/               architecture docs (request flow, caching, reuse)
```

## Setup

Requires Node ≥ 20 and pnpm.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env   # add ANTHROPIC_API_KEY
pnpm dev            # web :5173 + server :3001
```

- **Without Supabase** the server uses an in-memory dev store — everything
  works, nothing persists across restarts. To persist, set `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` and apply `apps/server/src/db/schema.sql` in the
  Supabase SQL editor.
- **Without `ANTHROPIC_API_KEY`** the seeded Todo widget still renders, but
  generation needs Claude. The key lives only in server `.env` — never exposed
  to the client or to sandboxed generated code.
- `SANDBOX=worker` forces the `worker_threads` runtime even if `isolated-vm`
  built.

## Commands

```bash
pnpm dev            # web (:5173) + server (:3001)
pnpm typecheck      # all packages
pnpm test           # vitest — schema, sanitizer, sandbox capability-API,
                    # validator, and orchestrator tests
```

## Safety rails (non-negotiable even in a POC)

1. Generated code never runs unsandboxed — Tier 2 in the browser page with
   import restrictions (imports limited to `react` / injected shell hooks, no
   raw `fetch`); Tier 3 in `isolated-vm`/`worker_threads` only.
2. All LLM output is validated (Zod / sanitizer / esbuild / static checks)
   before storage or execution, with one retry on failure, then a friendly
   decline.
3. Element trees are sanitized on both sides (allowlisted tags/attrs), with a
   CSP backstop. Server-side media-URL verification blocks invented URLs and
   private-network egress (SSRF hardening).
4. Generated-code network egress only via allowlisted `capFetch`; secrets are
   host-injected (`{{secret:NAME}}`), never LLM-visible, never in generated
   source.
5. New capabilities are `review_required`: stored but not registered in the
   sandbox until approved in the dev panel.

## Status

This is a proof of concept. Real auth, RLS/multi-tenancy, automated security
review of generated code, and a native port are explicitly out of scope for v1.
